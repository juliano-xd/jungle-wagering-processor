import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { MikroORM, EntityManager } from '@mikro-orm/postgresql';
import config from '../../mikro-orm.config.js';
import { WageringService } from '../../src/application/services/wagering.service.js';
import { Money } from '../../src/domain/value-objects/money.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/entities/wager-transaction.js';
import { payloadHashOf } from '../../src/domain/services/canonical-json.js';

/**
 * E2E do cenário 13.7 do edital:
 *   "ROLLBACK entregue antes da referência → PENDING_REFERENCE →
 *    quando referência chega, reprocessamento resolve."
 *
 * Tradução determinística de `scripts/test-out-of-order.sh`. Em vez de
 * `sleep 8` + `sleep 15`, aciona `service.retryPendingReference(id)`
 * diretamente — o mesmo método que o worker chama em produção. Roda em
 * ~1s em vez de 23s do script shell.
 *
 * Não usa HTTP: o que o shell testava era o *fluxo completo via API*, mas o
 * núcleo do comportamento está em `WageringService` + `PendingReferenceWorker`.
 * Os shells continuam disponíveis para smoke manual; este teste é o que
 * roda no CI.
 */
describe('E2E — cenário 13.7 (out-of-order delivery)', () => {
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

  it('1/5 Wallet abre com 100.00 e version 1', async () => {
    const playerId = crypto.randomUUID();
    const result = await service.createWallet({
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    expect(result.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(result.version).toBe(1);
  });

  it('2/5 ROLLBACK antes do WIN → PENDING_REFERENCE, saldo inalterado', async () => {
    const { playerId, walletId } = await openWallet(service, '100.00');

    const res = await service.submitTransaction({
      providerId: 'prov-1',
      externalTransactionId: 'rollback-early',
      idempotencyKey: 'prov-1:rollback-early',
      playerId,
      walletId,
      roundId: 'round-oos',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Rollback,
      money: Money.from({ amount: '30.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'win-not-arrived-yet',
      payloadHash: payloadHashOf({ action: 'rollback-before-win' }),
    });

    expect(res.status).toBe(WagerTransactionStatus.PendingReference);
    expect(res.balanceAfter.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(res.idempotentReplay).toBe(false);
  });

  it('3/5 worker em PENDING_REFERENCE mantém estado, saldo inalterado', async () => {
    const { playerId, walletId } = await openWallet(service, '100.00');
    const tx = await service.submitTransaction({
      providerId: 'prov-1',
      externalTransactionId: 'rollback-early',
      idempotencyKey: 'prov-1:rollback-early',
      playerId,
      walletId,
      roundId: 'round-oos',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Rollback,
      money: Money.from({ amount: '30.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'win-not-arrived-yet',
      payloadHash: payloadHashOf({ action: 'rollback-before-win' }),
    });

    const outcome = await service.retryPendingReference(tx.transactionId);
    expect(outcome).toBe('pending');

    const rec = await service.reconcileWallet(walletId);
    expect(rec.storedBalance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(rec.checkedEntries).toBe(1); // só a OPENING
  });

  it('4/5 WIN chega → PROCESSED, saldo 130.00', async () => {
    const { playerId, walletId } = await openWallet(service, '100.00');

    // Rollback pendente
    await service.submitTransaction({
      providerId: 'prov-1',
      externalTransactionId: 'rollback-early',
      idempotencyKey: 'prov-1:rollback-early',
      playerId,
      walletId,
      roundId: 'round-oos',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Rollback,
      money: Money.from({ amount: '30.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'win-not-arrived-yet',
      payloadHash: payloadHashOf({ action: 'rollback-before-win' }),
    });

    // WIN chega com o externalTransactionId que o ROLLBACK apontava
    const win = await service.submitTransaction({
      providerId: 'prov-1',
      externalTransactionId: 'win-not-arrived-yet',
      idempotencyKey: 'prov-1:win-1',
      playerId,
      walletId,
      roundId: 'round-oos',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Win,
      money: Money.from({ amount: '30.00', currency: 'BRL' }),
      payloadHash: payloadHashOf({ action: 'win-after-rollback' }),
    });

    expect(win.status).toBe(WagerTransactionStatus.Processed);
    expect(win.balanceAfter.toJSON()).toEqual({ amount: '130.00', currency: 'BRL' });
  });

  it('5/5 worker resolve ROLLBACK pendente → saldo 100.00, version 3, ledger consistente', async () => {
    const { playerId, walletId } = await openWallet(service, '100.00');

    const rb = await service.submitTransaction({
      providerId: 'prov-1',
      externalTransactionId: 'rollback-early',
      idempotencyKey: 'prov-1:rollback-early',
      playerId,
      walletId,
      roundId: 'round-oos',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Rollback,
      money: Money.from({ amount: '30.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'win-not-arrived-yet',
      payloadHash: payloadHashOf({ action: 'rollback-before-win' }),
    });

    // Worker roda 1x → pending (WIN ainda não chegou)
    expect(await service.retryPendingReference(rb.transactionId)).toBe('pending');

    // WIN chega
    await service.submitTransaction({
      providerId: 'prov-1',
      externalTransactionId: 'win-not-arrived-yet',
      idempotencyKey: 'prov-1:win-1',
      playerId,
      walletId,
      roundId: 'round-oos',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Win,
      money: Money.from({ amount: '30.00', currency: 'BRL' }),
      payloadHash: payloadHashOf({ action: 'win-after-rollback' }),
    });

    // Worker roda de novo → PROCESSED (ROLLBACK reverte o WIN)
    expect(await service.retryPendingReference(rb.transactionId)).toBe('processed');

    // Estado final
    em.clear();
    const wallet = await service.getWallet(walletId);
    expect(wallet).not.toBeNull();
    expect(wallet!.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(wallet!.version).toBe(3); // opening → win → rollback

    // Ledger: 3 entradas balanceadas
    const ledger = await service.listLedger(walletId, undefined, 50);
    expect(ledger.entries.length).toBe(3);

    const [debitRb, creditWin, creditOpening] = ledger.entries;
    // mais recente primeiro (DESC)
    expect(debitRb.direction).toBe('DEBIT');
    expect(debitRb.money.toJSON()).toEqual({ amount: '30.00', currency: 'BRL' });
    expect(debitRb.balanceBefore.toJSON()).toEqual({ amount: '130.00', currency: 'BRL' });
    expect(debitRb.balanceAfter.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });

    expect(creditWin.direction).toBe('CREDIT');
    expect(creditWin.money.toJSON()).toEqual({ amount: '30.00', currency: 'BRL' });
    expect(creditWin.balanceBefore.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(creditWin.balanceAfter.toJSON()).toEqual({ amount: '130.00', currency: 'BRL' });

    expect(creditOpening.direction).toBe('CREDIT');
    expect(creditOpening.money.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(creditOpening.balanceBefore.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(creditOpening.balanceAfter.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });

    // Reconciliação: stored = calculated
    const rec = await service.reconcileWallet(walletId);
    expect(rec.consistent).toBe(true);
    expect(rec.storedBalance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
  });
});

// ---------------------------------------------------------------------------
async function openWallet(
  service: WageringService,
  initialBalance: string,
): Promise<{ playerId: string; walletId: string }> {
  const playerId = crypto.randomUUID();
  const { walletId } = await service.createWallet({
    playerId,
    initialBalance: Money.from({ amount: initialBalance, currency: 'BRL' }),
  });
  return { playerId, walletId };
}
