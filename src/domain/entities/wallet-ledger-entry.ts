import { EntitySchema } from '@mikro-orm/core';
import { Money } from '../value-objects/money.js';
import { Wallet } from './wallet.js';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export interface CreateLedgerEntryProps {
  id: string;
  wallet: Wallet;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
}

/**
 * WalletLedgerEntry é IMUTÁVEL por construção: sem campos mutáveis e sem métodos
 * de transição. A factory `create` valida a aritmética do lançamento
 * (balanceBefore ± money === balanceAfter).
 *
 * ⚠️ A imutabilidade REAL (contra UPDATE/DELETE) é garantida pelo trigger
 * `trg_wallet_ledger_immutable` criado via migration — não apenas pela classe.
 */
export class WalletLedgerEntry {
  id!: string;
  wallet!: Wallet;
  transactionId!: string;
  direction!: LedgerDirection;
  moneyAmount!: string;
  moneyCurrency!: string;
  balanceBeforeAmount!: string;
  balanceBeforeCurrency!: string;
  balanceAfterAmount!: string;
  balanceAfterCurrency!: string;
  createdAt: Date = new Date();

  constructor() {}

  /** Money derivado das colunas amount/currency. */
  get money(): Money {
    return Money.rehydrate({
      amount: this.moneyAmount ?? '0.00',
      currency: this.moneyCurrency ?? 'BRL',
    });
  }

  /** Hidratação do ORM — não chamar após `rehydrate()`. A imutabilidade real é garantida pelo trigger do banco. */
  set money(m: Money) {
    const p = m.toJSON();
    this.moneyAmount = p.amount;
    this.moneyCurrency = p.currency;
  }

  /** Hidratação do ORM — não chamar após `rehydrate()`. */
  get balanceBefore(): Money {
    return Money.rehydrate({
      amount: this.balanceBeforeAmount ?? '0.00',
      currency: this.balanceBeforeCurrency ?? 'BRL',
    });
  }
  set balanceBefore(m: Money) {
    const p = m.toJSON();
    this.balanceBeforeAmount = p.amount;
    this.balanceBeforeCurrency = p.currency;
  }

  get balanceAfter(): Money {
    return Money.rehydrate({
      amount: this.balanceAfterAmount ?? '0.00',
      currency: this.balanceAfterCurrency ?? 'BRL',
    });
  }
  set balanceAfter(m: Money) {
    const p = m.toJSON();
    this.balanceAfterAmount = p.amount;
    this.balanceAfterCurrency = p.currency;
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = new WalletLedgerEntry();
    entry.id = props.id;
    entry.wallet = props.wallet;
    entry.transactionId = props.transactionId;
    entry.direction = props.direction;
    entry.money = props.money;
    entry.balanceBefore = props.balanceBefore;
    entry.balanceAfter = props.balanceAfter;

    if (!entry.isBalanced()) {
      throw new Error(
        `Ledger entry is unbalanced: ${entry.balanceBefore} ${
          entry.direction === LedgerDirection.Debit ? '-' : '+'
        } ${entry.money} != ${entry.balanceAfter}`,
      );
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    const entry = new WalletLedgerEntry();
    entry.id = state.id;
    entry.transactionId = state.transactionId;
    entry.direction = state.direction;
    entry.money = state.money;
    entry.balanceBefore = state.balanceBefore;
    entry.balanceAfter = state.balanceAfter;
    entry.createdAt = state.createdAt;
    return entry;
  }

  /** balanceBefore ± money === balanceAfter. */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Debit
        ? this.balanceBefore.subtract(this.money)
        : this.balanceBefore.add(this.money);
    return expected.equals(this.balanceAfter);
  }
}

export const WalletLedgerEntrySchema = new EntitySchema<WalletLedgerEntry>({
  class: WalletLedgerEntry,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true, defaultRaw: 'gen_random_uuid()' },
    wallet: { kind: 'm:1', type: 'Wallet', entity: () => Wallet, fieldName: 'wallet_id' },
    transactionId: { type: 'uuid', fieldName: 'transaction_id' },
    direction: { type: 'string', fieldName: 'direction' },
    // ✅ corrigido: sintaxe MikroORM 6 (era 'decimal(18,2)' → numeric(10,0))
    moneyAmount: { type: 'decimal', precision: 18, scale: 2, fieldName: 'money_amount' },
    moneyCurrency: { type: 'string', length: 3, fieldName: 'money_currency' },
    balanceBeforeAmount: {
      type: 'decimal',
      precision: 18,
      scale: 2,
      fieldName: 'balance_before_amount',
    },
    balanceBeforeCurrency: {
      type: 'string',
      length: 3,
      fieldName: 'balance_before_currency',
    },
    balanceAfterAmount: {
      type: 'decimal',
      precision: 18,
      scale: 2,
      fieldName: 'balance_after_amount',
    },
    balanceAfterCurrency: {
      type: 'string',
      length: 3,
      fieldName: 'balance_after_currency',
    },
    createdAt: { type: 'Date', fieldName: 'created_at', onCreate: () => new Date() },
  } as any,
  indexes: [
    { name: 'idx_ledger_wallet_created', properties: ['wallet', 'createdAt'] },
  ],
});
