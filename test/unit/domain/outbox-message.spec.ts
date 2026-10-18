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
    // after scheduleRetry, nextAttemptAt = now + base*2^1 + jitter ≥ 500ms
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

  it('agenda nextAttemptAt no futuro com backoff', () => {
    const msg = makePending();
    const now = new Date('2026-10-18T21:00:00Z');
    msg.scheduleRetry(now);
    expect(msg.nextAttemptAt).toBeDefined();
    expect(msg.nextAttemptAt!.getTime()).toBeGreaterThan(now.getTime());
  });

  it('backoff cresce com attempts', () => {
    const now = new Date();
    const msg = makePending();
    msg.scheduleRetry(now);
    const delay1 = msg.nextAttemptAt!.getTime() - now.getTime();
    msg.scheduleRetry(now);
    const delay2 = msg.nextAttemptAt!.getTime() - now.getTime();
    expect(delay2).toBeGreaterThan(delay1);
  });

  it('backoff limitado a 30s (jitter ±25% incluído)', () => {
    const now = new Date();
    const msg = makePending();
    // Muitas tentativas para estourar o teto
    for (let i = 0; i < 20; i++) msg.scheduleRetry(now);
    const delay = msg.nextAttemptAt!.getTime() - now.getTime();
    // 30_000 + jitter até 25% = 37_500 max
    expect(delay).toBeLessThanOrEqual(37_500);
    expect(delay).toBeGreaterThanOrEqual(30_000);
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
