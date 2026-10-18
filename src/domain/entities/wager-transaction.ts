import { Money } from '../value-objects/money.js';
import { FailureCode, WagerTransactionError } from '../errors/wager-transaction.error.js';
import { LedgerDirection } from './wallet-ledger-entry.js';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  pendingReferenceAttempts: number;
  pendingReferenceNextAttemptAt?: Date;
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

/**
 * WagerTransaction: nasce em PENDING e transiciona para estados terminais
 * (PROCESSED, REJECTED, FAILED) ou PENDING_REFERENCE.
 *
 * Transições válidas:
 *   PENDING -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE -> PROCESSED | REJECTED | FAILED
 *   PROCESSED/REJECTED/FAILED são terminais.
 *
 * ⚡ Novos campos (spec 7.1):
 *   - `pendingReferenceAttempts`   : contador de tentativas do worker.
 *   - `pendingReferenceNextAttemptAt` : próxima vez que o worker deve tentar.
 */
export class WagerTransaction {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: WagerTransactionKind;
  moneyAmount!: string;
  moneyCurrency!: string;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  createdAt: Date = new Date();
  status: WagerTransactionStatus = WagerTransactionStatus.Pending;
  failureCode?: FailureCode;
  processedAt?: Date;
  pendingReferenceAttempts: number = 0;
  pendingReferenceNextAttemptAt?: Date;

  constructor() {}

  get money(): Money {
    return Money.rehydrate({
      amount: this.moneyAmount ?? '0.00',
      currency: this.moneyCurrency ?? 'BRL',
    });
  }
  set money(m: Money) {
    const p = m.toJSON();
    this.moneyAmount = p.amount;
    this.moneyCurrency = p.currency;
  }

  isTerminal(): boolean {
    return (
      this.status === WagerTransactionStatus.Processed ||
      this.status === WagerTransactionStatus.Rejected ||
      this.status === WagerTransactionStatus.Failed
    );
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | undefined {
    if (this.kind === WagerTransactionKind.Loss) return undefined;
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) return LedgerDirection.Credit;
        const refDir = reference.ledgerDirectionFor();
        return refDir === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      default:
        return undefined;
    }
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    if (this.isTerminal()) {
      throw WagerTransactionError.invalidStateTransition();
    }
    this.status = WagerTransactionStatus.Processed;
    this.referenceTransactionId = referenceTransactionId;
    this.processedAt = at;
    this.pendingReferenceNextAttemptAt = undefined;
  }

  markPendingReference(): void {
    if (this.isTerminal()) {
      throw WagerTransactionError.invalidStateTransition();
    }
    this.status = WagerTransactionStatus.PendingReference;
  }

  /**
   * Agenda uma nova tentativa do worker de referência.
   * Retorna `false` se o estado já não é PendingReference (ex.: outra
   * instância processou enquanto esperávamos).
   */
  schedulePendingReferenceRetry(at: Date): boolean {
    if (this.status !== WagerTransactionStatus.PendingReference) return false;
    this.pendingReferenceAttempts += 1;
    this.pendingReferenceNextAttemptAt = at;
    return true;
  }

  reject(code: FailureCode): void {
    if (this.isTerminal()) {
      throw WagerTransactionError.invalidStateTransition();
    }
    this.status = WagerTransactionStatus.Rejected;
    this.failureCode = code;
    this.pendingReferenceNextAttemptAt = undefined;
  }

  fail(code: FailureCode): void {
    if (this.isTerminal()) {
      throw WagerTransactionError.invalidStateTransition();
    }
    this.status = WagerTransactionStatus.Failed;
    this.failureCode = code;
    this.pendingReferenceNextAttemptAt = undefined;
  }

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const tx = new WagerTransaction();
    tx.id = props.id;
    tx.providerId = props.providerId;
    tx.externalTransactionId = props.externalTransactionId;
    tx.idempotencyKey = props.idempotencyKey;
    tx.payloadHash = props.payloadHash;
    tx.walletId = props.walletId;
    tx.playerId = props.playerId;
    tx.roundId = props.roundId;
    tx.gameId = props.gameId;
    tx.kind = props.kind;
    tx.money = props.money;
    tx.referenceExternalTransactionId = props.referenceExternalTransactionId;
    tx.status = WagerTransactionStatus.Pending;

    if (tx.money.isZero()) {
      throw WagerTransactionError.zeroAmount();
    }
    if (
      (props.kind === WagerTransactionKind.Refund ||
        props.kind === WagerTransactionKind.Rollback) &&
      !props.referenceExternalTransactionId
    ) {
      throw WagerTransactionError.operationRequiresReference();
    }
    return tx;
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    const tx = new WagerTransaction();
    tx.id = state.id;
    tx.providerId = state.providerId;
    tx.externalTransactionId = state.externalTransactionId;
    tx.idempotencyKey = state.idempotencyKey;
    tx.payloadHash = state.payloadHash;
    tx.walletId = state.walletId;
    tx.playerId = state.playerId;
    tx.roundId = state.roundId;
    tx.gameId = state.gameId;
    tx.kind = state.kind;
    tx.money = state.money;
    tx.referenceExternalTransactionId = state.referenceExternalTransactionId;
    tx.status = state.status;
    tx.referenceTransactionId = state.referenceTransactionId;
    tx.failureCode = state.failureCode;
    tx.processedAt = state.processedAt;
    tx.pendingReferenceAttempts = state.pendingReferenceAttempts ?? 0;
    tx.pendingReferenceNextAttemptAt = state.pendingReferenceNextAttemptAt;
    return tx;
  }
}

