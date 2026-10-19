import { WalletSchema } from './src/domain/entities/wallet.js';
import { WalletLedgerEntrySchema } from './src/domain/entities/wallet-ledger-entry.js';
import { WagerTransactionSchema } from './src/domain/entities/wager-transaction.js';
import { IdempotencyRecordSchema } from './src/domain/entities/idempotency-record.js';
import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { InboxMessageSchema } from './src/infrastructure/persistence/schemas/inbox-message.schema.js';
import { OutboxMessageSchema } from './src/infrastructure/persistence/schemas/outbox-message.schema.js';

/**
 * Seleciona o banco por ambiente:
 *
 *   NODE_ENV=test  → DB_NAME_TEST  (default `wagering_db_test`)
 *   outros         → DB_NAME       (default `wagering_db`)
 *
 * Por que: sem isso, os testes competem com o `bun run start:dev` (que roda
 * workers em background) pelo mesmo banco. O `OutboxPublisherWorker` do app
 * consome mensagens durante o teste, causando flakiness em
 * `outbox-skip-locked` (esperava 3, recebia 1 — mensagens consumidas por fora).
 *
 * Para criar `wagering_db_test`:
 *   bun run db:create-test
 */
const isTest = process.env.NODE_ENV === 'test';

export default defineConfig({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  dbName: isTest
    ? (process.env.DB_NAME_TEST ?? 'wagering_db_test')
    : (process.env.DB_NAME ?? 'wagering_db'),

  entities: [
    WalletSchema,
    WalletLedgerEntrySchema,
    WagerTransactionSchema,
    InboxMessageSchema,
    OutboxMessageSchema,
    IdempotencyRecordSchema,
  ],
  extensions: [Migrator],

  migrations: {
    path: './src/infrastructure/database/migrations',
    pathTs: './src/infrastructure/database/migrations',
    glob: '!(*.d).{js,ts}',
    snapshot: false,
    emit: 'ts',
  },
});
