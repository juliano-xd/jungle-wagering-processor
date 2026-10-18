import { describe, it, expect } from 'bun:test';
import { InboxMessage } from '../../../domain/entities/inbox-message.js';
import { OutboxMessage } from '../../../domain/entities/outbox-message.js';

describe('Outbox & Inbox Domain Logic', () => {
  it('deve gerenciar o estado de processamento na Inbox', () => {
    const inboxMsg = InboxMessage.receive({
      messageId: 'msg-uuid-1',
      consumerName: 'wager-processor',
      payloadHash: 'hash-payload-123',
    });

    expect(inboxMsg.isProcessed()).toBe(false);
    inboxMsg.markProcessed(new Date());
    expect(inboxMsg.isProcessed()).toBe(true);
  });

  it('deve enfileirar eventos na Outbox corretamente', () => {
    const outboxMsg = OutboxMessage.enqueue({
      eventId: 'evt-uuid-1',
      aggregateId: 'wallet-uuid-1',
      correlationId: 'corr-1',
      occurredAt: new Date(),
      eventType: 'WalletBalanceChanged',
      data: { amount: '100.00', currency: 'BRL' },
    });

    expect(outboxMsg.isPending()).toBe(true);
    outboxMsg.markPublished(new Date());
    expect(outboxMsg.isPending()).toBe(false);
  });
});
