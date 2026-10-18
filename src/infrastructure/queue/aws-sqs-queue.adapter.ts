import { Logger } from '@nestjs/common';
import {
  QueueConsumerPort,
  QueueMessage,
  QueuePublisherPort,
} from './queue.port.js';

/**
 * AWS SQS adapter (LocalStack/MiniStack/AWS real).
 *
 * Usa `@aws-sdk/client-sqs` via **import dinâmico** — se o pacote não estiver
 * instalado, só falha quando `QUEUE_BACKEND=aws`. App roda normalmente com
 * in-memory sem instalar nada.
 *
 * Sobre DLQ: quando `SQS_DLQ_URL` está configurado, usamos envio explícito
 * (mais previsível que RedrivePolicy nativa). Também aceita RedrivePolicy
 * nativa — funciona em ambos os casos.
 *
 * Sobre FIFO: `MessageGroupId` derivado do tipo de evento; `MessageDeduplicationId`
 * derivado do ID da outbox. Redelivery idêntica é absorvida pelo inbox do consumer.
 */
export class AwsSqsQueueAdapter implements QueueConsumerPort, QueuePublisherPort {
  private readonly logger = new Logger(AwsSqsQueueAdapter.name);

  // Tipos `any` para não exigir o pacote em compile-time.
  private client: any;
  private sqsMod: any;

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

    // Lazy init — o primeiro `send`/`receiveBatch` carrega o SDK.
    void this.init(config);
  }

  private async init(config: {
    endpoint?: string;
    region: string;
    queueUrl: string;
    dlqUrl?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
  }): Promise<void> {
    if (this.client) return;
    try {
      this.sqsMod = await import('@aws-sdk/client-sqs');
    } catch {
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
    if (!this.client) {
      throw new Error('AwsSqsQueueAdapter: init in progress or failed');
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
        MaxNumberOfMessages: Math.min(maxMessages, 10), // SQS cap = 10
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
    // Nota: se SQS estiver configurado com RedrivePolicy (maxReceiveCount) e
    // esta for a enésima entrega, o SQS move para DLQ automaticamente. O método
    // `moveToDlq` abaixo é para DLQ explícita (mais determinística).
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
