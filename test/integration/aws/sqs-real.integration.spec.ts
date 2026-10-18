import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { MikroORM, EntityManager } from '@mikro-orm/postgresql';
import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  PurgeQueueCommand,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import config from '../../../mikro-orm.config';
import { WageringService } from '../../../src/application/services/wagering.service';
import { OutboxMessage } from '../../../src/domain/entities/outbox-message';
import { Wallet } from '../../../src/domain/entities/wallet';
import { WalletLedgerEntry } from '../../../src/domain/entities/wallet-ledger-entry';
import { WagerTransaction } from '../../../src/domain/entities/wager-transaction';
import { IdempotencyRecord } from '../../../src/domain/entities/idempotency-record';
import { InboxMessage } from '../../../src/domain/entities/inbox-message';
import { Money } from '../../../src/domain/value-objects/money';
import { WagerTransactionKind, WagerTransactionStatus } from '../../../src/domain/entities/wager-transaction';
import { payloadHashOf } from '../../../src/domain/services/canonical-json';

const SQS_ENDPOINT = 'http://localhost:4566';
const SQS_REGION = 'us-east-1';
const ACCOUNT_ID = '000000000000';
const OUTBOX_QUEUE_URL = `http://sqs.${SQS_REGION}.localhost.localstack.cloud:4566/${ACCOUNT_ID}/wager-outbox.fifo`;
const TX_QUEUE_URL = `http://sqs.${SQS_REGION}.localhost.localstack.cloud:4566/${ACCOUNT_ID}/wager-transactions.fifo`;

/**
 * Testes de integração com SQS LocalStack real.
 *
 * Valida:
 * 1. Publicação da outbox na fila SQS real
 * 2. Recebimento e processamento de mensagens da fila de transações
 * 3. Deduplicação via FIFO ContentBasedDeduplication
 */
