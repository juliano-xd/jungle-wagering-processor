import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiBody,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { WageringService } from '../../application/services/wagering.service.js';
import type { SubmitTransactionBody } from '../../application/dtos/submit-transaction.dto.js';
import { Money } from '../../domain/value-objects/money.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/entities/wager-transaction.js';
import { computeSubmitPayloadHash } from '../../application/services/payload-hash.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@ApiTags('wagering')
@Controller('wagering/transactions')
export class WageringController {
  constructor(private readonly service: WageringService) {}

  @Post()
  @ApiOperation({
    summary: 'Submete uma transação de apostas',
    description:
      'Idempotência via header `Idempotency-Key`. Mesma key + mesmo `payloadHash` → replay; ' +
      'mesma key + payload diferente → 409. Transações `REFUND`/`ROLLBACK` sem referência ' +
      'viram `PENDING_REFERENCE` (202) e são reprocessadas por worker.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'Formato recomendado: `{providerId}:{externalTransactionId}`. ' +
      'Fonte da verdade para idempotência.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: [
        'providerId',
        'externalTransactionId',
        'playerId',
        'walletId',
        'roundId',
        'gameId',
        'kind',
        'money',
      ],
      properties: {
        providerId: { type: 'string', example: 'prov-1' },
        externalTransactionId: { type: 'string', example: 'tx-123' },
        playerId: { type: 'string', format: 'uuid' },
        walletId: { type: 'string', format: 'uuid' },
        roundId: { type: 'string', example: 'round-987' },
        gameId: { type: 'string', example: 'fortune-chimp' },
        kind: {
          type: 'string',
          enum: ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'],
          example: 'BET',
        },
        money: {
          type: 'object',
          required: ['amount', 'currency'],
          properties: {
            amount: { type: 'string', example: '25.00' },
            currency: { type: 'string', example: 'BRL' },
          },
        },
        referenceExternalTransactionId: {
          type: 'string',
          description: 'Obrigatório para REFUND e ROLLBACK',
          example: 'original-bet-id',
        },
      },
    },
  })
  @ApiOkResponse({
    description: 'Transação PROCESSED',
    schema: {
      example: {
        transactionId: '0192f298-345e-7e38-af88-e43f851a819d',
        status: 'PROCESSED',
        balance: { amount: '975.00', currency: 'BRL' },
        walletVersion: 2,
        idempotentReplay: false,
      },
    },
  })
  @ApiResponse({
    status: 202,
    description: 'PENDING_REFERENCE — aguardando referência',
    schema: {
      example: {
        transactionId: '0192...',
        status: 'PENDING_REFERENCE',
        balance: { amount: '100.00', currency: 'BRL' },
        walletVersion: 1,
        idempotentReplay: false,
      },
    },
  })
  @ApiResponse({
    status: 422,
    description: 'Rejeição por regra de negócio',
    schema: {
      example: {
        transactionId: '0192...',
        status: 'REJECTED',
        balance: { amount: '10.00', currency: 'BRL' },
        walletVersion: 1,
        idempotentReplay: false,
        failureCode: 'INSUFFICIENT_FUNDS',
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Payload inválido ou Idempotency-Key ausente' })
  @ApiResponse({ status: 404, description: 'Wallet não encontrada' })
  @ApiResponse({ status: 409, description: 'Conflito de idempotência' })
  async submit(
    @Body() body: SubmitTransactionBody,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') _correlationId: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!idempotencyKey || idempotencyKey.trim() === '') {
      throw new BadRequestException({
        error: 'MISSING_IDEMPOTENCY_KEY',
        message: 'Idempotency-Key header is required',
        retryable: false,
      });
    }

    validateSubmitBody(body);

    const hash = computeSubmitPayloadHash({
      providerId: body.providerId,
      externalTransactionId: body.externalTransactionId,
      playerId: body.playerId,
      walletId: body.walletId,
      roundId: body.roundId,
      gameId: body.gameId,
      kind: body.kind,
      money: body.money,
      referenceExternalTransactionId: body.referenceExternalTransactionId,
    });

    const result = await this.service.submitTransaction({
      providerId: body.providerId,
      externalTransactionId: body.externalTransactionId,
      idempotencyKey,
      playerId: body.playerId,
      walletId: body.walletId,
      roundId: body.roundId,
      gameId: body.gameId,
      kind: body.kind,
      money: Money.from(body.money),
      referenceExternalTransactionId: body.referenceExternalTransactionId,
      payloadHash: hash,
    });

    switch (result.status) {
      case WagerTransactionStatus.Processed:
        res.status(HttpStatus.OK);
        break;
      case WagerTransactionStatus.PendingReference:
        res.status(HttpStatus.ACCEPTED);
        break;
      case WagerTransactionStatus.Rejected:
        res.status(HttpStatus.UNPROCESSABLE_ENTITY);
        break;
      default:
        res.status(HttpStatus.OK);
    }

    return {
      transactionId: result.transactionId,
      status: result.status,
      balance: result.balanceAfter.toJSON(),
      walletVersion: result.walletVersion,
      idempotentReplay: result.idempotentReplay,
      failureCode: result.failureCode,
    };
  }

  @Get(':transactionId')
  @ApiOperation({ summary: 'Consulta uma transação por ID interno' })
  @ApiOkResponse({ description: 'Transação encontrada' })
  @ApiResponse({ status: 400, description: 'UUID inválido' })
  @ApiResponse({ status: 404, description: 'Transação não encontrada' })
  async getById(@Param('transactionId') transactionId: string) {
    if (!UUID_RE.test(transactionId)) {
      throw new BadRequestException({
        error: 'INVALID_PARAM',
        message: 'transactionId must be a valid UUID',
        retryable: false,
      });
    }
    const tx = await this.service.getTransactionById(transactionId);
    if (!tx) {
      throw new NotFoundException({
        error: 'TRANSACTION_NOT_FOUND',
        message: 'Transaction not found',
        retryable: false,
      });
    }
    return serializeTransaction(tx);
  }
}

function serializeTransaction(tx: {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: Money;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  status: string;
  failureCode?: string;
  processedAt?: Date;
  createdAt: Date;
}) {
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

function validateSubmitBody(
  body: SubmitTransactionBody | undefined,
): asserts body is SubmitTransactionBody {
  if (!body || typeof body !== 'object') {
    throw new BadRequestException({
      error: 'INVALID_BODY',
      message: 'Request body is required',
      retryable: false,
    });
  }

  const requiredFields: Array<keyof SubmitTransactionBody> = [
    'providerId',
    'externalTransactionId',
    'playerId',
    'walletId',
    'roundId',
    'gameId',
    'kind',
    'money',
  ];
  for (const field of requiredFields) {
    const value = body[field];
    if (value == null || value === '') {
      throw new BadRequestException({
        error: 'INVALID_BODY',
        message: `Missing required field: ${String(field)}`,
        retryable: false,
      });
    }
  }

  if (!UUID_RE.test(body.playerId)) {
    throw new BadRequestException({
      error: 'INVALID_BODY',
      message: 'playerId must be a valid UUID',
      retryable: false,
    });
  }
  if (!UUID_RE.test(body.walletId)) {
    throw new BadRequestException({
      error: 'INVALID_BODY',
      message: 'walletId must be a valid UUID',
      retryable: false,
    });
  }

  if (
    !body.money ||
    typeof body.money.amount !== 'string' ||
    typeof body.money.currency !== 'string'
  ) {
    throw new BadRequestException({
      error: 'INVALID_BODY',
      message: 'money must be { amount: string, currency: string }',
      retryable: false,
    });
  }

  const validKinds = Object.values(WagerTransactionKind);
  if (!validKinds.includes(body.kind)) {
    throw new BadRequestException({
      error: 'INVALID_KIND',
      message: `kind must be one of: ${validKinds.join(', ')}`,
      retryable: false,
    });
  }

  if (body.kind === WagerTransactionKind.Opening) {
    throw new BadRequestException({
      error: 'INVALID_KIND',
      message: 'OPENING cannot be submitted externally',
      retryable: false,
    });
  }
}
