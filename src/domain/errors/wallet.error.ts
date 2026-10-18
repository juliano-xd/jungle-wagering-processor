import { DomainError } from './domain.error.js';

export class WalletError extends DomainError {
  private constructor(message: string, code: string) {
    super(message, code);
  }
  static alreadyExists(playerId: string, currency: string): WalletError {
    return new WalletError(`Wallet already exists for player ${playerId} and currency ${currency}`, 'WALLET_ALREADY_EXISTS');
  }
  static notFound(walletId: string): WalletError {
    return new WalletError(`Wallet not found: ${walletId}`, 'WALLET_NOT_FOUND');
  }
  static currencyMismatch(expected: string, actual: string): WalletError {
    return new WalletError(`Currency mismatch: expected ${expected}, got ${actual}`, 'WALLET_CURRENCY_MISMATCH');
  }
  static insufficientFunds(): WalletError {
    return new WalletError('Insufficient funds', 'WALLET_INSUFFICIENT_FUNDS');
  }
  static negativeBalanceWouldResult(): WalletError {
    return new WalletError('Operation would produce a negative balance', 'WALLET_NEGATIVE_BALANCE');
  }
  static zeroAmount(): WalletError {
    return new WalletError('Amount must be greater than zero', 'WALLET_ZERO_AMOUNT');
  }
}