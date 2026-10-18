import { MikroORM } from '@mikro-orm/postgresql';
import config from './mikro-orm.config.js';

const orm = await MikroORM.init(config);
const conn = orm.em.getConnection();

// Drop + recreate using the migration SQL (schema:fresh equivalent)
const drop = [
  'DROP TABLE IF EXISTS "idempotency_records"',
  'DROP TABLE IF EXISTS "wager_transactions"',
  'DROP TABLE IF EXISTS "outbox_messages"',
  'DROP TABLE IF EXISTS "inbox_messages"',
  'DROP TABLE IF EXISTS "wallet_ledger_entries"',
  'DROP TABLE IF EXISTS "wallets"',
];
for (const sql of drop) {
  await conn.execute(sql);
}

const create = [
  `CREATE TABLE "wallets" (
    id UUID PRIMARY KEY,
    player_id UUID NOT NULL,
    currency VARCHAR(3) NOT NULL,
    balance_amount NUMERIC(18,2) NOT NULL,
    balance_currency VARCHAR(3) NOT NULL,
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "uq_player_currency" UNIQUE (player_id, currency),
    CONSTRAINT "chk_balance_non_negative" CHECK (balance_amount >= 0)
  )`,
  `CREATE TABLE "wallet_ledger_entries" (
    id UUID PRIMARY KEY,
    wallet_id UUID NOT NULL REFERENCES "wallets"(id),
    transaction_id UUID NOT NULL,
    direction VARCHAR(10) NOT NULL,
    money_amount NUMERIC(18,2) NOT NULL,
    money_currency VARCHAR(3) NOT NULL,
    balance_before_amount NUMERIC(18,2) NOT NULL,
    balance_before_currency VARCHAR(3) NOT NULL,
    balance_after_amount NUMERIC(18,2) NOT NULL,
    balance_after_currency VARCHAR(3) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE "inbox_messages" (
    message_id VARCHAR(255) NOT NULL,
    consumer_name VARCHAR(255) NOT NULL,
    payload_hash VARCHAR(64) NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    PRIMARY KEY (message_id, consumer_name)
  )`,
  `CREATE TABLE "outbox_messages" (
    id UUID PRIMARY KEY,
    aggregate_id UUID NOT NULL,
    event_type VARCHAR(255) NOT NULL,
    payload JSONB NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    attempts INT NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ,
    published_at TIMESTAMPTZ
  )`,
  `CREATE TABLE "wager_transactions" (
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
    money_amount NUMERIC(18,2) NOT NULL,
    money_currency VARCHAR(3) NOT NULL,
    reference_external_transaction_id VARCHAR(255),
    reference_transaction_id UUID,
    status VARCHAR(50) NOT NULL,
    failure_code VARCHAR(50),
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE "idempotency_records" (
    idempotency_key VARCHAR(255) PRIMARY KEY,
    payload_hash VARCHAR(64) NOT NULL,
    status VARCHAR(50) NOT NULL,
    transaction_id UUID,
    failure_code VARCHAR(50),
    response JSON NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
];
for (const sql of create) {
  await conn.execute(sql);
}

await orm.close();
console.log('schema:fresh done');
