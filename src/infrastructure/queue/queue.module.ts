import { Global, Module } from '@nestjs/common';
import {
  QUEUE_CONSUMER,
  QUEUE_PUBLISHER,
} from './queue.port.js';
import { InMemoryQueueAdapter } from './in-memory-queue.adapter.js';
import { AwsSqsQueueAdapter } from './aws-sqs-queue.adapter.js';
import { WagerTransactionConsumer } from './wager-transaction.consumer.js';
import { DevQueueController } from './dev-queue.controller.js';
import { WageringService } from '../../application/services/wagering.service.js';

/**
 * Escolhe o backend da fila com base em `QUEUE_BACKEND`:
 *   - `memory` (default): in-memory (dev/testes)
 *   - `aws`: AWS SQS via `@aws-sdk/client-sqs`
 *
 * O `MetricsService` (de `MetricsModule`, `@Global`) é injetado
 * automaticamente nos providers que declaram `@Optional() metrics?`.
 */
@Global()
@Module({
  controllers: [DevQueueController],
  providers: [
    WageringService,
    InMemoryQueueAdapter,
    WagerTransactionConsumer,
    {
      provide: QUEUE_PUBLISHER,
      inject: [InMemoryQueueAdapter],
      useFactory: (inMemory: InMemoryQueueAdapter) => buildQueue(inMemory),
    },
    {
      provide: QUEUE_CONSUMER,
      inject: [InMemoryQueueAdapter],
      useFactory: (inMemory: InMemoryQueueAdapter) => buildQueue(inMemory),
    },
  ],
  exports: [
      WagerTransactionConsumer,
      QUEUE_PUBLISHER,
      QUEUE_CONSUMER,
    ],
})
export class QueueModule {}

function buildQueue(
  inMemory: InMemoryQueueAdapter,
): InMemoryQueueAdapter | AwsSqsQueueAdapter {
  const backend = (process.env.QUEUE_BACKEND ?? 'memory').toLowerCase();
  if (backend === 'aws') {
    const queueUrl = process.env.SQS_QUEUE_URL;
    if (!queueUrl) {
      throw new Error(
        'QUEUE_BACKEND=aws requires SQS_QUEUE_URL. ' +
          'Set it, or use QUEUE_BACKEND=memory for dev.',
      );
    }
    return new AwsSqsQueueAdapter({
      region: process.env.SQS_REGION ?? 'us-east-1',
      endpoint: process.env.SQS_ENDPOINT,
      queueUrl,
      dlqUrl: process.env.SQS_DLQ_URL,
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    });
  }
  return inMemory;
}
