import { describe, it, expect } from 'bun:test';
import { InboxMessage } from '../../../src/domain/entities/inbox-message.js';

describe('InboxMessage.receive', () => {
  it('cria mensagem não-processada', () => {
    const msg = InboxMessage.receive({
      messageId: 'msg-1',
      consumerName: 'wager-processor',
      payloadHash: 'hash-abc',
    });
    expect(msg.messageId).toBe('msg-1');
    expect(msg.consumerName).toBe('wager-processor');
    expect(msg.payloadHash).toBe('hash-abc');
    expect(msg.isProcessed()).toBe(false);
    expect(msg.processedAt).toBeUndefined();
    expect(msg.receivedAt).toBeInstanceOf(Date);
  });
});

describe('InboxMessage.markProcessed', () => {
  it('marca como processada com timestamp', () => {
    const msg = InboxMessage.receive({
      messageId: 'msg-1',
      consumerName: 'wager-processor',
      payloadHash: 'hash-abc',
    });
    const at = new Date('2026-10-18T21:00:00Z');
    msg.markProcessed(at);
    expect(msg.isProcessed()).toBe(true);
    expect(msg.processedAt).toEqual(at);
  });
});

describe('InboxMessage.rehydrate', () => {
  it('reconstrói mensagem não-processada', () => {
    const receivedAt = new Date('2026-10-18T20:00:00Z');
    const msg = InboxMessage.rehydrate({
      messageId: 'msg-1',
      consumerName: 'wager-processor',
      payloadHash: 'hash-abc',
      receivedAt,
    });
    expect(msg.isProcessed()).toBe(false);
    expect(msg.receivedAt).toEqual(receivedAt);
  });

  it('reconstrói mensagem processada', () => {
    const receivedAt = new Date('2026-10-18T20:00:00Z');
    const processedAt = new Date('2026-10-18T20:00:05Z');
    const msg = InboxMessage.rehydrate({
      messageId: 'msg-1',
      consumerName: 'wager-processor',
      payloadHash: 'hash-abc',
      receivedAt,
      processedAt,
    });
    expect(msg.isProcessed()).toBe(true);
    expect(msg.processedAt).toEqual(processedAt);
  });
});
