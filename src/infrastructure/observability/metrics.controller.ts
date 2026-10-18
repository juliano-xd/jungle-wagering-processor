import { Controller, Get, Header } from '@nestjs/common';
import { MetricsService } from './metrics.service.js';

/**
 * GET /metrics — exporta o registro Prometheus no formato texto.
 *
 * NÃO exige autenticação (spec 9 — health e métricas abertos; o contrato
 * de rede é interno). Em produção, isole via NetworkPolicy/ingress
 * privado, não via auth.
 */
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape(): Promise<string> {
    return this.metrics.render();
  }
}
