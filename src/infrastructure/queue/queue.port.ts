/**
 * Portas de fila. Duas implementações: in-memory (dev/testes) e AWS SQS
 * (produção, LocalStack/MiniStack). Contratos idênticos — o consumer não sabe
 * com qual está falando.
 */

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
  /** Devolve à fila com visibilidade zero. Retry após `retryAfterSeconds`. */
  nack(message: QueueMessage, retryAfterSeconds: number): Promise<void>;
  /** Move para DLQ explicitamente + remove da fila principal. */
  moveToDlq(message: QueueMessage, reason: string): Promise<void>;
}

export interface QueuePublisherPort {
  send(body: string, deduplicationId?: string, messageGroupId?: string): Promise<void>;
}

export const QUEUE_CONSUMER = Symbol('QUEUE_CONSUMER');
export const QUEUE_PUBLISHER = Symbol('QUEUE_PUBLISHER');

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
  data: {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: string;
    money: { amount: string; currency: string };
    referenceExternalTransactionId?: string;
  };
}
