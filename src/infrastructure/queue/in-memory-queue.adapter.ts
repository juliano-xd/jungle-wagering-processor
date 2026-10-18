import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  QueueConsumerPort,
  QueueMessage,
  QueuePublisherPort,
} from './queue.port.js';
import { MetricsService } from '../observability/metrics.service.js';

interface StoredMessage {
  id: string;
  body: string;
  receiveCount: number;
  visibleAt: number;
}

interface DlqEntry {
  id: string;
  body: string;
  reason: string;
  movedAt: Date;
}

/**
 * In-memory queue — para dev/testes SEM LocalStack/SQS.
 *
 * Semântica equivalente ao SQS para o que o consumer usa:
 *   - visibility timeout (nack adia a próxima entrega)
 *   - maxReceiveCount → DLQ automática
 *   - ack remove
 *
 * Diferenças (aceitas em dev):
 *   - Não persiste entre reinícios
 *   - Sem paralelismo real (single process)
 *   - Deduplicação por `deduplicationId` é no-op (SQS FIFO real deduplica)
 *
 * Exposto via endpoint de dev (`POST /_dev/queue/publish`) quando
 * `DEV_QUEUE_ENDPOINT=true`.
 */
@Injectable()
export class InMemoryQueueAdapter implements QueueConsumerPort, QueuePublisherPort {
  private readonly logger = new Logger(InMemoryQueueAdapter.name);
  private readonly queue: StoredMessage[] = [];
  private readonly dlq: DlqEntry[] = [];

  private readonly maxReceiveCount = Number(process.env.SQS_MAX_RECEIVE_COUNT ?? 5);

  constructor(@Optional() private readonly metrics?: MetricsService) {}

  async send(body: string, _deduplicationId?: string, _messageGroupId?: string): Promise<void> {
    const id = crypto.randomUUID();
    this.queue.push({
      id,
      body,
      receiveCount: 0,
      visibleAt: Date.now(),
    });
    this.logger.log(JSON.stringify({ event: 'queue.in_memory.enqueued', id }));
  }

  async receiveBatch(maxMessages: number, waitTimeSeconds: number): Promise<QueueMessage[]> {
    const now = Date.now();
    const ready = this.queue
      .filter((m) => m.visibleAt <= now)
      .slice(0, maxMessages);

    if (ready.length === 0 && waitTimeSeconds > 0) {
      await new Promise((r) => setTimeout(r, Math.min(waitTimeSeconds * 1000, 1000)));
    }

    for (const m of ready) m.receiveCount += 1;

    return ready.map((m) => ({
      messageId: m.id,
      receiptHandle: m.id,
      body: m.body,
    }));
  }

  async ack(message: QueueMessage): Promise<void> {
    const idx = this.queue.findIndex((m) => m.id === message.messageId);
    if (idx >= 0) this.queue.splice(idx, 1);
  }

  async nack(message: QueueMessage, retryAfterSeconds: number): Promise<void> {
    const m = this.queue.find((x) => x.id === message.messageId);
    if (!m) return;

    if (m.receiveCount >= this.maxReceiveCount) {
      await this.moveToDlq(
        message,
        `exceeded maxReceiveCount (${this.maxReceiveCount})`,
      );
      return;
    }
    m.visibleAt = Date.now() + retryAfterSeconds * 1000;
  }

  async moveToDlq(message: QueueMessage, reason: string): Promise<void> {
    const idx = this.queue.findIndex((m) => m.id === message.messageId);
    if (idx < 0) return;
    const [m] = this.queue.splice(idx, 1);
    this.dlq.push({ id: m.id, body: m.body, reason, movedAt: new Date() });
    this.metrics?.queueMovedToDlq();
    this.logger.warn(
      JSON.stringify({
        event: 'queue.in_memory.moved_to_dlq',
        id: m.id,
        reason,
      }),
    );
  }

  // ---- helpers de dev ----

  stats() {
    return {
      queued: this.queue.length,
      dlq: this.dlq.length,
      dlqEntries: this.dlq.map((d) => ({
        id: d.id,
        reason: d.reason,
        movedAt: d.movedAt.toISOString(),
      })),
    };
  }
}
