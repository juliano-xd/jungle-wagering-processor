import { Global, Module } from '@nestjs/common';
import {
  QUEUE_CONSUMER,
  QUEUE_PUBLISHER,
  type QueueConsumerPort,
  type QueuePublisherPort,
} from './queue.port.js';
import { InMemoryQueueAdapter } from './in-memory-queue.adapter.js';
import { AwsSqsQueueAdapter } from './aws-sqs-queue.adapter.js';
import { WagerTransactionConsumer } from './wager-transaction.consumer.js';
import { DevQueueController } from './dev-queue.controller.js';
import { WageringService } from '../../application/services/wagering.service.js';

/** Token interno — instância única do adapter de fila (SQS ou in-memory). */
const QUEUE_ADAPTER = Symbol('QUEUE_ADAPTER');

type QueueAdapter = QueueConsumerPort & QueuePublisherPort;

/**
 * Escolhe o backend da fila com base em `QUEUE_BACKEND`:
 *   - `memory` (default): in-memory (dev/testes)
 *   - `aws`: AWS SQS via `@aws-sdk/client-sqs`
 *
 * `QUEUE_PUBLISHER` e `QUEUE_CONSUMER` apontam para a **mesma instância**
 * via `useExisting` — importante para SQS (uma única conexão) e para FIFO
 * (deduplicação por `MessageDeduplicationId` exige coerência entre envios).
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
      provide: QUEUE_ADAPTER,
      inject: [InMemoryQueueAdapter],
      useFactory: buildQueue,
    },
    { provide: QUEUE_PUBLISHER, useExisting: QUEUE_ADAPTER },
    { provide: QUEUE_CONSUMER, useExisting: QUEUE_ADAPTER },
  ],
  exports: [WagerTransactionConsumer, QUEUE_PUBLISHER, QUEUE_CONSUMER],
})
export class QueueModule {}

function buildQueue(inMemory: InMemoryQueueAdapter): QueueAdapter {
  const backend = (process.env.QUEUE_BACKEND ?? 'memory').toLowerCase();
  if (backend !== 'aws') return inMemory;

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
