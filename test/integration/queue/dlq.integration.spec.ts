import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { InMemoryQueueAdapter } from '../../../src/infrastructure/queue/in-memory-queue.adapter.js';
import { WagerTransactionConsumer } from '../../../src/infrastructure/queue/wager-transaction.consumer.js';
import type { WagerTransactionRequestedEnvelope } from '../../../src/infrastructure/queue/queue.port.js';

/**
 * Spec 13 — retry + DLQ (teste de integração).
 *
 * Cenário: consumer falha com erro transitório N vezes. Ao exceder
 * `maxReceiveCount` (5), a mensagem é movida para a DLQ automaticamente
 * (moveToDlq é chamado pelo InMemoryQueueAdapter.nack).
 *
 * Não depende de Postgres — testa apenas a mecânica de fila.
 */
describe('DLQ — mensagem excede maxReceiveCount', () => {
  beforeAll(() => {
    // Backoff 0 para o teste rodar rápido (o adapter respeita a env).
    process.env.WAGER_CONSUMER_NACK_BACKOFF_S = '0';
  });
  afterAll(() => {
    delete process.env.WAGER_CONSUMER_NACK_BACKOFF_S;
  });

  beforeEach(() => {
    process.env.WAGER_CONSUMER_NACK_BACKOFF_S = '0';
  });

  it('após 5 nacks, mensagem vai para DLQ com reason="maxReceiveCount"', async () => {
    const queue = new InMemoryQueueAdapter();

    // Service stub que sempre falha com erro transitório (não-WagerTransactionError).
    const failingService = {
      submitTransaction: async () => {
        throw new Error('simulated transient failure');
      },
    } as unknown as import('../../../src/application/services/wagering.service.js').WageringService;

    const consumer = new WagerTransactionConsumer(failingService, queue);

    const envelope: WagerTransactionRequestedEnvelope = {
      messageId: `msg-dlq-${crypto.randomUUID()}`,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'prov-1',
        externalTransactionId: 'tx-dlq',
        idempotencyKey: 'prov-1:tx-dlq',
        playerId: crypto.randomUUID(),
        walletId: crypto.randomUUID(),
        roundId: 'round-dlq',
        gameId: 'slot-1',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      },
    };

    await queue.send(JSON.stringify(envelope));

    // Cada receive + processOne = 1 nack (o service falha).
    // Após 5 nacks (receiveCount = 5), moveToDlq dispara.
    for (let i = 0; i < 5; i++) {
      const batch = await queue.receiveBatch(1, 0);
      if (batch.length === 0) break; // já foi para DLQ
      await consumer.processOne(batch[0]);
    }

    const stats = queue.stats();
    expect(stats.queued).toBe(0);
    expect(stats.dlq).toBe(1);
    expect(stats.dlqEntries[0]?.reason).toMatch(/maxReceiveCount/);
  });

  it('erro de negócio (WagerTransactionError) NÃO vai para DLQ — ack terminal', async () => {
    const queue = new InMemoryQueueAdapter();

    // Service que retorna REJECTED (não lança).
    const rejectingService = {
      submitTransaction: async () => ({
        transactionId: crypto.randomUUID(),
        status: 'REJECTED',
        balanceAfter: { toJSON: () => ({ amount: '100.00', currency: 'BRL' }) },
        walletVersion: 1,
        idempotentReplay: false,
        failureCode: 'INSUFFICIENT_FUNDS',
      }),
    } as unknown as import('../../../src/application/services/wagering.service.js').WageringService;

    const consumer = new WagerTransactionConsumer(rejectingService, queue);

    const envelope: WagerTransactionRequestedEnvelope = {
      messageId: `msg-rejected-${crypto.randomUUID()}`,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'prov-1',
        externalTransactionId: 'tx-rej',
        idempotencyKey: 'prov-1:tx-rej',
        playerId: crypto.randomUUID(),
        walletId: crypto.randomUUID(),
        roundId: 'round-rej',
        gameId: 'slot-1',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      },
    };

    await queue.send(JSON.stringify(envelope));
    const batch = await queue.receiveBatch(1, 0);
    await consumer.processOne(batch[0]);

    const stats = queue.stats();
    expect(stats.queued).toBe(0); // ack'd
    expect(stats.dlq).toBe(0);    // não foi pra DLQ
  });
});
