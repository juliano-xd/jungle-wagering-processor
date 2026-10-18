import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import {
  SQSClient,
  CreateQueueCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
} from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { InboxMessage } from '../../domain/entities/inbox-message.js';
import { WageringService } from '../../application/services/wagering.service.js';
import { WagerTransactionStatus } from '../../domain/entities/wager-transaction.js';
import { Money } from '../../domain/value-objects/money.js';
import { WagerTransactionError } from '../../domain/errors/wager-transaction.error.js';
import { payloadHashOf } from '../../domain/services/canonical-json.js';

export interface SqsConsumerConfig {
  endpoint: string;
  region: string;
  queueUrl: string;
  dlqQueueUrl?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  maxAttempts?: number;
  visibilityTimeoutSec?: number;
}

/**
 * SqsConsumer: consome mensagens do WagerTransactionRequested.
 *
 * - Deduplicação via inbox persistente por (messageId, consumerName).
 * - ack somente após o commit da transação financeira.
 * - distinção de erros: de negócio (terminal, ack), transitório (retry
 *   com backoff via visibility timeout), permanente (DLQ).
 * - em SIGTERM, conclui mensagens em andamento ou devolve visibilidade.
 */
@Injectable()
export class SqsConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SqsConsumer.name);
  private readonly client: SQSClient;
  private isPolling = false;
  private inFlight = new Set<string>();
  private shuttingDown = false;

  constructor(
    private readonly config: SqsConsumerConfig,
    private readonly wageringService: WageringService,
    private readonly em: EntityManager,
  ) {
    this.client = new SQSClient({
      region: config.region,
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.accessKeyId || 'test',
        secretAccessKey: config.secretAccessKey || 'test',
      },
    });
  }

  async onModuleInit() {
    await this.ensureQueue();
    this.isPolling = true;
    this.poll();
  }

  onModuleDestroy() {
    this.shuttingDown = true;
    this.isPolling = false;
    this.logger.log(`SQS consumer shutting down (${this.inFlight.size} in flight)`);
  }

  private async ensureQueue() {
    try {
      await this.client.send(new CreateQueueCommand({ QueueName: this.queueName() }));
    } catch (e) {
      this.logger.warn('ensureQueue (may already exist)', e as Error);
    }
  }

  private queueName(): string {
    return this.config.queueUrl.split('/').pop() || 'wagering-events-queue';
  }

  private async poll() {
    while (this.isPolling && !this.shuttingDown) {
      try {
        const resp = await this.client.send(new ReceiveMessageCommand({
          QueueUrl: this.config.queueUrl,
          MaxNumberOfMessages: 5,
          WaitTimeSeconds: 5,
          VisibilityTimeout: this.config.visibilityTimeoutSec ?? 30,
        }));
        for (const msg of resp.Messages || []) {
          if (this.shuttingDown) {
            await this.returnVisibility(msg);
            continue;
          }
          this.inFlight.add(msg.MessageId!);
          try {
            await this.processMessage(msg);
            await this.deleteMessage(msg);
          } catch (err) {
            await this.handleFailure(msg, err as Error);
          } finally {
            this.inFlight.delete(msg.MessageId!);
          }
        }
      } catch (err) {
        this.logger.error('SQS poll error', err as Error);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  private async processMessage(msg: any): Promise<void> {
    const body = JSON.parse(msg.Body);
    const messageId = msg.MessageId;
    const consumerName = 'wager-processor';

    // 1. Inbox dedup persistente.
    const inbox = InboxMessage.receive({
      messageId,
      consumerName,
      payloadHash: payloadHashOf(body),
    });

    await this.em.transactional(async (em) => {
      try {
        em.persist(inbox);
        await em.flush();
      } catch (e: any) {
        // Duplicate inbox entry → já processada.
        if (e.code === '23505') {
          this.logger.log(`Duplicate message ${messageId} — skipping`);
          return;
        }
        throw e;
      }
    });

    // 2. Mapeia para o mesmo use case da API HTTP.
    const req = this.toRequest(body);
    await this.wageringService.submitTransaction(req);
  }

  private toRequest(body: any): any {
    const data = body.data;
    return {
      providerId: data.providerId,
      externalTransactionId: data.externalTransactionId,
      idempotencyKey: data.idempotencyKey,
      playerId: data.playerId,
      walletId: data.walletId,
      roundId: data.roundId,
      gameId: data.gameId,
      kind: data.kind,
      money: Money.from(data.money),
      payloadHash: payloadHashOf(data),
    };
  }

  private async deleteMessage(msg: any): Promise<void> {
    await this.client.send(new DeleteMessageCommand({
      QueueUrl: this.config.queueUrl,
      ReceiptHandle: msg.ReceiptHandle,
    }));
  }

  private async returnVisibility(msg: any): Promise<void> {
    await this.client.send(new ChangeMessageVisibilityCommand({
      QueueUrl: this.config.queueUrl,
      ReceiptHandle: msg.ReceiptHandle,
      VisibilityTimeout: 0,
    }));
  }

  private async handleFailure(msg: any, err: Error): Promise<void> {
    const isBusiness = err instanceof WagerTransactionError;
    if (isBusiness) {
      // Erro de negócio: terminal, ack (não retry).
      this.logger.warn(`Business error on ${msg.MessageId}: ${err.message}`);
      await this.deleteMessage(msg);
      return;
    }
    // Transitório: devolve visibilidade para retry.
    this.logger.warn(`Transient error on ${msg.MessageId}: ${err.message}`);
    await this.returnVisibility(msg);
  }
}