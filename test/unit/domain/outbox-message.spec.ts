import { describe, it, expect } from 'bun:test';
import { OutboxMessage } from '../../../src/domain/entities/outbox-message.js';

function makePending(overrides: { occurredAt?: Date } = {}): OutboxMessage {
  return OutboxMessage.enqueue({
    id: crypto.randomUUID(),
    aggregateId: crypto.randomUUID(),
    eventType: 'WagerTransactionProcessed',
    correlationId: 'corr-1',
    causationId: 'cause-1',
    occurredAt: overrides.occurredAt ?? new Date(),
    data: { foo: 'bar' },
  });
}

describe('OutboxMessage.enqueue', () => {
  it('cria mensagem pendente com attempts=0', () => {
    const msg = makePending();
    expect(msg.isPending()).toBe(true);
    expect(msg.attempts).toBe(0);
    expect(msg.publishedAt).toBeUndefined();
    expect(msg.nextAttemptAt).toBeUndefined();
  });

  it('empacota payload com eventId, eventType, correlationId, causationId, data', () => {
    const id = crypto.randomUUID();
    const occurredAt = new Date('2026-10-18T21:00:00Z');
    const msg = OutboxMessage.enqueue({
      id,
      aggregateId: 'agg-1',
      eventType: 'WagerTransactionProcessed',
      correlationId: 'corr-1',
      causationId: 'cause-1',
      occurredAt,
      data: { foo: 'bar', n: 42 },
    });
    expect(msg.payload).toEqual({
      eventId: id,
      eventType: 'WagerTransactionProcessed',
      aggregateId: 'agg-1',
      correlationId: 'corr-1',
      causationId: 'cause-1',
      occurredAt: occurredAt.toISOString(),
      data: { foo: 'bar', n: 42 },
    });
  });

  it('aceita causationId undefined', () => {
    const msg = OutboxMessage.enqueue({
      id: crypto.randomUUID(),
      aggregateId: 'agg-1',
      eventType: 'Evt',
      correlationId: 'corr-1',
      occurredAt: new Date(),
      data: {},
    });
    expect((msg.payload as any).causationId).toBeUndefined();
  });
});

describe('OutboxMessage.isDue', () => {
  it('pendente sem nextAttemptAt → due', () => {
    const msg = makePending();
    expect(msg.isDue(new Date())).toBe(true);
  });

  it('publishedAt setado → nunca due', () => {
    const msg = makePending();
    msg.markPublished(new Date());
    expect(msg.isDue(new Date())).toBe(false);
  });

  it('nextAttemptAt no futuro → não due', () => {
    const msg = makePending();
    msg.scheduleRetry(new Date());
    const before = new Date(msg.nextAttemptAt!.getTime() - 1);
    expect(msg.isDue(before)).toBe(false);
  });

  it('nextAttemptAt no passado → due', () => {
    const msg = makePending();
    msg.scheduleRetry(new Date(Date.now() - 10_000));
    expect(msg.isDue(new Date())).toBe(true);
  });
});

describe('OutboxMessage.scheduleRetry', () => {
  it('incrementa attempts', () => {
    const msg = makePending();
    msg.scheduleRetry(new Date());
    expect(msg.attempts).toBe(1);
    msg.scheduleRetry(new Date());
    expect(msg.attempts).toBe(2);
  });

  it('agenda nextAttemptAt no futuro', () => {
    const msg = makePending();
    const now = new Date('2026-10-18T21:00:00Z');
    msg.scheduleRetry(now);
    expect(msg.nextAttemptAt).toBeDefined();
    expect(msg.nextAttemptAt!.getTime()).toBeGreaterThan(now.getTime());
  });

  it('backoff cresce com attempts (nas primeiras tentativas)', () => {
    const now = new Date();
    const msg = makePending();
    msg.scheduleRetry(now);
    const delay1 = msg.nextAttemptAt!.getTime() - now.getTime();
    msg.scheduleRetry(now);
    const delay2 = msg.nextAttemptAt!.getTime() - now.getTime();
    // Com jitter ±25%, delay2_min (750) > delay1_max (625), sempre.
    expect(delay2).toBeGreaterThan(delay1);
  });

  it('backoff limitado a 30s ±25% (delay ∈ [22_500, 37_500])', () => {
    // Regressão para bug de jitter: implementação antiga produzia
    // jitter ∈ [0, 50%] (nunca negativo), estourando 30_000 → até 45_000.
    // Com ±25% real, o teto efetivo é 37_500ms.
    const now = new Date();
    const msg = makePending();
    for (let i = 0; i < 20; i++) msg.scheduleRetry(now); // satura em MAX
    const delay = msg.nextAttemptAt!.getTime() - now.getTime();
    expect(delay).toBeLessThanOrEqual(37_500);   // teto superior
    expect(delay).toBeGreaterThanOrEqual(22_500); // teto inferior (jitter -25%)
  });

  it('múltiplas amostras do backoff saturado cabem em [22_500, 37_500]', () => {
    // Prova empírica (100 amostras): garante que o jitter é simétrico
    // (nunca extrapola +25%, nunca abaixo de -25%).
    const now = new Date();
    const samples: number[] = [];
    for (let s = 0; s < 100; s++) {
      const msg = makePending();
      for (let i = 0; i < 20; i++) msg.scheduleRetry(now);
      samples.push(msg.nextAttemptAt!.getTime() - now.getTime());
    }
    for (const d of samples) {
      expect(d).toBeGreaterThanOrEqual(22_500);
      expect(d).toBeLessThanOrEqual(37_500);
    }
    // A média deve ficar próxima de 30_000 (jitter simétrico = média 0)
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    expect(mean).toBeGreaterThan(27_000);
    expect(mean).toBeLessThan(33_000);
  });
});

describe('OutboxMessage.markPublished', () => {
  it('seta publishedAt e marca isPending=false', () => {
    const msg = makePending();
    expect(msg.isPending()).toBe(true);
    msg.markPublished(new Date());
    expect(msg.isPending()).toBe(false);
    expect(msg.publishedAt).toBeInstanceOf(Date);
  });
});

describe('OutboxMessage.rehydrate', () => {
  it('reconstrói estado completo', () => {
    const occurredAt = new Date('2026-10-18T20:00:00Z');
    const publishedAt = new Date('2026-10-18T20:00:05Z');
    const msg = OutboxMessage.rehydrate({
      id: 'id-1',
      aggregateId: 'agg-1',
      eventType: 'Evt',
      payload: { foo: 'bar' },
      occurredAt,
      attempts: 3,
      publishedAt,
    });
    expect(msg.id).toBe('id-1');
    expect(msg.attempts).toBe(3);
    expect(msg.publishedAt).toEqual(publishedAt);
    expect(msg.occurredAt).toEqual(occurredAt);
    expect(msg.isPending()).toBe(false);
  });
});
