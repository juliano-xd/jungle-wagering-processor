import { describe, it, expect } from 'bun:test';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../../src/domain/entities/wager-transaction';
import { LedgerDirection } from '../../../../src/domain/entities/wallet-ledger-entry';
import { Money } from '../../../../src/domain/value-objects/money';
import { FailureCode, WagerTransactionError } from '../../../../src/domain/errors/wager-transaction.error';

describe('WagerTransaction Domain Entity', () => {
  const money = Money.from({ amount: '50.00', currency: 'BRL' });

  it('should create a valid BET transaction in PENDING status', () => {
    const tx = WagerTransaction.create({
      id: 'tx-1',
      providerId: 'provider-a',
      externalTransactionId: 'ext-1',
      idempotencyKey: 'provider-a:ext-1',
      payloadHash: 'hash-abc',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Bet,
      money,
    });

    expect(tx.status).toBe(WagerTransactionStatus.Pending);
    expect(tx.requiresReference()).toBe(false);
    expect(tx.affectsBalance()).toBe(true);
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(tx.matchesPayload('hash-abc')).toBe(true);
    expect(tx.matchesPayload('hash-different')).toBe(false);
    expect(tx.isTerminal()).toBe(false);
  });

  it('should treat LOSS as non-balance affecting without ledger direction', () => {
    const tx = WagerTransaction.create({
      id: 'tx-loss',
      providerId: 'provider-a',
      externalTransactionId: 'ext-loss',
      idempotencyKey: 'provider-a:ext-loss',
      payloadHash: 'hash-loss',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Loss,
      money,
    });

    expect(tx.affectsBalance()).toBe(false);
    expect(tx.ledgerDirectionFor()).toBeUndefined();
  });

  it('should require reference external transaction ID for REFUND and ROLLBACK', () => {
    expect(() => {
      WagerTransaction.create({
        id: 'tx-2',
        providerId: 'provider-a',
        externalTransactionId: 'ext-2',
        idempotencyKey: 'provider-a:ext-2',
        payloadHash: 'hash-def',
        walletId: 'wallet-1',
        playerId: 'player-1',
        roundId: 'round-1',
        gameId: 'slot-1',
        kind: WagerTransactionKind.Refund,
        money,
      });
    }).toThrow(WagerTransactionError);

    expect(() => {
      WagerTransaction.create({
        id: 'tx-2b',
        providerId: 'provider-a',
        externalTransactionId: 'ext-2b',
        idempotencyKey: 'provider-a:ext-2b',
        payloadHash: 'hash-def',
        walletId: 'wallet-1',
        playerId: 'player-1',
        roundId: 'round-1',
        gameId: 'slot-1',
        kind: WagerTransactionKind.Rollback,
        money,
      });
    }).toThrow(WagerTransactionError);
  });

  it('should reject creation with zero amount', () => {
    expect(() => {
      WagerTransaction.create({
        id: 'tx-zero',
        providerId: 'provider-a',
        externalTransactionId: 'ext-zero',
        idempotencyKey: 'provider-a:ext-zero',
        payloadHash: 'hash-zero',
        walletId: 'wallet-1',
        playerId: 'player-1',
        roundId: 'round-1',
        gameId: 'slot-1',
        kind: WagerTransactionKind.Bet,
        money: Money.zero('BRL'),
      });
    }).toThrow(WagerTransactionError);
  });

  it('should successfully transition to PROCESSED terminal state and prevent further transitions', () => {
    const tx = WagerTransaction.create({
      id: 'tx-3',
      providerId: 'provider-a',
      externalTransactionId: 'ext-3',
      idempotencyKey: 'provider-a:ext-3',
      payloadHash: 'hash-ghi',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Win,
      money,
    });

    const now = new Date();
    tx.markProcessed('ref-tx-1', now);
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.referenceTransactionId).toBe('ref-tx-1');
    expect(tx.processedAt).toEqual(now);
    expect(tx.isTerminal()).toBe(true);

    // Tentar transicionar a partir de estado terminal deve lançar erro
    expect(() => tx.reject(FailureCode.InsufficientFunds)).toThrow(WagerTransactionError);
    expect(() => tx.fail(FailureCode.InfraTransient)).toThrow(WagerTransactionError);
    expect(() => tx.markProcessed(undefined, new Date())).toThrow(WagerTransactionError);
    expect(() => tx.markPendingReference()).toThrow(WagerTransactionError);
  });

  it('should allow transition to PENDING_REFERENCE and then to terminal states', () => {
    const tx = WagerTransaction.create({
      id: 'tx-ref',
      providerId: 'provider-a',
      externalTransactionId: 'ext-ref',
      idempotencyKey: 'provider-a:ext-ref',
      payloadHash: 'hash-ref',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Refund,
      money,
      referenceExternalTransactionId: 'ext-bet-origin',
    });

    expect(tx.status).toBe(WagerTransactionStatus.Pending);
    tx.markPendingReference();
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
    expect(tx.isTerminal()).toBe(false);

    // De PENDING_REFERENCE pode transicionar para PROCESSED
    tx.markProcessed('resolved-ref-id', new Date());
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.isTerminal()).toBe(true);
  });

  it('should correctly reject transaction with failureCode', () => {
    const tx = WagerTransaction.create({
      id: 'tx-rej',
      providerId: 'provider-a',
      externalTransactionId: 'ext-rej',
      idempotencyKey: 'provider-a:ext-rej',
      payloadHash: 'hash-rej',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Bet,
      money,
    });

    tx.reject(FailureCode.InsufficientFunds);
    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.isTerminal()).toBe(true);
  });

  it('should correctly fail transaction with failureCode', () => {
    const tx = WagerTransaction.create({
      id: 'tx-fail',
      providerId: 'provider-a',
      externalTransactionId: 'ext-fail',
      idempotencyKey: 'provider-a:ext-fail',
      payloadHash: 'hash-fail',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Bet,
      money,
    });

    tx.fail(FailureCode.InfraPermanent);
    expect(tx.status).toBe(WagerTransactionStatus.Failed);
    expect(tx.failureCode).toBe(FailureCode.InfraPermanent);
    expect(tx.isTerminal()).toBe(true);
  });

  it('should correctly rehydrate state without running creation validation', () => {
    const createdAt = new Date('2026-02-01T00:00:00Z');
    const processedAt = new Date('2026-02-01T00:01:00Z');

    const tx = WagerTransaction.rehydrate({
      id: 'tx-rehydrated',
      providerId: 'prov',
      externalTransactionId: 'ext-r',
      idempotencyKey: 'prov:ext-r',
      payloadHash: 'hash-r',
      walletId: 'w-1',
      playerId: 'p-1',
      roundId: 'r-1',
      gameId: 'g-1',
      kind: WagerTransactionKind.Win,
      money,
      status: WagerTransactionStatus.Processed,
      referenceTransactionId: 'ref-tx-99',
      processedAt,
      createdAt,
    });

    expect(tx.id).toBe('tx-rehydrated');
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.referenceTransactionId).toBe('ref-tx-99');
    expect(tx.processedAt).toEqual(processedAt);
    expect(tx.isTerminal()).toBe(true);
  });
});
