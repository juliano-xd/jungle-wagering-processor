import { describe, it, expect } from 'bun:test';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/entities/wager-transaction.js';
import { LedgerDirection } from '../../src/domain/entities/wallet-ledger-entry.js';
import { Money } from '../../src/domain/value-objects/money.js';
import { WagerTransactionError } from '../../src/domain/errors/wager-transaction.error.js';

function makeTx(
  kind: WagerTransactionKind,
  overrides: Partial<{
    money: Money;
    referenceExternalTransactionId: string;
    payloadHash: string;
  }> = {},
): WagerTransaction {
  return WagerTransaction.create({
    id: crypto.randomUUID(),
    providerId: 'prov-1',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'prov-1:ext-1',
    payloadHash: overrides.payloadHash ?? 'hash',
    walletId: crypto.randomUUID(),
    playerId: crypto.randomUUID(),
    roundId: 'round-1',
    gameId: 'slot-1',
    kind,
    money: overrides.money ?? Money.from({ amount: '10.00', currency: 'BRL' }),
    referenceExternalTransactionId: overrides.referenceExternalTransactionId,
  });
}

describe('WagerTransaction.create', () => {
  it('cria BET em PENDING', () => {
    const tx = makeTx(WagerTransactionKind.Bet);
    expect(tx.status).toBe(WagerTransactionStatus.Pending);
    expect(tx.money.toJSON()).toEqual({ amount: '10.00', currency: 'BRL' });
  });

  it('lança ZERO_AMOUNT quando money é zero', () => {
    try {
      makeTx(WagerTransactionKind.Bet, {
        money: Money.from({ amount: '0.00', currency: 'BRL' }),
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as WagerTransactionError).code).toBe('ZERO_AMOUNT');
    }
  });

  it('REFUND sem referência lança OPERATION_REQUIRES_REFERENCE', () => {
    try {
      makeTx(WagerTransactionKind.Refund);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as WagerTransactionError).code).toBe('OPERATION_REQUIRES_REFERENCE');
    }
  });

  it('ROLLBACK sem referência lança OPERATION_REQUIRES_REFERENCE', () => {
    try {
      makeTx(WagerTransactionKind.Rollback);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as WagerTransactionError).code).toBe('OPERATION_REQUIRES_REFERENCE');
    }
  });

  it('REFUND com referência é aceito', () => {
    expect(() =>
      makeTx(WagerTransactionKind.Refund, {
        referenceExternalTransactionId: 'original-bet',
      }),
    ).not.toThrow();
  });

  it('ROLLBACK com referência é aceito', () => {
    expect(() =>
      makeTx(WagerTransactionKind.Rollback, {
        referenceExternalTransactionId: 'original-win',
      }),
    ).not.toThrow();
  });
});

describe('WagerTransaction.requiresReference', () => {
  for (const kind of [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Loss, WagerTransactionKind.Opening]) {
    it(`${kind} → false`, () => {
      expect(makeTx(kind).requiresReference()).toBe(false);
    });
  }

  it('REFUND → true', () => {
    const tx = makeTx(WagerTransactionKind.Refund, {
      referenceExternalTransactionId: 'ref',
    });
    expect(tx.requiresReference()).toBe(true);
  });

  it('ROLLBACK → true', () => {
    const tx = makeTx(WagerTransactionKind.Rollback, {
      referenceExternalTransactionId: 'ref',
    });
    expect(tx.requiresReference()).toBe(true);
  });
});

describe('WagerTransaction.affectsBalance', () => {
  it('BET → true', () => {
    expect(makeTx(WagerTransactionKind.Bet).affectsBalance()).toBe(true);
  });
  it('WIN → true', () => {
    expect(makeTx(WagerTransactionKind.Win).affectsBalance()).toBe(true);
  });
  it('LOSS → false', () => {
    expect(makeTx(WagerTransactionKind.Loss).affectsBalance()).toBe(false);
  });
  it('OPENING → true', () => {
    expect(makeTx(WagerTransactionKind.Opening).affectsBalance()).toBe(true);
  });
});

