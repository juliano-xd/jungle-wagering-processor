import { describe, it, expect } from 'bun:test';
import {
  WalletLedgerEntry,
  LedgerDirection,
} from '../../../src/domain/entities/wallet-ledger-entry.js';
import { Wallet } from '../../../src/domain/entities/wallet.js';
import { Money } from '../../../src/domain/value-objects/money.js';

/**
 * WalletLedgerEntry é estruturalmente imutável — sem setters de negócio.
 * A factory `create` valida a aritmética (`balanceBefore ± money = balanceAfter`).
 * Estes testes travam essa invariante.
 */
function makeWallet(): Wallet {
  return Wallet.open({
    id: crypto.randomUUID(),
    playerId: crypto.randomUUID(),
    initialBalance: Money.zero('BRL'),
  });
}

describe('WalletLedgerEntry.create — invariante de balanceamento', () => {
  it('DEBIT: balanceBefore - money = balanceAfter', () => {
    const entry = WalletLedgerEntry.create({
      id: crypto.randomUUID(),
      wallet: makeWallet(),
      transactionId: crypto.randomUUID(),
      direction: LedgerDirection.Debit,
      money: Money.from({ amount: '30.00', currency: 'BRL' }),
      balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
      balanceAfter: Money.from({ amount: '70.00', currency: 'BRL' }),
    });
    expect(entry.isBalanced()).toBe(true);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.money.toJSON()).toEqual({ amount: '30.00', currency: 'BRL' });
    expect(entry.balanceBefore.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(entry.balanceAfter.toJSON()).toEqual({ amount: '70.00', currency: 'BRL' });
  });

  it('CREDIT: balanceBefore + money = balanceAfter', () => {
    const entry = WalletLedgerEntry.create({
      id: crypto.randomUUID(),
      wallet: makeWallet(),
      transactionId: crypto.randomUUID(),
      direction: LedgerDirection.Credit,
      money: Money.from({ amount: '30.00', currency: 'BRL' }),
      balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
      balanceAfter: Money.from({ amount: '130.00', currency: 'BRL' }),
    });
    expect(entry.isBalanced()).toBe(true);
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  it('lança erro em DEBIT cujo balanceAfter não bate', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: crypto.randomUUID(),
        wallet: makeWallet(),
        transactionId: crypto.randomUUID(),
        direction: LedgerDirection.Debit,
        money: Money.from({ amount: '30.00', currency: 'BRL' }),
        balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
        balanceAfter: Money.from({ amount: '999.00', currency: 'BRL' }), // errado
      }),
    ).toThrow(/unbalanced|isBalanced/i);
  });

  it('lança erro em CREDIT cujo balanceAfter não bate', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: crypto.randomUUID(),
        wallet: makeWallet(),
        transactionId: crypto.randomUUID(),
        direction: LedgerDirection.Credit,
        money: Money.from({ amount: '30.00', currency: 'BRL' }),
        balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
        balanceAfter: Money.from({ amount: '50.00', currency: 'BRL' }), // errado
      }),
    ).toThrow(/unbalanced|isBalanced/i);
  });

  it('aceita movimento zerado (0.00 = before = after)', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: crypto.randomUUID(),
        wallet: makeWallet(),
        transactionId: crypto.randomUUID(),
        direction: LedgerDirection.Debit,
        money: Money.from({ amount: '0.00', currency: 'BRL' }),
        balanceBefore: Money.from({ amount: '10.00', currency: 'BRL' }),
        balanceAfter: Money.from({ amount: '10.00', currency: 'BRL' }),
      }),
    ).not.toThrow();
  });
});

describe('WalletLedgerEntry.rehydrate', () => {
  it('reconstrói sem revalidar balanceamento (estado já persistido)', () => {
    // Balanceamento inválido proposital: rehydrate NÃO valida.
    const entry = WalletLedgerEntry.rehydrate({
      id: crypto.randomUUID(),
      walletId: crypto.randomUUID(),
      transactionId: crypto.randomUUID(),
      direction: LedgerDirection.Debit,
      money: Money.from({ amount: '30.00', currency: 'BRL' }),
      balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
      balanceAfter: Money.from({ amount: '999.00', currency: 'BRL' }),
      createdAt: new Date(),
    });
    expect(entry.isBalanced()).toBe(false); // expõe inconsistência, não lança
    expect(entry.direction).toBe(LedgerDirection.Debit);
  });

  it('preserva createdAt', () => {
    const createdAt = new Date('2026-01-01T00:00:00Z');
    const entry = WalletLedgerEntry.rehydrate({
      id: crypto.randomUUID(),
      walletId: crypto.randomUUID(),
      transactionId: crypto.randomUUID(),
      direction: LedgerDirection.Credit,
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
      balanceBefore: Money.from({ amount: '0.00', currency: 'BRL' }),
      balanceAfter: Money.from({ amount: '10.00', currency: 'BRL' }),
      createdAt,
    });
    expect(entry.createdAt).toEqual(createdAt);
  });
});
