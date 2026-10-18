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
import type { Response } from 'express';
import { WageringService } from '../../application/services/wagering.service.js';
import type { SubmitTransactionBody } from '../../application/dtos/submit-transaction.dto.js';
import { Money } from '../../domain/value-objects/money.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/entities/wager-transaction.js';
import { payloadHashOf } from '../../domain/services/canonical-json.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('wagering/transactions')
export class WageringController {
  constructor(private readonly service: WageringService) {}

  @Post()
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

    const hash = payloadHashOf({
      providerId: body.providerId,
      externalTransactionId: body.externalTransactionId,
      playerId: body.playerId,
      walletId: body.walletId,
      roundId: body.roundId,
      gameId: body.gameId,
      kind: body.kind,
      money: body.money,
      referenceExternalTransactionId:
        body.referenceExternalTransactionId ?? null,
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

  // UUIDs: playerId, walletId (e transactionId no path do GET).
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
