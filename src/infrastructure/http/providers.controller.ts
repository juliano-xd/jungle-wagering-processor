import {
  Controller,
  Get,
  NotFoundException,
  Param,
} from '@nestjs/common';
import { WageringService } from '../../application/services/wagering.service.js';

/**
 * GET /providers/:providerId/wagering/transactions/:externalTransactionId
 *
 * Lookup por (providerId, externalTransactionId) — a mesma chave usada pelo
 * provedor quando consulta o resultado de uma transação específica.
 */
@Controller('providers/:providerId/wagering/transactions')
export class ProvidersController {
  constructor(private readonly service: WageringService) {}

  @Get(':externalTransactionId')
  async getByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    const tx = await this.service.getTransactionByProviderAndExternalId(
      providerId,
      externalTransactionId,
    );
    if (!tx) {
      throw new NotFoundException({
        error: 'TRANSACTION_NOT_FOUND',
        message: 'Transaction not found for this provider',
        retryable: false,
      });
    }
    return {
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      money: tx.money.toJSON(),
      referenceExternalTransactionId: tx.referenceExternalTransactionId,
      referenceTransactionId: tx.referenceTransactionId,
      status: tx.status,
      failureCode: tx.failureCode,
      processedAt: tx.processedAt?.toISOString(),
      createdAt: tx.createdAt.toISOString(),
    };
  }
}
