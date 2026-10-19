import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { MikroORM, EntityManager } from '@mikro-orm/postgresql';
import config from '../../../mikro-orm.config.js';
import { WageringService } from '../../../src/application/services/wagering.service.js';
import { Money } from '../../../src/domain/value-objects/money.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../src/domain/entities/wager-transaction.js';
import { FailureCode } from '../../../src/domain/errors/wager-transaction.error.js';
import { payloadHashOf } from '../../../src/domain/services/canonical-json.js';

/**
 * Concorrência com PARALELISMO REAL.
 *
 * Cada operação roda em `new WageringService(orm.em.fork())` — um
 * EntityManager independente, simulando "processos/instâncias separados".
 * Se todos compartilhassem o mesmo `em`, o MikroORM serializaria
 * internamente e o teste NÃO mediria concorrência real.
 */
describe('Concorrência — paralelismo real (múltiplas instâncias)', () => {
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

  function submitFromFork(req: Parameters<WageringService['submitTransaction']>[0]) {
    return new WageringService(orm.em.fork()).submitTransaction(req);
  }

  it('1. 50 requests paralelos com MESMA idempotencyKey → 1 PROCESSED + 49 replays', async () => {
    const playerId = crypto.randomUUID();
    const { walletId } = await service.createWallet({
      playerId,
      initialBalance: Money.from({ amount: '500.00', currency: 'BRL' }),
    });

    const dto = {
      providerId: 'prov-1',
      externalTransactionId: 'bet-parallel-50x',
      idempotencyKey: 'prov-1:bet-parallel-50x',
      playerId,
      walletId,
      roundId: 'round-parallel',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '30.00', currency: 'BRL' }),
      payloadHash: payloadHashOf({ action: 'bet-parallel-50x' }),
    };

    // ⚠️ `Array.from` cria 50 promessas que disparam ANTES do primeiro `await`.
    // Isso força 50 forks a disputarem o `PESSIMISTIC_WRITE` simultaneamente.
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () => submitFromFork(dto)),
    );

    const rejected = results.filter((r) => r.status === 'rejected');
    const processed = results.filter(
      (r) => r.status === 'fulfilled' && r.value.idempotentReplay === false,
    );
    const replays = results.filter(
      (r) => r.status === 'fulfilled' && r.value.idempotentReplay === true,
    );

    expect(rejected.length).toBe(0);
    expect(processed.length).toBe(1);
    expect(replays.length).toBe(49);

    // Todas as respostas apontam para a MESMA transação → sem duplicação
    const txIds = new Set(
      results
        .filter(
          (r): r is PromiseFulfilledResult<{ transactionId: string }> =>
            r.status === 'fulfilled',
        )
        .map((r) => r.value.transactionId),
    );
    expect(txIds.size).toBe(1);

    // Estado: apenas 1 débito no ledger
    const rec = await service.reconcileWallet(walletId);
    expect(rec.storedBalance.toJSON()).toEqual({ amount: '470.00', currency: 'BRL' });
    expect(rec.checkedEntries).toBe(2); // opening + 1 bet
    expect(rec.consistent).toBe(true);
  });

  it('2. 5 wallets distintas × 10 ops cada, TODAS paralelas → sem cross-contamination', async () => {
    const N = 5;
    const M = 10;

    // Cria wallets em série (setup, não é o que está sendo testado).
    const wallets: Array<{ playerId: string; walletId: string }> = [];
    for (let i = 0; i < N; i++) {
      const playerId = crypto.randomUUID();
      const { walletId } = await service.createWallet({
        playerId,
        initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
      });
      wallets.push({ playerId, walletId });
    }

    // 50 operações: 5 wallets × 10 bets de 10.00
    const ops = wallets.flatMap((w, walletIdx) =>
      Array.from({ length: M }, (_, opIdx) => ({
        providerId: 'prov-1',
        externalTransactionId: `bet-w${walletIdx}-op${opIdx}`,
        idempotencyKey: `prov-1:bet-w${walletIdx}-op${opIdx}`,
        playerId: w.playerId,
        walletId: w.walletId,
        roundId: `round-w${walletIdx}`,
        gameId: 'slot-1',
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: '10.00', currency: 'BRL' }),
        payloadHash: payloadHashOf({ wallet: walletIdx, op: opIdx }),
      })),
    );

    const results = await Promise.allSettled(ops.map((op) => submitFromFork(op)));

    const rejected = results.filter((r) => r.status === 'rejected');
    const processed = results.filter(
      (r) =>
        r.status === 'fulfilled' &&
        r.value.status === WagerTransactionStatus.Processed,
    );

    expect(rejected.length).toBe(0);
    expect(processed.length).toBe(N * M); // 50

    // Cada wallet: 100 - 10*10 = 0 exatos
    for (const w of wallets) {
      const rec = await service.reconcileWallet(w.walletId);
      expect(rec.storedBalance.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
      expect(rec.checkedEntries).toBe(M + 1); // opening + M bets
      expect(rec.consistent).toBe(true);
    }
  });

  it('3. 3 "instâncias" simultâneas sobre a MESMA wallet → serialização correta', async () => {
    const playerId = crypto.randomUUID();
    const { walletId } = await service.createWallet({
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    const make = (n: number) => ({
      providerId: 'prov-1',
      externalTransactionId: `bet-3i-${n}`,
      idempotencyKey: `prov-1:bet-3i-${n}`,
      playerId,
      walletId,
      roundId: 'round-3i',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '40.00', currency: 'BRL' }),
      payloadHash: payloadHashOf({ inst: n }),
    });

    const results = await Promise.allSettled([
      submitFromFork(make(1)),
      submitFromFork(make(2)),
      submitFromFork(make(3)),
    ]);

    const processed = results.filter(
      (r): r is PromiseFulfilledResult<any> =>
        r.status === 'fulfilled' && r.value.status === WagerTransactionStatus.Processed,
    );
    const rejected = results.filter(
      (r): r is PromiseFulfilledResult<any> =>
        r.status === 'fulfilled' && r.value.status === WagerTransactionStatus.Rejected,
    );

    expect(processed.length).toBe(2);
    expect(rejected.length).toBe(1);
    expect(rejected[0].value.failureCode).toBe(FailureCode.InsufficientFunds);

    const rec = await service.reconcileWallet(walletId);
    expect(rec.storedBalance.toJSON()).toEqual({ amount: '20.00', currency: 'BRL' });
    expect(rec.checkedEntries).toBe(3); // opening + 2 bets
    expect(rec.consistent).toBe(true);
  });
});
