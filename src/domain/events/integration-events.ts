import { Money, MoneyProps } from '../value-objects/money.js';

export interface EventContext {
  correlationId: string;
  causationId?: string;
}

export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

/**
 * Envelope de evento de integração.
 *
 * - `eventType` e `version` estão no TIPO, não em uma string solta no call site.
 * - `data` carrega `MoneyProps` (string decimal), nunca a instância de `Money`.
 * - `toJSON()` produz o objeto gravado no payload da outbox.
 */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = props.data;
  }

  toJSON(): {
    eventId: string;
    eventType: string;
    aggregateId: string;
    correlationId: string;
    causationId?: string;
    occurredAt: string;
    version: number;
    data: T;
  } {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      causationId: this.causationId,
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data as T,
    };
  }
}

// ---- Eventos concretos -----------------------------------------------------

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: 'DEBIT' | 'CREDIT';
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(
    walletId: string,
    entry: {
      transactionId: string;
      direction: 'DEBIT' | 'CREDIT';
      money: Money;
      balanceBefore: Money;
      balanceAfter: Money;
    },
    walletVersion: number,
    ctx: EventContext,
  ): WalletBalanceChanged {
    return new WalletBalanceChanged({
      eventId: crypto.randomUUID(),
      aggregateId: walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: new Date(),
      data: {
        walletId,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion,
      },
    });
  }
}

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(
    tx: {
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
    },
    balanceAfter: MoneyProps,
    walletVersion: number,
    ctx: EventContext,
  ): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      eventId: crypto.randomUUID(),
      aggregateId: tx.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: new Date(),
      data: {
        transactionId: tx.id,
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
        balanceAfter,
        walletVersion,
      },
    });
  }
}

export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  kind: string;
  failureCode: string;
  message: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(
    tx: {
      id: string;
      providerId: string;
      externalTransactionId: string;
      idempotencyKey: string;
      walletId: string;
      kind: string;
    },
    failureCode: string,
    message: string,
    ctx: EventContext,
  ): WagerTransactionRejected {
    return new WagerTransactionRejected({
      eventId: crypto.randomUUID(),
      aggregateId: tx.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: new Date(),
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        idempotencyKey: tx.idempotencyKey,
        walletId: tx.walletId,
        kind: tx.kind,
        failureCode,
        message,
      },
    });
  }
}

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  kind: string;
  referenceExternalTransactionId: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  /**
   * Aceita `referenceExternalTransactionId` opcional no parâmetro de entrada
   * para casar com o tipo de `WagerTransaction` (que tem o campo `?: string`).
   * A invariante é verificada em runtime: este evento só faz sentido quando a
   * referência existe, então falhar cedo é o comportamento correto.
   */
  static from(
    tx: {
      id: string;
      providerId: string;
      externalTransactionId: string;
      idempotencyKey: string;
      walletId: string;
      kind: string;
      referenceExternalTransactionId?: string;
    },
    ctx: EventContext,
  ): WagerTransactionPendingReference {
    if (!tx.referenceExternalTransactionId) {
      throw new Error(
        'WagerTransactionPendingReference.from requires referenceExternalTransactionId (invariant violated)',
      );
    }
    return new WagerTransactionPendingReference({
      eventId: crypto.randomUUID(),
      aggregateId: tx.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: new Date(),
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        idempotencyKey: tx.idempotencyKey,
        walletId: tx.walletId,
        kind: tx.kind,
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
      },
    });
  }
}
