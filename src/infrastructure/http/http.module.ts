import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { WageringController } from './wagering.controller.js';
import { WalletsController } from './wallets.controller.js';
import { ProvidersController } from './providers.controller.js';
import { HealthController } from './health.controller.js';
import { DomainErrorFilter } from './domain-error.filter.js';
import { WageringService } from '../../application/services/wagering.service.js';

@Module({
  controllers: [
    WageringController,
    WalletsController,
    ProvidersController,
    HealthController,
  ],
  providers: [
    WageringService,
    { provide: APP_FILTER, useClass: DomainErrorFilter },
  ],
  exports: [WageringService],
})
export class HttpModule {}
