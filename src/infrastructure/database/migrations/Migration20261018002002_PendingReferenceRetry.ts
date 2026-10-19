import { Migration } from '@mikro-orm/migrations';

/**
 * Colunas para o worker de PENDING_REFERENCE (spec 7.1).
 *
 *   - `pending_reference_attempts`     : contador de tentativas.
 *   - `pending_reference_next_attempt_at` : próxima tentativa (backoff).
 *   - índice parcial onde status='PENDING_REFERENCE' — acelera a query do
 *     worker (que filtra por status + next_attempt_at <= now()).
 *
 * Idempotente: não falha se já aplicada.
 */
export class Migration20260101000002_PendingReferenceRetry extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE "wager_transactions"
        ADD COLUMN IF NOT EXISTS "pending_reference_attempts" integer NOT NULL DEFAULT 0;
    `);
    this.addSql(`
      ALTER TABLE "wager_transactions"
        ADD COLUMN IF NOT EXISTS "pending_reference_next_attempt_at" timestamptz NULL;
    `);
    this.addSql(`
      CREATE INDEX IF NOT EXISTS "idx_wager_tx_pending_reference"
        ON "wager_transactions" ("status", "pending_reference_next_attempt_at")
        WHERE "status" = 'PENDING_REFERENCE';
    `);
  }

  async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS "idx_wager_tx_pending_reference";`);
    this.addSql(`
      ALTER TABLE "wager_transactions"
        DROP COLUMN IF EXISTS "pending_reference_next_attempt_at";
    `);
    this.addSql(`
      ALTER TABLE "wager_transactions"
        DROP COLUMN IF EXISTS "pending_reference_attempts";
    `);
  }
}
