/**
 * Cria o banco de testes (`wagering_db_test`) se ainda não existir.
 *
 * Usa **`Bun.sql`** — o driver SQL nativo do Bun (built-in, zero dependência
 * externa). Alternativa ao `pg` + `@types/pg`.
 *
 * ⚠️ Requer Bun 1.1+. Não funciona em Node.js — mas este projeto já exige
 * Bun (runtime, test runner, CLI do MikroORM). Consistente com a decisão.
 *
 * Idempotente: reexecutar não causa erro.
 *
 * Uso:
 *   bun run scripts/create-test-db.ts
 *   bun run db:create-test       (alias no package.json)
 */
import { SQL } from 'bun';

async function main(): Promise<void> {
  const testDb = process.env.DB_NAME_TEST ?? 'wagering_db_test';

  // Conecta no DB administrativo `postgres` (sempre existe).
  const admin = new SQL({
    hostname: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USER ?? 'postgres',
    password: process.env.DB_PASSWORD ?? 'postgres',
    database: 'postgres',
  });

  try {
    const rows = await admin`
      SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = ${testDb}) AS exists
    `;

    if (rows[0]?.exists) {
      console.log(`✅ DB "${testDb}" já existe`);
      return;
    }

    // Identifier não pode ser parametrizado. Aspas duplas + escape defensivo.
    const safeName = testDb.replace(/"/g, '""');
    await admin.unsafe(`CREATE DATABASE "${safeName}"`);
    console.log(`✅ DB "${testDb}" criado`);
  } finally {
    await admin.close();
  }
}

main().catch((err) => {
  console.error('❌ Falha ao criar DB de teste:', err);
  process.exit(1);
});
