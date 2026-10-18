import { describe, it, expect } from 'bun:test';
import { OutboxMessage } from '../../domain/entities/outbox-message.js';

describe('OutboxProcessor Unit / Logic Verification', () => {
  it('deve instanciar a mensagem da outbox, verificar se está pendente e marcar como publicada', () => {
    const message = OutboxMessage.enqueue({
      eventId: 'evt-test-123',
      aggregateId: 'wallet-123',
      eventType: 'WalletBalanceChanged',
      correlationId: 'corr-123',
      occurredAt: new Date(),
      data: { amount: '200.00' },
    });

    expect(message.isPending()).toBe(true);
    message.markPublished(new Date());
    expect(message.isPending()).toBe(false);
  });
});
