import { Logger } from '@nestjs/common';
import {
  QueueConsumerPort,
  QueueMessage,
  QueuePublisherPort,
} from './queue.port.js';

interface SqsConfig {
  endpoint?: string;
  region: string;
  queueUrl: string;
  dlqUrl?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

/**
 * AWS SQS adapter (LocalStack/MiniStack/AWS real).
 *
 * Init é assíncrono: o construtor não pode ser `async`, então guardamos a
 * promise em `initPromise` e fazemos `await` em `ready()` antes de qualquer
 * operação. Sem isso, `send`/`receive` chamados logo após o `new` falhariam.
 *
 * DLQ: com `dlqUrl` configurado, usamos envio explícito — sempre funciona,
 * independente de a fila ter sido criada com `RedrivePolicy`.
 *
 * FIFO: `MessageGroupId`/`MessageDeduplicationId` vêm do caller; redelivery
 * idêntica é absorvida pelo inbox.
 */
export class AwsSqsQueueAdapter implements QueueConsumerPort, QueuePublisherPort {
  private readonly logger = new Logger(AwsSqsQueueAdapter.name);

  // Tipos `any` para não exigir `@aws-sdk/client-sqs` em compile-time.
  private client: any = null;
  private sqsMod: any = null;
  private readonly initPromise: Promise<void>;

  private readonly queueUrl: string;
  private readonly dlqUrl?: string;

  constructor(config: SqsConfig) {
    this.queueUrl = config.queueUrl;
    this.dlqUrl = config.dlqUrl;
    this.initPromise = this.init(config);
  }

  private async init(config: SqsConfig): Promise<void> {
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

  /** Garante que o client foi inicializado. */
  private async ready(): Promise<void> {
    await this.initPromise;
  }

  /** Instancia um comando SQS e o envia após garantir o `ready()`. */
  private async dispatch(commandName: string, input: Record<string, unknown>): Promise<any> {
    await this.ready();
    return this.client.send(new this.sqsMod[commandName](input));
  }

  async send(body: string, deduplicationId?: string, messageGroupId?: string): Promise<void> {
    await this.dispatch('SendMessageCommand', {
      QueueUrl: this.queueUrl,
      MessageBody: body,
      ...(deduplicationId ? { MessageDeduplicationId: deduplicationId } : {}),
      ...(messageGroupId ? { MessageGroupId: messageGroupId } : {}),
    });
  }

  async receiveBatch(maxMessages: number, waitTimeSeconds: number): Promise<QueueMessage[]> {
    const res = await this.dispatch('ReceiveMessageCommand', {
      QueueUrl: this.queueUrl,
      MaxNumberOfMessages: Math.min(maxMessages, 10),
      WaitTimeSeconds: waitTimeSeconds,
      AttributeNames: ['ApproximateReceiveCount'],
    });

    return (res.Messages ?? []).map((m: any) => ({
      messageId: m.MessageId ?? '',
      receiptHandle: m.ReceiptHandle ?? '',
      body: m.Body ?? '',
    }));
  }

  async ack(message: QueueMessage): Promise<void> {
    await this.dispatch('DeleteMessageCommand', {
      QueueUrl: this.queueUrl,
      ReceiptHandle: message.receiptHandle,
    });
  }

  async nack(message: QueueMessage, retryAfterSeconds: number): Promise<void> {
    await this.dispatch('ChangeMessageVisibilityCommand', {
      QueueUrl: this.queueUrl,
      ReceiptHandle: message.receiptHandle,
      VisibilityTimeout: retryAfterSeconds,
    });
  }

  async moveToDlq(message: QueueMessage, reason: string): Promise<void> {
    if (this.dlqUrl) {
      await this.dispatch('SendMessageCommand', {
        QueueUrl: this.dlqUrl,
        MessageBody: message.body,
        MessageAttributes: {
          reason: { DataType: 'String', StringValue: reason },
        },
      });
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
