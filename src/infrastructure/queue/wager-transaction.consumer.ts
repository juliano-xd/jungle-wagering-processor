import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  QUEUE_CONSUMER,
  WagerTransactionRequestedEnvelope,
} from './queue.port.js';
import type { QueueConsumerPort, QueueMessage } from './queue.port.js';
import { WageringService } from '../../application/services/wagering.service.js';
import { WagerTransactionError } from '../../domain/errors/wager-transaction.error.js';
import { WagerTransactionKind } from '../../domain/entities/wager-transaction.js';
import { Money } from '../../domain/value-objects/money.js';
import { computeSubmitPayloadHash } from '../../application/services/payload-hash.js';
import { MetricsService } from '../observability/metrics.service.js';

/** Motivos possíveis de ack — casa com `MetricsService.queueAck`. */
type AckReason = 'processed' | 'domain_error' | 'invalid_envelope' | 'invalid_kind';

const CONSUMER_NAME = 'wager-tx-consumer';

/** `Set` para busca O(1) — o loop é caminho quente. */
const ALL_KINDS: ReadonlySet<string> = new Set(
  Object.values(WagerTransactionKind) as string[],
);

/**
 * Consumer de `wager-transactions.fifo` (spec seção 10).
 *
 * Fluxo por mensagem (ver `processOne`):
 *   1. Decodificação do envelope — inválido → ack + log (retentativa não ajuda).
 *   2. `submitTransaction` com `inboxMessage` — deduplicação via inbox
 *      persistente, lock pessimista, wallet+ledger+idempotency+inbox+outbox
 *      na mesma transação SQL.
 *   3. PROCESSED / PENDING_REFERENCE / REJECTED → **ack**.
 *   4. `WagerTransactionError` → **ack + log** (payload conflitante,
 *      wallet inexistente, moeda divergente — retentativa não ajuda).
 *   5. Outros erros (banco de dados fora do ar, timeout) → **nack** com
 *      backoff. DLQ após `SQS_MAX_RECEIVE_COUNT` entregas.
 *
 * `processOne` é público para permitir que os testes E2E dirijam o
 * processamento de forma determinística, sem depender de temporizadores.
 */
