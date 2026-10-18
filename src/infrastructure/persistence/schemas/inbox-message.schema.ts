import { EntitySchema } from '@mikro-orm/core';
import { InboxMessage } from '../../../domain/entities/inbox-message.js';

export const InboxMessageSchema = new EntitySchema<InboxMessage>({
  class: InboxMessage as any,
  tableName: 'inbox_messages',
  properties: {
    messageId: { type: 'string', length: 255, primary: true },
    consumerName: { type: 'string', length: 255, primary: true },
    payloadHash: { type: 'string', length: 64 },
    receivedAt: { type: 'Date', fieldName: 'received_at', onCreate: () => new Date() },
    processedAt: { type: 'Date', nullable: true, fieldName: 'processed_at' },
  },
});