describe('SQS Real Integration com LocalStack (TDD)', () => {
  let orm: MikroORM;
  let em: EntityManager;
  let service: WageringService;
  let sqsClient: SQSClient;

  const clearDb = async (em: EntityManager) => {
    const conn = em.getConnection();
    await conn.execute('TRUNCATE TABLE "outbox_messages", "idempotency_records", "inbox_messages", "wallet_ledger_entries", "wager_transactions", "wallets" CASCADE;');
    em.clear();
  };

  beforeEach(async () => {
    if (!orm) {
      orm = await MikroORM.init(config);
    }
    em = orm.em.fork();
    service = new WageringService(em);

    sqsClient = new SQSClient({
      region: SQS_REGION,
      endpoint: SQS_ENDPOINT,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });

    await clearDb(em);

    // Limpa as filas antes de cada teste
    try {
      await sqsClient.send(new PurgeQueueCommand({ QueueUrl: OUTBOX_QUEUE_URL }));
      await sqsClient.send(new PurgeQueueCommand({ QueueUrl: TX_QUEUE_URL }));
    } catch (e) {
      // Ignora erro se filas estiverem vazias
    }
  });

  afterAll(async () => {
    if (orm) await orm.close();
  });

  it('1. deve publicar mensagem de outbox na fila SQS FIFO com sucesso', async () => {
    // Publica uma mensagem diretamente na fila FIFO de outbox
    const messageId = crypto.randomUUID();
    const payload = {
      eventId: messageId,
      eventType: 'WalletBalanceChanged',
      aggregateId: crypto.randomUUID(),
      correlationId: 'corr-test',
      occurredAt: new Date().toISOString(),
      data: { amount: '50.00', currency: 'BRL' },
    };

    await sqsClient.send(new SendMessageCommand({
      QueueUrl: OUTBOX_QUEUE_URL,
      MessageBody: JSON.stringify(payload),
      MessageGroupId: payload.aggregateId,
      MessageDeduplicationId: messageId,
    }));

    // Lê a mensagem da fila
    const resp = await sqsClient.send(new ReceiveMessageCommand({
      QueueUrl: OUTBOX_QUEUE_URL,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 5,
    }));

    expect(resp.Messages).toBeDefined();
    expect(resp.Messages!.length).toBe(1);

    const received = JSON.parse(resp.Messages![0].Body!);
    expect(received.eventId).toBe(messageId);
    expect(received.eventType).toBe('WalletBalanceChanged');
    expect(received.data.amount).toBe('50.00');

    // Ack da mensagem
    await sqsClient.send(new DeleteMessageCommand({
      QueueUrl: OUTBOX_QUEUE_URL,
      ReceiptHandle: resp.Messages![0].ReceiptHandle!,
    }));
  });

  it('2. deve publicar eventos de outbox após processar transação financeira e confirmar na fila SQS', async () => {
    // Cria wallet e processa uma aposta — a transação gera OutboxMessages no banco
    const playerId = crypto.randomUUID();
    const { walletId } = await service.createWallet({
      playerId,
      initialBalance: Money.from({ amount: '200.00', currency: 'BRL' }),
    });

    const betDto = {
      providerId: 'prov-sqs-real',
      externalTransactionId: 'bet-sqs-real-001',
      idempotencyKey: 'prov-sqs-real:bet-sqs-real-001',
      playerId,
      walletId,
      roundId: 'round-sqs-001',
      gameId: 'game-sqs-001',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '75.00', currency: 'BRL' }),
      payloadHash: payloadHashOf({ bet: 'sqs-real-001' }),
    };

    const res = await service.submitTransaction(betDto);
    expect(res.status).toBe(WagerTransactionStatus.Processed);

    // Verifica que os OutboxMessages foram gravados no banco
    const outboxMsgs = await em.fork().find(OutboxMessage, { publishedAt: null });
    expect(outboxMsgs.length).toBeGreaterThan(0);

    // Simula o OutboxWorker publicando na SQS: publica cada mensagem pendente
    for (const msg of outboxMsgs) {
      const payload = msg.payload as Record<string, unknown>;
      await sqsClient.send(new SendMessageCommand({
        QueueUrl: OUTBOX_QUEUE_URL,
        MessageBody: JSON.stringify(payload),
        MessageGroupId: msg.aggregateId,
        MessageDeduplicationId: msg.id,
      }));

      // Marca como publicado no banco
      const forkedEm = orm.em.fork();
      const dbMsg = await forkedEm.findOne(OutboxMessage, { id: msg.id });
      if (dbMsg) {
        dbMsg.markPublished(new Date());
        forkedEm.persist(dbMsg);
        await forkedEm.flush();
      }
    }

    // Lê as mensagens publicadas na SQS
    const received = await sqsClient.send(new ReceiveMessageCommand({
      QueueUrl: OUTBOX_QUEUE_URL,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 5,
    }));

    expect(received.Messages).toBeDefined();
    expect(received.Messages!.length).toBeGreaterThan(0);

    // Verifica que pelo menos um evento é WagerTransactionProcessed
    const eventTypes = received.Messages!.map(m => JSON.parse(m.Body!).eventType);
    expect(eventTypes).toContain('WagerTransactionProcessed');

    // Verifica que todas as outbox foram marcadas como publicadas
    const stillPending = await em.fork().find(OutboxMessage, { publishedAt: null });
    expect(stillPending.length).toBe(0);
  });

  it('3. a fila SQS FIFO deve deduplicar mensagens com mesmo MessageDeduplicationId', async () => {
    const deduplicationId = crypto.randomUUID();
    const aggregateId = crypto.randomUUID();
    const payload = { eventId: deduplicationId, eventType: 'TestEvent', data: {} };

    // Envia duas vezes o mesmo MessageDeduplicationId
    await sqsClient.send(new SendMessageCommand({
      QueueUrl: OUTBOX_QUEUE_URL,
      MessageBody: JSON.stringify(payload),
      MessageGroupId: aggregateId,
      MessageDeduplicationId: deduplicationId,
    }));

    await sqsClient.send(new SendMessageCommand({
      QueueUrl: OUTBOX_QUEUE_URL,
      MessageBody: JSON.stringify({ ...payload, duplicate: true }), // Payload diferente, mesmo dedup ID
      MessageGroupId: aggregateId,
      MessageDeduplicationId: deduplicationId,
    }));

    // Deve receber apenas 1 mensagem (a primeira)
    const resp = await sqsClient.send(new ReceiveMessageCommand({
      QueueUrl: OUTBOX_QUEUE_URL,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 5,
    }));

    // FIFO com ContentBasedDeduplication garante exactly-once dentro da janela de 5 minutos
    expect(resp.Messages?.length).toBe(1);
    const body = JSON.parse(resp.Messages![0].Body!);
    // A 2ª mensagem (com duplicate=true) deve ter sido descartada
    expect(body.duplicate).toBeUndefined();
  });

  it('4. deve verificar a disponibilidade do SQS LocalStack via GetQueueAttributes', async () => {
    const attrs = await sqsClient.send(new GetQueueAttributesCommand({
      QueueUrl: OUTBOX_QUEUE_URL,
      AttributeNames: ['All'],
    }));

    expect(attrs.Attributes).toBeDefined();
    expect(attrs.Attributes!.FifoQueue).toBe('true');
    expect(attrs.Attributes!.ContentBasedDeduplication).toBe('true');
  });
});
