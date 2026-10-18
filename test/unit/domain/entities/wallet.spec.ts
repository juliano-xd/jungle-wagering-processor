import { describe, it, expect } from 'bun:test';
import { Wallet } from '../../../../src/domain/entities/wallet';
import { LedgerDirection } from '../../../../src/domain/entities/wallet-ledger-entry';
import { Money } from '../../../../src/domain/value-objects/money';
import { FailureCode, WagerTransactionError } from '../../../../src/domain/errors/wager-transaction.error';

describe('Wallet Aggregate Root', () => {
  const initialMoney = Money.from({ amount: '100.00', currency: 'BRL' });
  const playerId = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
  const walletId = '0192f291-27dd-7d3f-8071-5f8685deef37';

  it('should successfully open a wallet with initial balance and version 1', () => {
    const wallet = Wallet.open({
      id: walletId,
      playerId,
      initialBalance: initialMoney,
    });

    expect(wallet.id).toBe(walletId);
    expect(wallet.playerId).toBe(playerId);
    expect(wallet.balance.equals(initialMoney)).toBe(true);
    expect(wallet.currency).toBe('BRL');
    expect(wallet.version).toBe(1);
  });

  it('should successfully debit an amount and generate a balanced ledger entry', () => {
    const wallet = Wallet.open({ id: walletId, playerId, initialBalance: initialMoney });
    const debitAmount = Money.from({ amount: '30.00', currency: 'BRL' });

    const entry = wallet.debit(debitAmount, 'txn-debit-1');

    expect(wallet.balance.toJSON()).toEqual({ amount: '70.00', currency: 'BRL' });
    expect(wallet.version).toBe(2);
    expect(entry.money.toJSON()).toEqual({ amount: '30.00', currency: 'BRL' });
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.transactionId).toBe('txn-debit-1');
    expect(entry.balanceBefore.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(entry.balanceAfter.toJSON()).toEqual({ amount: '70.00', currency: 'BRL' });
    expect(entry.isBalanced()).toBe(true);
  });

  it('should prevent debiting an amount greater than the current balance (insufficient funds)', () => {
    const wallet = Wallet.open({ id: walletId, playerId, initialBalance: initialMoney });
    const debitAmount = Money.from({ amount: '150.00', currency: 'BRL' });

    expect(() => wallet.debit(debitAmount, 'txn-debit-2')).toThrow(WagerTransactionError);
    expect(wallet.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);
  });

  it('should successfully credit an amount and generate a balanced ledger entry', () => {
    const wallet = Wallet.open({ id: walletId, playerId, initialBalance: initialMoney });
    const creditAmount = Money.from({ amount: '50.00', currency: 'BRL' });

    const entry = wallet.credit(creditAmount, 'txn-credit-1');

    expect(wallet.balance.toJSON()).toEqual({ amount: '150.00', currency: 'BRL' });
    expect(wallet.version).toBe(2);
    expect(entry.money.toJSON()).toEqual({ amount: '50.00', currency: 'BRL' });
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.transactionId).toBe('txn-credit-1');
    expect(entry.balanceBefore.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(entry.balanceAfter.toJSON()).toEqual({ amount: '150.00', currency: 'BRL' });
    expect(entry.isBalanced()).toBe(true);
  });

  it('should prevent operations with currency mismatches', () => {
    const wallet = Wallet.open({ id: walletId, playerId, initialBalance: initialMoney });
    const wrongCurrency = Money.from({ amount: '10.00', currency: 'USD' });

    expect(() => wallet.debit(wrongCurrency, 'txn-err-1')).toThrow(WagerTransactionError);
    expect(() => wallet.credit(wrongCurrency, 'txn-err-2')).toThrow(WagerTransactionError);
  });

  it('should reject zero amount on debit and credit', () => {
    const wallet = Wallet.open({ id: walletId, playerId, initialBalance: initialMoney });
    const zero = Money.zero('BRL');

    expect(() => wallet.debit(zero, 'txn-zero-1')).toThrow(WagerTransactionError);
    expect(() => wallet.credit(zero, 'txn-zero-2')).toThrow(WagerTransactionError);
  });

  it('should apply rollback of a DEBIT by crediting the wallet', () => {
    const wallet = Wallet.open({ id: walletId, playerId, initialBalance: initialMoney });
    const amount = Money.from({ amount: '40.00', currency: 'BRL' });

    // Revertendo um débito -> gera crédito
    const entry = wallet.applyRollback(LedgerDirection.Debit, amount, 'txn-rollback-1');

    expect(wallet.balance.toJSON()).toEqual({ amount: '140.00', currency: 'BRL' });
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.money.toJSON()).toEqual({ amount: '40.00', currency: 'BRL' });
    expect(entry.isBalanced()).toBe(true);
  });

  it('should apply rollback of a CREDIT by debiting the wallet', () => {
    const wallet = Wallet.open({ id: walletId, playerId, initialBalance: initialMoney });
    const amount = Money.from({ amount: '40.00', currency: 'BRL' });

    // Revertendo um crédito -> gera débito
    const entry = wallet.applyRollback(LedgerDirection.Credit, amount, 'txn-rollback-2');

    expect(wallet.balance.toJSON()).toEqual({ amount: '60.00', currency: 'BRL' });
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.money.toJSON()).toEqual({ amount: '40.00', currency: 'BRL' });
    expect(entry.isBalanced()).toBe(true);
  });

  it('should reject rollback of a CREDIT if balance would become negative with distinct failure code', () => {
    const wallet = Wallet.open({ id: walletId, playerId, initialBalance: Money.from({ amount: '30.00', currency: 'BRL' }) });
    const rollbackAmount = Money.from({ amount: '50.00', currency: 'BRL' });

    let caughtError: any;
    try {
      wallet.applyRollback(LedgerDirection.Credit, rollbackAmount, 'txn-rb-fail');
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(WagerTransactionError);
    expect(caughtError.code).toBe(FailureCode.NegativeBalanceWouldResult);
    expect(wallet.balance.toJSON()).toEqual({ amount: '30.00', currency: 'BRL' });
  });

  it('should correctly rehydrate state without re-running transition logic', () => {
    const createdAt = new Date('2026-01-01T00:00:00Z');
    const updatedAt = new Date('2026-01-02T00:00:00Z');
    const wallet = Wallet.rehydrate({
      id: walletId,
      playerId,
      currency: 'BRL',
      balance: Money.from({ amount: '500.00', currency: 'BRL' }),
      version: 5,
      createdAt,
      updatedAt,
    });

    expect(wallet.id).toBe(walletId);
    expect(wallet.balance.toJSON()).toEqual({ amount: '500.00', currency: 'BRL' });
    expect(wallet.version).toBe(5);
    expect(wallet.createdAt).toEqual(createdAt);
    expect(wallet.updatedAt).toEqual(updatedAt);
  });
});
