import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import {
  WagerTransaction,
  WagerTransactionStatus,
} from '../../domain/entities/wager-transaction.js';
import { WageringService } from '../../application/services/wagering.service.js';
import { MetricsService } from '../observability/metrics.service.js';

/**
 * PendingReferenceWorker (spec 7.1)
 *
 * Poll periódico por transações em PENDING_REFERENCE cujo
 * `pending_reference_next_attempt_at` já venceu. Para cada uma, chama
 * `WageringService.retryPendingReference`.
 *
 * Concorrência: cada instância roda o próprio loop. Duplicação é absorvida
 * por (a) CAS no `pendingReferenceAttempts` dentro do service e (b)
 * idempotência via `submitTransaction` (replay seguro se já foi processado).
 *
 * Config por env:
 *   - PENDING_REFERENCE_WORKER_ENABLED    (default true)
 *   - PENDING_REFERENCE_POLL_INTERVAL_MS  (default 5000)
 *   - PENDING_REFERENCE_BATCH_SIZE        (default 20)
 *   - PENDING_REFERENCE_MAX_ATTEMPTS      (default 12) — lido pelo service
 *   - PENDING_REFERENCE_BASE_BACKOFF_MS   (default 5000)
 *   - PENDING_REFERENCE_MAX_BACKOFF_MS    (default 60000)
 */
@Injectable()
export class PendingReferenceWorker
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private readonly instanceId = `pending-ref-${crypto.randomUUID().slice(0, 8)}`;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  private readonly enabled =
    String(process.env.PENDING_REFERENCE_WORKER_ENABLED ?? 'true').toLowerCase() !== 'false';
  private readonly pollIntervalMs = Number(
    process.env.PENDING_REFERENCE_POLL_INTERVAL_MS ?? 5000,
  );
  private readonly batchSize = Number(process.env.PENDING_REFERENCE_BATCH_SIZE ?? 20);

  constructor(
    private readonly em: EntityManager,
    private readonly service: WageringService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.log(
        JSON.stringify({
          event: 'pending_reference.worker_disabled',
          instanceId: this.instanceId,
        }),
      );
      return;
    }
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        this.logger.error(
          JSON.stringify({
            event: 'pending_reference.tick_error',
            instanceId: this.instanceId,
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      });
    }, this.pollIntervalMs);
    this.logger.log(
      JSON.stringify({
        event: 'pending_reference.worker_started',
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
    if (this.enabled) {
      this.logger.log(
        JSON.stringify({
          event: 'pending_reference.worker_stopped',
          instanceId: this.instanceId,
        }),
      );
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const forkEm = this.em.fork();
      const now = new Date();

      const due = await forkEm.find(
        WagerTransaction,
        {
          status: WagerTransactionStatus.PendingReference,
          $or: [
            { pendingReferenceNextAttemptAt: null },
            { pendingReferenceNextAttemptAt: { $lte: now } },
          ],
        },
        {
          fields: ['id'],
          limit: this.batchSize,
          orderBy: { pendingReferenceNextAttemptAt: 'ASC' },
        },
      );

      if (due.length === 0) return;

      let processed = 0;
      let stillPending = 0;
      let rejected = 0;
      let skipped = 0;

      for (const { id } of due) {
        try {
          const outcome = await this.service.retryPendingReference(id);
          this.metrics?.pendingReference(outcome);
          switch (outcome) {
            case 'processed':
              processed += 1;
              break;
            case 'pending':
              stillPending += 1;
              break;
            case 'rejected':
              rejected += 1;
              break;
            case 'skipped':
              skipped += 1;
              break;
          }
          this.logger.log(
            JSON.stringify({
              event: 'pending_reference.retry',
              instanceId: this.instanceId,
              transactionId: id,
              outcome,
            }),
          );
        } catch (err) {
          this.logger.error(
            JSON.stringify({
              event: 'pending_reference.retry_error',
              instanceId: this.instanceId,
              txId: id,
              message: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      }

      this.logger.log(
        JSON.stringify({
          event: 'pending_reference.batch_done',
          instanceId: this.instanceId,
          total: due.length,
          processed,
          stillPending,
          rejected,
          skipped,
        }),
      );
    } finally {
      this.running = false;
    }
  }
}
