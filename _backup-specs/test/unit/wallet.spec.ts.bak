import { describe, it, expect } from 'bun:test';
import { Wallet } from '../../src/domain/entities/wallet.js';
import { Money } from '../../src/domain/value-objects/money.js';
import { WagerTransactionError } from '../../src/domain/errors/wager-transaction.error.js';
import { LedgerDirection } from '../../src/domain/entities/wallet-ledger-entry.js';

/**
 * Helper: cria wallet com saldo desejado via `credit` (simulando opening).
 * `version` é resetado para 1 após — reflete o comportamento da `createWallet`.
 */
function makeWallet(balance = '100.00'): Wallet {
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

describe('Wallet.open', () => {
  it('cria wallet com saldo zero e version 1', () => {
    const w = Wallet.open({
      id: 'wallet-id',
      playerId: 'player-id',
      initialBalance: Money.zero('BRL'),
    });
    expect(w.balance.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(w.version).toBe(1);
    expect(w.currency).toBe('BRL');
  });
});

describe('Wallet.debit', () => {
  it('reduz o saldo e retorna um ledger entry balanceado', () => {
    const w = makeWallet('100.00');
    const txId = crypto.randomUUID();
    const entry = w.debit(Money.from({ amount: '30.00', currency: 'BRL' }), txId);

    expect(w.balance.toJSON()).toEqual({ amount: '70.00', currency: 'BRL' });
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.money.toJSON()).toEqual({ amount: '30.00', currency: 'BRL' });
    expect(entry.balanceBefore.toJSON()).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
    expect(entry.balanceAfter.toJSON()).toEqual({ amount: '70.00', currency: 'BRL' });
    expect(entry.isBalanced()).toBe(true);
    expect(entry.transactionId).toBe(txId);
  });

  it('incrementa version', () => {
    const w = makeWallet('100.00');
    const before = w.version;
    w.debit(Money.from({ amount: '10.00', currency: 'BRL' }), crypto.randomUUID());
    expect(w.version).toBe(before + 1);
  });

  it('lança INSUFFICIENT_FUNDS quando saldo é insuficiente', () => {
    const w = makeWallet('10.00');
    try {
      w.debit(Money.from({ amount: '20.00', currency: 'BRL' }), crypto.randomUUID());
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(WagerTransactionError);
      expect((e as WagerTransactionError).code).toBe('INSUFFICIENT_FUNDS');
    }
  });

  it('lança ZERO_AMOUNT em valor zero', () => {
    const w = makeWallet('100.00');
    try {
      w.debit(Money.from({ amount: '0.00', currency: 'BRL' }), crypto.randomUUID());
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as WagerTransactionError).code).toBe('ZERO_AMOUNT');
    }
  });

  it('lança CURRENCY_MISMATCH em moeda diferente', () => {
    const w = makeWallet('100.00');
    try {
      w.debit(Money.from({ amount: '10.00', currency: 'USD' }), crypto.randomUUID());
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as WagerTransactionError).code).toBe('CURRENCY_MISMATCH');
    }
  });

  it('não modifica saldo nem version em erro', () => {
    const w = makeWallet('10.00');
    const balanceBefore = w.balance.toJSON();
    const versionBefore = w.version;
    try {
      w.debit(Money.from({ amount: '20.00', currency: 'BRL' }), crypto.randomUUID());
    } catch {
      // esperado
    }
    expect(w.balance.toJSON()).toEqual(balanceBefore);
    expect(w.version).toBe(versionBefore);
  });

  it('permite debitar exatamente o saldo (fica zero)', () => {
    const w = makeWallet('50.00');
    w.debit(Money.from({ amount: '50.00', currency: 'BRL' }), crypto.randomUUID());
    expect(w.balance.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
  });
});

describe('Wallet.credit', () => {
  it('aumenta o saldo e retorna ledger entry balanceado', () => {
    const w = makeWallet('50.00');
    const entry = w.credit(
      Money.from({ amount: '30.00', currency: 'BRL' }),
      crypto.randomUUID(),
    );
    expect(w.balance.toJSON()).toEqual({ amount: '80.00', currency: 'BRL' });
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.isBalanced()).toBe(true);
  });

  it('incrementa version', () => {
    const w = makeWallet('50.00');
    const before = w.version;
    w.credit(Money.from({ amount: '10.00', currency: 'BRL' }), crypto.randomUUID());
    expect(w.version).toBe(before + 1);
  });

  it('lança ZERO_AMOUNT em valor zero', () => {
    const w = makeWallet('50.00');
    try {
      w.credit(Money.from({ amount: '0.00', currency: 'BRL' }), crypto.randomUUID());
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as WagerTransactionError).code).toBe('ZERO_AMOUNT');
    }
  });

  it('lança CURRENCY_MISMATCH em moeda diferente', () => {
    const w = makeWallet('50.00');
    try {
      w.credit(Money.from({ amount: '10.00', currency: 'USD' }), crypto.randomUUID());
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as WagerTransactionError).code).toBe('CURRENCY_MISMATCH');
    }
  });
});

describe('Wallet.applyRollback', () => {
  it('reverter um DEBIT credita a wallet', () => {
    const w = makeWallet('100.00');
    w.debit(Money.from({ amount: '30.00', currency: 'BRL' }), crypto.randomUUID());
    expect(w.balance.toJSON()).toEqual({ amount: '70.00', currency: 'BRL' });

    const rb = w.applyRollback(
      LedgerDirection.Debit,
      Money.from({ amount: '30.00', currency: 'BRL' }),
      crypto.randomUUID(),
    );
    expect(w.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(rb.direction).toBe(LedgerDirection.Credit);
    expect(rb.isBalanced()).toBe(true);
  });

  it('reverter um CREDIT debita a wallet', () => {
    const w = makeWallet('100.00');
    w.credit(Money.from({ amount: '30.00', currency: 'BRL' }), crypto.randomUUID());
    expect(w.balance.toJSON()).toEqual({ amount: '130.00', currency: 'BRL' });

    const rb = w.applyRollback(
      LedgerDirection.Credit,
      Money.from({ amount: '30.00', currency: 'BRL' }),
      crypto.randomUUID(),
    );
    expect(w.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(rb.direction).toBe(LedgerDirection.Debit);
    expect(rb.isBalanced()).toBe(true);
  });

  it('reverter CREDIT que causaria saldo negativo lança NEGATIVE_BALANCE_WOULD_RESULT', () => {
    const w = makeWallet('10.00');
    w.credit(Money.from({ amount: '5.00', currency: 'BRL' }), crypto.randomUUID());
    expect(w.balance.toJSON()).toEqual({ amount: '15.00', currency: 'BRL' });

    try {
      w.applyRollback(
        LedgerDirection.Credit,
        Money.from({ amount: '20.00', currency: 'BRL' }),
        crypto.randomUUID(),
      );
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as WagerTransactionError).code).toBe('NEGATIVE_BALANCE_WOULD_RESULT');
    }
    expect(w.balance.toJSON()).toEqual({ amount: '15.00', currency: 'BRL' });
  });

  it('reverter CREDIT com amount maior que saldo NÃO altera o saldo', () => {
    const w = makeWallet('10.00');
    try {
      w.applyRollback(
        LedgerDirection.Credit,
        Money.from({ amount: '999.00', currency: 'BRL' }),
        crypto.randomUUID(),
      );
    } catch {
      // esperado
    }
    expect(w.balance.toJSON()).toEqual({ amount: '10.00', currency: 'BRL' });
  });
});
