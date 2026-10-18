import { Migration } from '@mikro-orm/migrations';

/**
 * Migration 3: Correção do tipo aggregate_id em outbox_messages.
 *
 * O aggregate_id representa o ID do aggregate que gerou o evento, mas não é
 * necessariamente uma FK para wallets. Outros aggregates (e.g. providers,
 * rounds) também podem publicar eventos na outbox. O tipo deve ser VARCHAR
 * para comportar qualquer identificador de string, não apenas UUIDs.
 */
export class Migration20261018001000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE "outbox_messages"
        ALTER COLUMN "aggregate_id" TYPE VARCHAR(255)
        USING "aggregate_id"::TEXT;
    `);
  }

  async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE "outbox_messages"
        ALTER COLUMN "aggregate_id" TYPE UUID
        USING "aggregate_id"::UUID;
    `);
  }
}
