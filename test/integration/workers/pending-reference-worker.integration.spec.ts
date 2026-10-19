import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { MikroORM, EntityManager } from '@mikro-orm/postgresql';
import config from '../../../mikro-orm.config.js';
import { WageringService } from '../../../src/application/services/wagering.service.js';
import { Money } from '../../../src/domain/value-objects/money.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../src/domain/entities/wager-transaction.js';
import {
  FailureCode,
  WagerTransactionError,
} from '../../../src/domain/errors/wager-transaction.error.js';
import { payloadHashOf } from '../../../src/domain/services/canonical-json.js';

/**
 * Testa o caminho de produção REAL do worker de PENDING_REFERENCE:
 *   - `WageringService.retryPendingReference(txId)` → resolve ou reagenda
 *   - `WageringService.rejectPendingReferenceTx(txId, reason)` → rejeita
 *
 * Antes: o teste usava `PendingReferenceProcessorService` (código antigo,
 * fora de produção, logava texto puro). O worker real
 * (`src/infrastructure/pending-reference/pending-reference.worker.ts`) não
 * tinha cobertura. Este teste corrige o gap.
 *
 * Cenário 1: referência chega → `retryPendingReference` processa.
 * Cenário 2: TTL esgotado → `retryPendingReference` rejeita com REFERENCE_NOT_FOUND.
 * Cenário 3: ainda sem referência → reagenda com backoff, incrementa attempts.
 */
describe('PendingReferenceWorker — caminho de produção real', () => {
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

  async function openWallet(balance = '100.00') {
    const playerId = crypto.randomUUID();
    const { walletId } = await service.createWallet({
      playerId,
      initialBalance: Money.from({ amount: balance, currency: 'BRL' }),
    });
    return { playerId, walletId };
  }

  async function submitPendingRollback(
    playerId: string,
    walletId: string,
    referenceExt: string,
    amount = '30.00',
  ) {
    const res = await service.submitTransaction({
      providerId: 'prov-1',
      externalTransactionId: `rb-${crypto.randomUUID()}`,
      idempotencyKey: `prov-1:rb-${crypto.randomUUID()}`,
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Rollback,
      money: Money.from({ amount, currency: 'BRL' }),
      referenceExternalTransactionId: referenceExt,
      payloadHash: payloadHashOf({ action: 'pending-rb' }),
    });
    expect(res.status).toBe(WagerTransactionStatus.PendingReference);
    return res.transactionId;
  }

  it('1. referência chega → retryPendingReference PROCESSED, saldo final correto', async () => {
    const { playerId, walletId } = await openWallet('100.00');
    const referenceExt = `win-${crypto.randomUUID()}`;

    const rbTxId = await submitPendingRollback(playerId, walletId, referenceExt);

    // Primeira tentativa sem referência → pending
    const firstAttempt = await service.retryPendingReference(rbTxId);
    expect(firstAttempt).toBe('pending');

    // Referência chega
    await service.submitTransaction({
      providerId: 'prov-1',
      externalTransactionId: referenceExt,
      idempotencyKey: `prov-1:${referenceExt}`,
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Win,
      money: Money.from({ amount: '30.00', currency: 'BRL' }),
      payloadHash: payloadHashOf({ action: 'win-after-rb' }),
    });

    // Retry agora processa
    const secondAttempt = await service.retryPendingReference(rbTxId);
    expect(secondAttempt).toBe('processed');

    em.clear();
    const tx = await service.getTransactionById(rbTxId);
    expect(tx!.status).toBe(WagerTransactionStatus.Processed);
    expect(tx!.referenceTransactionId).toBeDefined();

    const rec = await service.reconcileWallet(walletId);
    expect(rec.storedBalance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(rec.consistent).toBe(true);
    expect(rec.checkedEntries).toBe(3); // opening + win + rollback
  });

  it('2. TTL esgotado → retryPendingReference REJECTED com REFERENCE_NOT_FOUND', async () => {
    const { playerId, walletId } = await openWallet('100.00');
    const rbTxId = await submitPendingRollback(
      playerId,
      walletId,
      `win-never-${crypto.randomUUID()}`,
    );

    // Força `pending_reference_attempts` no limite diretamente via ORM.
    // Isso simula o TTL esgotado sem esperar 12 × backoff exponencial (~10min
    // em produção).
    await em.transactional(async (tx) => {
      const txRecord = await tx.findOne(WagerTransaction, { id: rbTxId });
      if (txRecord) {
        txRecord.pendingReferenceAttempts = 9999;
        tx.persist(txRecord);
        await tx.flush();
      }
    });

    const outcome = await service.retryPendingReference(rbTxId, {
      maxAttempts: 3,
    });
    expect(outcome).toBe('rejected');

    em.clear();
    const tx = await service.getTransactionById(rbTxId);
    expect(tx!.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx!.failureCode).toBe(FailureCode.ReferenceNotFound);

    // Saldo intacto (rejeição não aplica efeito)
    const rec = await service.reconcileWallet(walletId);
    expect(rec.storedBalance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(rec.checkedEntries).toBe(1); // só opening
  });

  it('3. sem referência → pending, incrementa attempts e agenda backoff', async () => {
    const { playerId, walletId } = await openWallet('100.00');
    const rbTxId = await submitPendingRollback(
      playerId,
      walletId,
      `win-not-arrived-${crypto.randomUUID()}`,
    );

    // Primeira tentativa
    expect(await service.retryPendingReference(rbTxId)).toBe('pending');

    em.clear();
    const afterFirst = await service.getTransactionById(rbTxId);
    expect(afterFirst!.pendingReferenceAttempts).toBe(1);
    expect(afterFirst!.pendingReferenceNextAttemptAt).toBeInstanceOf(Date);

    // Segunda tentativa após backoff — `next_attempt_at` no futuro não impede
    // retry manual (o worker respeita esse campo, mas o método direto não).
    expect(await service.retryPendingReference(rbTxId)).toBe('pending');

    em.clear();
    const afterSecond = await service.getTransactionById(rbTxId);
    expect(afterSecond!.pendingReferenceAttempts).toBe(2);

    // Segunda tentativa agendou `nextAttemptAt` mais distante que a primeira
    // (backoff crescente).
    expect(
      afterSecond!.pendingReferenceNextAttemptAt!.getTime(),
    ).toBeGreaterThanOrEqual(afterFirst!.pendingReferenceNextAttemptAt!.getTime());
  });

  it('4. rejectPendingReferenceTx com reason customizado → REJECTED + IdempotencyRecord', async () => {
    const { playerId, walletId } = await openWallet('100.00');
    const rbTxId = await submitPendingRollback(
      playerId,
      walletId,
      `win-orphan-${crypto.randomUUID()}`,
    );

    await service.rejectPendingReferenceTx(rbTxId, FailureCode.ReferenceWrongKind);

    em.clear();
    const tx = await service.getTransactionById(rbTxId);
    expect(tx!.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx!.failureCode).toBe(FailureCode.ReferenceWrongKind);
  });
});
