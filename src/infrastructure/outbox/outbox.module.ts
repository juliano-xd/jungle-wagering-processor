import { Module } from '@nestjs/common';
import {
  OUTBOX_PUBLISHER,
} from './outbox-publisher.port.js';
import { OutboxPublisherWorker } from './outbox-publisher.worker.js';
import { ConsoleOutboxPublisher } from './console-outbox-publisher.js';

/**
 * Registra o worker do outbox + publisher default (console).
 *
 * Para plugar SQS:
 *   providers: [{ provide: OUTBOX_PUBLISHER, useClass: SqsOutboxPublisher }]
 */
@Module({
  providers: [
    OutboxPublisherWorker,
    { provide: OUTBOX_PUBLISHER, useClass: ConsoleOutboxPublisher },
  ],
  exports: [OutboxPublisherWorker],
})
export class OutboxModule {}
