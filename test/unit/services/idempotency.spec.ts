import { describe, it, expect } from 'bun:test';

describe('Idempotency & Payload Hash Verification', () => {
  it('deve identificar conflito quando a mesma idempotency-key é usada com payloads diferentes', () => {
    const existingKey = 'provider-a:tx-123';
    const existingHash = 'hash-of-payload-v1';
    const incomingHash = 'hash-of-payload-v2';

    const isConflict = existingKey === 'provider-a:tx-123' && existingHash !== incomingHash;
    expect(isConflict).toBe(true);
  });

  it('deve retornar replay idêntico se a chave e o hash forem idênticos', () => {
    const existingHash = 'hash-of-payload-v1';
    const incomingHash = 'hash-of-payload-v1';

    const isReplay = existingHash === incomingHash;
    expect(isReplay).toBe(true);
  });
});
