import { Migration } from '@mikro-orm/migrations';

export class Migration20261018000000 extends Migration {
  async up(): Promise<void> {
    // 1. Trigger de Imutabilidade Estrita do Ledger (Restrição Inviolável 9)
    this.addSql(`
      CREATE OR REPLACE FUNCTION prevent_ledger_modification()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'Ledger entries are immutable and cannot be updated or deleted';
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_immutable_ledger ON "wallet_ledger_entries";
      CREATE TRIGGER trg_immutable_ledger
      BEFORE UPDATE OR DELETE ON "wallet_ledger_entries"
      FOR EACH ROW EXECUTE FUNCTION prevent_ledger_modification();
    `);

    // 2. Constraint de Unicidade Condicional para evitar dupla reversão (Seção 7, regra 4)
    this.addSql(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_wager_tx_reversal" 
      ON "wager_transactions" (provider_id, reference_external_transaction_id, kind) 
      WHERE status = 'PROCESSED' AND reference_external_transaction_id IS NOT NULL;
    `);

    // 3. Índices para performance em alta concorrência e paginação com cursor
    this.addSql(`
      CREATE INDEX IF NOT EXISTS "idx_outbox_pending" 
      ON "outbox_messages" (published_at, next_attempt_at);

      CREATE INDEX IF NOT EXISTS "idx_ledger_wallet_created" 
      ON "wallet_ledger_entries" (wallet_id, created_at, id);

      CREATE INDEX IF NOT EXISTS "idx_wager_provider_ref" 
      ON "wager_transactions" (provider_id, reference_external_transaction_id);

      CREATE INDEX IF NOT EXISTS "idx_wager_round" 
      ON "wager_transactions" (round_id);
    `);
  }

  async down(): Promise<void> {
    this.addSql(`DROP TRIGGER IF EXISTS trg_immutable_ledger ON "wallet_ledger_entries";`);
    this.addSql(`DROP FUNCTION IF EXISTS prevent_ledger_modification();`);
    this.addSql(`DROP INDEX IF EXISTS "uq_wager_tx_reversal";`);
    this.addSql(`DROP INDEX IF EXISTS "idx_outbox_pending";`);
    this.addSql(`DROP INDEX IF EXISTS "idx_ledger_wallet_created";`);
    this.addSql(`DROP INDEX IF EXISTS "idx_wager_provider_ref";`);
    this.addSql(`DROP INDEX IF EXISTS "idx_wager_round";`);
  }
}
