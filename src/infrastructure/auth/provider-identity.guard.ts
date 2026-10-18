import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

/**
 * ProviderIdentityPort — ponto de extensão para autenticação.
 *
 * DECISÃO (documentada no ARCHITECTURE.md): este desafio NÃO implementa
 * autenticação artesanal. O `ProviderIdentityGuard` é um no-op que permite
 * a requisição, e o `ProviderIdentityPort` é a porta onde um Identity
 * Provider externo (Keycloak/Zitadel/OIDC) seria integrado.
 *
 * Para ativar a autenticação em produção:
 *   1. implemente `ProviderIdentityPort` validando JWT/Client-Credentials;
 *   2. substitua o `canReturnTrue` abaixo por uma verificação real;
 * 3. anote os controllers com `@UseGuards(ProviderIdentityGuard)`.
 */
export const PROVIDER_IDENTITY_PORT = 'PROVIDER_IDENTITY_PORT';

export interface ProviderIdentity {
  providerId: string;
  scopes: string[];
}

export interface ProviderIdentityPort {
  validate(request: {
    headers: Record<string, string | string[] | undefined>;
    ip?: string;
  }): Promise<ProviderIdentity | null>;
}

/** Implementação no-op padrão — aceita qualquer provedor. */
@Injectable()
export class NoopProviderIdentity implements ProviderIdentityPort {
  async validate(_request: {
    headers: Record<string, string | string[] | undefined>;
    ip?: string;
  }): Promise<ProviderIdentity | null> {
    return { providerId: 'unknown', scopes: [] };
  }
}

@Injectable()
export class ProviderIdentityGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly identity: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.get<boolean>('isPublic', context.getHandler());
    if (isPublic) return true;
    const req = context.switchToHttp().getRequest();
    const identity = await this.identity.validate({
      headers: req.headers,
      ip: req.ip,
    });
    if (!identity) return false;
    req.provider = identity;
    return true;
  }
}