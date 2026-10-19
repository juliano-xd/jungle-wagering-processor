import { Module } from '@nestjs/common';
import { OUTBOX_PUBLISHER } from './outbox-publisher.port.js';
import { OutboxPublisherWorker } from './outbox-publisher.worker.js';
import { ConsoleOutboxPublisher } from './console-outbox-publisher.js';
import { QueueOutboxPublisher } from './queue-outbox-publisher.js';
import { QueueModule } from '../queue/queue.module.js';

@Module({
  imports: [QueueModule],
  providers: [
    OutboxPublisherWorker,
    ConsoleOutboxPublisher,
    QueueOutboxPublisher,
    {
      provide: OUTBOX_PUBLISHER,
      inject: [ConsoleOutboxPublisher, QueueOutboxPublisher],
      useFactory: (
        console_: ConsoleOutboxPublisher,
        queue_: QueueOutboxPublisher,
      ) => {
        const backend = (
          process.env.OUTBOX_PUBLISHER_BACKEND ?? 'console'
        ).toLowerCase();
        return backend === 'queue' ? queue_ : console_;
      },
    },
  ],
  exports: [OutboxPublisherWorker],
})
export class OutboxModule {}
