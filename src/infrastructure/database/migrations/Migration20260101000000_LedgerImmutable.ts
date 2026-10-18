import { Migration } from '@mikro-orm/migrations';

/**
 * Falha eliminatória da spec: "ledger pode ser update/delete".
 *
 * A imutabilidade é garantida NO BANCO (trigger), não apenas na classe
 * `WalletLedgerEntry` (sem métodos de mutação). Triggers BEFORE UPDATE/DELETE
 * bloqueiam qualquer tentativa — inclusive SQL direto, migrations mal feitas
 * ou código de terceiros.
 */
export class Migration20260101000000_LedgerImmutable extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE OR REPLACE FUNCTION wallet_ledger_immutable_fn()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is immutable: rows cannot be updated or deleted';
      END;
      $$ LANGUAGE plpgsql;
    `);
    this.addSql(`
      DROP TRIGGER IF EXISTS trg_wallet_ledger_immutable
      ON "wallet_ledger_entries";
    `);
    this.addSql(`
      CREATE TRIGGER trg_wallet_ledger_immutable
      BEFORE UPDATE OR DELETE ON "wallet_ledger_entries"
      FOR EACH ROW EXECUTE FUNCTION wallet_ledger_immutable_fn();
    `);
  }

  async down(): Promise<void> {
    this.addSql(
      `DROP TRIGGER IF EXISTS trg_wallet_ledger_immutable ON "wallet_ledger_entries";`,
    );
    this.addSql(`DROP FUNCTION IF EXISTS wallet_ledger_immutable_fn();`);
  }
}
