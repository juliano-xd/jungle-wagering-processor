import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/postgresql';
import { OutboxMessage } from '../../domain/entities/outbox-message.js';
import { MessagePublisher } from '../aws/adapters/message-publisher.interface.js';

export interface OutboxWorkerConfig {
  pollIntervalMs?: number;
  batchSize?: number;
  maxAttempts?: number;
}

const DLQ_THRESHOLD = 15;

/**
 * OutboxWorker: publica mensagens pendentes da outbox na SQS.
 *
 * Concorrência segura:
 * - Cada ciclo de polling abre uma transação e seleciona mensagens com
 *   `FOR UPDATE SKIP LOCKED`. Múltiplas instâncias/workers não processam a
 *   mesma mensagem simultaneamente — quem não obtém o lock simplesmente
 *   não vê a linha.
 *
 * Retry & DLQ:
 * - Falhas transitórias incrementam `attempts` e calculam backoff exponencial
 *   com jitter em `nextAttemptAt` (`OutboxMessage.scheduleRetry`).
 * - Após `DLQ_THRESHOLD` tentativas, a mensagem é re-publicada na DLQ
 *   e marcada como `publishedAt` para ser removida do loop normal.
 *
 * Idempotência do consumidor:
 * - Mesmo que uma mensagem seja publicada mais de uma vez (e.g. crash antes
 *   do commit de `publishedAt`), o consumidor deduplica via InboxMessage.
 */
@Injectable()
export class OutboxWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxWorker.name);
  private isRunning = false;
  private intervalId: NodeJS.Timeout | null = null;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly em: EntityManager,
    @Inject(MessagePublisher) private readonly publisher: MessagePublisher,
    private readonly config: OutboxWorkerConfig = {},
  ) {
    this.pollIntervalMs = config.pollIntervalMs ?? 2000;
    this.batchSize = config.batchSize ?? 10;
    this.maxAttempts = config.maxAttempts ?? DLQ_THRESHOLD;
  }

  onModuleInit() {
    this.isRunning = true;
    this.intervalId = setInterval(() => {
      if (this.isRunning) this.processPendingMessages().catch((e) => this.logger.error('Outbox worker error', e));
    }, this.pollIntervalMs);
    this.logger.log(`Outbox worker started (poll=${this.pollIntervalMs}ms, batch=${this.batchSize}, maxAttempts=${this.maxAttempts})`);
  }

  onModuleDestroy() {
    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.logger.log('Outbox worker stopped');
  }

  /**
   * Processa um lote de mensagens pendentes.
   *
   * Cada mensagem é selecionada e publicada DENTRO da mesma transação SQL
   * com FOR UPDATE SKIP LOCKED — garantindo que nenhum outro worker processe
   * a mesma mensagem ao mesmo tempo.
   *
   * O commit da transação marca `publishedAt` atomicamente. Se o processo
   * morrer após o publish mas antes do commit, a mensagem será re-publicada
   * na próxima tentativa (entrega at-least-once, consumidor deduplica via inbox).
   */
  async processPendingMessages(): Promise<void> {
    const forkEm = this.em.fork();
    try {
      await forkEm.transactional(async (tx) => {
        const now = new Date();
        const pending = await tx.find(OutboxMessage, {
          publishedAt: null,
          $or: [
            { nextAttemptAt: null } as any,
            { nextAttemptAt: { $lte: now } as any },
          ],
        }, {
          lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE, // FOR UPDATE SKIP LOCKED
          limit: this.batchSize,
          orderBy: { occurredAt: 'ASC' },
        });

        for (const message of pending) {
          try {
            await this.publishOne(message);
            message.markPublished(new Date());
          } catch (err) {
            this.logger.warn(`Outbox publish failed for ${message.id}: ${(err as Error).message}`);
            if (message.attempts + 1 >= this.maxAttempts) {
              this.logger.error(`Outbox message ${message.id} exceeded max attempts (${this.maxAttempts}) — sending to DLQ`);
              await this.publishDlq(message, (err as Error).message);
              message.markPublished(new Date()); // Remove do loop normal após envio à DLQ
            } else {
              message.scheduleRetry(now);
            }
          }
          // Cada mensagem é persistida individualmente dentro da transação
          tx.persist(message);
        }
        // flush ocorre ao finalizar o transactional — commit atômico de todas as mensagens do lote
      });
    } catch (err) {
      this.logger.error('Outbox sweep error', err as Error);
    }
  }

  private async publishOne(message: OutboxMessage): Promise<void> {
    const payload = message.payload as Record<string, unknown>;
    await this.publisher.publish(message.id, payload);
  }

  private async publishDlq(message: OutboxMessage, reason: string): Promise<void> {
    const payload = {
      ...message.payload,
      dlqReason: reason,
      dlqAt: new Date().toISOString(),
    };
    await this.publisher.publish(`dlq:${message.id}`, payload);
  }
}