import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { WageringService } from '../../application/services/wagering.service.js';
import type { CreateWalletBody } from '../../application/dtos/create-wallet.dto.js';
import { Money } from '../../domain/value-objects/money.js';

/**
 * UUID em formato canônico (8-4-4-4-12 hex, com hífens).
 *
 * NÃO valida a versão (v1–v8) nem a variante RFC 4122 — o Postgres aceita
 * qualquer UUID nesse formato, e o serviço usa UUIDs v7 (time-ordered)
 * gerados pelo `crypto.randomUUID()` do Node.
 *
 * Regex anterior `[1-5][0-9a-f]{3}` rejeitava v7 — bug encontrado no E2E.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new BadRequestException({
      error: 'INVALID_BODY',
      message: `${field} must be a valid UUID`,
      retryable: false,
    });
  }
}

@Controller('wallets')
export class WalletsController {
  constructor(private readonly service: WageringService) {}

  @Post()
  async create(
    @Body() body: CreateWalletBody,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!body || typeof body !== 'object') {
      throw new BadRequestException({
        error: 'INVALID_BODY',
        message: 'Request body is required',
        retryable: false,
      });
    }
    assertUuid(body.playerId, 'playerId');

    if (
      !body.initialBalance ||
      typeof body.initialBalance.amount !== 'string' ||
      typeof body.initialBalance.currency !== 'string'
    ) {
      throw new BadRequestException({
        error: 'INVALID_BODY',
        message: 'initialBalance must be { amount: string, currency: string }',
        retryable: false,
      });
    }

    const result = await this.service.createWallet({
      playerId: body.playerId,
      initialBalance: Money.from(body.initialBalance),
    });

    res.status(HttpStatus.CREATED);
    return {
      id: result.walletId,
      playerId: body.playerId,
      balance: result.balance.toJSON(),
      version: result.version,
    };
  }

  @Get(':walletId')
  async getById(@Param('walletId') walletId: string) {
    if (!UUID_RE.test(walletId)) {
      throw new BadRequestException({
        error: 'INVALID_PARAM',
        message: 'walletId must be a valid UUID',
        retryable: false,
      });
    }
    const wallet = await this.service.getWallet(walletId);
    if (!wallet) {
      throw new NotFoundException({
        error: 'WALLET_NOT_FOUND',
        message: 'Wallet not found',
        retryable: false,
      });
    }
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
      createdAt: wallet.createdAt.toISOString(),
      updatedAt: wallet.updatedAt.toISOString(),
    };
  }

  @Get(':walletId/ledger')
  async getLedger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limitRaw?: string,
  ) {
    if (!UUID_RE.test(walletId)) {
      throw new BadRequestException({
        error: 'INVALID_PARAM',
        message: 'walletId must be a valid UUID',
        retryable: false,
      });
    }
    const parsedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : 50;
    const limit = Number.isFinite(parsedLimit) ? parsedLimit : 50;

    const result = await this.service.listLedger(walletId, cursor, limit);
    return {
      walletId,
      entries: result.entries.map((e) => ({
        id: e.id,
        transactionId: e.transactionId,
        direction: e.direction,
        money: e.money.toJSON(),
        balanceBefore: e.balanceBefore.toJSON(),
        balanceAfter: e.balanceAfter.toJSON(),
        createdAt: e.createdAt.toISOString(),
      })),
      nextCursor: result.nextCursor,
    };
  }

  @Post(':walletId/reconciliation')
  async reconcile(@Param('walletId') walletId: string) {
    if (!UUID_RE.test(walletId)) {
      throw new BadRequestException({
        error: 'INVALID_PARAM',
        message: 'walletId must be a valid UUID',
        retryable: false,
      });
    }
    const rec = await this.service.reconcileWallet(walletId);
    return {
      walletId: rec.walletId,
      storedBalance: rec.storedBalance.toJSON(),
      calculatedBalance: rec.calculatedBalance.toJSON(),
      difference: rec.difference.toJSON(),
      consistent: rec.consistent,
      checkedEntries: rec.checkedEntries,
    };
  }
}
