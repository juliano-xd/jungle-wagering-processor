/**
 * Portas de fila. Duas implementações: in-memory (dev/testes) e AWS SQS
 * (produção, LocalStack/MiniStack). Contratos idênticos — o consumer não sabe
 * com qual está falando.
 */

// ── Portas ──────────────────────────────────────────────────────────

export interface QueueMessage {
  /** ID único da mensagem na fila (SQS MessageId ou UUID local). */
  messageId: string;
  /** Handle opaco para ack/nack (SQS ReceiptHandle). */
  receiptHandle: string;
  /** Corpo cru — o consumer parseia. */
  body: string;
}

export interface QueueConsumerPort {
  receiveBatch(maxMessages: number, waitTimeSeconds: number): Promise<QueueMessage[]>;
  /** Remove da fila. Sucesso — não retorna mais. */
  ack(message: QueueMessage): Promise<void>;
  /** Adia a próxima entrega por `retryAfterSeconds` segundos (visibility timeout). */
  nack(message: QueueMessage, retryAfterSeconds: number): Promise<void>;
  /** Move para DLQ explicitamente + remove da fila principal. */
  moveToDlq(message: QueueMessage, reason: string): Promise<void>;
}

export interface QueuePublisherPort {
  send(body: string, deduplicationId?: string, messageGroupId?: string): Promise<void>;
}

// ── Tokens de injeção ───────────────────────────────────────────────

export const QUEUE_CONSUMER = Symbol('QUEUE_CONSUMER');
export const QUEUE_PUBLISHER = Symbol('QUEUE_PUBLISHER');

// ── Envelope inbound ────────────────────────────────────────────────

/**
 * Envelope `WagerTransactionRequested` (spec seção 10).
 *
 * Diferente do envelope de OUTBOX (que publica eventos de integração), este é
 * o envelope INBOUND — o provedor envia, o consumer aplica.
 */
export interface WagerTransactionRequestedEnvelope {
  messageId: string;
  type: 'WagerTransactionRequested';
  occurredAt: string;
  data: WagerTransactionRequestedData;
}

export interface WagerTransactionRequestedData {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  /** Tipo do wager (ex: `BET`, `WIN`, `ROLLBACK`). Validado pelo consumer. */
  kind: string;
  /** Valor como string decimal — preserva precisão; currency é ISO-4217. */
  money: { amount: string; currency: string };
  /** Referência a uma transação externa anterior (ex: rollback de uma aposta). */
  referenceExternalTransactionId?: string;
}
