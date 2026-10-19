import { Injectable } from '@nestjs/common';
import {
  ProviderIdentity,
  ProviderIdentityPort,
} from '../../application/ports/provider-identity.port.js';

/**
 * Implementação no-op de `ProviderIdentityPort`.
 *
 * Retorna sempre `null` (anônimo). O `WageringController` continua validando
 * `providerId` como campo de negócio — spec 2: "a identidade do provedor
 * contida na mensagem continua sujeita às mesmas validações de domínio".
 */
@Injectable()
export class NoopProviderIdentityPort implements ProviderIdentityPort {
  async authenticate(_request: unknown): Promise<ProviderIdentity | null> {
    return null;
  }
}
