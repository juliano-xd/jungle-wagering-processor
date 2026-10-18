import { describe, it, expect } from 'bun:test';
import { Money } from '../../src/domain/value-objects/money.js';
import { MoneyError } from '../../src/domain/errors/money.error.js';

describe('Money.from — entradas válidas', () => {
  it('cria Money com 2 casas decimais', () => {
    const m = Money.from({ amount: '25.00', currency: 'BRL' });
    expect(m.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  it('aceita inteiro (normaliza para 2 casas)', () => {
    const m = Money.from({ amount: '25', currency: 'BRL' });
    expect(m.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  it('aceita 1 casa decimal (normaliza para 2)', () => {
    const m = Money.from({ amount: '25.5', currency: 'BRL' });
    expect(m.toJSON()).toEqual({ amount: '25.50', currency: 'BRL' });
  });

  it('aceita zero', () => {
    expect(Money.from({ amount: '0.00', currency: 'BRL' }).isZero()).toBe(true);
  });

  it('normaliza currency para uppercase', () => {
    expect(Money.from({ amount: '10.00', currency: 'brl' }).currency).toBe('BRL');
  });

  it('trima espaços em amount e currency', () => {
    const m = Money.from({ amount: '  10.00  ', currency: ' BRL ' });
    expect(m.toJSON()).toEqual({ amount: '10.00', currency: 'BRL' });
  });

  it('aceita valores grandes', () => {
    const m = Money.from({ amount: '9999999999.99', currency: 'BRL' });
    expect(m.toJSON()).toEqual({ amount: '9999999999.99', currency: 'BRL' });
  });

  it('aceita centavo (0.01)', () => {
    expect(Money.from({ amount: '0.01', currency: 'BRL' }).toJSON()).toEqual({
      amount: '0.01',
      currency: 'BRL',
    });
  });
});

describe('Money.from — entradas inválidas', () => {
  const invalidAmounts = [
    ['vazio', ''],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['notação científica', '1e5'],
    ['mais de 2 casas', '1.234'],
    ['negativo', '-1.00'],
    ['não numérico', 'abc'],
    ['vírgula como separador', '1,50'],
  ] as const;

  for (const [label, amount] of invalidAmounts) {
    it(`rejeita amount ${label}`, () => {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(MoneyError);
    });
  }

  it('rejeita amount não-string', () => {
    expect(() => Money.from({ amount: 25 as any, currency: 'BRL' })).toThrow(
      MoneyError,
    );
  });

  it('rejeita currency vazia', () => {
    expect(() => Money.from({ amount: '1.00', currency: '' })).toThrow(MoneyError);
  });

  it('rejeita currency não-string', () => {
    expect(() => Money.from({ amount: '1.00', currency: 123 as any })).toThrow(
      MoneyError,
    );
  });
});

describe('Money.add', () => {
  it('soma duas quantias da mesma moeda', () => {
    const a = Money.from({ amount: '10.00', currency: 'BRL' });
    const b = Money.from({ amount: '5.50', currency: 'BRL' });
    expect(a.add(b).toJSON()).toEqual({ amount: '15.50', currency: 'BRL' });
  });

  it('é imutável — não modifica as entradas', () => {
    const a = Money.from({ amount: '10.00', currency: 'BRL' });
    const b = Money.from({ amount: '5.00', currency: 'BRL' });
    const c = a.add(b);
    expect(a.toJSON()).toEqual({ amount: '10.00', currency: 'BRL' });
    expect(c).not.toBe(a);
  });

  it('lança erro em currency mismatch', () => {
    const a = Money.from({ amount: '10.00', currency: 'BRL' });
    const b = Money.from({ amount: '5.00', currency: 'USD' });
    expect(() => a.add(b)).toThrow(MoneyError);
  });

  it('preserva escala de 2 casas', () => {
    const a = Money.from({ amount: '0.10', currency: 'BRL' });
    const b = Money.from({ amount: '0.20', currency: 'BRL' });
    expect(a.add(b).toJSON()).toEqual({ amount: '0.30', currency: 'BRL' });
  });
});

describe('Money.subtract', () => {
  it('subtrai quantias da mesma moeda', () => {
    const a = Money.from({ amount: '10.00', currency: 'BRL' });
    const b = Money.from({ amount: '3.50', currency: 'BRL' });
    expect(a.subtract(b).toJSON()).toEqual({ amount: '6.50', currency: 'BRL' });
  });

  it('pode produzir negativo (aritmética intermediária)', () => {
    const a = Money.from({ amount: '5.00', currency: 'BRL' });
    const b = Money.from({ amount: '10.00', currency: 'BRL' });
    const c = a.subtract(b);
    expect(c.isNegative()).toBe(true);
    expect(c.toJSON()).toEqual({ amount: '-5.00', currency: 'BRL' });
  });

  it('lança erro em currency mismatch', () => {
    const a = Money.from({ amount: '10.00', currency: 'BRL' });
    const b = Money.from({ amount: '5.00', currency: 'USD' });
    expect(() => a.subtract(b)).toThrow(MoneyError);
  });
});

describe('Money.negate', () => {
  it('inverte o sinal', () => {
    const m = Money.from({ amount: '10.00', currency: 'BRL' });
    expect(m.negate().toJSON()).toEqual({ amount: '-10.00', currency: 'BRL' });
  });

  it('dupla negação retorna o original', () => {
    const m = Money.from({ amount: '10.00', currency: 'BRL' });
    expect(m.negate().negate().equals(m)).toBe(true);
  });
});

describe('Money predicates', () => {
  it('isZero', () => {
    expect(Money.from({ amount: '0.00', currency: 'BRL' }).isZero()).toBe(true);
    expect(Money.from({ amount: '0.01', currency: 'BRL' }).isZero()).toBe(false);
  });

  it('isPositive', () => {
    expect(Money.from({ amount: '0.01', currency: 'BRL' }).isPositive()).toBe(true);
    expect(Money.from({ amount: '0.00', currency: 'BRL' }).isPositive()).toBe(false);
  });

  it('isNegative', () => {
    const a = Money.from({ amount: '5.00', currency: 'BRL' });
    const b = Money.from({ amount: '10.00', currency: 'BRL' });
    expect(a.subtract(b).isNegative()).toBe(true);
    expect(a.isNegative()).toBe(false);
  });

  it('isLessThan', () => {
    const a = Money.from({ amount: '5.00', currency: 'BRL' });
    const b = Money.from({ amount: '10.00', currency: 'BRL' });
    expect(a.isLessThan(b)).toBe(true);
    expect(b.isLessThan(a)).toBe(false);
    expect(a.isLessThan(a)).toBe(false);
  });

  it('isLessThanOrEqual', () => {
    const a = Money.from({ amount: '5.00', currency: 'BRL' });
    const b = Money.from({ amount: '10.00', currency: 'BRL' });
    expect(a.isLessThanOrEqual(b)).toBe(true);
    expect(a.isLessThanOrEqual(a)).toBe(true);
    expect(b.isLessThanOrEqual(a)).toBe(false);
  });

  it('equals compara amount E currency', () => {
    const a = Money.from({ amount: '10.00', currency: 'BRL' });
    const b = Money.from({ amount: '10.00', currency: 'BRL' });
    const c = Money.from({ amount: '10.00', currency: 'USD' });
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
  });
});

describe('Money.zero', () => {
  it('cria zero com a moeda informada', () => {
    const m = Money.zero('BRL');
    expect(m.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(m.isZero()).toBe(true);
  });

  it('normaliza currency', () => {
    expect(Money.zero('brl').currency).toBe('BRL');
  });
});

describe('Money.rehydrate', () => {
  it('aceita valores persistidos sem revalidar regras de criação', () => {
    const m = Money.rehydrate({ amount: '10.00', currency: 'BRL' });
    expect(m.toJSON()).toEqual({ amount: '10.00', currency: 'BRL' });
  });

  it('normaliza escala', () => {
    const m = Money.rehydrate({ amount: '10.5', currency: 'BRL' });
    expect(m.toJSON()).toEqual({ amount: '10.50', currency: 'BRL' });
  });

  it('round-trip from() → toJSON() → rehydrate() preserva valor', () => {
    const original = Money.from({ amount: '10.00', currency: 'BRL' });
    const rehydrated = Money.rehydrate(original.toJSON());
    expect(rehydrated.equals(original)).toBe(true);
  });
});
