import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { WageringController } from './wagering.controller.js';
import { WalletsController } from './wallets.controller.js';
import { ProvidersController } from './providers.controller.js';
import { HealthController } from './health.controller.js';
import { DomainErrorFilter } from './domain-error.filter.js';
import { WageringService } from '../../application/services/wagering.service.js';
import { NoopAuthGuard } from '../auth/noop-auth.guard.js';
import { NoopProviderIdentityPort } from '../auth/noop-provider-identity.port.js';
import {
  PROVIDER_IDENTITY,
} from '../../application/ports/provider-identity.port.js';

/**
 * Camada HTTP.
 *
 * Autenticação (spec 2): `NoopAuthGuard` como `APP_GUARD` — aceita tudo.
 * Ponto de extensão: substituir `NoopAuthGuard` por um guard real e
 * `NoopProviderIdentityPort` por uma implementação Keycloak/Zitadel.
 */
@Module({
  controllers: [
    WageringController,
    WalletsController,
    ProvidersController,
    HealthController,
  ],
  providers: [
    WageringService,
    NoopProviderIdentityPort,
    { provide: PROVIDER_IDENTITY, useExisting: NoopProviderIdentityPort },
    { provide: APP_GUARD, useClass: NoopAuthGuard },
    { provide: APP_FILTER, useClass: DomainErrorFilter },
  ],
  exports: [WageringService],
})
export class HttpModule {}
