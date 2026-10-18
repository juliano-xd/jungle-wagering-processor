import { DomainError } from './domain.error.js';

export class MoneyError extends DomainError {
  private constructor(message: string, code: string) {
    super(message, code);
  }
  static invalidAmount(amount: string): MoneyError {
    return new MoneyError(`Invalid money amount: "${amount}"`, 'MONEY_INVALID_AMOUNT');
  }
  static invalidCurrency(currency: string): MoneyError {
    return new MoneyError(`Invalid money currency: "${currency}"`, 'MONEY_INVALID_CURRENCY');
  }
  static tooManyDecimals(amount: string): MoneyError {
    return new MoneyError(`Money amount cannot have more than 2 decimal places: "${amount}"`, 'MONEY_TOO_MANY_DECIMALS');
  }
  static negative(amount: string): MoneyError {
    return new MoneyError(`Money amount cannot be negative: "${amount}"`, 'MONEY_NEGATIVE');
  }
  static currencyMismatch(a: string, b: string): MoneyError {
    return new MoneyError(`Currency mismatch: ${a} vs ${b}`, 'MONEY_CURRENCY_MISMATCH');
  }
}