@Injectable()
export class WagerTransactionConsumer
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(WagerTransactionConsumer.name);
  private readonly instanceId = `wager-consumer-${randomUUID().slice(0, 8)}`;
  private running = false;
  private stopped = false;

  private readonly enabled =
    String(process.env.WAGER_CONSUMER_ENABLED ?? 'true').toLowerCase() !== 'false';
  private readonly pollMs = Number(process.env.WAGER_CONSUMER_POLL_MS ?? 1000);
  private readonly batchSize = Number(process.env.WAGER_CONSUMER_BATCH_SIZE ?? 10);
  private readonly waitSeconds = Number(process.env.WAGER_CONSUMER_WAIT_SECONDS ?? 5);
  private readonly nackBackoffSeconds = Number(
    process.env.WAGER_CONSUMER_NACK_BACKOFF_S ?? 10,
  );

  constructor(
    private readonly service: WageringService,
    @Inject(QUEUE_CONSUMER) private readonly queue: QueueConsumerPort,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.log(
        JSON.stringify({ event: 'wager_consumer.disabled', instanceId: this.instanceId }),
      );
      return;
    }
    void this.loop();
    this.logger.log(
      JSON.stringify({
        event: 'wager_consumer.started',
        instanceId: this.instanceId,
        pollMs: this.pollMs,
        batchSize: this.batchSize,
      }),
    );
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    while (this.running) {
      await new Promise((r) => setTimeout(r, 100));
    }
    this.logger.log(
      JSON.stringify({ event: 'wager_consumer.stopped', instanceId: this.instanceId }),
    );
  }

  /**
   * Processa uma mensagem já recebida da fila. Idempotente, seguro para
   * chamar N vezes sobre a mesma `messageId` (deduplicação via inbox
   * persistente).
   *
   * Público para permitir testes determinísticos sem depender do loop.
   */
  async processOne(msg: QueueMessage): Promise<void> {
    const envelope = await this.parseEnvelope(msg);
    if (!envelope) return;

    const { kind } = envelope.data;

    if (!ALL_KINDS.has(kind)) {
      await this.reject(msg, 'wager_consumer.invalid_kind', { kind }, 'invalid_kind');
      return;
    }
    if (kind === WagerTransactionKind.Opening) {
      // `Opening` existe no enum mas é rejeitado no fluxo de entrada
      // (não é uma transação aplicável — seria a criação inicial da wallet).
      await this.reject(msg, 'wager_consumer.opening_rejected', {}, 'invalid_kind');
      return;
    }

    try {
      const result = await this.service.submitTransaction({
        providerId: envelope.data.providerId,
        externalTransactionId: envelope.data.externalTransactionId,
        idempotencyKey: envelope.data.idempotencyKey,
        playerId: envelope.data.playerId,
        walletId: envelope.data.walletId,
        roundId: envelope.data.roundId,
        gameId: envelope.data.gameId,
        kind: kind as WagerTransactionKind,
        money: Money.from(envelope.data.money),
        referenceExternalTransactionId: envelope.data.referenceExternalTransactionId,
        payloadHash: payloadHashForEnvelope(envelope),
        inboxMessage: {
          messageId: envelope.messageId,
          consumerName: CONSUMER_NAME,
        },
      });

      this.logger.log(
        JSON.stringify({
          event: 'wager_consumer.processed',
          instanceId: this.instanceId,
          correlationId: envelope.data.idempotencyKey,
          messageId: msg.messageId,
          transactionId: result.transactionId,
          walletId: envelope.data.walletId,
          providerId: envelope.data.providerId,
          kind,
          status: result.status,
          idempotentReplay: result.idempotentReplay,
        }),
      );
      await this.ack(msg, 'processed');
    } catch (err) {
      if (err instanceof WagerTransactionError) {
        await this.reject(
          msg,
          'wager_consumer.domain_error',
          {
            correlationId: envelope.data.idempotencyKey,
            walletId: envelope.data.walletId,
            providerId: envelope.data.providerId,
            kind,
            code: err.code,
            err,
          },
          'domain_error',
        );
        return;
      }

      this.warn('wager_consumer.transient_error', {
        correlationId: envelope.data.idempotencyKey,
        messageId: msg.messageId,
        walletId: envelope.data.walletId,
        providerId: envelope.data.providerId,
        err,
      });
      await this.queue.nack(msg, this.nackBackoffSeconds);
      this.metrics?.queueNack();
    }
  }

  // ── laço principal ──────────────────────────────────────────────

  private async loop(): Promise<void> {
    while (!this.stopped) {
      this.running = true;
      try {
        const messages = await this.queue.receiveBatch(this.batchSize, this.waitSeconds);
        if (messages.length > 0) {
          this.metrics?.queueReceive(messages.length);
        }
        for (const msg of messages) {
          if (this.stopped) break;
          await this.processOne(msg);
        }
      } catch (err) {
        this.warn('wager_consumer.loop_error', { err });
        await new Promise((r) => setTimeout(r, this.pollMs));
      } finally {
        this.running = false;
      }
    }
  }

  // ── auxiliares ──────────────────────────────────────────────────

  /** Decodifica + valida o formato. Retorna `null` (após ack + log) se inválido. */
  private async parseEnvelope(
    msg: QueueMessage,
  ): Promise<WagerTransactionRequestedEnvelope | null> {
    try {
      const envelope = JSON.parse(msg.body) as WagerTransactionRequestedEnvelope;
      if (
        !envelope ||
        envelope.type !== 'WagerTransactionRequested' ||
        !envelope.data ||
        !envelope.messageId
      ) {
        throw new Error('formato de envelope inválido');
      }
      return envelope;
    } catch (err) {
      await this.reject(
        msg,
        'wager_consumer.invalid_envelope',
        { body: msg.body.slice(0, 200), err },
        'invalid_envelope',
      );
      return null;
    }
  }

  /** Registra o evento + ack + métrica. Usado para descartes definitivos. */
  private async reject(
    msg: QueueMessage,
    event: string,
    fields: Record<string, unknown>,
    metricLabel: AckReason,
  ): Promise<void> {
    this.warn(event, { messageId: msg.messageId, ...fields });
    await this.ack(msg, metricLabel);
  }

  private async ack(msg: QueueMessage, reason: AckReason): Promise<void> {
    await this.queue.ack(msg);
    this.metrics?.queueAck(reason);
  }

  /** Registro estruturado — extrai `.message` de `err` para combinar com o resto. */
  private warn(event: string, fields: Record<string, unknown> = {}): void {
    const { err, ...rest } = fields;
    this.logger.warn(
      JSON.stringify({
        event,
        instanceId: this.instanceId,
        ...rest,
        ...(err !== undefined
          ? { message: err instanceof Error ? err.message : String(err) }
          : {}),
      }),
    );
  }
}

function payloadHashForEnvelope(env: WagerTransactionRequestedEnvelope): string {
  return computeSubmitPayloadHash({
    providerId: env.data.providerId,
    externalTransactionId: env.data.externalTransactionId,
    playerId: env.data.playerId,
    walletId: env.data.walletId,
    roundId: env.data.roundId,
    gameId: env.data.gameId,
    kind: env.data.kind,
    money: env.data.money,
    referenceExternalTransactionId: env.data.referenceExternalTransactionId,
  });
}
