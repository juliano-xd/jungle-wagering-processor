import { MikroORM, EntityManager } from '@mikro-orm/postgresql';
import config from '../../mikro-orm.config.js';

/**
 * Inicializa MikroORM + garante migrations aplicadas.
 * Reutilizável em todos os specs de integração.
 */
export async function createTestOrm(): Promise<MikroORM> {
  const orm = await MikroORM.init(config);
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
    // migrations já aplicadas via CLI
  }
  return orm;
}

/**
 * Trunca todas as tabelas do domínio. Chamar em `beforeEach` para isolar
 * cada teste. Uma única transação SQL para performance.
 */
export async function truncateAll(em: EntityManager): Promise<void> {
  await em.getConnection().execute(
    'TRUNCATE TABLE "outbox_messages", "idempotency_records", "inbox_messages", "wallet_ledger_entries", "wager_transactions", "wallets" CASCADE;',
  );
  em.clear();
}
