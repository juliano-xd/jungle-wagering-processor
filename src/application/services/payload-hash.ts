import { payloadHashOf } from '../../domain/services/canonical-json.js';

/**
 * Hash canônico do payload de submissão de transação.
 *
 * **Fonte única de verdade**: HTTP controller e consumer SQS DEVEM usar este
 * helper — caso contrário, a mesma operação semântica gera hashes diferentes
 * dependendo do canal de entrada, quebrando replay entre HTTP e SQS.
 *
 * Inclui APENAS campos de negócio. Metadados de transporte (header
 * `X-Correlation-Id`, `X-Forwarded-For`, timestamp de chegada) NÃO entram.
 *
 * Testado em `test/unit/services/payload-hash.spec.ts` (paridade HTTP↔SQS).
 */
export interface SubmitPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string | null;
}

export function computeSubmitPayloadHash(dto: SubmitPayload): string {
  return payloadHashOf({
    providerId: dto.providerId,
    externalTransactionId: dto.externalTransactionId,
    playerId: dto.playerId,
    walletId: dto.walletId,
    roundId: dto.roundId,
    gameId: dto.gameId,
    kind: dto.kind,
    money: dto.money,
    referenceExternalTransactionId: dto.referenceExternalTransactionId ?? null,
  });
}
