import { EntitySchema } from '@mikro-orm/core';
import { Money } from '../value-objects/money.js';
import { WalletLedgerEntry, LedgerDirection } from './wallet-ledger-entry.js';
import { WagerTransactionError } from '../errors/wager-transaction.error.js';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
}

/**
 * Wallet é a Aggregate Root.
 *
 * Invariantes:
 * - no máximo uma wallet por `playerId + currency` (unique constraint);
 * - saldo nunca negativo (CHECK no banco);
 * - toda alteração de saldo gera um lançamento no ledger (e vice-versa);
 * - a moeda da operação deve ser igual à moeda da wallet;
 * - `version` inicia em 1 e incrementa somente quando o saldo muda.
 *
 * Persistência: `balance` é derivado das colunas `balanceAmount`/
 * `balanceCurrency`. O ORM mapeia apenas essas colunas; o getter
 * `balance` reconstrói o value object Money.
 */
export class Wallet {
  id!: string;
  playerId!: string;
  currency!: string;
  balanceAmount!: string;
  balanceCurrency!: string;
  version: number = 1;
  createdAt: Date = new Date();
  updatedAt: Date = new Date();

  constructor() {}

  /** Saldo como value object Money (derivado das colunas amount/currency). */
  get balance(): Money {
    return Money.rehydrate({
      amount: this.balanceAmount ?? '0.00',
      currency: this.balanceCurrency ?? this.currency ?? 'BRL',
    });
  }
  set balance(m: Money) {
    const props = m.toJSON();
    this.balanceAmount = props.amount;
    this.balanceCurrency = props.currency;
    this.currency = props.currency;
  }

  static open(props: CreateWalletProps): Wallet {
    const wallet = new Wallet();
    wallet.id = props.id;
    wallet.playerId = props.playerId;
    wallet.balance = props.initialBalance;
    wallet.version = 1;
    return wallet;
  }

  /** Reconstrói a partir da persistência — não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    const wallet = new Wallet();
    wallet.id = state.id;
    wallet.playerId = state.playerId;
    wallet.currency = state.currency;
    wallet.balance = state.balance;
    wallet.version = state.version;
    wallet.createdAt = state.createdAt;
    wallet.updatedAt = state.updatedAt;
    return wallet;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.balance.currency) {
      throw WagerTransactionError.currencyMismatch();
    }
  }

  /**
   * Aplica um débito e retorna o lançamento do ledger correspondente.
   * O caller é responsável por persistir wallet + entry na mesma transação
   * e por garantir concorrência (lock pessimista).
   */
  debit(amount: Money, transactionId: string): WalletLedgerEntry {
    this.assertSameCurrency(amount);
    if (amount.isZero()) throw WagerTransactionError.zeroAmount();
    if (this.balance.isLessThan(amount)) {
      throw WagerTransactionError.insufficientFunds();
    }
    const balanceBefore = this.balance;
    this.balance = this.balance.subtract(amount);
    this.version += 1;
    this.updatedAt = new Date();
    return WalletLedgerEntry.create({
      id: '',
      wallet: this,
      transactionId,
      direction: LedgerDirection.Debit,
      money: amount,
      balanceBefore,
      balanceAfter: this.balance,
    });
  }

  /**
   * Aplica um crédito e retorna o lançamento do ledger correspondente.
   */
  credit(amount: Money, transactionId: string): WalletLedgerEntry {
    this.assertSameCurrency(amount);
    if (amount.isZero()) throw WagerTransactionError.zeroAmount();
    const balanceBefore = this.balance;
    this.balance = this.balance.add(amount);
    this.version += 1;
    this.updatedAt = new Date();
    return WalletLedgerEntry.create({
      id: '',
      wallet: this,
      transactionId,
      direction: LedgerDirection.Credit,
      money: amount,
      balanceBefore,
      balanceAfter: this.balance,
    });
  }

  /**
   * Reverte um lançamento já aplicado (usado por ROLLBACK).
   * Se reverte DEBIT -> CREDITA a wallet.
   * Se reverte CREDIT -> DEBITA a wallet (e falha com NEGATIVE_BALANCE_WOULD_RESULT se saldo insuficiente).
   */
  applyRollback(
    directionToRevert: LedgerDirection,
    amount: Money,
    transactionId: string,
  ): WalletLedgerEntry {
    this.assertSameCurrency(amount);
    if (amount.isZero()) throw WagerTransactionError.zeroAmount();

    if (directionToRevert === LedgerDirection.Debit) {
      return this.credit(amount, transactionId);
    }

    // Revertendo um crédito: devemos debitar
    if (this.balance.isLessThan(amount)) {
      throw WagerTransactionError.negativeBalanceWouldResult();
    }
    return this.debit(amount, transactionId);
  }
}

export const WalletSchema = new EntitySchema<Wallet>({
  class: Wallet,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true, defaultRaw: 'gen_random_uuid()' },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    currency: { type: 'string', length: 3 },
    // ✅ corrigido: sintaxe MikroORM 6 (era 'decimal(18,2)' → numeric(10,0))
    balanceAmount: { type: 'decimal', precision: 18, scale: 2, fieldName: 'balance_amount' },
    balanceCurrency: { type: 'string', length: 3, fieldName: 'balance_currency' },
    balance: { type: 'any', persist: false },
    version: { type: 'number', default: 1 },
    createdAt: { type: 'Date', fieldName: 'created_at', onCreate: () => new Date() },
    updatedAt: {
      type: 'Date',
      fieldName: 'updated_at',
      onCreate: () => new Date(),
      onUpdate: () => new Date(),
    },
  },
  checks: [
    { name: 'chk_balance_non_negative', expression: 'balance_amount >= 0' },
  ],
  uniques: [
    { properties: ['playerId', 'currency'] },
  ],
});
