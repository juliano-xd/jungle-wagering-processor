import { EntitySchema } from '@mikro-orm/core';

export enum IdempotencyRecordStatus {
  Pending = 'PENDING',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export interface IdempotencyRecordState {
  idempotencyKey: string;
  payloadHash: string;
  status: IdempotencyRecordStatus;
  transactionId?: string;
  failureCode?: string;
  response: Record<string, unknown>;
  createdAt: Date;
}

export interface CreateIdempotencyRecordProps {
  idempotencyKey: string;
  payloadHash: string;
  status: IdempotencyRecordStatus;
  transactionId?: string;
  failureCode?: string;
  response: Record<string, unknown>;
}

/**
 * IdempotencyRecord é a **fonte da verdade** da idempotência.
 *
 * - Persistente (nunca em cache em memória).
 * - Uma mesma key com payloadHash igual → replay (retorna resposta armazenada).
 * - Uma mesma key com payloadHash diferente → conflito (não replay).
 * - A resposta é armazenada integralmente para que o replay devolva o mesmo
 *   resultado, incluindo o saldo observado naquele momento.
 */
export class IdempotencyRecord {
  idempotencyKey!: string;
  payloadHash!: string;
  status!: IdempotencyRecordStatus;
  transactionId?: string;
  failureCode?: string;
  response!: Record<string, unknown>;
  createdAt: Date = new Date();

  private constructor() {}

  static create(props: CreateIdempotencyRecordProps): IdempotencyRecord {
    const record = new IdempotencyRecord();
    record.idempotencyKey = props.idempotencyKey;
    record.payloadHash = props.payloadHash;
    record.status = props.status;
    record.transactionId = props.transactionId;
    record.failureCode = props.failureCode;
    record.response = props.response;
    record.createdAt = new Date();
    return record;
  }

  static rehydrate(state: IdempotencyRecordState): IdempotencyRecord {
    const record = new IdempotencyRecord();
    record.idempotencyKey = state.idempotencyKey;
    record.payloadHash = state.payloadHash;
    record.status = state.status;
    record.transactionId = state.transactionId;
    record.failureCode = state.failureCode;
    record.response = state.response;
    record.createdAt = state.createdAt;
    return record;
  }
}

export const IdempotencyRecordSchema = new EntitySchema<IdempotencyRecord>({
  class: IdempotencyRecord as any,
  tableName: 'idempotency_records',
  properties: {
    idempotencyKey: { type: 'string', primary: true, fieldName: 'idempotency_key' },
    payloadHash: { type: 'string', length: 64, fieldName: 'payload_hash' },
    // ✅ corrigido: `type: 'enum'` mapeia para smallint no Postgres; o banco já
    // existe como varchar. Usar `string` reflete o schema real e evita o diff
    // `alter column status type smallint` (que colapsaria os valores).
    status: { type: 'string', length: 20, fieldName: 'status' },
    transactionId: { type: 'uuid', nullable: true, fieldName: 'transaction_id' },
    failureCode: { type: 'string', length: 50, nullable: true, fieldName: 'failure_code' },
    response: { type: 'json', fieldName: 'response' },
    createdAt: { type: 'Date', fieldName: 'created_at', onCreate: () => new Date() },
  },
});
