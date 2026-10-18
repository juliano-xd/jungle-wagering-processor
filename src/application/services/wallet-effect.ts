import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../domain/entities/wager-transaction.js';
import { FailureCode } from '../../domain/errors/wager-transaction.error.js';
import { Wallet } from '../../domain/entities/wallet.js';
import { WalletLedgerEntry, LedgerDirection } from '../../domain/entities/wallet-ledger-entry.js';
import { Money } from '../../domain/value-objects/money.js';


export interface SubmitTransactionRequest {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  payloadHash: string;
  inboxMessage?: {
    messageId: string;
    consumerName: string;
  };
}

export interface SubmitTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balanceAfter: Money;
  walletVersion: number;
  idempotentReplay: boolean;
  /** Presente somente quando status === REJECTED. */
  failureCode?: FailureCode;
}

export interface CreateWalletRequest {
  playerId: string;
  initialBalance: Money;
}

export interface CreateWalletResult {
  walletId: string;
  balance: Money;
  version: number;
}

export interface ReconcileWalletResult {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Aplica o efeito financeiro de uma transação já validada no wallet aggregate.
 * LOSS não gera lançamento no ledger (retorna undefined).
 */
export function applyBalanceEffect(
  wallet: Wallet,
  tx: WagerTransaction,
  reference: WagerTransaction | null,
): WalletLedgerEntry | undefined {
  if (tx.kind === WagerTransactionKind.Loss) return undefined;

  switch (tx.kind) {
    case WagerTransactionKind.Bet:
      return wallet.debit(tx.money, tx.id);
    case WagerTransactionKind.Opening:
    case WagerTransactionKind.Win:
    case WagerTransactionKind.Refund:
      return wallet.credit(tx.money, tx.id);
    case WagerTransactionKind.Rollback: {
      const refDir = reference!.ledgerDirectionFor() || LedgerDirection.Debit;
      return wallet.applyRollback(refDir, tx.money, tx.id);
    }
    default:
      return undefined;
  }
}
