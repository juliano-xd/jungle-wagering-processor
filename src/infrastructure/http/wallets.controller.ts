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
import {
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { WageringService } from '../../application/services/wagering.service.js';
import type { CreateWalletBody } from '../../application/dtos/create-wallet.dto.js';
import { Money } from '../../domain/value-objects/money.js';

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

@ApiTags('wallets')
@Controller('wallets')
export class WalletsController {
  constructor(private readonly service: WageringService) {}

  @Post()
  @ApiOperation({
    summary: 'Cria wallet com saldo inicial',
    description:
      'O saldo inicial gera uma transação `OPENING` interna + `CREDIT` no ledger, ' +
      'na mesma transação SQL. Wallet duplicada (mesmo `playerId` + `currency`) → 409.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['playerId', 'initialBalance'],
      properties: {
        playerId: { type: 'string', format: 'uuid' },
        initialBalance: {
          type: 'object',
          required: ['amount', 'currency'],
          properties: {
            amount: { type: 'string', example: '100.00' },
            currency: { type: 'string', example: 'BRL' },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Wallet criada',
    schema: {
      example: {
        id: '0192f291-27dd-7d3f-8071-5f8685deef37',
        playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
        balance: { amount: '100.00', currency: 'BRL' },
        version: 1,
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Payload inválido' })
  @ApiResponse({ status: 409, description: 'Wallet duplicada (playerId+currency)' })
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
  @ApiOperation({ summary: 'Consulta uma wallet por ID' })
  @ApiOkResponse({ description: 'Wallet encontrada' })
  @ApiResponse({ status: 400, description: 'UUID inválido' })
  @ApiResponse({ status: 404, description: 'Wallet não encontrada' })
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
  @ApiOperation({
    summary: 'Consulta o ledger paginado por cursor opaco',
    description:
      'Cursor keyset: `base64url(JSON({ createdAt, id }))`. Ordenação: ' +
      '`created_at DESC, id DESC`. `limit` máximo 200.',
  })
  @ApiOkResponse({ description: 'Página do ledger' })
  @ApiResponse({ status: 400, description: 'UUID ou cursor inválido' })
  @ApiResponse({ status: 404, description: 'Wallet não encontrada' })
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
  @ApiOperation({
    summary: 'Reconciliação — recalcula saldo a partir do ledger',
    description:
      'Divergências NÃO são corrigidas silenciosamente: retorna `consistent: false` + ' +
      '`difference`. Também incrementa `wallet_reconciliation_divergence_total` e loga ' +
      '`wallet.reconciliation_divergence` em `WARN`.',
  })
  @ApiOkResponse({ description: 'Resultado da reconciliação' })
  @ApiResponse({ status: 400, description: 'UUID inválido' })
  @ApiResponse({ status: 404, description: 'Wallet não encontrada' })
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
