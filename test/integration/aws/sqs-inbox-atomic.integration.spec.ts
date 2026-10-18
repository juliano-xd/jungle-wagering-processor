import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { MikroORM, EntityManager } from '@mikro-orm/postgresql';
import config from '../../../mikro-orm.config';
import { WageringService } from '../../../src/application/services/wagering.service';
import { Money } from '../../../src/domain/value-objects/money';
import { WagerTransactionKind, WagerTransactionStatus } from '../../../src/domain/entities/wager-transaction';
import { Wallet } from '../../../src/domain/entities/wallet';
import { WalletLedgerEntry } from '../../../src/domain/entities/wallet-ledger-entry';
import { WagerTransaction } from '../../../src/domain/entities/wager-transaction';
import { IdempotencyRecord } from '../../../src/domain/entities/idempotency-record';
import { OutboxMessage } from '../../../src/domain/entities/outbox-message';
import { InboxMessage } from '../../../src/domain/entities/inbox-message';
import { payloadHashOf } from '../../../src/domain/services/canonical-json';
import { FailureCode, WagerTransactionError } from '../../../src/domain/errors/wager-transaction.error';

describe('Transactional Inbox & SQS Consumer Atomic Deduplication (TDD)', () => {
  let orm: MikroORM;
  let em: EntityManager;
  let service: WageringService;

  beforeEach(async () => {
    if (!orm) {
      orm = await MikroORM.init(config);
    }
    em = orm.em.fork();
    service = new WageringService(em);

    const conn = em.getConnection();
    await conn.execute('TRUNCATE TABLE "outbox_messages", "idempotency_records", "inbox_messages", "wallet_ledger_entries", "wager_transactions", "wallets" CASCADE;');
    em.clear();
  });

  afterAll(async () => {
    if (orm) {
      await orm.close();
    }
  });

  it('1. deve persistir InboxMessage atomicamente na mesma transação que a operação financeira', async () => {
    const playerId = crypto.randomUUID();
    const { walletId } = await service.createWallet({
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    const messageId = `sqs-msg-${crypto.randomUUID()}`;
    const consumerName = 'wager-processor';
    const payload = { bet: 'test-atomic-inbox' };

    const betDto = {
      providerId: 'prov-sqs',
      externalTransactionId: 'tx-sqs-001',
      idempotencyKey: 'prov-sqs:tx-sqs-001',
      playerId,
      walletId,
      roundId: 'round-sqs-1',
      gameId: 'game-sqs-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '40.00', currency: 'BRL' }),
      payloadHash: payloadHashOf(payload),
      inboxMessage: {
        messageId,
        consumerName,
      },
    };

    const res = await service.submitTransaction(betDto);
    expect(res.status).toBe(WagerTransactionStatus.Processed);
    expect(res.balanceAfter.toJSON()).toEqual({ amount: '60.00', currency: 'BRL' });

    // Verifica que o InboxMessage foi gravado e marcado como processado
    const savedInbox = await em.fork().findOne(InboxMessage, { messageId, consumerName });
    expect(savedInbox).toBeDefined();
    expect(savedInbox?.isProcessed()).toBe(true);
  });

  it('2. deve persistir InboxMessage como processado mesmo quando a operação é REJEITADA por regra de negócio (rejeição é terminal)', async () => {
    const playerId = crypto.randomUUID();
    const { walletId } = await service.createWallet({
      playerId,
      initialBalance: Money.from({ amount: '30.00', currency: 'BRL' }),
    });

    const messageId = `sqs-msg-rejected-${crypto.randomUUID()}`;
    const consumerName = 'wager-processor';
    const payload = { bet: 'rejected-insufficient' };

    const betDto = {
      providerId: 'prov-sqs',
      externalTransactionId: 'tx-sqs-rejected',
      idempotencyKey: 'prov-sqs:tx-sqs-rejected',
      playerId,
      walletId,
      roundId: 'round-sqs-rejected',
      gameId: 'game-sqs-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '80.00', currency: 'BRL' }), // > 30.00
      payloadHash: payloadHashOf(payload),
      inboxMessage: { messageId, consumerName },
    };

    // Rejeição = resultado, não falha. Não lança.
    const res = await service.submitTransaction(betDto);
    expect(res.status).toBe(WagerTransactionStatus.Rejected);
    expect(res.failureCode).toBe(FailureCode.InsufficientFunds);

    // Inbox FOI persistido e marcado como processado — rejeição é terminal,
    // não faz sentido retentar (o payload está errado por regra de negócio).
    const savedInbox = await em.fork().findOne(InboxMessage, { messageId, consumerName });
    expect(savedInbox).toBeDefined();
    expect(savedInbox?.isProcessed()).toBe(true);

    // Wallet intacta
    const w = await em.fork().findOne(Wallet, { id: walletId });
    expect(w?.balance.toJSON()).toEqual({ amount: '30.00', currency: 'BRL' });
  });

  it('2b. deve fazer rollback no InboxMessage quando a operação FALHA por pré-condição (DuplicateIdempotencyKey) — permitindo retry', async () => {
    const playerId = crypto.randomUUID();
    const { walletId } = await service.createWallet({
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    // Primeira tx bem-sucedida: cria IdempotencyRecord com hash H1.
    const firstMsgId = `sqs-msg-first-${crypto.randomUUID()}`;
    await service.submitTransaction({
      providerId: 'prov-sqs',
      externalTransactionId: 'tx-sqs-rollback-1',
      idempotencyKey: 'prov-sqs:tx-sqs-rollback',
      playerId,
      walletId,
      roundId: 'round-sqs-rollback',
      gameId: 'game-sqs-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
      payloadHash: payloadHashOf({ action: 'first-ok' }),
      inboxMessage: { messageId: firstMsgId, consumerName: 'wager-processor' },
    });

    // Segunda tentativa: MESMA idempotencyKey, payloadHash DIFERENTE,
    // messageId NOVO. Deve lançar DuplicateIdempotencyKey (pré-condição).
    const rollbackMsgId = `sqs-msg-rollback-${crypto.randomUUID()}`;

    await expect(
      service.submitTransaction({
        providerId: 'prov-sqs',
        externalTransactionId: 'tx-sqs-rollback-2',
        idempotencyKey: 'prov-sqs:tx-sqs-rollback', // mesma key
        playerId,
        walletId,
        roundId: 'round-sqs-rollback',
        gameId: 'game-sqs-1',
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: '10.00', currency: 'BRL' }),
        payloadHash: payloadHashOf({ action: 'DIFFERENT' }), // hash diferente
        inboxMessage: {
          messageId: rollbackMsgId,
          consumerName: 'wager-processor',
        },
      }),
    ).rejects.toThrow(WagerTransactionError);

    // ROLLBACK verificado: o inbox da 2ª tentativa NÃO foi persistido,
    // porque a exceção abortou a transação inteira (inbox + wallet + tx + outbox).
    const rollbackInbox = await em
      .fork()
      .findOne(InboxMessage, { messageId: rollbackMsgId, consumerName: 'wager-processor' });
    expect(rollbackInbox).toBeNull();

    // O inbox da 1ª tentativa continua intacto (foi commitado antes)
    const firstInbox = await em
      .fork()
      .findOne(InboxMessage, { messageId: firstMsgId, consumerName: 'wager-processor' });
    expect(firstInbox).toBeDefined();
    expect(firstInbox?.isProcessed()).toBe(true);

    // Wallet só reflete a 1ª BET (100 - 10 = 90), não a 2ª tentativa falha
    const w = await em.fork().findOne(Wallet, { id: walletId });
    expect(w?.balance.toJSON()).toEqual({ amount: '90.00', currency: 'BRL' });

    // Retry com a MESMA messageId (rollbackMsgId) e MESMO payload da 1ª tentativa
    // seria seguro — mas aqui o payload diverge; o importante é que o inbox
    // da tentativa falha pode ser reenviado sem duplicação.
  });

  it('3. deve ignorar redelivery idêntico da mesma mensagem SQS sem duplicar débitos', async () => {
    const playerId = crypto.randomUUID();
    const { walletId } = await service.createWallet({
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    const messageId = `sqs-msg-redelivery-${crypto.randomUUID()}`;
    const consumerName = 'wager-processor';
    const payload = { bet: 'test-redelivery' };

    const betDto = {
      providerId: 'prov-sqs',
      externalTransactionId: 'tx-sqs-redelivery',
      idempotencyKey: 'prov-sqs:tx-sqs-redelivery',
      playerId,
      walletId,
      roundId: 'round-sqs-redelivery',
      gameId: 'game-sqs-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      payloadHash: payloadHashOf(payload),
      inboxMessage: {
        messageId,
        consumerName,
      },
    };

    // 1ª entrega
    const res1 = await service.submitTransaction(betDto);
    expect(res1.status).toBe(WagerTransactionStatus.Processed);
    expect(res1.balanceAfter.toJSON()).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(res1.idempotentReplay).toBe(false);

    // 2ª entrega (redelivery do SQS por falha de ack/rede)
    const res2 = await service.submitTransaction(betDto);
    expect(res2.idempotentReplay).toBe(true);
    expect(res2.balanceAfter.toJSON()).toEqual({ amount: '75.00', currency: 'BRL' });

    // Saldo final deve ser exatamente 75.00 e apenas 1 débito no ledger (além da abertura)
    const ledgerEntries = await em.fork().find(WalletLedgerEntry, { wallet: { id: walletId } as any });
    // 1 abertura + 1 bet = 2 entradas
    expect(ledgerEntries.length).toBe(2);
  });
});
