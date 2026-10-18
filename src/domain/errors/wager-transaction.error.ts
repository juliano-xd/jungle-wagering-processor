import { DomainError } from './domain.error.js';

/**
 * Códigos de falha estáveis e legíveis por máquina.
 *
 * A taxonomia é deliberada para que o provedor decida se reenvia, corrige o
 * payload ou desiste:
 *   - REJECT_* : rejeição por regra de negócio (terminal). O provedor deve
 *     corrigir o payload e reenviar como nova transação.
 *   - REFERENCE_* : dependência de transação inexistente ou já revertida.
 *   - DUPLICATE_* : conflito de idempotência (payload divergente).
 *   - INFRA_* : erro transitório/permanente de infraestrutura.
 */
export enum FailureCode {
  // Rejeição por regra de negócio
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  NegativeBalanceWouldResult = 'NEGATIVE_BALANCE_WOULD_RESULT',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceAlreadyReverted = 'REFERENCE_ALREADY_REVERTED',
  ReferenceWrongKind = 'REFERENCE_WRONG_KIND',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  OperationRequiresReference = 'OPERATION_REQUIRES_REFERENCE',
  ZeroAmount = 'ZERO_AMOUNT',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  WalletNotFound = 'WALLET_NOT_FOUND',
  InvalidStateTransition = 'INVALID_STATE_TRANSITION',
  DuplicateIdempotencyKey = 'DUPLICATE_IDEMPOTENCY_KEY',

  // Infraestrutura
  InfraTransient = 'INFRA_TRANSIENT',
  InfraPermanent = 'INFRA_PERMANENT',
  InfraOutboxPublish = 'INFRA_OUTBOX_PUBLISH',
  InfraDeadLetter = 'INFRA_DEAD_LETTER',
}

export class WagerTransactionError extends DomainError {
  constructor(message: string, code: FailureCode) {
    super(message, code as unknown as string);
    this.name = this.constructor.name;
  }
  static insufficientFunds(): WagerTransactionError {
    return new WagerTransactionError('Insufficient funds for this bet', FailureCode.InsufficientFunds);
  }
  static negativeBalanceWouldResult(): WagerTransactionError {
    return new WagerTransactionError(
      'Reversal would produce a negative balance',
      FailureCode.NegativeBalanceWouldResult,
    );
  }
  static referenceNotFound(): WagerTransactionError {
    return new WagerTransactionError('Referenced transaction not found', FailureCode.ReferenceNotFound);
  }
  static referenceAlreadyReverted(): WagerTransactionError {
    return new WagerTransactionError('Referenced transaction was already reverted', FailureCode.ReferenceAlreadyReverted);
  }
  static referenceWrongKind(): WagerTransactionError {
    return new WagerTransactionError('Referenced transaction is not of the allowed kind', FailureCode.ReferenceWrongKind);
  }
  static referenceMismatch(field: string): WagerTransactionError {
    return new WagerTransactionError(
      `Referenced transaction does not match on ${field}`,
      FailureCode.ReferenceMismatch,
    );
  }
  static referenceNotProcessed(): WagerTransactionError {
    return new WagerTransactionError('Referenced transaction is not PROCESSED', FailureCode.ReferenceNotProcessed);
  }
  static operationRequiresReference(): WagerTransactionError {
    return new WagerTransactionError('Operation requires referenceExternalTransactionId', FailureCode.OperationRequiresReference);
  }
  static zeroAmount(): WagerTransactionError {
    return new WagerTransactionError('Amount must be greater than zero', FailureCode.ZeroAmount);
  }
  static currencyMismatch(): WagerTransactionError {
    return new WagerTransactionError('Currency mismatch', FailureCode.CurrencyMismatch);
  }
  static walletNotFound(): WagerTransactionError {
    return new WagerTransactionError('Wallet not found', FailureCode.WalletNotFound);
  }
  static invalidStateTransition(): WagerTransactionError {
    return new WagerTransactionError('Invalid state transition', FailureCode.InvalidStateTransition);
  }
  static duplicateIdempotencyKey(): WagerTransactionError {
    return new WagerTransactionError('Idempotency key already used with a different payload', FailureCode.DuplicateIdempotencyKey);
  }
  static infraTransient(cause?: string): WagerTransactionError {
    return new WagerTransactionError(cause ? `Transient infrastructure error: ${cause}` : 'Transient infrastructure error', FailureCode.InfraTransient);
  }
  static infraPermanent(cause?: string): WagerTransactionError {
    return new WagerTransactionError(cause ? `Permanent infrastructure error: ${cause}` : 'Permanent infrastructure error', FailureCode.InfraPermanent);
  }
  static outboxPublish(cause?: string): WagerTransactionError {
    return new WagerTransactionError(cause ? `Outbox publish failure: ${cause}` : 'Outbox publish failure', FailureCode.InfraOutboxPublish);
  }
}