import { describe, it, expect } from 'bun:test';
import { applyBalanceEffect } from '../../../src/application/services/wallet-effect.js';
import { Wallet } from '../../../src/domain/entities/wallet.js';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../../../src/domain/entities/wager-transaction.js';
import { Money } from '../../../src/domain/value-objects/money.js';
import { LedgerDirection } from '../../../src/domain/entities/wallet-ledger-entry.js';
import {
  FailureCode,
  WagerTransactionError,
} from '../../../src/domain/errors/wager-transaction.error.js';

/**
 * Cria wallet com saldo desejado.
 *
 * ⚠️ `Wallet.credit` PROÍBE amount zero. Para `balance='0.00'`, apenas abre
 * a wallet (sem `credit`). Bug pego por TDD: helper antigo chamava
 * `credit(0.00)` e estourava em `ZERO_AMOUNT`.
 */
function makeWallet(balance: string): Wallet {
  const w = Wallet.open({
    id: crypto.randomUUID(),
    playerId: crypto.randomUUID(),
    initialBalance: Money.zero('BRL'),
  });
  if (balance !== '0.00') {
    w.credit(Money.from({ amount: balance, currency: 'BRL' }), crypto.randomUUID());
    w.version = 1;
  }
  return w;
}

function makeTx(
  kind: WagerTransactionKind,
  overrides: { money?: Money; referenceExternalTransactionId?: string } = {},
): WagerTransaction {
  return WagerTransaction.create({
    id: crypto.randomUUID(),
    providerId: 'prov-1',
    externalTransactionId: `ext-${crypto.randomUUID()}`,
    idempotencyKey: `prov-1:ext-${crypto.randomUUID()}`,
    payloadHash: 'hash',
    walletId: crypto.randomUUID(),
    playerId: crypto.randomUUID(),
    roundId: 'round-1',
    gameId: 'slot-1',
    kind,
    money: overrides.money ?? Money.from({ amount: '20.00', currency: 'BRL' }),
    referenceExternalTransactionId: overrides.referenceExternalTransactionId,
  });
}

describe('applyBalanceEffect — BET (debit)', () => {
  it('debita o saldo e retorna ledger DEBIT', () => {
    const wallet = makeWallet('100.00');
    const tx = makeTx(WagerTransactionKind.Bet, {
      money: Money.from({ amount: '30.00', currency: 'BRL' }),
    });

    const entry = applyBalanceEffect(wallet, tx, null);
    expect(wallet.balance.toJSON()).toEqual({ amount: '70.00', currency: 'BRL' });
    expect(entry).toBeDefined();
    expect(entry!.direction).toBe(LedgerDirection.Debit);
    expect(entry!.money.toJSON()).toEqual({ amount: '30.00', currency: 'BRL' });
  });

  it('propaga INSUFFICIENT_FUNDS do Wallet.debit', () => {
    const wallet = makeWallet('10.00');
    const tx = makeTx(WagerTransactionKind.Bet, {
      money: Money.from({ amount: '50.00', currency: 'BRL' }),
    });
    try {
      applyBalanceEffect(wallet, tx, null);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(WagerTransactionError);
      expect((e as WagerTransactionError).code).toBe(FailureCode.InsufficientFunds);
    }
  });
});

describe('applyBalanceEffect — WIN (credit)', () => {
  it('credita e retorna ledger CREDIT', () => {
    const wallet = makeWallet('100.00');
    const tx = makeTx(WagerTransactionKind.Win, {
      money: Money.from({ amount: '30.00', currency: 'BRL' }),
    });
    const entry = applyBalanceEffect(wallet, tx, null);
    expect(wallet.balance.toJSON()).toEqual({ amount: '130.00', currency: 'BRL' });
    expect(entry!.direction).toBe(LedgerDirection.Credit);
  });
});

