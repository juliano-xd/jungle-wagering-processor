import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { MikroORM, EntityManager } from '@mikro-orm/postgresql';
import config from '../../../mikro-orm.config.js';
import { WageringService } from '../../../src/application/services/wagering.service.js';
import { Money } from '../../../src/domain/value-objects/money.js';
import { InMemoryQueueAdapter } from '../../../src/infrastructure/queue/in-memory-queue.adapter.js';
import { WagerTransactionConsumer } from '../../../src/infrastructure/queue/wager-transaction.consumer.js';
import { InboxMessage } from '../../../src/domain/entities/inbox-message.js';
import { WagerTransactionKind } from '../../../src/domain/entities/wager-transaction.js';
import { payloadHashOf } from '../../../src/domain/services/canonical-json.js';
import type { WagerTransactionRequestedEnvelope } from '../../../src/infrastructure/queue/queue.port.js';

const CONSUMER_NAME = 'wager-tx-consumer';

/**
 * Spec 13 item 5: "worker morto DEPOIS do commit e ANTES do ack".
 *
 * Simulação:
 *   1. Consumer A recebe a mensagem, roda `submitTransaction` (commit OK,
 *      inbox marcado como processado), mas MORRE antes do `queue.ack`.
 *   2. Broker reentrega (envelope.messageId igual).
 *   3. Consumer B (novo processo) processa → deve ser replay, sem novo débito.
 *
 * ⚠️ `queueMessage.messageId` é o ID **interno do broker** (gerado pelo
 * InMemoryQueueAdapter, ou MessageId do SQS). É **diferente** do
 * `envelope.messageId` (ID de negócio, que vem no body). A dedup do inbox
 * usa o **envelope.messageId** — que é o que o consumer real lê via
 * `JSON.parse(msg.body)`. Testes que quiserem comparar o que foi reentregue
 * precisam parsear o body, não olhar `msg.messageId`.
 */
describe('Crash recovery — consumer morre entre commit e ack', () => {
  let orm: MikroORM;
  let em: EntityManager;
  let service: WageringService;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
    try {
      const anyOrm = orm as unknown as {
        getMigrator?: () => { up: () => Promise<unknown> };
        migrator?: { up: () => Promise<unknown> };
      };
      const migrator = anyOrm.getMigrator?.() ?? anyOrm.migrator;
      if (migrator && typeof migrator.up === 'function') {
        await migrator.up();
      }
    } catch {
      // migrations já aplicadas
    }
  });

  afterAll(async () => {
    await orm.close();
  });

  beforeEach(async () => {
    em = orm.em.fork();
    service = new WageringService(em);
    await em.getConnection().execute(
      'TRUNCATE TABLE "outbox_messages", "idempotency_records", "inbox_messages", "wallet_ledger_entries", "wager_transactions", "wallets" CASCADE;',
    );
    em.clear();
  });

  it('commit feito, ack perdido → redelivery é replay (sem débito duplicado)', async () => {
    const playerId = crypto.randomUUID();
    const { walletId } = await service.createWallet({
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    // `envelopeMessageId` = ID de negócio (usado pelo inbox para dedup)
    const envelopeMessageId = `msg-crash-${crypto.randomUUID()}`;
    const externalTransactionId = `bet-crash-${crypto.randomUUID()}`;

    const envelope: WagerTransactionRequestedEnvelope = {
      messageId: envelopeMessageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'prov-1',
        externalTransactionId,
        idempotencyKey: `prov-1:${externalTransactionId}`,
        playerId,
        walletId,
        roundId: 'round-crash',
        gameId: 'slot-1',
        kind: 'BET',
        money: { amount: '30.00', currency: 'BRL' },
      },
    };

    const queue = new InMemoryQueueAdapter();

    // ── 1ª tentativa: commit OK, ack PERDIDO (simula crash) ────────
    await queue.send(JSON.stringify(envelope));

    const firstDelivery = await queue.receiveBatch(1, 0);
    expect(firstDelivery.length).toBe(1);

    // Verifica que o envelope que chegou é o esperado (parsing do body,
    // NÃO comparação com `firstDelivery[0].messageId`, que é o ID do broker).
    const firstEnvelope = JSON.parse(firstDelivery[0].body) as WagerTransactionRequestedEnvelope;
    expect(firstEnvelope.messageId).toBe(envelopeMessageId);

    // Roda `submitTransaction` diretamente, SEM chamar `queue.ack`.
    // É exatamente o que acontece se o processo morre entre o commit do DB
    // e o ack ao broker.
    await service.submitTransaction({
      providerId: envelope.data.providerId,
      externalTransactionId: envelope.data.externalTransactionId,
      idempotencyKey: envelope.data.idempotencyKey,
      playerId: envelope.data.playerId,
      walletId: envelope.data.walletId,
      roundId: envelope.data.roundId,
      gameId: envelope.data.gameId,
      kind: WagerTransactionKind.Bet,
      money: Money.from(envelope.data.money),
      payloadHash: payloadHashOf(envelope.data),
      inboxMessage: { messageId: envelopeMessageId, consumerName: CONSUMER_NAME },
    });
    // ⚠️ Sem `queue.ack(firstDelivery[0])` — o "crash" acontece aqui.

    // Estado após commit + crash:
    //   - saldo debitado
    //   - inbox processado
    //   - mensagem AINDA na fila (broker vai reentregar)
    em.clear();
    const walletAfterCommit = await service.getWallet(walletId);
    expect(walletAfterCommit!.balance.toJSON()).toEqual({
      amount: '70.00',
      currency: 'BRL',
    });

    const inboxAfterCommit = await em
      .fork()
      .findOne(InboxMessage, { messageId: envelopeMessageId, consumerName: CONSUMER_NAME });
    expect(inboxAfterCommit).not.toBeNull();
    expect(inboxAfterCommit!.isProcessed()).toBe(true);

    // Mensagem ainda está na fila — `receiveBatch` a devolve novamente.
    const redelivery = await queue.receiveBatch(1, 0);
    expect(redelivery.length).toBe(1);

    // ⚠️ Comparação CORRETA: parsear o body (ID de negócio), não o
    // `messageId` interno do broker (que é um UUID gerado pelo adapter/SQS).
    const redeliveredEnvelope = JSON.parse(redelivery[0].body) as WagerTransactionRequestedEnvelope;
    expect(redeliveredEnvelope.messageId).toBe(envelopeMessageId);

    // ── 2ª tentativa: processo NOVO, redelivery ────────────────────
    const consumerAfterRestart = new WagerTransactionConsumer(
      new WageringService(orm.em.fork()),
      queue,
    );
    await consumerAfterRestart.processOne(redelivery[0]);

    // Estado final: saldo AINDA em 70.00 (não 40.00), 1 débito no ledger.
    em.clear();
    const walletFinal = await service.getWallet(walletId);
    expect(walletFinal!.balance.toJSON()).toEqual({
      amount: '70.00',
      currency: 'BRL',
    });
    expect(walletFinal!.version).toBe(2); // opening + 1 bet

    const ledger = await service.listLedger(walletId, undefined, 10);
    expect(ledger.entries.length).toBe(2); // opening + 1 bet

    // A 2ª tentativa ack'ou com sucesso — fila vazia.
    const stats = queue.stats();
    expect(stats.queued).toBe(0);
    expect(stats.dlq).toBe(0);
  });
});
