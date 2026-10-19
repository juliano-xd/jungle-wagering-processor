/**
 * Identidade do provedor autenticado (spec 2).
 *
 * **Ponto de extensão** para autenticação. O padrão é **no-op** — a
 * `NoopProviderIdentityPort` retorna `null` e o `NoopAuthGuard` permite tudo.
 *
 * Para integrar um IdP real (Keycloak/Zitadel), implemente `ProviderIdentityPort`
 * chamando o `introspect` ou `verify` do provedor:
 *
 * ```typescript
 * @Injectable()
 * export class KeycloakProviderIdentityPort implements ProviderIdentityPort {
 *   async authenticate(request: Request): Promise<ProviderIdentity | null> {
 *     const token = request.headers.authorization?.replace('Bearer ', '');
 *     if (!token) return null;
 *     const claims = await this.keycloak.introspect(token);
 *     if (!claims.active) return null;
 *     return { providerId: claims.azp, claims };
 *   }
 * }
 * ```
 *
 * E registre em `HttpModule`:
 *
 * ```typescript
 * { provide: PROVIDER_IDENTITY, useClass: KeycloakProviderIdentityPort }
 * ```
 *
 * O `WageringController` continua validando `providerId` como campo de negócio
 * (spec 2: "a identidade do provedor contida na mensagem continua sujeita às
 * mesmas validações de domínio").
 */
export interface ProviderIdentity {
  /** Identificador do provedor (ex.: `provider-a`, `provider-b`). */
  providerId: string;
  /** Claims brutos do IdP para autorização/auditoria. */
  claims?: Record<string, unknown>;
}

export interface ProviderIdentityPort {
  /**
   * Retorna a identidade autenticada ou `null` se anônimo.
   *
   * Implementações no-op retornam sempre `null`.
   */
  authenticate(request: unknown): Promise<ProviderIdentity | null>;
}

export const PROVIDER_IDENTITY = Symbol('PROVIDER_IDENTITY');
