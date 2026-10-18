import { Global, Module } from '@nestjs/common';
import { MetricsService } from './metrics.service.js';
import { MetricsController } from './metrics.controller.js';

/**
 * @Global — qualquer provider pode injetar `MetricsService` sem importar
 * o módulo (evita repetição em todo lugar). O registro Prometheus é um
 * singleton por processo.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
