import { Decimal } from 'decimal.js';
import { MoneyError } from '../errors/money.error.js';

export interface MoneyProps {
  amount: string;   // decimal string, ex.: "25.00"
  currency: string; // ISO-4217, ex.: "BRL"
}

/**
 * Money é um value object imutável.
 *
 * - `amount` é recebido e serializado como string decimal com escala fixa de 2 casas.
 * - Operações entre moedas diferentes lançam MoneyError (domínio, não o ORM).
 * - Entradas inválidas (NaN, Infinity, notação científica, string vazia, mais de 2
 *   casas decimais, negativo em contratos de criação) são rejeitadas.
 * - O domínio NÃO depende de tipos monetários do ORM nem de decorators do NestJS.
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (!props || typeof props.amount !== 'string' || props.amount.trim() === '') {
      throw MoneyError.invalidAmount(props?.amount ?? '');
    }
    if (!props.currency || typeof props.currency !== 'string' || props.currency.trim() === '') {
      throw MoneyError.invalidCurrency(props.currency ?? '');
    }

    const trimmed = props.amount.trim();

    // Recusa notação científica e formatos não decimais simples.
    if (/e/i.test(trimmed) || !/^-?\d+(\.\d+)?$/.test(trimmed)) {
      throw MoneyError.invalidAmount(trimmed);
    }

    const parts = trimmed.split('.');
    if (parts[1] && parts[1].length > 2) {
      throw MoneyError.tooManyDecimals(trimmed);
    }

    const decimalValue = new Decimal(trimmed);
    if (!decimalValue.isFinite()) {
      throw MoneyError.invalidAmount(trimmed);
    }

    if (decimalValue.isNegative()) {
      throw MoneyError.negative(trimmed);
    }

    const fixedValue = decimalValue.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    return new Money(fixedValue, props.currency.trim().toUpperCase());
  }

  /** Reconstrói um Money já persistido/serializado sem revalidar regras de criação. */
  static rehydrate(props: MoneyProps): Money {
    if (!props || typeof props.amount !== 'string') {
      throw MoneyError.invalidAmount(props?.amount ?? '');
    }
    const value = new Decimal(props.amount);
    if (!value.isFinite()) throw MoneyError.invalidAmount(props.amount);
    return new Money(value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP), props.currency.toUpperCase());
  }

  static zero(currency: string): Money {
    return new Money(new Decimal('0.00'), currency.trim().toUpperCase());
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.gt(0);
  }

  isNegative(): boolean {
    return this.value.lt(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lt(other.value);
  }

  isLessThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lte(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return {
      amount: this.value.toFixed(2),
      currency: this.currency,
    };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw MoneyError.currencyMismatch(this.currency, other.currency);
    }
  }
}
