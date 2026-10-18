import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { MikroORM, EntityManager } from '@mikro-orm/postgresql';
import { LockMode } from '@mikro-orm/core';
import config from '../../../mikro-orm.config.js';

import { Wallet } from '../../domain/entities/wallet.js';
import { WalletLedgerEntry } from '../../domain/entities/wallet-ledger-entry.js';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../domain/entities/wager-transaction.js';
import { Money } from '../../domain/value-objects/money.js';

describe('Database Constraints, Ledger Immutability & Locking', () => {
  let orm: MikroORM;
  let em: EntityManager;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
    em = orm.em.fork();
  });

  afterAll(async () => {
    await orm.close();
  });

  beforeEach(async () => {
    const conn = em.getConnection();
    await conn.execute('TRUNCATE TABLE "wallet_ledger_entries", "wager_transactions", "wallets" CASCADE;');
    em.clear();
  });

  it('deve inserir uma carteira com Money e atualizar seu saldo', async () => {
    const wallet = Wallet.open({
      id: crypto.randomUUID(),
      playerId: crypto.randomUUID(),
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    em.persist(wallet);
    await em.flush();

    const saved = await em.findOne(Wallet, { id: wallet.id });
    expect(saved).toBeDefined();
    expect(saved?.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
  });

  it('deve falhar ao tentar inserir saldo negativo no banco (Constraint CHECK)', async () => {
    const walletId = crypto.randomUUID();
    const playerId = crypto.randomUUID();

    // Tenta violar a constraint chk_balance_non_negative diretamente via SQL
    expect(
      em.getConnection().execute(
        `INSERT INTO "wallets" (id, player_id, currency, balance_amount, balance_currency, version)
         VALUES ('${walletId}', '${playerId}', 'BRL', -10.00, 'BRL', 1);`
      )
    ).rejects.toThrow(/chk_balance_non_negative|check constraint/i);
  });

  it('deve falhar ao tentar criar duas wallets para o mesmo playerId e currency (UNIQUE constraint)', async () => {
    const playerId = crypto.randomUUID();

    const w1 = Wallet.open({
      id: crypto.randomUUID(),
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });
    em.persist(w1);
    await em.flush();

    const w2 = Wallet.open({
      id: crypto.randomUUID(),
      playerId,
      initialBalance: Money.from({ amount: '50.00', currency: 'BRL' }),
    });

    em.persist(w2);
    expect(em.flush()).rejects.toThrow(/uq_player_currency|unique constraint/i);
  });

  it('deve impedir UPDATE e DELETE no ledger via Trigger do banco (Imutabilidade Estrita)', async () => {
    const wallet = Wallet.open({
      id: crypto.randomUUID(),
      playerId: crypto.randomUUID(),
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });
    const txId = crypto.randomUUID();
    const entry = wallet.debit(Money.from({ amount: '30.00', currency: 'BRL' }), txId);
    entry.id = crypto.randomUUID();

    em.persist([wallet, entry]);
    await em.flush();

    // Tentativa de UPDATE no ledger deve ser barrada pela trigger
    expect(
      em.getConnection().execute(
        `UPDATE "wallet_ledger_entries" SET money_amount = 50.00 WHERE id = '${entry.id}';`
      )
    ).rejects.toThrow(/ledger entries are immutable|immutable/i);

    // Tentativa de DELETE no ledger deve ser barrada pela trigger
    expect(
      em.getConnection().execute(
        `DELETE FROM "wallet_ledger_entries" WHERE id = '${entry.id}';`
      )
    ).rejects.toThrow(/ledger entries are immutable|immutable/i);
  });

  it('deve prevenir race conditions usando LockMode.PESSIMISTIC_WRITE', async () => {
    const wallet = Wallet.open({
      id: crypto.randomUUID(),
      playerId: crypto.randomUUID(),
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });
    em.persist(wallet);
    await em.flush();

    const t1 = em.fork().transactional(async (txEm) => {
      const w1 = await txEm.findOne(Wallet, { id: wallet.id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      w1!.debit(Money.from({ amount: '80.00', currency: 'BRL' }), crypto.randomUUID());
      await new Promise((resolve) => setTimeout(resolve, 60));
    });

    const t2 = em.fork().transactional(async (txEm) => {
      const w2 = await txEm.findOne(Wallet, { id: wallet.id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      w2!.debit(Money.from({ amount: '80.00', currency: 'BRL' }), crypto.randomUUID());
    });

    const results = await Promise.allSettled([t1, t2]);
    const hasRejected = results.some((r) => r.status === 'rejected');
    expect(hasRejected).toBe(true);

    const freshEm = em.fork();
    const finalWallet = await freshEm.findOne(Wallet, { id: wallet.id });
    expect(finalWallet?.balance.toJSON()).toEqual({ amount: '20.00', currency: 'BRL' });
  });
});
