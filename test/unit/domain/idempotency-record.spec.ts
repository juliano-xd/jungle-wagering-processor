import { describe, it, expect } from 'bun:test';
import {
  IdempotencyRecord,
  IdempotencyRecordStatus,
} from '../../../src/domain/entities/idempotency-record.js';

describe('IdempotencyRecord.create', () => {
  it('cria registro PROCESSED', () => {
    const record = IdempotencyRecord.create({
      idempotencyKey: 'prov-1:tx-1',
      payloadHash: 'hash-abc',
      status: IdempotencyRecordStatus.Processed,
      transactionId: 'tx-id-1',
      response: { transactionId: 'tx-id-1', status: 'PROCESSED' },
    });
    expect(record.idempotencyKey).toBe('prov-1:tx-1');
    expect(record.payloadHash).toBe('hash-abc');
    expect(record.status).toBe(IdempotencyRecordStatus.Processed);
    expect(record.transactionId).toBe('tx-id-1');
    expect(record.failureCode).toBeUndefined();
    expect(record.createdAt).toBeInstanceOf(Date);
  });

  it('cria registro REJECTED com failureCode', () => {
    const record = IdempotencyRecord.create({
      idempotencyKey: 'prov-1:tx-2',
      payloadHash: 'hash-def',
      status: IdempotencyRecordStatus.Rejected,
      transactionId: 'tx-id-2',
      failureCode: 'INSUFFICIENT_FUNDS',
      response: { status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' },
    });
    expect(record.status).toBe(IdempotencyRecordStatus.Rejected);
    expect(record.failureCode).toBe('INSUFFICIENT_FUNDS');
  });

  it('cria registro PENDING sem transactionId (ainda não decidido)', () => {
    const record = IdempotencyRecord.create({
      idempotencyKey: 'prov-1:tx-3',
      payloadHash: 'hash-ghi',
      status: IdempotencyRecordStatus.Pending,
      response: { status: 'PENDING' },
    });
    expect(record.status).toBe(IdempotencyRecordStatus.Pending);
    expect(record.transactionId).toBeUndefined();
  });

  it('preserva o objeto response como-é', () => {
    const response = { transactionId: 'tx-1', status: 'PROCESSED', balanceAfter: { amount: '70.00', currency: 'BRL' } };
    const record = IdempotencyRecord.create({
      idempotencyKey: 'k',
      payloadHash: 'h',
      status: IdempotencyRecordStatus.Processed,
      transactionId: 'tx-1',
      response,
    });
    expect(record.response).toEqual(response);
  });
});

describe('IdempotencyRecord.rehydrate', () => {
  it('reconstrói estado completo', () => {
    const createdAt = new Date('2026-10-18T20:00:00Z');
    const record = IdempotencyRecord.rehydrate({
      idempotencyKey: 'k',
      payloadHash: 'h',
      status: IdempotencyRecordStatus.Rejected,
      transactionId: 'tx-1',
      failureCode: 'REFERENCE_NOT_FOUND',
      response: { status: 'REJECTED' },
      createdAt,
    });
    expect(record.createdAt).toEqual(createdAt);
    expect(record.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect(record.status).toBe(IdempotencyRecordStatus.Rejected);
  });
});

describe('IdempotencyRecordStatus enum', () => {
  it('expõe todos os 4 estados', () => {
    expect(IdempotencyRecordStatus.Pending).toBe('PENDING');
    expect(IdempotencyRecordStatus.Processed).toBe('PROCESSED');
    expect(IdempotencyRecordStatus.Rejected).toBe('REJECTED');
    expect(IdempotencyRecordStatus.Failed).toBe('FAILED');
  });
});
