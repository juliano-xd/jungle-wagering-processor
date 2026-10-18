import { EntitySchema } from '@mikro-orm/core';
import { OutboxMessage } from '../../../domain/entities/outbox-message.js';

export const OutboxMessageSchema = new EntitySchema<OutboxMessage>({
  class: OutboxMessage as any,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true, defaultRaw: 'gen_random_uuid()' },
    aggregateId: { type: 'string', length: 255, fieldName: 'aggregate_id' },
    eventType: { type: 'string', length: 255, fieldName: 'event_type' },
    payload: { type: 'json' },
    occurredAt: { type: 'Date', fieldName: 'occurred_at' },
    attempts: { type: 'number', default: 0 },
    nextAttemptAt: { type: 'Date', nullable: true, fieldName: 'next_attempt_at' },
    publishedAt: { type: 'Date', nullable: true, fieldName: 'published_at' },
  },
  indexes: [
    { name: 'idx_outbox_pending', properties: ['publishedAt', 'nextAttemptAt'] },
  ],
});
