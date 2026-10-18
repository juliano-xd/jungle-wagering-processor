import { Migration } from '@mikro-orm/migrations';

export class Migration20261017000000 extends Migration {
  async up(): Promise<void> {
    // 1. Wallets: unique(player_id, currency) e CHECK(balance_amount >= 0)
    this.addSql(`
      CREATE TABLE "wallets" (
        id UUID PRIMARY KEY,
        player_id UUID NOT NULL,
        currency VARCHAR(3) NOT NULL,
        balance_amount NUMERIC(18, 2) NOT NULL,
        balance_currency VARCHAR(3) NOT NULL,
        version INT NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT "uq_player_currency" UNIQUE (player_id, currency),
        CONSTRAINT "chk_balance_non_negative" CHECK (balance_amount >= 0)
      );
    `);

    // 2. Ledger (imutável, append-only). balanceBefore/After em amount+currency.
    this.addSql(`
      CREATE TABLE "wallet_ledger_entries" (
        id UUID PRIMARY KEY,
        wallet_id UUID NOT NULL REFERENCES "wallets"(id),
        transaction_id UUID NOT NULL,
        direction VARCHAR(10) NOT NULL,
        money_amount NUMERIC(18, 2) NOT NULL,
        money_currency VARCHAR(3) NOT NULL,
        balance_before_amount NUMERIC(18, 2) NOT NULL,
        balance_before_currency VARCHAR(3) NOT NULL,
        balance_after_amount NUMERIC(18, 2) NOT NULL,
        balance_after_currency VARCHAR(3) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // 3. Inbox: deduplicação por (message_id, consumer_name)
    this.addSql(`
      CREATE TABLE "inbox_messages" (
        message_id VARCHAR(255) NOT NULL,
        consumer_name VARCHAR(255) NOT NULL,
        payload_hash VARCHAR(64) NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ,
        PRIMARY KEY (message_id, consumer_name)
      );
    `);

    // 4. Outbox: transactional outbox pattern
    this.addSql(`
      CREATE TABLE "outbox_messages" (
        id UUID PRIMARY KEY,
        aggregate_id UUID NOT NULL,
        event_type VARCHAR(255) NOT NULL,
        payload JSONB NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        attempts INT NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ,
        published_at TIMESTAMPTZ
      );
    `);

    // 5. Wager transactions
    this.addSql(`
      CREATE TABLE "wager_transactions" (
        id UUID PRIMARY KEY,
        provider_id VARCHAR(100) NOT NULL,
        external_transaction_id VARCHAR(255) NOT NULL,
        idempotency_key VARCHAR(255) NOT NULL UNIQUE,
        payload_hash VARCHAR(64) NOT NULL,
        wallet_id UUID NOT NULL REFERENCES "wallets"(id),
        player_id UUID NOT NULL,
        round_id VARCHAR(255) NOT NULL,
        game_id VARCHAR(255) NOT NULL,
        kind VARCHAR(50) NOT NULL,
        money_amount NUMERIC(18, 2) NOT NULL,
        money_currency VARCHAR(3) NOT NULL,
        reference_external_transaction_id VARCHAR(255),
        reference_transaction_id UUID,
        status VARCHAR(50) NOT NULL,
        failure_code VARCHAR(50),
        processed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // 6. Idempotency records: fonte da verdade da idempotência
    this.addSql(`
      CREATE TABLE "idempotency_records" (
        idempotency_key VARCHAR(255) PRIMARY KEY,
        payload_hash VARCHAR(64) NOT NULL,
        status VARCHAR(50) NOT NULL,
        transaction_id UUID,
        failure_code VARCHAR(50),
        response JSON NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }

  async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS "idempotency_records";`);
    this.addSql(`DROP TABLE IF EXISTS "wager_transactions";`);
    this.addSql(`DROP TABLE IF EXISTS "outbox_messages";`);
    this.addSql(`DROP TABLE IF EXISTS "inbox_messages";`);
    this.addSql(`DROP TABLE IF EXISTS "wallet_ledger_entries";`);
    this.addSql(`DROP TABLE IF EXISTS "wallets";`);
  }
}