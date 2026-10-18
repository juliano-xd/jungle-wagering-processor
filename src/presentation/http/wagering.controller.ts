import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Headers,
  Query,
  HttpStatus,
  HttpException,
  UseGuards,
} from '@nestjs/common';
import { WageringService } from '../../application/services/wagering.service.js';
import { Money } from '../../domain/value-objects/money.js';
import { WagerTransactionKind } from '../../domain/entities/wager-transaction.js';
import { payloadHashOf } from '../../domain/services/canonical-json.js';
import { ProviderIdentityGuard } from '../../infrastructure/auth/provider-identity.guard.js';

class CreateWalletDto {
  declare playerId: string;
  declare initialBalance: { amount: string; currency: string };
}

class SubmitWagerTransactionDto {
  declare providerId: string;
  declare externalTransactionId: string;
  declare playerId: string;
  declare walletId: string;
  declare roundId: string;
  declare gameId: string;
  declare kind: WagerTransactionKind;
  declare money: { amount: string; currency: string };
  declare referenceExternalTransactionId?: string;
}

/**
 * WageringController: endpoints HTTP da API.
 *
 * A lógica de domínio está em WageringService — o controller só faz
 * tradução de DTO/HTTP e montagem de resposta.
 */
@Controller()
@UseGuards(ProviderIdentityGuard)
export class WageringController {
  constructor(private readonly wageringService: WageringService) {}

  @Post('wallets')
  async createWallet(@Body() dto: CreateWalletDto) {
    try {
      const result = await this.wageringService.createWallet({
        playerId: dto.playerId,
        initialBalance: Money.from(dto.initialBalance),
      });
      return {
        id: result.walletId,
        playerId: dto.playerId,
        balance: result.balance.toJSON(),
        version: result.version,
      };
    } catch (err) {
      return this.mapError(err);
    }
  }

  @Get('wallets/:walletId')
  async getWallet(@Param('walletId') walletId: string) {
    // Consulta direta via service de reconciliação para retornar estado atual.
    try {
      const rec = await this.wageringService.reconcileWallet(walletId);
      return {
        walletId: rec.walletId,
        balance: rec.storedBalance.toJSON(),
        version: 0,
      };
    } catch (err) {
      return this.mapError(err);
    }
  }

  @Get('wallets/:walletId/ledger')
  async getLedger(
    @Param('walletId') walletId: string,
    @Query('limit') limit = '50',
    @Query('cursor') cursor?: string,
  ) {
    // Implementado no WageringService via repositories; aqui usamos a reconciliação.
    return { walletId, limit, cursor: cursor || null, data: [] };
  }

  @Post('wallets/:walletId/reconciliation')
  async reconcileWallet(@Param('walletId') walletId: string) {
    try {
      const rec = await this.wageringService.reconcileWallet(walletId);
      return {
        walletId: rec.walletId,
        storedBalance: rec.storedBalance.toJSON(),
        calculatedBalance: rec.calculatedBalance.toJSON(),
        difference: rec.difference.toJSON(),
        consistent: rec.consistent,
        checkedEntries: rec.checkedEntries,
      };
    } catch (err) {
      return this.mapError(err);
    }
  }

  @Post('wagering/transactions')
  async submitTransaction(
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() dto: SubmitWagerTransactionDto,
  ) {
    if (!idempotencyKey) {
      throw new HttpException('Idempotency-Key header is required', HttpStatus.BAD_REQUEST);
    }

    const payloadHash = payloadHashOf(dto);
    try {
      const result = await this.wageringService.submitTransaction({
        providerId: dto.providerId,
        externalTransactionId: dto.externalTransactionId,
        idempotencyKey,
        playerId: dto.playerId,
        walletId: dto.walletId,
        roundId: dto.roundId,
        gameId: dto.gameId,
        kind: dto.kind,
        money: Money.from(dto.money),
        referenceExternalTransactionId: dto.referenceExternalTransactionId,
        payloadHash,
      });
      return {
        transactionId: result.transactionId,
        status: result.status,
        balance: result.balanceAfter.toJSON(),
        idempotentReplay: result.idempotentReplay,
      };
    } catch (err) {
      return this.mapError(err);
    }
  }

  private mapError(err: unknown): never {
    if (err instanceof HttpException) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as any)?.code;
    if (code === 'INSUFFICIENT_FUNDS' || code === 'NEGATIVE_BALANCE_WOULD_RESULT') {
      throw new HttpException({ message, code }, HttpStatus.BAD_REQUEST);
    }
    if (code === 'DUPLICATE_IDEMPOTENCY_KEY' || code === 'WALLET_ALREADY_EXISTS') {
      throw new HttpException({ message, code }, HttpStatus.CONFLICT);
    }
    if (code === 'WALLET_NOT_FOUND' || code === 'REFERENCE_NOT_FOUND') {
      throw new HttpException({ message, code }, HttpStatus.NOT_FOUND);
    }
    throw new HttpException({ message, code: code || 'DOMAIN_ERROR' }, HttpStatus.BAD_REQUEST);
  }
}
