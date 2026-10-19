import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import {
  QUEUE_CONSUMER,
  WagerTransactionRequestedEnvelope,
} from './queue.port.js';
import type { QueueConsumerPort, QueueMessage } from './queue.port.js';
import { WageringService } from '../../application/services/wagering.service.js';
import { WagerTransactionError } from '../../domain/errors/wager-transaction.error.js';
import { WagerTransactionKind } from '../../domain/entities/wager-transaction.js';
import { Money } from '../../domain/value-objects/money.js';
import { payloadHashOf } from '../../domain/services/canonical-json.js';
import { MetricsService } from '../observability/metrics.service.js';

const CONSUMER_NAME = 'wager-tx-consumer';

/**
 * Consumer de `wager-transactions.fifo` (spec seção 10).
 *
 * Fluxo por mensagem (ver `processOne`):
 *   1. Parse do envelope — inválido → ack + log (retry não ajuda).
 *   2. `submitTransaction` com `inboxMessage` — dedup via inbox persistente,
 *      lock pessimista, wallet+ledger+idempotency+inbox+outbox na mesma tx SQL.
 *   3. PROCESSED / PENDING_REFERENCE / REJECTED → **ack**.
 *   4. `WagerTransactionError` → **ack + log** (payload conflitante,
 *      wallet inexistente, moeda divergente — retry não ajuda).
 *   5. Outros erros (DB down, timeout) → **nack** com backoff. DLQ após
 *      `SQS_MAX_RECEIVE_COUNT` entregas.
 *
 * `processOne` é público para permitir que os testes E2E dirijam o
 * processamento de forma determinística, sem depender de timers.
 */
@Injectable()
export class WagerTransactionConsumer
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(WagerTransactionConsumer.name);
  private readonly instanceId = `wager-consumer-${crypto.randomUUID().slice(0, 8)}`;
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
        this.logger.error(
          JSON.stringify({
            event: 'wager_consumer.loop_error',
            instanceId: this.instanceId,
            message: err instanceof Error ? err.message : String(err),
          }),
        );
        await new Promise((r) => setTimeout(r, this.pollMs));
      } finally {
        this.running = false;
      }
    }
  }

  /**
   * Processa uma mensagem já recebida da fila. Idempotente, safe para chamar
   * N vezes sobre a mesma `messageId` (dedup via inbox persistente).
   *
   * Público para permitir testes determinísticos sem depender do loop.
   */
  async processOne(msg: QueueMessage): Promise<void> {
    let envelope: WagerTransactionRequestedEnvelope;
    try {
      envelope = JSON.parse(msg.body) as WagerTransactionRequestedEnvelope;
      if (
        !envelope ||
        envelope.type !== 'WagerTransactionRequested' ||
        !envelope.data ||
        !envelope.messageId
      ) {
        throw new Error('invalid envelope shape');
      }
    } catch (err) {
      this.logger.error(
        JSON.stringify({
          event: 'wager_consumer.invalid_envelope',
          messageId: msg.messageId,
          body: msg.body.slice(0, 200),
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      await this.queue.ack(msg);
      this.metrics?.queueAck('invalid_envelope');
      return;
    }

    const validKinds = Object.values(WagerTransactionKind) as string[];
    if (!validKinds.includes(envelope.data.kind)) {
      this.logger.error(
        JSON.stringify({
          event: 'wager_consumer.invalid_kind',
          messageId: msg.messageId,
          kind: envelope.data.kind,
        }),
      );
      await this.queue.ack(msg);
      this.metrics?.queueAck('invalid_kind');
      return;
    }
    if (envelope.data.kind === WagerTransactionKind.Opening) {
      this.logger.error(
        JSON.stringify({
          event: 'wager_consumer.opening_rejected',
          messageId: msg.messageId,
        }),
      );
      await this.queue.ack(msg);
      this.metrics?.queueAck('invalid_kind');
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
        kind: envelope.data.kind as WagerTransactionKind,
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
          messageId: msg.messageId,
          txId: result.transactionId,
          status: result.status,
          idempotentReplay: result.idempotentReplay,
        }),
      );
      await this.queue.ack(msg);
      this.metrics?.queueAck('processed');
    } catch (err) {
      if (err instanceof WagerTransactionError) {
        this.logger.warn(
          JSON.stringify({
            event: 'wager_consumer.domain_error',
            instanceId: this.instanceId,
            messageId: msg.messageId,
            code: err.code,
            message: err.message,
          }),
        );
        await this.queue.ack(msg);
        this.metrics?.queueAck('domain_error');
        return;
      }

      this.logger.warn(
        JSON.stringify({
          event: 'wager_consumer.transient_error',
          instanceId: this.instanceId,
          messageId: msg.messageId,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      await this.queue.nack(msg, this.nackBackoffSeconds);
      this.metrics?.queueNack();
    }
  }
}

function payloadHashForEnvelope(env: WagerTransactionRequestedEnvelope): string {
  return payloadHashOf({
    providerId: env.data.providerId,
    externalTransactionId: env.data.externalTransactionId,
    playerId: env.data.playerId,
    walletId: env.data.walletId,
    roundId: env.data.roundId,
    gameId: env.data.gameId,
    kind: env.data.kind,
    money: env.data.money,
    referenceExternalTransactionId: env.data.referenceExternalTransactionId ?? null,
  });
}
