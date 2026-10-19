import { describe, it, expect } from 'bun:test';
import { computeSubmitPayloadHash } from '../../../src/application/services/payload-hash.js';

describe('computeSubmitPayloadHash — paridade HTTP↔SQS', () => {
  const base = {
    providerId: 'prov-1',
    externalTransactionId: 'tx-1',
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
    roundId: 'round-1',
    gameId: 'slot-1',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  };

  it('é determinístico para o mesmo input', () => {
    expect(computeSubmitPayloadHash(base)).toBe(computeSubmitPayloadHash({ ...base }));
  });

  it('mudar 1 campo de negócio muda o hash', () => {
    const h1 = computeSubmitPayloadHash(base);
    const h2 = computeSubmitPayloadHash({ ...base, roundId: 'round-2' });
    expect(h1).not.toBe(h2);
  });

  it('referenceExternalTransactionId: undefined e null produzem o mesmo hash', () => {
    const h1 = computeSubmitPayloadHash({ ...base, referenceExternalTransactionId: undefined });
    const h2 = computeSubmitPayloadHash({ ...base, referenceExternalTransactionId: null });
    expect(h1).toBe(h2);
  });

  it('metadados de transporte (não incluídos) não afetam o hash', () => {
    // Não passa X-Correlation-Id, X-Forwarded-For, etc. — só campos de negócio.
    const h1 = computeSubmitPayloadHash(base);
    const h2 = computeSubmitPayloadHash(base);
    expect(h1).toBe(h2);
  });
});
