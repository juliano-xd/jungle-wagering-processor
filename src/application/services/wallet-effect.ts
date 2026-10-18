import { WagerTransaction, WagerTransactionKind } from '../../domain/entities/wager-transaction.js';
import { Wallet } from '../../domain/entities/wallet.js';
import { WalletLedgerEntry, LedgerDirection } from '../../domain/entities/wallet-ledger-entry.js';

export interface SubmitTransactionRequest {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: import('../../domain/value-objects/money.js').Money;
  referenceExternalTransactionId?: string;
  payloadHash: string;
  inboxMessage?: {
    messageId: string;
    consumerName: string;
  };
}

export interface SubmitTransactionResult {
  transactionId: string;
  status: import('../../domain/entities/wager-transaction.js').WagerTransactionStatus;
  balanceAfter: import('../../domain/value-objects/money.js').Money;
  walletVersion: number;
  idempotentReplay: boolean;
  failureCode?: import('../../domain/errors/wager-transaction.error.js').FailureCode;
}

export interface CreateWalletRequest {
  playerId: string;
  initialBalance: import('../../domain/value-objects/money.js').Money;
}

export interface CreateWalletResult {
  walletId: string;
  balance: import('../../domain/value-objects/money.js').Money;
  version: number;
}

export interface ReconcileWalletResult {
  walletId: string;
  storedBalance: import('../../domain/value-objects/money.js').Money;
  calculatedBalance: import('../../domain/value-objects/money.js').Money;
  difference: import('../../domain/value-objects/money.js').Money;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Aplica o efeito financeiro de uma transação já validada no wallet aggregate.
 *
 * **Pré-condições (garantidas por `WageringService`):**
 *   - `wallet` está lockada (`PESSIMISTIC_WRITE`);
 *   - `tx.requiresReference()` foi resolvido antes — se `Rollback`/`Refund`
 *     chegou com referência ausente, o service retornou `PENDING_REFERENCE`
 *     e **não** chama `applyBalanceEffect`.
 *
 * **Invariantes:**
 *   - `LOSS` não gera lançamento (retorna `undefined`);
 *   - `ROLLBACK` **exige** `reference` não-nulo — a checagem explícita abaixo
 *     é defesa em profundidade: se o service algum dia regredir e passar null,
 *     a falha é explícita em vez de `TypeError: null is not an object`.
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
      // Defesa em profundidade: `WageringService` só chama com `reference`
      // resolvido. Se chegar null, é bug de estado — falha cedo com mensagem
      // clara em vez de `TypeError`.
      if (!reference) {
        throw new Error(
          'applyBalanceEffect: ROLLBACK requires a reference transaction (invariant violated)',
        );
      }
      const refDir = reference.ledgerDirectionFor() ?? LedgerDirection.Debit;
      return wallet.applyRollback(refDir, tx.money, tx.id);
    }

    default:
      return undefined;
  }
}
