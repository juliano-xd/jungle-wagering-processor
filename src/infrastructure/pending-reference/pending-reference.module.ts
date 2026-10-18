import { Module } from '@nestjs/common';
import { WageringService } from '../../application/services/wagering.service.js';
import { PendingReferenceWorker } from './pending-reference.worker.js';

/**
 * Registra o worker de PENDING_REFERENCE.
 *
 * Depende de `WageringService` — se outro módulo já o registra como provider,
 * importe-o e exporte; aqui mantemos autocontido (registramos localmente)
 * porque `WageringService` é stateless e barato de instanciar.
 */
@Module({
  providers: [WageringService, PendingReferenceWorker],
  exports: [PendingReferenceWorker],
})
export class PendingReferenceModule {}
