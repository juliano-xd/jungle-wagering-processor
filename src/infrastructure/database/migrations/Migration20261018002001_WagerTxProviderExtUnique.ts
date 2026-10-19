import { Migration } from '@mikro-orm/migrations';

/**
 * Garante unicidade de (providerId, externalTransactionId) no banco.
 *
 * Necessário para:
 *   - idempotência de resolução de referência (REFUND/ROLLBACK buscam por
 *     este par — múltiplas linhas = ambiguidade);
 *   - defesa contra duplicação de submit (mesmo provedor reenviando com
 *     payload divergente mas externalTransactionId igual).
 *
 * Idempotente: só cria a constraint se ainda não existir. Roda com segurança
 * em bases que já tiveram a migration original aplicada.
 */
export class Migration20260101000001_WagerTxProviderExtUnique extends Migration {
  async up(): Promise<void> {
    // Remove o índice antigo (não-unique) se ele existir.
    this.addSql(`DROP INDEX IF EXISTS "idx_wager_tx_provider_ext";`);

    this.addSql(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'uq_wager_tx_provider_ext'
            AND conrelid = 'wager_transactions'::regclass
        ) THEN
          ALTER TABLE "wager_transactions"
            ADD CONSTRAINT "uq_wager_tx_provider_ext"
            UNIQUE ("provider_id", "external_transaction_id");
        END IF;
      END $$;
    `);
  }

  async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE "wager_transactions"
        DROP CONSTRAINT IF EXISTS "uq_wager_tx_provider_ext";
    `);
    this.addSql(`
      CREATE INDEX IF NOT EXISTS "idx_wager_tx_provider_ext"
        ON "wager_transactions" ("provider_id", "external_transaction_id");
    `);
  }
}
