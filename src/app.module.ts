import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import config from '../mikro-orm.config.js';
import { HttpModule } from './infrastructure/http/http.module.js';
import { MetricsModule } from './infrastructure/observability/metrics.module.js';
import { OutboxModule } from './infrastructure/outbox/outbox.module.js';
import { PendingReferenceModule } from './infrastructure/pending-reference/pending-reference.module.js';
import { QueueModule } from './infrastructure/queue/queue.module.js';

/**
 * Módulo raiz.
 *
 * `MetricsModule` é `@Global`, portanto pode ser importado em qualquer posição
 * da lista sem afetar a resolução de `@Optional() metrics?` nos workers.
 */
@Module({
  imports: [
    MikroOrmModule.forRoot(config),
    MetricsModule,
    HttpModule,
    OutboxModule,
    PendingReferenceModule,
    QueueModule,
  ],
})
export class AppModule {}
