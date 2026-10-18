import { describe, it, expect } from 'bun:test';
import { OutboxMessage } from '../../../src/domain/entities/outbox-message';

describe('Transactional Outbox Worker Logic', () => {
  it('deve buscar apenas mensagens pendentes e permitir marcá-las como publicadas', () => {
    const message = OutboxMessage.enqueue({
      eventId: 'evt-1',
      aggregateId: 'wallet-1',
      eventType: 'WalletBalanceChanged',
      correlationId: 'corr-1',
      occurredAt: new Date(),
      data: { amount: '50.00' },
    });

    expect(message.isPending()).toBe(true);
    message.markPublished(new Date());
    expect(message.isPending()).toBe(false);
  });
});
