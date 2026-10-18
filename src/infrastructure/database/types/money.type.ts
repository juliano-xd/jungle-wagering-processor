import { Type } from '@mikro-orm/core';
import { Money } from '../../../domain/value-objects/money.js';

/**
 * Custom MikroORM type: persiste um Money como duas colunas
 * (amount decimal(18,2) + currency varchar(3)) e reidrata como Money.
 *
 * Usado em propriedades do tipo Money nas entities, para que o ORM
 * trate o value object como colunas separadas e devolva a instância de Money.
 */
export class MoneyType extends Type<Money, string> {
  convertToDatabaseValue(value: any): any {
    if (value == null) return null;
    if (value instanceof Money) {
      return { amount: value.toJSON().amount, currency: value.currency };
    }
    if (typeof value === 'object' && value.amount !== undefined) {
      return { amount: String(value.amount), currency: value.currency };
    }
    throw new Error(`Cannot convert to MoneyType: ${String(value)}`);
  }

  convertToJSValue(value: any): Money {
    if (value == null) return value;
    if (value instanceof Money) return value;
    if (typeof value === 'object') {
      return Money.rehydrate({ amount: String(value.amount), currency: value.currency });
    }
    return value;
  }

  toJSON(value: Money): any {
    return value ? value.toJSON() : value;
  }
}
