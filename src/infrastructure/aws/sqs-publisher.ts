import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

export interface SqsPublisherConfig {
  endpoint: string;
  region: string;
  queueUrl: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

/**
 * SqsPublisher: publica mensagens de integração na SQS (LocalStack em dev).
 */
export class SqsPublisher {
  private readonly client: SQSClient;

  constructor(private readonly config: SqsPublisherConfig) {
    this.client = new SQSClient({
      region: config.region,
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.accessKeyId || 'test',
        secretAccessKey: config.secretAccessKey || 'test',
      },
    });
  }

  async publish(messageId: string, body: unknown): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.config.queueUrl,
        MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    );
  }
}
