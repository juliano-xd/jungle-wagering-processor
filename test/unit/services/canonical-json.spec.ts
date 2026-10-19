import { describe, it, expect } from 'bun:test';
import {
  canonicalJson,
  payloadHashOf,
} from '../../../src/domain/services/canonical-json.js';

describe('canonicalJson', () => {
  it('ordena chaves recursivamente', () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(canonicalJson({ z: { y: 2, x: 1 }, a: 3 })).toBe(
      '{"a":3,"z":{"x":1,"y":2}}',
    );
  });

  it('remove valores undefined', () => {
    expect(canonicalJson({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
  });

  it('preserva ordem de arrays (arrays são ordenados)', () => {
    expect(canonicalJson({ arr: [3, 1, 2] })).toBe('{"arr":[3,1,2]}');
  });

  it('processa objetos dentro de arrays', () => {
    expect(canonicalJson({ list: [{ b: 1, a: 2 }] })).toBe(
      '{"list":[{"a":2,"b":1}]}',
    );
  });

  it('é determinístico para o mesmo input', () => {
    const obj = { b: 2, a: 1, c: { z: 26, a: 1 } };
    expect(canonicalJson(obj)).toBe(canonicalJson(obj));
  });
});

describe('payloadHashOf', () => {
  it('mesmo valor semântico → mesmo hash (ordem de chaves irrelevante)', () => {
    const a = payloadHashOf({ b: 2, a: 1 });
    const b = payloadHashOf({ a: 1, b: 2 });
    expect(a).toBe(b);
  });

  it('valores diferentes → hashes diferentes', () => {
    expect(payloadHashOf({ a: 1 })).not.toBe(payloadHashOf({ a: 2 }));
  });

  it('produz 64 caracteres hexadecimais (SHA-256)', () => {
    expect(payloadHashOf({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('undefined e chave ausente produzem o mesmo hash', () => {
    expect(payloadHashOf({ a: 1, b: undefined })).toBe(payloadHashOf({ a: 1 }));
  });
});
