/**
 * Porta de publicação do outbox. A implementação concreta (SQS, LocalStack,
 * stub de teste) é injetada no `OutboxPublisherWorker`.
 *
 * Contrato:
 *   - `publish()` deve ser **idempotente do lado do broker** quando possível
 *     (ex.: SQS `MessageDeduplicationId`), mas o sistema NÃO depende disso:
 *     duplicatas são absorvidas pelo inbox do consumer.
 *   - Deve lançar exceção em falha transitória (retry) e permanente (DLQ).
 *   - Não deve bloquear indefinidamente.
 */
export interface OutboxEnvelope {
  /** ID da mensagem na outbox (não confundir com eventId do payload). */
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
}

export interface OutboxPublisherPort {
  publish(envelope: OutboxEnvelope): Promise<void>;
}

/** Token de injeção (evita string mágica nos providers). */
export const OUTBOX_PUBLISHER = Symbol('OUTBOX_PUBLISHER');
