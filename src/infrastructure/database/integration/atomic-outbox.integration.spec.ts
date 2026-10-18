import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { MikroORM, EntityManager } from '@mikro-orm/postgresql';
import config from '../../../../mikro-orm.config.js';
import { Wallet } from '../../../domain/entities/wallet.js';
import { Money } from '../../../domain/value-objects/money.js';

describe('Atomic Outbox & Transactional Consistency Integration', () => {
  let orm: MikroORM;
  let em: EntityManager;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
    em = orm.em.fork();
  });

  afterAll(async () => {
    await orm.close();
  });

  it('deve abortar persistência da wallet se houver falha na transação', async () => {
    const forkEm = orm.em.fork();
    const walletId = crypto.randomUUID();
    let errorThrown = false;

    try {
      await forkEm.transactional(async (txEm) => {
        const wallet = Wallet.create(Money.from({ amount: '200.00', currency: 'BRL' }));
        wallet.id = walletId; // Utiliza UUID válido
        txEm.persist(wallet);

        throw new Error('Forced transaction failure');
      });
    } catch (err) {
      errorThrown = true;
    }

    expect(errorThrown).toBe(true);

    const savedWallet = await forkEm.findOne(Wallet, { id: walletId });
    expect(savedWallet).toBeNull();
  });
});
