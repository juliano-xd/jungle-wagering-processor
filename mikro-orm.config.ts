import { WalletSchema } from './src/domain/entities/wallet.js';
import { WalletLedgerEntrySchema } from './src/domain/entities/wallet-ledger-entry.js';
import { WagerTransactionSchema } from './src/domain/entities/wager-transaction.js';
import { IdempotencyRecordSchema } from './src/domain/entities/idempotency-record.js';
import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { InboxMessageSchema } from './src/infrastructure/persistence/schemas/inbox-message.schema.js';
import { OutboxMessageSchema } from './src/infrastructure/persistence/schemas/outbox-message.schema.js';

export default defineConfig({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  dbName: process.env.DB_NAME || 'wagering_db',

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
