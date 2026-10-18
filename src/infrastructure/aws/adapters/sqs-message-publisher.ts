import { MessagePublisher } from './message-publisher.interface.js';

/**
 * Adaptador que publica mensagens na SQS via SqsPublisher.
 */
export class SqsMessagePublisher implements MessagePublisher {
  constructor(private readonly publisher: { publish(messageId: string, body: unknown): Promise<void> }) {}

  async publish(queueUrl: string, payload: any): Promise<void> {
    const messageId = payload?.eventId || payload?.messageId || `msg-${Date.now()}`;
    await this.publisher.publish(messageId, payload);
  }
}