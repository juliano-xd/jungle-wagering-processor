import { describe, it, expect } from 'bun:test';
import { Money } from '../../../src/domain/value-objects/money';

describe('Money Value Object', () => {
  it('should correctly instantiate a valid money object', () => {
    const money = Money.from({ amount: '100.50', currency: 'BRL' });
    expect(money.toJSON()).toEqual({ amount: '100.50', currency: 'BRL' });
    expect(money.toString()).toBe('100.50 BRL');
    expect(money.isPositive()).toBe(true);
    expect(money.isZero()).toBe(false);
    expect(money.isNegative()).toBe(false);
  });

  it('should create zero money representation', () => {
    const zero = Money.zero('BRL');
    expect(zero.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(zero.isZero()).toBe(true);
    expect(zero.isPositive()).toBe(false);
    expect(zero.isNegative()).toBe(false);
  });

  it('should normalize currency code to uppercase', () => {
    const money = Money.from({ amount: '50.00', currency: 'brl' });
    expect(money.currency).toBe('BRL');
  });

  it('should reject invalid decimal string formats', () => {
    expect(() => Money.from({ amount: 'abc', currency: 'BRL' })).toThrow();
    expect(() => Money.from({ amount: '1e5', currency: 'BRL' })).toThrow();
    expect(() => Money.from({ amount: '10.505', currency: 'BRL' })).toThrow(); // Mais de 2 casas
    expect(() => Money.from({ amount: '', currency: 'BRL' })).toThrow();
    expect(() => Money.from({ amount: '   ', currency: 'BRL' })).toThrow();
  });

  it('should reject negative amounts in base creation contracts', () => {
    expect(() => Money.from({ amount: '-10.00', currency: 'BRL' })).toThrow();
  });

  it('should perform addition between same currencies', () => {
    const m1 = Money.from({ amount: '10.00', currency: 'BRL' });
    const m2 = Money.from({ amount: '20.50', currency: 'BRL' });
    const result = m1.add(m2);

    expect(result.toJSON()).toEqual({ amount: '30.50', currency: 'BRL' });
  });

  it('should perform subtraction between same currencies', () => {
    const m1 = Money.from({ amount: '30.50', currency: 'BRL' });
    const m2 = Money.from({ amount: '10.00', currency: 'BRL' });
    const result = m1.subtract(m2);

    expect(result.toJSON()).toEqual({ amount: '20.50', currency: 'BRL' });
  });

  it('should negate amount correctly', () => {
    const m = Money.from({ amount: '25.00', currency: 'BRL' });
    const negated = m.negate();

    expect(negated.toJSON()).toEqual({ amount: '-25.00', currency: 'BRL' });
    expect(negated.isNegative()).toBe(true);
    expect(negated.isPositive()).toBe(false);
  });

  it('should correctly compare money instances', () => {
    const m1 = Money.from({ amount: '10.00', currency: 'BRL' });
    const m2 = Money.from({ amount: '20.00', currency: 'BRL' });
    const m3 = Money.from({ amount: '10.00', currency: 'BRL' });

    expect(m1.isLessThan(m2)).toBe(true);
    expect(m2.isLessThan(m1)).toBe(false);
    expect(m1.equals(m3)).toBe(true);
    expect(m1.equals(m2)).toBe(false);
  });

  it('should prevent operations between different currencies', () => {
    const m1 = Money.from({ amount: '10.00', currency: 'BRL' });
    const m2 = Money.from({ amount: '10.00', currency: 'USD' });

    expect(() => m1.add(m2)).toThrow(/Currency mismatch/);
    expect(() => m1.subtract(m2)).toThrow(/Currency mismatch/);
    expect(() => m1.isLessThan(m2)).toThrow(/Currency mismatch/);
  });

  it('should be strictly immutable', () => {
    const m1 = Money.from({ amount: '10.00', currency: 'BRL' });
    const m2 = m1.add(Money.from({ amount: '5.00', currency: 'BRL' }));

    expect(m1.toJSON()).toEqual({ amount: '10.00', currency: 'BRL' });
    expect(m2.toJSON()).toEqual({ amount: '15.00', currency: 'BRL' });
  });

  it('should rehydrate valid persisted money without creating contract checks', () => {
    const rehydrated = Money.rehydrate({ amount: '0.00', currency: 'BRL' });
    expect(rehydrated.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
  });
});
