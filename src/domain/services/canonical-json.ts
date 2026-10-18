import * as crypto from 'crypto';

/**
 * JSON canônico: chaves ordenadas recursivamente, sem espaços, sem `undefined`.
 * Usado para calcular `payloadHash` de forma determinística.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) {
        sorted[key] = sortKeys(v);
      }
    }
    return sorted;
  }
  return value;
}

export function payloadHashOf(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}
