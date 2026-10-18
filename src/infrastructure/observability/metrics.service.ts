import { Injectable } from '@nestjs/common';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

/**
 * Registro central de métricas Prometheus — cobre a spec 12:
 *   - transações por status
 *   - duplicatas / replays detectados
 *   - retries (outbox, pending-ref, fila)
 *   - DLQ
 *   - conflitos de lock
 *   - outbox lag
 *   - latência de processamento
 *
 * Nomes seguem a convenção Prometheus (`*_total` para counters,
 * `*_seconds` para histogramas de tempo, `*_count`/`*_pending` para gauges).
 *
 * O MetricsService é registrado em `MetricsModule` como `@Global`, então
 * qualquer provider pode injetá-lo sem importar o módulo. Nos testes de
 * integração, os services são instanciados manualmente (`new WageringService(em)`)
 * — o parâmetro `metrics` é opcional lá para não quebrar os testes.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  // ------- transações por status -------
  readonly transactionsTotal = new Counter({
    name: 'wager_transactions_total',
    help: 'Wager transactions by terminal status',
    labelNames: ['status'] as const, // PROCESSED | REJECTED | PENDING_REFERENCE
    registers: [this.registry],
  });

  readonly submitDuration = new Histogram({
    name: 'wager_submit_duration_seconds',
    help: 'WageringService.submitTransaction latency',
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [this.registry],
  });

  // ------- idempotência -------
  readonly idempotencyReplays = new Counter({
    name: 'wager_idempotency_replays_total',
    help: 'Requests answered from IdempotencyRecord (replay)',
    registers: [this.registry],
  });

  readonly idempotencyConflicts = new Counter({
    name: 'wager_idempotency_conflicts_total',
    help: 'Same idempotencyKey with different payloadHash (409)',
    registers: [this.registry],
  });

  // ------- concorrência -------
  readonly lockConflicts = new Counter({
    name: 'wager_lock_conflicts_total',
    help: 'PESSIMISTIC_WRITE lock contention (serialization failure)',
    registers: [this.registry],
  });

  // ------- outbox -------
  readonly outboxPublished = new Counter({
    name: 'outbox_published_total',
    help: 'Outbox messages successfully published',
    registers: [this.registry],
  });

  readonly outboxPublishFailed = new Counter({
    name: 'outbox_publish_failed_total',
    help: 'Outbox publish attempts that failed (retried)',
    registers: [this.registry],
  });

  readonly outboxPendingGauge = new Gauge({
    name: 'outbox_pending',
    help: 'Outbox messages pending publication',
    registers: [this.registry],
  });

  readonly outboxEventAge = new Histogram({
    name: 'outbox_event_age_seconds',
    help: 'Seconds between outbox occurredAt and successful publish',
    buckets: [0.1, 0.5, 1, 5, 10, 30, 60, 300],
    registers: [this.registry],
  });

  // ------- pending reference worker -------
  readonly pendingReferenceOutcome = new Counter({
    name: 'pending_reference_outcome_total',
    help: 'PENDING_REFERENCE retry outcomes',
    labelNames: ['outcome'] as const, // processed | pending | rejected | skipped
    registers: [this.registry],
  });

  // ------- fila / consumer -------
  readonly queueReceived = new Counter({
    name: 'queue_messages_received_total',
    help: 'Messages received from queue',
    registers: [this.registry],
  });

  readonly queueAcked = new Counter({
    name: 'queue_messages_acked_total',
    help: 'Messages acked (success or terminal)',
    labelNames: ['reason'] as const, // processed | domain_error | invalid_envelope | invalid_kind
    registers: [this.registry],
  });

  readonly queueNacked = new Counter({
    name: 'queue_messages_nacked_total',
    help: 'Messages nacked (transient error, retry scheduled)',
    registers: [this.registry],
  });

  readonly queueDlq = new Counter({
    name: 'queue_messages_dlq_total',
    help: 'Messages moved to DLQ',
    registers: [this.registry],
  });

  // ------- HTTP -------
  readonly httpErrors = new Counter({
    name: 'http_errors_total',
    help: 'HTTP error responses by status code',
    labelNames: ['status'] as const,
    registers: [this.registry],
  });

  constructor() {
    // Métricas de processo (memória, event loop, GC) com prefixo `nodejs_`.
    collectDefaultMetrics({ register: this.registry, prefix: 'nodejs_' });
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }

  // ---- helpers tipados (evitam string solta nos call sites) ----

  transaction(status: 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE'): void {
    this.transactionsTotal.inc({ status });
  }

  observeSubmit(seconds: number): void {
    this.submitDuration.observe(seconds);
  }

  replay(): void {
    this.idempotencyReplays.inc();
  }

  conflict(): void {
    this.idempotencyConflicts.inc();
  }

  lockConflict(): void {
    this.lockConflicts.inc();
  }

  outboxSuccess(count: number): void {
    this.outboxPublished.inc(count);
  }

  outboxFailure(): void {
    this.outboxPublishFailed.inc();
  }

  setOutboxPending(count: number): void {
    this.outboxPendingGauge.set(count);
  }

  observeOutboxAge(seconds: number): void {
    this.outboxEventAge.observe(seconds);
  }

  pendingReference(outcome: 'processed' | 'pending' | 'rejected' | 'skipped'): void {
    this.pendingReferenceOutcome.inc({ outcome });
  }

  queueReceive(count: number): void {
    this.queueReceived.inc(count);
  }

  queueAck(
    reason: 'processed' | 'domain_error' | 'invalid_envelope' | 'invalid_kind',
  ): void {
    this.queueAcked.inc({ reason });
  }

  queueNack(): void {
    this.queueNacked.inc();
  }

  queueMovedToDlq(): void {
    this.queueDlq.inc();
  }

  httpError(status: number): void {
    this.httpErrors.inc({ status: String(status) });
  }
}