import { EntitySchema } from '@mikro-orm/core';

export const WagerTransactionSchema = new EntitySchema<WagerTransaction>({
  class: WagerTransaction,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true, defaultRaw: 'gen_random_uuid()' },
    providerId: { type: 'string', length: 100, fieldName: 'provider_id' },
    externalTransactionId: {
      type: 'string',
      length: 255,
      fieldName: 'external_transaction_id',
    },
    idempotencyKey: {
      type: 'string',
      length: 255,
      unique: true,
      fieldName: 'idempotency_key',
    },
    payloadHash: { type: 'string', length: 64, fieldName: 'payload_hash' },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    roundId: { type: 'string', length: 255, fieldName: 'round_id' },
    gameId: { type: 'string', length: 255, fieldName: 'game_id' },
    kind: { type: 'string', fieldName: 'kind' },
    moneyAmount: { type: 'decimal', precision: 18, scale: 2, fieldName: 'money_amount' },
    moneyCurrency: { type: 'string', length: 3, fieldName: 'money_currency' },
    referenceExternalTransactionId: {
      type: 'string',
      length: 255,
      nullable: true,
      fieldName: 'reference_external_transaction_id',
    },
    referenceTransactionId: {
      type: 'uuid',
      nullable: true,
      fieldName: 'reference_transaction_id',
    },
    status: { type: 'string', fieldName: 'status' },
    failureCode: { type: 'string', length: 50, nullable: true, fieldName: 'failure_code' },
    processedAt: { type: 'Date', nullable: true, fieldName: 'processed_at' },
    createdAt: { type: 'Date', fieldName: 'created_at', onCreate: () => new Date() },
    // ⚡ novos campos para o worker de PENDING_REFERENCE (spec 7.1)
    pendingReferenceAttempts: {
      type: 'number',
      default: 0,
      fieldName: 'pending_reference_attempts',
    },
    pendingReferenceNextAttemptAt: {
      type: 'Date',
      nullable: true,
      fieldName: 'pending_reference_next_attempt_at',
    },
  } as any,
  indexes: [
    { name: 'idx_wager_tx_round', properties: ['roundId'] },
    { name: 'idx_wager_tx_status', properties: ['status'] },
    // ⚡ query do worker: WHERE status='PENDING_REFERENCE' AND next_attempt_at <= now()
    { name: 'idx_wager_tx_pending_reference', properties: ['status', 'pendingReferenceNextAttemptAt'] },
  ],
  uniques: [
    { name: 'uq_wager_tx_provider_ext', properties: ['providerId', 'externalTransactionId'] },
  ],
});
