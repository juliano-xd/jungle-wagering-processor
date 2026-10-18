import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import config from '../mikro-orm.config.js';
import { HttpModule } from './infrastructure/http/http.module.js';
import { OutboxModule } from './infrastructure/outbox/outbox.module.js';
import { PendingReferenceModule } from './infrastructure/pending-reference/pending-reference.module.js';
import { QueueModule } from './infrastructure/queue/queue.module.js';
import { MetricsModule } from './infrastructure/observability/metrics.module.js';

/**
 * Módulo raiz.
 *
 * Ordem importa só no sentido de "MetricsModule" precisa estar registrado
 * ANTES dos workers (para o `@Optional() metrics?` ser resolvido). Como
 * `MetricsModule` é `@Global`, a ordem efetiva não muda o resultado.
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
