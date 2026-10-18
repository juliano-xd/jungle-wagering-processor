/**
 * Verifica invariantes eliminatórias do schema no banco.
 *
 * Uso:   bun run scripts/verify-db-invariants.ts
 * Falha: exit 1 se qualquer invariante estiver quebrada.
 *
 * Cobre:
 *   - colunas monetárias como NUMERIC(18,2)
 *   - trigger de imutabilidade do ledger
 *   - unique (providerId, externalTransactionId) — resolução determinística
 *   - unique parcial de reversão (uq_wager_tx_reversal), se existir
 */
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../mikro-orm.config.js';

type Row = Record<string, any>;

async function main() {
  const orm = await MikroORM.init(config);
  const conn = orm.em.getConnection();
  const failures: string[] = [];

  // 1) Colunas NUMERIC(18,2)
  const numericCols = await conn.execute<Row[]>(`
    SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
    FROM information_schema.columns
    WHERE (table_name, column_name) IN (
      ('wallets', 'balance_amount'),
      ('wallet_ledger_entries', 'money_amount'),
      ('wallet_ledger_entries', 'balance_before_amount'),
      ('wallet_ledger_entries', 'balance_after_amount'),
      ('wager_transactions', 'money_amount')
    )
  `);
  for (const c of numericCols) {
    if (c.data_type !== 'numeric') {
      failures.push(`coluna ${c.table_name}.${c.column_name} é ${c.data_type}, esperado numeric`);
    }
    if (Number(c.numeric_scale) !== 2) {
      failures.push(`coluna ${c.table_name}.${c.column_name} escala=${c.numeric_scale}, esperado 2`);
    }
    if (Number(c.numeric_precision) !== 18) {
      failures.push(`coluna ${c.table_name}.${c.column_name} precision=${c.numeric_precision}, esperado 18`);
    }
  }

  // 2) Trigger de imutabilidade do ledger
  const triggers = await conn.execute<Row[]>(`
    SELECT tgname
    FROM pg_trigger
    WHERE tgrelid = 'wallet_ledger_entries'::regclass
      AND NOT tgisinternal
  `);
  const hasImmutable = triggers.some((t) =>
    /immutable/i.test(String(t.tgname)),
  );
  if (!hasImmutable) {
    failures.push(
      `trigger de imutabilidade ausente em wallet_ledger_entries (triggers: ${triggers
        .map((t) => t.tgname)
        .join(', ') || 'nenhum'})`,
    );
  }

  // 3) Unique (providerId, externalTransactionId)
  const providerExtUnique = await conn.execute<Row[]>(`
    SELECT i.relname AS index_name, pg_get_indexdef(i.oid) AS def
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_class t ON t.oid = x.indrelid
    WHERE t.relname = 'wager_transactions'
      AND x.indisunique
  `);
  const hasProviderExtUnique = providerExtUnique.some((r) => {
    const def = String(r.def);
    return (
      def.includes('provider_id') && def.includes('external_transaction_id')
    );
  });
  if (!hasProviderExtUnique) {
    failures.push(
      `unique (provider_id, external_transaction_id) ausente em wager_transactions`,
    );
  }

  // 4) Unique parcial de reversão (informativo — não falha se não existir)
  const reversals = providerExtUnique.find((r) =>
    String(r.index_name) === 'uq_wager_tx_reversal',
  );
  if (reversals) {
    console.log(`[info] uq_wager_tx_reversal existe:\n         ${reversals.def}`);
  } else {
    console.log(
      `[info] uq_wager_tx_reversal NÃO existe (garantia vem só da regra em resolveReferenceTx)`,
    );
  }

  await orm.close();

  if (failures.length > 0) {
    console.error('\n❌ Falhas:');
    for (const f of failures) console.error(`   - ${f}`);
    process.exit(1);
  }

  console.log('\n✅ Todas as invariantes de schema estão OK.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