describe('applyBalanceEffect — OPENING (credit)', () => {
  it('credita e retorna ledger CREDIT (wallet zerada)', () => {
    // makeWallet('0.00') agora abre wallet SEM chamar credit(0.00).
    const wallet = makeWallet('0.00');
    const tx = makeTx(WagerTransactionKind.Opening, {
      money: Money.from({ amount: '100.00', currency: 'BRL' }),
    });
    const entry = applyBalanceEffect(wallet, tx, null);
    expect(wallet.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(entry!.direction).toBe(LedgerDirection.Credit);
  });
});

describe('applyBalanceEffect — REFUND (credit)', () => {
  it('credita o valor e retorna ledger CREDIT', () => {
    const wallet = makeWallet('50.00');
    const ref = makeTx(WagerTransactionKind.Bet);
    const tx = makeTx(WagerTransactionKind.Refund, {
      money: Money.from({ amount: '20.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'ref-ext',
    });
    const entry = applyBalanceEffect(wallet, tx, ref);
    expect(wallet.balance.toJSON()).toEqual({ amount: '70.00', currency: 'BRL' });
    expect(entry!.direction).toBe(LedgerDirection.Credit);
  });
});

describe('applyBalanceEffect — LOSS (no-op)', () => {
  it('não altera saldo e retorna undefined', () => {
    const wallet = makeWallet('100.00');
    const tx = makeTx(WagerTransactionKind.Loss);
    const entry = applyBalanceEffect(wallet, tx, null);
    expect(entry).toBeUndefined();
    expect(wallet.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
  });
});

describe('applyBalanceEffect — ROLLBACK', () => {
  it('reverter BET (DEBIT) → credit', () => {
    const wallet = makeWallet('70.00');
    const betRef = makeTx(WagerTransactionKind.Bet, {
      money: Money.from({ amount: '30.00', currency: 'BRL' }),
    });
    const rb = makeTx(WagerTransactionKind.Rollback, {
      money: Money.from({ amount: '30.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'bet-ext',
    });
    const entry = applyBalanceEffect(wallet, rb, betRef);
    expect(wallet.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(entry!.direction).toBe(LedgerDirection.Credit);
  });

  it('reverter WIN (CREDIT) → debit', () => {
    const wallet = makeWallet('130.00');
    const winRef = makeTx(WagerTransactionKind.Win, {
      money: Money.from({ amount: '30.00', currency: 'BRL' }),
    });
    const rb = makeTx(WagerTransactionKind.Rollback, {
      money: Money.from({ amount: '30.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'win-ext',
    });
    const entry = applyBalanceEffect(wallet, rb, winRef);
    expect(wallet.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(entry!.direction).toBe(LedgerDirection.Debit);
  });

  it('reverter WIN com saldo insuficiente → NEGATIVE_BALANCE_WOULD_RESULT', () => {
    // Saldo atual 15.00; reverter WIN de 100.00 produziria -85.00.
    const wallet = makeWallet('15.00');
    const winRef = makeTx(WagerTransactionKind.Win, {
      money: Money.from({ amount: '100.00', currency: 'BRL' }),
    });
    const rb = makeTx(WagerTransactionKind.Rollback, {
      money: Money.from({ amount: '100.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'win-ext',
    });

    // Checa `error.code` (mais robusto que string matching — a mensagem
    // exata do erro é `"Reversal would produce a negative balance"`).
    try {
      applyBalanceEffect(wallet, rb, winRef);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(WagerTransactionError);
      expect((e as WagerTransactionError).code).toBe(
        FailureCode.NegativeBalanceWouldResult,
      );
    }

    // Saldo NÃO muda após rejeição
    expect(wallet.balance.toJSON()).toEqual({ amount: '15.00', currency: 'BRL' });
  });

  it('falha explicitamente se reference=null (defesa em profundidade)', () => {
    // O service NUNCA passa null em ROLLBACK (garante requiresReference +
    // resolveReferenceTx + PENDING_REFERENCE). Se chegar null, é bug de
    // estado — falha com mensagem clara, não com TypeError opaco.
    const wallet = makeWallet('100.00');
    const rb = makeTx(WagerTransactionKind.Rollback, {
      money: Money.from({ amount: '30.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'orphan-ref',
    });
    expect(() => applyBalanceEffect(wallet, rb, null)).toThrow(
      /ROLLBACK requires a reference transaction/i,
    );
    // E não altera o saldo
    expect(wallet.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
  });
});

describe('applyBalanceEffect — imutabilidade', () => {
  it('múltiplas aplicações acumulam corretamente', () => {
    const wallet = makeWallet('100.00');
    applyBalanceEffect(
      wallet,
      makeTx(WagerTransactionKind.Bet, {
        money: Money.from({ amount: '20.00', currency: 'BRL' }),
      }),
      null,
    );
    applyBalanceEffect(
      wallet,
      makeTx(WagerTransactionKind.Bet, {
        money: Money.from({ amount: '30.00', currency: 'BRL' }),
      }),
      null,
    );
    expect(wallet.balance.toJSON()).toEqual({ amount: '50.00', currency: 'BRL' });
  });
});
