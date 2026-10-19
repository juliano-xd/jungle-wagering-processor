import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

/**
 * Guard no-op — aceita qualquer request (spec 2: autenticação fora do escopo
 * de pontos).
 *
 * **Ponto de extensão explícito**: substitua por um guard real (Keycloak,
 * Zitadel, etc.) registrando-o como `APP_GUARD` em `HttpModule` no lugar
 * deste. Ou adicione `@UseGuards(KeycloakGuard)` em controllers específicos.
 *
 * O `NoopAuthGuard` é registrado como `APP_GUARD` em `HttpModule` e não
 * interfere nos endpoints `/health/*` nem no consumer SQS (canal interno
 * confiável, spec 2).
 *
 * Documentação relacionada: `ARCHITECTURE.md` seção 12; `.env.example`.
 */
@Injectable()
export class NoopAuthGuard implements CanActivate {
  canActivate(_ctx: ExecutionContext): boolean {
    return true;
  }
}