describe('WagerTransaction — transições de estado', () => {
  it('markProcessed a partir de PENDING', () => {
    const tx = makeTx(WagerTransactionKind.Bet);
    tx.markProcessed(undefined, new Date());
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.processedAt).toBeDefined();
    expect(tx.isTerminal()).toBe(true);
  });

  it('markProcessed a partir de PENDING_REFERENCE', () => {
    const tx = makeTx(WagerTransactionKind.Refund, {
      referenceExternalTransactionId: 'ref',
    });
    tx.markPendingReference();
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
    tx.markProcessed('ref-tx-id', new Date());
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.referenceTransactionId).toBe('ref-tx-id');
  });

  it('markProcessed duas vezes lança INVALID_STATE_TRANSITION', () => {
    const tx = makeTx(WagerTransactionKind.Bet);
    tx.markProcessed(undefined, new Date());
    try {
      tx.markProcessed(undefined, new Date());
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as WagerTransactionError).code).toBe('INVALID_STATE_TRANSITION');
    }
  });

  it('reject a partir de PENDING', () => {
    const tx = makeTx(WagerTransactionKind.Bet);
    tx.reject('INSUFFICIENT_FUNDS' as any);
    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.failureCode).toBe('INSUFFICIENT_FUNDS');
  });

  it('reject a partir de PROCESSED lança INVALID_STATE_TRANSITION', () => {
    const tx = makeTx(WagerTransactionKind.Bet);
    tx.markProcessed(undefined, new Date());
    try {
      tx.reject('ANY' as any);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as WagerTransactionError).code).toBe('INVALID_STATE_TRANSITION');
    }
  });

  it('fail a partir de PENDING', () => {
    const tx = makeTx(WagerTransactionKind.Bet);
    tx.fail('INFRA_PERMANENT' as any);
    expect(tx.status).toBe(WagerTransactionStatus.Failed);
    expect(tx.isTerminal()).toBe(true);
  });

  it('markPendingReference a partir de PROCESSED lança INVALID_STATE_TRANSITION', () => {
    const tx = makeTx(WagerTransactionKind.Bet);
    tx.markProcessed(undefined, new Date());
    try {
      tx.markPendingReference();
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as WagerTransactionError).code).toBe('INVALID_STATE_TRANSITION');
    }
  });
});

describe('WagerTransaction.ledgerDirectionFor', () => {
  it('BET → Debit', () => {
    expect(makeTx(WagerTransactionKind.Bet).ledgerDirectionFor()).toBe(
      LedgerDirection.Debit,
    );
  });

  it('WIN → Credit', () => {
    expect(makeTx(WagerTransactionKind.Win).ledgerDirectionFor()).toBe(
      LedgerDirection.Credit,
    );
  });

  it('OPENING → Credit', () => {
    expect(makeTx(WagerTransactionKind.Opening).ledgerDirectionFor()).toBe(
      LedgerDirection.Credit,
    );
  });

  it('REFUND → Credit', () => {
    const tx = makeTx(WagerTransactionKind.Refund, {
      referenceExternalTransactionId: 'ref',
    });
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  it('LOSS → undefined', () => {
    expect(makeTx(WagerTransactionKind.Loss).ledgerDirectionFor()).toBeUndefined();
  });

  it('ROLLBACK de BET (Debit) → Credit', () => {
    const betRef = makeTx(WagerTransactionKind.Bet);
    const rb = makeTx(WagerTransactionKind.Rollback, {
      referenceExternalTransactionId: 'bet-ext-id',
    });
    expect(rb.ledgerDirectionFor(betRef)).toBe(LedgerDirection.Credit);
  });

  it('ROLLBACK de WIN (Credit) → Debit', () => {
    const winRef = makeTx(WagerTransactionKind.Win);
    const rb = makeTx(WagerTransactionKind.Rollback, {
      referenceExternalTransactionId: 'win-ext-id',
    });
    expect(rb.ledgerDirectionFor(winRef)).toBe(LedgerDirection.Debit);
  });
});

describe('WagerTransaction.matchesPayload', () => {
  it('retorna true para hash idêntico', () => {
    const tx = makeTx(WagerTransactionKind.Bet, { payloadHash: 'abc' });
    expect(tx.matchesPayload('abc')).toBe(true);
    expect(tx.matchesPayload('xyz')).toBe(false);
  });
});

describe('WagerTransaction.schedulePendingReferenceRetry', () => {
  it('incrementa attempts quando em PENDING_REFERENCE', () => {
    const tx = makeTx(WagerTransactionKind.Refund, {
      referenceExternalTransactionId: 'ref',
    });
    tx.markPendingReference();
    expect(tx.pendingReferenceAttempts).toBe(0);

    const ok = tx.schedulePendingReferenceRetry(new Date(Date.now() + 5000));
    expect(ok).toBe(true);
    expect(tx.pendingReferenceAttempts).toBe(1);
    expect(tx.pendingReferenceNextAttemptAt).toBeDefined();
  });

  it('retorna false quando não está em PENDING_REFERENCE', () => {
    const tx = makeTx(WagerTransactionKind.Bet);
    const ok = tx.schedulePendingReferenceRetry(new Date());
    expect(ok).toBe(false);
    expect(tx.pendingReferenceAttempts).toBe(0);
  });
});
