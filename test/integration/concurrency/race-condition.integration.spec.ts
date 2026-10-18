import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { MikroORM, EntityManager } from '@mikro-orm/postgresql';
import config from '../../../mikro-orm.config';
import { WageringService } from '../../../src/application/services/wagering.service';
import { Money } from '../../../src/domain/value-objects/money';
import { WagerTransactionKind, WagerTransactionStatus } from '../../../src/domain/entities/wager-transaction';
import { FailureCode } from '../../../src/domain/errors/wager-transaction.error';
import { payloadHashOf } from '../../../src/domain/services/canonical-json';
import { OutboxMessage } from '../../../src/domain/entities/outbox-message';

describe('Eliminatórios — Concorrência Real e Invariantes Invisíveis', () => {
  let orm: MikroORM;
  let em: EntityManager;
  let service: WageringService;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
    // Migrations devem estar aplicadas via CLI antes dos testes
    // (`bun run mikro-orm migration:up`). A API `getMigrator()` varia entre
    // versões do MikroORM; tentamos ambas as formas conhecidas e caímos em
    // no-op se nenhuma existir — os testes assumem DB já migrado.
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
      // Migrations já aplicadas via CLI.
    }
  });

  afterAll(async () => {
    await orm.close();
  });

  beforeEach(async () => {
    em = orm.em.fork();
    service = new WageringService(em);
    const conn = em.getConnection();
    await conn.execute(
      'TRUNCATE TABLE "outbox_messages", "idempotency_records", "inbox_messages", "wallet_ledger_entries", "wager_transactions", "wallets" CASCADE;',
    );
    em.clear();
  });

  // -----------------------------------------------------------------
  // FALHA ELIMINATÓRIA: number/float/double para dinheiro
  // -----------------------------------------------------------------
  it('não usa number/float/double para dinheiro no schema (colunas são NUMERIC(18,2))', async () => {
    const conn = em.getConnection();
    const col = await conn.execute(
      `SELECT data_type, numeric_precision, numeric_scale
       FROM information_schema.columns
       WHERE table_name = 'wallets' AND column_name = 'balance_amount'`,
    );
    expect(col.length).toBeGreaterThan(0);
    expect(col[0].data_type).toBe('numeric');
    expect(Number(col[0].numeric_scale)).toBe(2);
    expect(Number(col[0].numeric_precision)).toBe(18);
  });

  it('não usa number/float/double para dinheiro nas colunas do ledger (NUMERIC)', async () => {
    const conn = em.getConnection();
    const cols = await conn.execute(
      `SELECT column_name, data_type, numeric_precision, numeric_scale
       FROM information_schema.columns
       WHERE table_name = 'wallet_ledger_entries'
       AND column_name IN ('money_amount','balance_before_amount','balance_after_amount')`,
    );
    expect(cols.length).toBe(3);
    for (const c of cols) {
      expect(c.data_type).toBe('numeric');
      expect(Number(c.numeric_scale)).toBe(2);
      expect(Number(c.numeric_precision)).toBe(18);
    }
  });

  it('não usa number/float/double para dinheiro nas colunas do wager_transactions (NUMERIC)', async () => {
    const conn = em.getConnection();
    const cols = await conn.execute(
      `SELECT column_name, data_type, numeric_precision, numeric_scale
       FROM information_schema.columns
       WHERE table_name = 'wager_transactions'
       AND column_name IN ('money_amount')`,
    );
    expect(cols.length).toBe(1);
    expect(cols[0].data_type).toBe('numeric');
    expect(Number(cols[0].numeric_scale)).toBe(2);
    expect(Number(cols[0].numeric_precision)).toBe(18);
  });

  // -----------------------------------------------------------------
  // FALHA ELIMINATÓRIA: idempotência apenas em memória
  // -----------------------------------------------------------------
  it('idempotência é persistente: IdempotencyRecord gravado no banco, não apenas em memória', async () => {
    const playerId = crypto.randomUUID();
    const { walletId } = await service.createWallet({
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    const txDto = {
      providerId: 'prov-1',
      externalTransactionId: 'tx-persist-idem',
      idempotencyKey: 'prov-1:tx-persist-idem',
      playerId,
      walletId,
      roundId: 'round-idem',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '20.00', currency: 'BRL' }),
      payloadHash: payloadHashOf({ action: 'persist-idem' }),
    };

    await service.submitTransaction(txDto);

    const conn = em.getConnection();
    const rows = await conn.execute(
      `SELECT idempotency_key, payload_hash, status
       FROM "idempotency_records"
       WHERE idempotency_key = '${txDto.idempotencyKey.replace(/'/g, "''")}'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].idempotency_key).toBe(txDto.idempotencyKey);
    expect(rows[0].status).toBe(WagerTransactionStatus.Processed);
  });

  it('idempotência sobrevive a restart: registro persiste e replay funciona após limpar memória', async () => {
    const playerId = crypto.randomUUID();
    const { walletId } = await service.createWallet({
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    const txDto = {
      providerId: 'prov-1',
      externalTransactionId: 'tx-restart-idem',
      idempotencyKey: 'prov-1:tx-restart-idem',
      playerId,
      walletId,
      roundId: 'round-restart',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '20.00', currency: 'BRL' }),
      payloadHash: payloadHashOf({ action: 'restart-idem' }),
    };

    const em1 = orm.em.fork();
    const svc1 = new WageringService(em1);
    const first = await svc1.submitTransaction(txDto);
    expect(first.status).toBe(WagerTransactionStatus.Processed);

    const em2 = orm.em.fork();
    const svc2 = new WageringService(em2);
    const second = await svc2.submitTransaction(txDto);
    expect(second.idempotentReplay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(second.balanceAfter.toJSON()).toEqual({ amount: '80.00', currency: 'BRL' });

    em2.clear();
    const rec = await svc2.reconcileWallet(walletId);
    expect(rec.storedBalance.toJSON()).toEqual({ amount: '80.00', currency: 'BRL' });
    expect(rec.checkedEntries).toBe(2);
  });

  // -----------------------------------------------------------------
  // FALHA ELIMINATÓRIA: evento publicado antes do commit
  // -----------------------------------------------------------------
  it('evento não é publicado antes do commit: rollback do submit não deixa evento novo na outbox', async () => {
    const playerId = crypto.randomUUID();
    const { walletId } = await service.createWallet({
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    // A criação da wallet publica eventos da OPENING (comportamento correto,
    // spec 11). Testamos que o ROLLBACK do submit NÃO deixa eventos NOVOS.
    const beforeEm = orm.em.fork();
    const before = await beforeEm.find(OutboxMessage, {});

    const forkEm2 = orm.em.fork();
    await forkEm2
      .transactional(async (tx) => {
        const svc = new WageringService(tx);
        await svc.submitTransaction({
          providerId: 'prov-1',
          externalTransactionId: 'tx-rollback-publish',
          idempotencyKey: 'prov-1:tx-rollback-publish',
          playerId,
          walletId,
          roundId: 'round-rollback-pub',
          gameId: 'slot-1',
          kind: WagerTransactionKind.Bet,
          money: Money.from({ amount: '50.00', currency: 'BRL' }),
          payloadHash: payloadHashOf({ action: 'rollback-pub' }),
        });
        throw new Error('rollback antes do commit');
      })
      .catch(() => {});

    const afterEm = orm.em.fork();
    const after = await afterEm.find(OutboxMessage, {});
    expect(after.length).toBe(before.length);
  });

  // -----------------------------------------------------------------
  // FALHA ELIMINATÓRIA: ledger pode ser update/delete
  // -----------------------------------------------------------------
  it('ledger é imutável: UPDATE é rejeitado pelo trigger do banco', async () => {
    const playerId = crypto.randomUUID();
    const { walletId } = await service.createWallet({
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    await service.submitTransaction({
      providerId: 'prov-1',
      externalTransactionId: 'bet-for-immutable',
      idempotencyKey: 'prov-1:bet-for-immutable',
      playerId,
      walletId,
      roundId: 'round-immutable',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '20.00', currency: 'BRL' }),
      payloadHash: payloadHashOf({ action: 'immutable' }),
    });

    const conn = em.getConnection();
    let updateError: Error | null = null;
    try {
      await conn.execute(
        `UPDATE "wallet_ledger_entries" SET money_amount = '999.99' WHERE wallet_id = '${walletId}'`,
      );
    } catch (e: any) {
      updateError = e;
    }
    expect(updateError).toBeInstanceOf(Error);
    expect(updateError?.message).toContain('immutable');
    expect(updateError?.message).toContain('cannot be updated or deleted');
  });

  it('ledger é imutável: DELETE é rejeitado pelo trigger do banco', async () => {
    const playerId = crypto.randomUUID();
    const { walletId } = await service.createWallet({
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    await service.submitTransaction({
      providerId: 'prov-1',
      externalTransactionId: 'bet-for-delete',
      idempotencyKey: 'prov-1:bet-for-delete',
      playerId,
      walletId,
      roundId: 'round-delete',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '20.00', currency: 'BRL' }),
      payloadHash: payloadHashOf({ action: 'delete-test' }),
    });

    const conn = em.getConnection();
    let deleteError: Error | null = null;
    try {
      await conn.execute(
        `DELETE FROM "wallet_ledger_entries" WHERE wallet_id = '${walletId}'`,
      );
    } catch (e: any) {
      deleteError = e;
    }
    expect(deleteError).toBeInstanceOf(Error);
    expect(deleteError?.message).toContain('immutable');
    expect(deleteError?.message).toContain('cannot be updated or deleted');
  });

  // -----------------------------------------------------------------
  // FALHA ELIMINATÓRIA: saldo calculado sem lock
  // -----------------------------------------------------------------
  it('saldo não é calculado via read→calculate→write sem lock: usa PESSIMISTIC_WRITE', async () => {
    const playerId = crypto.randomUUID();
    const { walletId } = await service.createWallet({
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    const svcA = new WageringService(orm.em.fork());
    const svcB = new WageringService(orm.em.fork());

    const betA = svcA.submitTransaction({
      providerId: 'prov-1',
      externalTransactionId: 'bet-lock-1',
      idempotencyKey: 'prov-1:bet-lock-1',
      playerId,
      walletId,
      roundId: 'round-lock',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '60.00', currency: 'BRL' }),
      payloadHash: payloadHashOf({ action: 'lock-1' }),
    });
    const betB = svcB.submitTransaction({
      providerId: 'prov-1',
      externalTransactionId: 'bet-lock-2',
      idempotencyKey: 'prov-1:bet-lock-2',
      playerId,
      walletId,
      roundId: 'round-lock',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '60.00', currency: 'BRL' }),
      payloadHash: payloadHashOf({ action: 'lock-2' }),
    });

    const results = await Promise.allSettled([betA, betB]);

    const accepted = results.filter(
      (r) => r.status === 'fulfilled' && r.value.status === WagerTransactionStatus.Processed,
    );
    const rejected = results.filter(
      (r) => r.status === 'fulfilled' && r.value.status === WagerTransactionStatus.Rejected,
    );

    expect(accepted.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseFulfilledResult<any>).value.failureCode).toBe(
      FailureCode.InsufficientFunds,
    );

    em.clear();
    const rec = await service.reconcileWallet(walletId);
    expect(rec.storedBalance.toJSON()).toEqual({ amount: '40.00', currency: 'BRL' });
    expect(rec.consistent).toBe(true);
    expect(rec.checkedEntries).toBe(2);
  });

  // -----------------------------------------------------------------
  // CENÁRIO OBRIGATÓRIO (seção 8): duas apostas disputando saldo
  // -----------------------------------------------------------------
  it('cenário seção 8: saldo inicial 100.00, duas apostas de 80.00 simultâneas → 1 PROCESSED + 1 REJECTED, saldo final 20.00, 1 débito no ledger', async () => {
    const playerId = crypto.randomUUID();
    const { walletId } = await service.createWallet({
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    const svcA = new WageringService(orm.em.fork());
    const svcB = new WageringService(orm.em.fork());

    const betA = svcA.submitTransaction({
      providerId: 'prov-1',
      externalTransactionId: 'bet-80-a',
      idempotencyKey: 'prov-1:bet-80-a',
      playerId,
      walletId,
      roundId: 'round-80',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '80.00', currency: 'BRL' }),
      payloadHash: payloadHashOf({ action: 'bet-80-a' }),
    });
    const betB = svcB.submitTransaction({
      providerId: 'prov-1',
      externalTransactionId: 'bet-80-b',
      idempotencyKey: 'prov-1:bet-80-b',
      playerId,
      walletId,
      roundId: 'round-80',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '80.00', currency: 'BRL' }),
      payloadHash: payloadHashOf({ action: 'bet-80-b' }),
    });

    const results = await Promise.allSettled([betA, betB]);

    const processed = results.filter(
      (r) => r.status === 'fulfilled' && r.value.status === WagerTransactionStatus.Processed,
    );
    const rejected = results.filter(
      (r) => r.status === 'fulfilled' && r.value.status === WagerTransactionStatus.Rejected,
    );

    expect(processed.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseFulfilledResult<any>).value.failureCode).toBe(
      FailureCode.InsufficientFunds,
    );

    em.clear();
    const rec = await service.reconcileWallet(walletId);
    expect(rec.storedBalance.toJSON()).toEqual({ amount: '20.00', currency: 'BRL' });
    expect(rec.consistent).toBe(true);
    expect(rec.checkedEntries).toBe(2);
  });

  // -----------------------------------------------------------------
  // CENÁRIO OBRIGATÓRIO: mesma aposta 50 vezes → 1 débito
  // -----------------------------------------------------------------
  it('cenário seção 13: mesma aposta enviada 50 vezes → 1 único débito (idempotência persistente)', async () => {
    const playerId = crypto.randomUUID();
    const { walletId } = await service.createWallet({
      playerId,
      initialBalance: Money.from({ amount: '500.00', currency: 'BRL' }),
    });

    const betDto = {
      providerId: 'prov-1',
      externalTransactionId: 'bet-50x',
      idempotencyKey: 'prov-1:bet-50x',
      playerId,
      walletId,
      roundId: 'round-50x',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '30.00', currency: 'BRL' }),
      payloadHash: payloadHashOf({ action: '50x-same' }),
    };

    const results: Awaited<ReturnType<typeof service.submitTransaction>>[] = [];
    for (let i = 0; i < 50; i++) {
      results.push(await service.submitTransaction(betDto));
    }

    expect(results.length).toBe(50);
    const firstNonReplay = results.find((r) => r.idempotentReplay === false);
    expect(firstNonReplay).toBeDefined();
    expect(firstNonReplay!.balanceAfter.toJSON()).toEqual({
      amount: '470.00',
      currency: 'BRL',
    });

    em.clear();
    const rec = await service.reconcileWallet(walletId);
    expect(rec.storedBalance.toJSON()).toEqual({ amount: '470.00', currency: 'BRL' });
    expect(rec.consistent).toBe(true);
    expect(rec.checkedEntries).toBe(2);
  });

  // -----------------------------------------------------------------
  // CENÁRIO OBRIGATÓRIO: ROLLBACK antes da referência
  // -----------------------------------------------------------------
  it('cenário seção 13.7: ROLLBACK entregue antes da referência → PENDING_REFERENCE → quando referência chega, reprocessamento resolve', async () => {
    const playerId = crypto.randomUUID();
    const { walletId } = await service.createWallet({
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    const rollbackDto = {
      providerId: 'prov-1',
      externalTransactionId: 'rb-before-win',
      idempotencyKey: 'prov-1:rb-before-win',
      playerId,
      walletId,
      roundId: 'round-out-of-order',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Rollback,
      money: Money.from({ amount: '30.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'win-not-arrived-yet',
      payloadHash: payloadHashOf({ action: 'rb-oos' }),
    };

    const firstAttempt = await service.submitTransaction(rollbackDto);
    expect(firstAttempt.status).toBe(WagerTransactionStatus.PendingReference);
    expect(firstAttempt.idempotentReplay).toBe(false);

    em.clear();
    let rec = await service.reconcileWallet(walletId);
    expect(rec.storedBalance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(rec.checkedEntries).toBe(1);

    const winDto = {
      providerId: 'prov-1',
      externalTransactionId: 'win-not-arrived-yet',
      idempotencyKey: 'prov-1:win-after-rb',
      playerId,
      walletId,
      roundId: 'round-out-of-order',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Win,
      money: Money.from({ amount: '30.00', currency: 'BRL' }),
      payloadHash: payloadHashOf({ action: 'win-oos' }),
    };

    const winResult = await service.submitTransaction(winDto);
    expect(winResult.status).toBe(WagerTransactionStatus.Processed);
    expect(winResult.balanceAfter.toJSON()).toEqual({ amount: '130.00', currency: 'BRL' });

    em.clear();
    rec = await service.reconcileWallet(walletId);
    expect(rec.storedBalance.toJSON()).toEqual({ amount: '130.00', currency: 'BRL' });
    expect(rec.checkedEntries).toBe(2);

    const workerEm = orm.em.fork();
    const workerSvc = new WageringService(workerEm);
    const rbResult = await workerSvc.submitTransaction(rollbackDto);
    expect(rbResult.status).toBe(WagerTransactionStatus.Processed);
    expect(rbResult.balanceAfter.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });

    workerEm.clear();
    rec = await workerSvc.reconcileWallet(walletId);
    expect(rec.storedBalance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(rec.consistent).toBe(true);
    expect(rec.checkedEntries).toBe(3);
  });
});
