import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  OutboxEnvelope,
  OutboxPublisherPort,
} from './outbox-publisher.port.js';
import { QUEUE_PUBLISHER } from '../queue/queue.port.js';
import type { QueuePublisherPort } from '../queue/queue.port.js';

/**
 * Publisher que envia eventos da outbox para a fila configurada em
 * `QUEUE_BACKEND` (memory ou SQS).
 *
 * Ativar com `OUTBOX_PUBLISHER_BACKEND=queue`.
 *
 * - `MessageGroupId` = `eventType` (ordem por tipo de evento dentro da fila FIFO)
 * - `MessageDeduplicationId` = `outbox.id` (idempotência no broker, defesa em
 *   profundidade — a dedup real continua no inbox do consumer)
 */
@Injectable()
export class QueueOutboxPublisher implements OutboxPublisherPort {
  private readonly logger = new Logger(QueueOutboxPublisher.name);

  constructor(
    @Inject(QUEUE_PUBLISHER) private readonly queue: QueuePublisherPort,
  ) {}

  async publish(envelope: OutboxEnvelope): Promise<void> {
    const body = JSON.stringify({
      messageId: envelope.id,
      type: envelope.eventType,
      occurredAt: envelope.occurredAt.toISOString(),
      data: envelope.payload,
    });

    await this.queue.send(body, envelope.id, envelope.eventType);

    this.logger.log(
      JSON.stringify({
        event: 'outbox.published_to_queue',
        outboxId: envelope.id,
        eventType: envelope.eventType,
      }),
    );
  }
}
