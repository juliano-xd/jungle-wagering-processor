import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { MikroORM, EntityManager } from '@mikro-orm/postgresql';
import config from '../../../mikro-orm.config';
import { WageringService } from '../../../src/application/services/wagering.service';
import { PendingReferenceWorker } from '../../../src/infrastructure/workers/pending-reference-processor.service';
import { Money } from '../../../src/domain/value-objects/money';
import { WagerTransactionKind, WagerTransactionStatus, WagerTransaction } from '../../../src/domain/entities/wager-transaction';
import { Wallet } from '../../../src/domain/entities/wallet';
import { FailureCode } from '../../../src/domain/errors/wager-transaction.error';
import { payloadHashOf } from '../../../src/domain/services/canonical-json';

describe('PendingReferenceWorker (Integration & TDD)', () => {
  let orm: MikroORM;
  let em: EntityManager;
  let wageringService: WageringService;
  let worker: PendingReferenceWorker;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
    em = orm.em.fork();
    wageringService = new WageringService(em);
  });

  afterAll(async () => {
    await orm.close();
  });

  beforeEach(async () => {
    worker = new PendingReferenceWorker(em, wageringService, {
      maxAttempts: 3,
      pollIntervalMs: 1000,
    });
    const conn = em.getConnection();
    await conn.execute('TRUNCATE TABLE "outbox_messages", "idempotency_records", "inbox_messages", "wallet_ledger_entries", "wager_transactions", "wallets" CASCADE;');
    em.clear();
  });

  it('deve reprocessar transação PENDING_REFERENCE com sucesso após a chegada da transação referenciada', async () => {
    const playerId = crypto.randomUUID();
    const { walletId } = await wageringService.createWallet({
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    // 1. REFUND chega antes da BET -> deve entrar como PENDING_REFERENCE
    const refundRes = await wageringService.submitTransaction({
      providerId: 'prov-pending',
      externalTransactionId: 'refund-early',
      idempotencyKey: 'prov:refund-early',
      playerId,
      walletId,
      roundId: 'round-ooo',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: '40.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'bet-late',
      payloadHash: payloadHashOf({ refund: 'early' }),
    });

    expect(refundRes.status).toBe(WagerTransactionStatus.PendingReference);

    // Saldo da wallet ainda é 100.00 (REFUND pendente não alterou saldo)
    let checkWallet = await em.fork().findOne(Wallet, { id: walletId });
    expect(checkWallet?.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });

    // 2. A BET atrasada finalmente chega e é processada -> saldo vira 60.00
    const betRes = await wageringService.submitTransaction({
      providerId: 'prov-pending',
      externalTransactionId: 'bet-late',
      idempotencyKey: 'prov:bet-late',
      playerId,
      walletId,
      roundId: 'round-ooo',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '40.00', currency: 'BRL' }),
      payloadHash: payloadHashOf({ bet: 'late' }),
    });
    expect(betRes.status).toBe(WagerTransactionStatus.Processed);

    // 3. Worker executa o reprocessamento das referências pendentes
    await worker.processPendingReferences();

    // 4. A transação de REFUND deve ter transicionado para PROCESSED
    const updatedRefund = await em.fork().findOne(WagerTransaction, { id: refundRes.transactionId });
    expect(updatedRefund?.status).toBe(WagerTransactionStatus.Processed);
    expect(updatedRefund?.referenceTransactionId).toBe(betRes.transactionId);

    // 5. O saldo da carteira deve ter sido atualizado com o crédito do refund: 60.00 + 40.00 = 100.00
    checkWallet = await em.fork().findOne(Wallet, { id: walletId });
    expect(checkWallet?.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });

    // 6. Reconciliação perfeita do ledger
    const rec = await wageringService.reconcileWallet(walletId);
    expect(rec.consistent).toBe(true);
    expect(rec.storedBalance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
  });

  it('deve marcar REJECTED com REFERENCE_NOT_FOUND quando esgotar o limite de tentativas', async () => {
    const playerId = crypto.randomUUID();
    const { walletId } = await wageringService.createWallet({
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    // REFUND cuja BET NUNCA chegará
    const refundRes = await wageringService.submitTransaction({
      providerId: 'prov-orphan',
      externalTransactionId: 'refund-orphan',
      idempotencyKey: 'prov:refund-orphan',
      playerId,
      walletId,
      roundId: 'round-orphan',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'bet-never-exists',
      payloadHash: payloadHashOf({ refund: 'orphan' }),
    });

    expect(refundRes.status).toBe(WagerTransactionStatus.PendingReference);

    // Executa o worker até esgotar maxAttempts (configurado como 3)
    await worker.processPendingReferences();
    await worker.processPendingReferences();
    await worker.processPendingReferences();

    const orphanTx = await em.fork().findOne(WagerTransaction, { id: refundRes.transactionId });
    expect(orphanTx?.status).toBe(WagerTransactionStatus.Rejected);
    expect(orphanTx?.failureCode).toBe(FailureCode.ReferenceNotFound);
  });
});
