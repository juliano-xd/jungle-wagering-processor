import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import config from '../../../mikro-orm.config.js';

/**
 * Fecha §4 do edital: "Migrations versionadas **e reversíveis**".
 *
 * Roda `down(to: 0)` + `up()` num banco **dedicado** (`wagering_db_test`),
 * verifica que o schema é recriado com trigger + unique composto intactos.
 *
 * ⚠️ MikroORM v7: `orm.getMigrator()` foi REMOVIDO **e** o construtor de
 * `Migrator` mudou — espera um `EntityManager` (`orm.em`), não `MikroORM`.
 * Na v6, `new Migrator(orm)` funcionava; na v7 explodia com
 * "this.em.getDriver is not a function".
 *
 * ⚠️ Roda em serial (`--max-concurrency=1`). Como ele DROPA e RECRIA o schema,
 * não pode coexistir com outros testes de integration em paralelo.
 */
describe('Migrations — reversibilidade', () => {
  let orm: MikroORM;
  let migrator: Migrator;

  beforeAll(async () => {
    orm = await MikroORM.init({
      ...config,
      dbName: process.env.DB_NAME_TEST ?? 'wagering_db_test',
    });
    // v7: `Migrator` recebe EntityManager (não MikroORM).
    migrator = new Migrator(orm.em);
  });

  afterAll(async () => {
    // Garante estado "up" para não quebrar outros testes que rodem depois
    try {
      await migrator.up();
    } catch {
      // já estava up
    }
    await orm.close();
  });

  it('down(to: 0) + up() restaura schema consistente', async () => {
    // 1. Down até zero — desfaz TODAS as migrations
    await migrator.down({ to: 0 });

    // 2. Verifica que as tabelas de domínio sumiram
    const tablesAfterDown = await orm.em.getConnection().execute<Array<{ c: string }>>(
      `SELECT count(*)::text AS c FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('wallets','wager_transactions','wallet_ledger_entries',
                            'idempotency_records','inbox_messages','outbox_messages')`,
    );
    expect(Number(tablesAfterDown[0].c)).toBe(0);

    // 3. Up novamente
    await migrator.up();

    // 4. Verifica que as 6 tabelas voltaram
    const tablesAfterUp = await orm.em.getConnection().execute<Array<{ c: string }>>(
      `SELECT count(*)::text AS c FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('wallets','wager_transactions','wallet_ledger_entries',
                            'idempotency_records','inbox_messages','outbox_messages')`,
    );
    expect(Number(tablesAfterUp[0].c)).toBe(6);

    // 5. Trigger de imutabilidade sobreviveu ao ciclo down+up
    const triggers = await orm.em.getConnection().execute<Array<{ tgname: string }>>(
      `SELECT tgname FROM pg_trigger
       WHERE tgrelid = 'wallet_ledger_entries'::regclass
         AND NOT tgisinternal`,
    );
    const hasImmutable = triggers.some((t) => /immutable/i.test(t.tgname));
    expect(hasImmutable).toBe(true);

    // 6. Unique composto (provider, external) sobreviveu
    const uniques = await orm.em.getConnection().execute<Array<{ def: string }>>(
      `SELECT pg_get_indexdef(i.oid) AS def
       FROM pg_index x
       JOIN pg_class i ON i.oid = x.indexrelid
       JOIN pg_class t ON t.oid = x.indrelid
       WHERE t.relname = 'wager_transactions' AND x.indisunique`,
    );
    const hasProviderExtUnique = uniques.some(
      (u) => u.def.includes('provider_id') && u.def.includes('external_transaction_id'),
    );
    expect(hasProviderExtUnique).toBe(true);
  }, 120_000);
});
