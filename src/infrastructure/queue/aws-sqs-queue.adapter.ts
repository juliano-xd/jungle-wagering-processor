import { Logger } from '@nestjs/common';
import {
  QueueConsumerPort,
  QueueMessage,
  QueuePublisherPort,
} from './queue.port.js';

/**
 * AWS SQS adapter (LocalStack/MiniStack/AWS real).
 *
 * ⚠️ Init é assíncrono (`await import('@aws-sdk/client-sqs')`). Como o
 * construtor não pode ser async, guardamos a promise em `initPromise` e
 * `await` em `ready()`. Sem isso, `send`/`receive` disparados logo após
 * `new AwsSqsQueueAdapter(...)` lançariam "init in progress or failed".
 *
 * DLQ: se `SQS_DLQ_URL` estiver configurado, usamos envio explícito (mais
 * previsível que RedrivePolicy nativa). Ambos funcionam — RedrivePolicy só
 * funciona se a fila for criada com ela; envio explícito funciona sempre.
 *
 * FIFO: `MessageGroupId` derivado do tipo de evento; `MessageDeduplicationId`
 * derivado do ID da outbox. Redelivery idêntica é absorvida pelo inbox.
 */
export class AwsSqsQueueAdapter implements QueueConsumerPort, QueuePublisherPort {
  private readonly logger = new Logger(AwsSqsQueueAdapter.name);

  // Tipos `any` para não exigir o pacote em compile-time.
  private client: any;
  private sqsMod: any;
  private readonly initPromise: Promise<void>;

  private readonly queueUrl: string;
  private readonly dlqUrl?: string;
  private readonly maxReceiveCount = Number(process.env.SQS_MAX_RECEIVE_COUNT ?? 5);

  constructor(config: {
    endpoint?: string;
    region: string;
    queueUrl: string;
    dlqUrl?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
  }) {
    this.queueUrl = config.queueUrl;
    this.dlqUrl = config.dlqUrl;
    this.sqsMod = null;
    this.client = null;

    // Guarda a promise — `ready()` faz `await` antes de qualquer chamada.
    this.initPromise = this.init(config);
  }

  private async init(config: {
    endpoint?: string;
    region: string;
    queueUrl: string;
    dlqUrl?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
  }): Promise<void> {
    try {
      this.sqsMod = await import('@aws-sdk/client-sqs');
    } catch (err) {
      throw new Error(
        "QUEUE_BACKEND=aws requires '@aws-sdk/client-sqs' installed. " +
          'Run: bun add @aws-sdk/client-sqs',
      );
    }
    this.client = new this.sqsMod.SQSClient({
      region: config.region,
      endpoint: config.endpoint,
      credentials:
        config.accessKeyId && config.secretAccessKey
          ? {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            }
          : undefined,
    });
  }

  private async ready(): Promise<void> {
    await this.initPromise;
    if (!this.client) {
      throw new Error('AwsSqsQueueAdapter: initialization failed');
    }
  }

  async send(body: string, deduplicationId?: string, messageGroupId?: string): Promise<void> {
    await this.ready();
    const { SendMessageCommand } = this.sqsMod;
    const cmd = new SendMessageCommand({
      QueueUrl: this.queueUrl,
      MessageBody: body,
      ...(deduplicationId ? { MessageDeduplicationId: deduplicationId } : {}),
      ...(messageGroupId ? { MessageGroupId: messageGroupId } : {}),
    });
    await this.client.send(cmd);
  }

  async receiveBatch(maxMessages: number, waitTimeSeconds: number): Promise<QueueMessage[]> {
    await this.ready();
    const { ReceiveMessageCommand } = this.sqsMod;
    const res = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: Math.min(maxMessages, 10),
        WaitTimeSeconds: waitTimeSeconds,
        AttributeNames: ['ApproximateReceiveCount'],
      }),
    );
    return (res.Messages ?? []).map((m: any) => ({
      messageId: m.MessageId ?? '',
      receiptHandle: m.ReceiptHandle ?? '',
      body: m.Body ?? '',
    }));
  }

  async ack(message: QueueMessage): Promise<void> {
    await this.ready();
    const { DeleteMessageCommand } = this.sqsMod;
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: message.receiptHandle,
      }),
    );
  }

  async nack(message: QueueMessage, retryAfterSeconds: number): Promise<void> {
    await this.ready();
    const { ChangeMessageVisibilityCommand } = this.sqsMod;
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: message.receiptHandle,
        VisibilityTimeout: retryAfterSeconds,
      }),
    );
  }

  async moveToDlq(message: QueueMessage, reason: string): Promise<void> {
    await this.ready();
    if (this.dlqUrl) {
      const { SendMessageCommand } = this.sqsMod;
      await this.client.send(
        new SendMessageCommand({
          QueueUrl: this.dlqUrl,
          MessageBody: message.body,
          MessageAttributes: {
            reason: { DataType: 'String', StringValue: reason },
          },
        }),
      );
    } else {
      this.logger.error(
        JSON.stringify({
          event: 'queue.sqs.moved_to_dlq_no_url',
          messageId: message.messageId,
          reason,
        }),
      );
    }
    await this.ack(message);
  }
}
