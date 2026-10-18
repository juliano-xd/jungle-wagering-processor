import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
  Optional,
} from '@nestjs/common';
import { Response } from 'express';
import {
  FailureCode,
  WagerTransactionError,
} from '../../domain/errors/wager-transaction.error.js';
import { MoneyError } from '../../domain/errors/money.error.js';
import { MetricsService } from '../observability/metrics.service.js';

/**
 * Filtro global de exceções — mapeia erros de domínio para HTTP de forma
 * CONSISTENTE entre todos os endpoints.
 *
 *   - 400 Bad Request            → payload inválido
 *   - 404 Not Found              → wallet/transação não encontrada
 *   - 409 Conflict               → conflito de idempotência
 *   - 422 Unprocessable Entity   → rejeição por regra de negócio
 *   - 500 Internal Server Error  → erro permanente de infraestrutura
 *   - 503 Service Unavailable    → transitório (cliente DEVE retry)
 *
 * `retryable` no body informa ao provedor se vale reenviar.
 *
 * `metrics` é opcional — o filtro pode ser instanciado sem MetricsService
 * (não há necessidade nos testes). O campo `http_errors_total` é
 * incrementado após a resposta ser escrita (best effort).
 */
@Catch()
export class DomainErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainErrorFilter.name);

  constructor(@Optional() private readonly metrics?: MetricsService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<{ method: string; url: string }>();

    let status = 500;
    let body: Record<string, unknown> = {
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Internal server error',
      retryable: false,
    };

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const r = exception.getResponse();
      body =
        typeof r === 'string'
          ? { error: 'HTTP_ERROR', message: r, retryable: false }
          : (r as Record<string, unknown>);
    } else if (exception instanceof WagerTransactionError) {
      const code = exception.code as FailureCode;
      const mapped = mapFailureCodeToHttp(code);
      status = mapped.status;
      body = {
        error: code,
        message: exception.message,
        retryable: mapped.retryable,
      };
    } else if (exception instanceof MoneyError) {
      status = 400;
      body = {
        error: (exception as unknown as { code?: string }).code ?? 'MONEY_ERROR',
        message: exception.message,
        retryable: false,
      };
    } else if (exception instanceof Error) {
      this.logger.error(
        `${request.method} ${request.url} → 500: ${exception.message}`,
        exception.stack,
      );
      body = {
        error: 'INTERNAL_SERVER_ERROR',
        message: 'Internal server error',
        retryable: false,
      };
    }

    response.status(status).json(body);
    try {
      this.metrics?.httpError(status);
    } catch {
      /* best effort */
    }
  }
}

function mapFailureCodeToHttp(code: string): {
  status: number;
  retryable: boolean;
} {
  switch (code) {
    case FailureCode.WalletNotFound:
      return { status: 404, retryable: false };

    case FailureCode.DuplicateIdempotencyKey:
      return { status: 409, retryable: false };

    case FailureCode.CurrencyMismatch:
    case FailureCode.ZeroAmount:
    case FailureCode.InvalidStateTransition:
    case FailureCode.OperationRequiresReference:
      return { status: 400, retryable: false };

    case FailureCode.ReferenceNotFound:
    case FailureCode.ReferenceAlreadyReverted:
    case FailureCode.ReferenceWrongKind:
    case FailureCode.ReferenceMismatch:
    case FailureCode.ReferenceNotProcessed:
    case FailureCode.InsufficientFunds:
    case FailureCode.NegativeBalanceWouldResult:
      return { status: 422, retryable: false };

    case FailureCode.InfraTransient:
    case FailureCode.InfraOutboxPublish:
      return { status: 503, retryable: true };

    case FailureCode.InfraPermanent:
    case FailureCode.InfraDeadLetter:
      return { status: 500, retryable: false };

    default:
      return { status: 500, retryable: false };
  }
}
