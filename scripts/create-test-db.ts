/**
 * Cria o banco de testes (`wagering_db_test`) se ainda não existir.
 *
 * Usa o client `pg` direto (não MikroORM) para conectar no DB administrativo
 * `postgres` e rodar `CREATE DATABASE`. Isso evita problemas de inicialização
 * do ORM contra um banco que ainda não existe.
 *
 * Idempotente: reexecutar não causa erro.
 *
 * Uso:
 *   bun run scripts/create-test-db.ts
 *   bun run db:create-test       (alias no package.json)
 */
import { Client } from 'pg';

async function main(): Promise<void> {
  const testDb = process.env.DB_NAME_TEST ?? 'wagering_db_test';
  const client = new Client({
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER ?? 'postgres',
    password: process.env.DB_PASSWORD ?? 'postgres',
    database: 'postgres', // DB administrativo sempre existe
  });

  await client.connect();
  try {
    const { rows } = await client.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists`,
      [testDb],
    );

    if (rows[0]?.exists) {
      console.log(`✅ DB "${testDb}" já existe`);
      return;
    }

    // Identifier não pode ser parametrizado; aspas duplas + escape defensivo.
    const safeName = testDb.replace(/"/g, '""');
    await client.query(`CREATE DATABASE "${safeName}"`);
    console.log(`✅ DB "${testDb}" criado`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('❌ Falha ao criar DB de teste:', err);
  process.exit(1);
});
