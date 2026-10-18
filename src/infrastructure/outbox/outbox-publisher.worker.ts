import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import {
  OUTBOX_PUBLISHER,
  OutboxEnvelope,
} from './outbox-publisher.port.js';
import type { OutboxPublisherPort } from './outbox-publisher.port.js';
import { MetricsService } from '../observability/metrics.service.js';

/**
 * Linha crua do SELECT ... FOR UPDATE SKIP LOCKED.
 *
 * `occurred_at` pode vir como string porque `conn.execute` NÃO usa a
 * hidratação de entidades do MikroORM. Coagimos defensivamente em
 * `ensureDate()`.
 */
interface ClaimedRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown> | string;
  occurred_at: Date | string;
  attempts: number;
}

@Injectable()
export class OutboxPublisherWorker
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private readonly instanceId = `outbox-${crypto.randomUUID().slice(0, 8)}`;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  private readonly pollIntervalMs = Number(
    process.env.OUTBOX_POLL_INTERVAL_MS ?? 1000,
  );
  private readonly batchSize = Number(process.env.OUTBOX_BATCH_SIZE ?? 20);

  private readonly maxAttempts = 20;
  private readonly baseBackoffMs = 250;
  private readonly maxBackoffMs = 30_000;

  constructor(
    private readonly em: EntityManager,
    @Inject(OUTBOX_PUBLISHER) private readonly publisher: OutboxPublisherPort,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        this.logger.error(
          JSON.stringify({
            event: 'outbox.tick_error',
            instanceId: this.instanceId,
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      });
    }, this.pollIntervalMs);
    this.logger.log(
      JSON.stringify({
        event: 'outbox.worker_started',
        instanceId: this.instanceId,
        pollIntervalMs: this.pollIntervalMs,
        batchSize: this.batchSize,
      }),
    );
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    while (this.running) {
      await new Promise((r) => setTimeout(r, 50));
    }
    this.logger.log(
      JSON.stringify({
        event: 'outbox.worker_stopped',
        instanceId: this.instanceId,
      }),
    );
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let published = 0;
      do {
        published = await this.publishBatch();
      } while (published === this.batchSize);
    } finally {
      this.running = false;
    }
  }

  private async publishBatch(): Promise<number> {
    const forkEm = this.em.fork();
    let publishedCount = 0;

    await forkEm.transactional(async (txEm) => {
      const conn = txEm.getConnection();

      const rows = await conn.execute<ClaimedRow[]>(
        `SELECT id, aggregate_id, event_type, payload, occurred_at, attempts
           FROM outbox_messages
          WHERE published_at IS NULL
            AND (next_attempt_at IS NULL OR next_attempt_at <= now())
          ORDER BY occurred_at ASC
          LIMIT ?
          FOR UPDATE SKIP LOCKED`,
        [this.batchSize],
      );

      for (const row of rows) {
        const envelope: OutboxEnvelope = {
          id: row.id,
          aggregateId: row.aggregate_id,
          eventType: row.event_type,
          payload: ensureObject(row.payload),
          occurredAt: ensureDate(row.occurred_at),
        };

        try {
          await this.publisher.publish(envelope);
          await conn.execute(
            `UPDATE outbox_messages SET published_at = now() WHERE id = ?`,
            [row.id],
          );
          publishedCount += 1;
          this.metrics?.outboxSuccess(1);
          this.metrics?.observeOutboxAge(
            (Date.now() - envelope.occurredAt.getTime()) / 1000,
          );
        } catch (err) {
          const attempts = row.attempts + 1;
          const backoff = this.nextBackoffMs(attempts);
          await conn.execute(
            `UPDATE outbox_messages
                SET attempts = ?,
                    next_attempt_at = now() + (? * interval '1 millisecond')
              WHERE id = ?`,
            [attempts, backoff, row.id],
          );
          this.metrics?.outboxFailure();
          this.logger.warn(
            JSON.stringify({
              event: 'outbox.publish_failed',
              instanceId: this.instanceId,
              outboxId: row.id,
              eventType: row.event_type,
              attempts,
              backoffMs: backoff,
              message: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      }

      // Atualiza gauge de "pending" ao final do batch (best effort).
      try {
        const [{ count }] = await conn.execute<Array<{ count: string }>>(
          `SELECT count(*)::text AS count FROM outbox_messages WHERE published_at IS NULL`,
        );
        this.metrics?.setOutboxPending(Number(count));
      } catch {
        /* best effort */
      }
    });

    if (publishedCount > 0) {
      this.logger.log(
        JSON.stringify({
          event: 'outbox.batch_published',
          instanceId: this.instanceId,
          count: publishedCount,
        }),
      );
    }
    return publishedCount;
  }

  private nextBackoffMs(attempts: number): number {
    if (attempts >= this.maxAttempts) {
      return 24 * 60 * 60 * 1000;
    }
    const exp = Math.min(
      this.maxBackoffMs,
      this.baseBackoffMs * Math.pow(2, attempts),
    );
    const jitter = Math.floor(exp * 0.25 * Math.random());
    return exp + jitter;
  }
}

// ---------------------------------------------------------------------------
// Helpers de coerção — o driver devolve valores brutos, não hidratados.

function ensureDate(value: Date | string | null | undefined): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string' && value.length > 0) {
    const normalized = value.includes('T') ? value : value.replace(' ', 'T');
    const d = new Date(normalized);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

function ensureObject(
  value: Record<string, unknown> | string | null | undefined,
): Record<string, unknown> {
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* cai no fallback */
    }
  }
  return {};
}
