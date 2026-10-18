import { Injectable, Logger } from '@nestjs/common';
import {
  OutboxEnvelope,
  OutboxPublisherPort,
} from './outbox-publisher.port.js';

/**
 * Publisher placeholder que apenas LOGA o envelope em JSON.
 *
 * Substitua por `SqsOutboxPublisher` quando o SQS estiver configurado
 * (próximo bloco). O worker já funciona com este stub — a outbox é drenada,
 * os envelopes ficam registrados em stdout/stderr, os contadores avançam.
 *
 * Não deve ser usado em produção (nenhuma garantia de entrega real), mas
 * destrava os testes de integração do worker antes do SQS estar pronto.
 */
@Injectable()
export class ConsoleOutboxPublisher implements OutboxPublisherPort {
  private readonly logger = new Logger(ConsoleOutboxPublisher.name);

  async publish(envelope: OutboxEnvelope): Promise<void> {
    this.logger.log(
      JSON.stringify({
        event: 'outbox.publish_console',
        outboxId: envelope.id,
        aggregateId: envelope.aggregateId,
        eventType: envelope.eventType,
        occurredAt: envelope.occurredAt.toISOString(),
        payload: envelope.payload,
      }),
    );
  }
}
