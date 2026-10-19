import { Injectable, Logger, Optional } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/core';
import { Wallet } from '../../domain/entities/wallet.js';
import { WalletLedgerEntry, LedgerDirection } from '../../domain/entities/wallet-ledger-entry.js';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../domain/entities/wager-transaction.js';
import { IdempotencyRecord, IdempotencyRecordStatus } from '../../domain/entities/idempotency-record.js';
import { Money } from '../../domain/value-objects/money.js';
import { OutboxMessage } from '../../domain/entities/outbox-message.js';
import { InboxMessage } from '../../domain/entities/inbox-message.js';
import { FailureCode, WagerTransactionError } from '../../domain/errors/wager-transaction.error.js';
import {
  WalletBalanceChanged,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WagerTransactionPendingReference,
} from '../../domain/events/integration-events.js';
import {
  SubmitTransactionRequest,
  SubmitTransactionResult,
  CreateWalletRequest,
  CreateWalletResult,
  ReconcileWalletResult,
  applyBalanceEffect,
} from './wallet-effect.js';
import { payloadHashOf } from '../../domain/services/canonical-json.js';
import { MetricsService } from '../../infrastructure/observability/metrics.service.js';

/**
 * WageringService: único ponto de mutação do domínio financeiro.
 *
 * ⚠️ ORDEM DE PERSISTÊNCIA: `wallets` sempre em um `flush` isolado ANTES de
 * qualquer `wager_transactions` (o MikroORM não infere a FK `wallet_id →
 * wallets.id` porque a coluna é `uuid` puro sem `kind: 'm:1'`).
 *
 * Decisão de design: rejeições de REGRA DE NEGÓCIO são persistidas como
 * REJECTED e DEVOLVIDAS (`status: REJECTED`, `failureCode`), não lançadas.
 * Mantém a rejeição auditável e evita rollback do IdempotencyRecord.
 *
 * `metrics` é opcional (@Optional) — testes de integração instanciam
 * `new WageringService(em)` sem Nest e sem instrumentação.
 */
@Injectable()
export class WageringService {
  private readonly logger = new Logger(WageringService.name);

  constructor(
    private readonly em: EntityManager,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  // ------------------------------------------------------------------ wallet

  async createWallet(req: CreateWalletRequest): Promise<CreateWalletResult> {
    if (req.initialBalance.isZero()) {
      throw new WagerTransactionError(
        'Initial balance must be greater than zero',
        FailureCode.ZeroAmount,
      );
    }

    return this.em.transactional(async (em) => {
      const existing = await em.findOne(Wallet, {
        playerId: req.playerId,
        currency: req.initialBalance.currency,
      });
      if (existing) {
        throw new WagerTransactionError(
          'Wallet already exists for this player and currency',
          FailureCode.DuplicateIdempotencyKey,
        );
      }

      const wallet = Wallet.open({
        id: crypto.randomUUID(),
        playerId: req.playerId,
        initialBalance: Money.zero(req.initialBalance.currency),
      });

      em.persist(wallet);
      await em.flush();

      const openingTx = WagerTransaction.create({
        id: crypto.randomUUID(),
        providerId: 'system',
        externalTransactionId: `opening:${wallet.id}`,
        idempotencyKey: `system:opening:${wallet.id}`,
        payloadHash: payloadHashOf({ walletId: wallet.id, amount: req.initialBalance.toJSON() }),
        walletId: wallet.id,
        playerId: req.playerId,
        roundId: 'opening',
        gameId: 'system',
        kind: WagerTransactionKind.Opening,
        money: req.initialBalance,
      });

      const openingEntry = wallet.credit(req.initialBalance, openingTx.id);
      openingEntry.id = crypto.randomUUID();
      openingTx.markProcessed(undefined, new Date());

      wallet.version = 1;

      em.persist(openingTx);
      em.persist(openingEntry);
      await em.flush();

      await this.upsertIdempotency(
        em,
        openingTx,
        IdempotencyRecordStatus.Processed,
        wallet.balance,
        wallet.version,
      );

      await this.enqueue(
        em,
        WalletBalanceChanged.from(
          wallet.id,
          {
            transactionId: openingTx.id,
            direction: openingEntry.direction,
            money: openingEntry.money,
            balanceBefore: openingEntry.balanceBefore,
            balanceAfter: openingEntry.balanceAfter,
          },
          wallet.version,
          { correlationId: openingTx.idempotencyKey, causationId: openingTx.id },
        ),
      );
      await this.enqueue(
        em,
        WagerTransactionProcessed.from(openingTx, wallet.balance.toJSON(), wallet.version, {
          correlationId: openingTx.idempotencyKey,
          causationId: openingTx.id,
        }),
      );

      await em.flush();

      return {
        walletId: wallet.id,
        balance: wallet.balance,
        version: wallet.version,
      };
    });
  }

  // ---------------------------------------------------------- submit tx

  async submitTransaction(req: SubmitTransactionRequest): Promise<SubmitTransactionResult> {
    if (req.kind === WagerTransactionKind.Opening) {
      throw new WagerTransactionError(
        'OPENING is an internal transaction kind and cannot be submitted',
        FailureCode.InvalidStateTransition,
      );
    }

    const start = Date.now();
    try {
      return await this.em.transactional(async (em) => {
        const wallet = await em.findOne(
          Wallet,
          { id: req.walletId },
          { lockMode: LockMode.PESSIMISTIC_WRITE },
        );
        if (!wallet) {
          throw new WagerTransactionError('Wallet not found', FailureCode.WalletNotFound);
        }
        if (wallet.playerId !== req.playerId) {
          throw new WagerTransactionError(
            'Wallet does not belong to the given player',
            FailureCode.ReferenceMismatch,
          );
        }
        if (wallet.currency !== req.money.currency) {
          throw new WagerTransactionError('Currency mismatch', FailureCode.CurrencyMismatch);
        }

        let inbox: InboxMessage | null = null;
        if (req.inboxMessage) {
          inbox = await em.findOne(InboxMessage, {
            messageId: req.inboxMessage.messageId,
            consumerName: req.inboxMessage.consumerName,
          });
          if (inbox && inbox.isProcessed()) {
            const existingRecord = await em.findOne(IdempotencyRecord, {
              idempotencyKey: req.idempotencyKey,
            });
            if (existingRecord) {
              this.metrics?.replay();
              return this.buildReplayResult(existingRecord, wallet);
            }
            this.metrics?.replay();
            return {
              transactionId: '',
              status: WagerTransactionStatus.Processed,
              balanceAfter: wallet.balance,
              walletVersion: wallet.version,
              idempotentReplay: true,
            };
          }
          if (!inbox) {
            inbox = InboxMessage.receive({
              messageId: req.inboxMessage.messageId,
              consumerName: req.inboxMessage.consumerName,
              payloadHash: req.payloadHash,
            });
            em.persist(inbox);
          }
        }

        const existingRecord = await em.findOne(IdempotencyRecord, {
          idempotencyKey: req.idempotencyKey,
        });
        if (existingRecord && existingRecord.payloadHash !== req.payloadHash) {
          this.metrics?.conflict();
          throw new WagerTransactionError(
            'Idempotency key already used with a different payload',
            FailureCode.DuplicateIdempotencyKey,
          );
        }
        if (existingRecord && existingRecord.status !== IdempotencyRecordStatus.Pending) {
          this.metrics?.replay();
          return this.buildReplayResult(existingRecord, wallet);
        }

        let tx: WagerTransaction;
        if (existingRecord?.transactionId) {
          const found = await em.findOne(WagerTransaction, { id: existingRecord.transactionId });
          if (!found) {
            throw new WagerTransactionError(
              'Idempotency record points to a missing transaction',
              FailureCode.ReferenceNotFound,
            );
          }
          tx = found;
        } else {
          tx = WagerTransaction.create({
            id: crypto.randomUUID(),
            providerId: req.providerId,
            externalTransactionId: req.externalTransactionId,
            idempotencyKey: req.idempotencyKey,
            payloadHash: req.payloadHash,
            walletId: req.walletId,
            playerId: req.playerId,
            roundId: req.roundId,
            gameId: req.gameId,
            kind: req.kind,
            money: req.money,
            referenceExternalTransactionId: req.referenceExternalTransactionId,
          });
          em.persist(tx);
        }

        let reference: WagerTransaction | null = null;
        try {
          if (tx.requiresReference()) {
            reference = await this.resolveReferenceTx(em, tx);
          }
        } catch (err) {
          if (err instanceof WagerTransactionError) {
            return await this.finalizeRejected(em, wallet, tx, inbox, err, req.idempotencyKey);
          }
          throw err;
        }

        if (tx.requiresReference() && reference === null) {
          const wasAlreadyPending = tx.status === WagerTransactionStatus.PendingReference;
          if (!wasAlreadyPending) {
            tx.markPendingReference();
            em.persist(tx);
          }
          if (inbox) inbox.markProcessed(new Date());
          await this.upsertIdempotency(
            em,
            tx,
            IdempotencyRecordStatus.Pending,
            wallet.balance,
            wallet.version,
          );
          if (!wasAlreadyPending) {
            await this.enqueue(
              em,
              WagerTransactionPendingReference.from(tx, { correlationId: req.idempotencyKey }),
            );
          }
          await em.flush();
          this.metrics?.transaction('PENDING_REFERENCE');
          return {
            transactionId: tx.id,
            status: WagerTransactionStatus.PendingReference,
            balanceAfter: wallet.balance,
            walletVersion: wallet.version,
            idempotentReplay: false,
          };
        }

        try {
          const ledgerEntry = applyBalanceEffect(wallet, tx, reference);
          if (ledgerEntry) ledgerEntry.id = crypto.randomUUID();

          tx.markProcessed(reference?.id, new Date());
          em.persist(wallet);
          em.persist(tx);
          if (ledgerEntry) em.persist(ledgerEntry);
          if (inbox) inbox.markProcessed(new Date());

          await this.upsertIdempotency(
            em,
            tx,
            IdempotencyRecordStatus.Processed,
            wallet.balance,
            wallet.version,
          );

          if (ledgerEntry) {
            await this.enqueue(
              em,
              WalletBalanceChanged.from(
                wallet.id,
                {
                  transactionId: tx.id,
                  direction: ledgerEntry.direction,
                  money: ledgerEntry.money,
                  balanceBefore: ledgerEntry.balanceBefore,
                  balanceAfter: ledgerEntry.balanceAfter,
                },
                wallet.version,
                { correlationId: req.idempotencyKey, causationId: tx.id },
              ),
            );
          }
          await this.enqueue(
            em,
            WagerTransactionProcessed.from(tx, wallet.balance.toJSON(), wallet.version, {
              correlationId: req.idempotencyKey,
              causationId: tx.id,
            }),
          );

          await em.flush();
          this.metrics?.transaction('PROCESSED');

          return {
            transactionId: tx.id,
            status: WagerTransactionStatus.Processed,
            balanceAfter: wallet.balance,
            walletVersion: wallet.version,
            idempotentReplay: false,
          };
        } catch (err) {
          if (err instanceof WagerTransactionError) {
            return await this.finalizeRejected(em, wallet, tx, inbox, err, req.idempotencyKey);
          }
          throw err;
        }
      });
    } catch (err) {
      // PostgreSQL: 40001 (serialization_failure) / 40P01 (deadlock_detected).
      // Estes podem ocorrer quando 2+ transações disputam o lock da wallet.
      // Contabiliza em métrica e propaga (cliente/worker deve retry).
      const code = (err as { code?: string })?.code;
      if (code === '40001' || code === '40P01') {
        this.metrics?.lockConflict();
      }
      throw err;
    } finally {
      this.metrics?.observeSubmit((Date.now() - start) / 1000);
    }
  }

  // ----------------------------------------------------------- aux methods

  private async finalizeRejected(
    em: EntityManager,
    wallet: Wallet,
    tx: WagerTransaction,
    inbox: InboxMessage | null,
    err: WagerTransactionError,
    correlationId: string,
  ): Promise<SubmitTransactionResult> {
    tx.reject(err.code as unknown as FailureCode);
    em.persist(tx);
    if (inbox) inbox.markProcessed(new Date());
    await this.upsertIdempotency(
      em,
      tx,
      IdempotencyRecordStatus.Rejected,
      wallet.balance,
      wallet.version,
    );
    await this.enqueue(
      em,
      WagerTransactionRejected.from(tx, err.code, err.message, {
        correlationId,
        causationId: tx.id,
      }),
    );
    await em.flush();
    this.metrics?.transaction('REJECTED');
    return {
      transactionId: tx.id,
      status: WagerTransactionStatus.Rejected,
      balanceAfter: wallet.balance,
      walletVersion: wallet.version,
      idempotentReplay: false,
      failureCode: err.code as unknown as FailureCode,
    };
  }

  private buildReplayResult(
    record: IdempotencyRecord,
    wallet: Wallet,
  ): SubmitTransactionResult {
    const response = record.response as Record<string, unknown>;
    const balanceAfter =
      response.balanceAfter != null
        ? Money.rehydrate(response.balanceAfter as any)
        : wallet.balance;

    const status = record.status as unknown as WagerTransactionStatus;

    return {
      transactionId: (record.transactionId ?? response.transactionId) as string,
      status,
      balanceAfter,
      walletVersion:
        (response.walletVersion as number | null | undefined) ?? wallet.version,
      idempotentReplay: true,
      failureCode: record.failureCode as unknown as FailureCode | undefined,
    };
  }

  private async upsertIdempotency(
    em: EntityManager,
    tx: WagerTransaction,
    status: IdempotencyRecordStatus,
    balance: Money | undefined,
    walletVersion: number | undefined,
  ): Promise<void> {
    const response = {
      transactionId: tx.id,
      status,
      balanceAfter: balance ? balance.toJSON() : undefined,
      walletVersion: walletVersion ?? null,
    };
    const failureCode =
      status === IdempotencyRecordStatus.Rejected
        ? (tx.failureCode as unknown as string)
        : undefined;

    const existing = await em.findOne(IdempotencyRecord, {
      idempotencyKey: tx.idempotencyKey,
    });
    if (existing) {
      existing.status = status;
      existing.transactionId = tx.id;
      existing.failureCode = failureCode;
      existing.response = response;
      return;
    }

    em.persist(
      IdempotencyRecord.create({
        idempotencyKey: tx.idempotencyKey,
        payloadHash: tx.payloadHash,
        status,
        transactionId: tx.id,
        failureCode,
        response,
      }),
    );
  }

  private async enqueue(em: EntityManager, event: any): Promise<void> {
    const msg = OutboxMessage.enqueue({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      correlationId: event.correlationId,
      causationId: event.causationId,
      occurredAt: event.occurredAt,
      data: event.toJSON().data as Record<string, unknown>,
    });
    em.persist(msg);
  }

  private async resolveReferenceTx(
    em: EntityManager,
    tx: WagerTransaction,
  ): Promise<WagerTransaction | null> {
    if (!tx.referenceExternalTransactionId) return null;

    const reference = await em.findOne(WagerTransaction, {
      providerId: tx.providerId,
      externalTransactionId: tx.referenceExternalTransactionId,
    });
    if (!reference) return null;

    if (reference.status !== WagerTransactionStatus.Processed) {
      throw WagerTransactionError.referenceNotProcessed();
    }
    if (reference.providerId !== tx.providerId) {
      throw WagerTransactionError.referenceMismatch('providerId');
    }
    if (reference.playerId !== tx.playerId) {
      throw WagerTransactionError.referenceMismatch('playerId');
    }
    if (reference.walletId !== tx.walletId) {
      throw WagerTransactionError.referenceMismatch('walletId');
    }
    if (reference.roundId !== tx.roundId) {
      throw WagerTransactionError.referenceMismatch('roundId');
    }
    if (reference.money.currency !== tx.money.currency) {
      throw WagerTransactionError.currencyMismatch();
    }
    if (!tx.money.equals(reference.money)) {
      throw WagerTransactionError.referenceMismatch('money');
    }
    if (tx.kind === WagerTransactionKind.Refund && reference.kind !== WagerTransactionKind.Bet) {
      throw WagerTransactionError.referenceWrongKind();
    }
    if (tx.kind === WagerTransactionKind.Rollback) {
      if (
        reference.kind !== WagerTransactionKind.Bet &&
        reference.kind !== WagerTransactionKind.Win &&
        reference.kind !== WagerTransactionKind.Refund
      ) {
        throw WagerTransactionError.referenceWrongKind();
      }
    }

    const alreadyReverted = await em.findOne(WagerTransaction, {
      providerId: tx.providerId,
      referenceExternalTransactionId: tx.referenceExternalTransactionId,
      kind: tx.kind,
      status: WagerTransactionStatus.Processed,
      id: { $ne: tx.id } as any,
    });
    if (alreadyReverted) {
      throw WagerTransactionError.referenceAlreadyReverted();
    }

    return reference;
  }

  // -------------------------------------------------------- reconciliation

  async reconcileWallet(walletId: string): Promise<ReconcileWalletResult> {
    const forkEm = this.em.fork();
    const wallet = await forkEm.findOne(Wallet, { id: walletId });
    if (!wallet) {
      throw new WagerTransactionError('Wallet not found', FailureCode.WalletNotFound);
    }
    const entries = await forkEm.find(WalletLedgerEntry, { wallet: walletId } as any);
    let calculated = Money.zero(wallet.currency);
    for (const entry of entries) {
      if (entry.direction === LedgerDirection.Credit) {
        calculated = calculated.add(entry.money);
      } else {
        calculated = calculated.subtract(entry.money);
      }
    }
    const stored = wallet.balance;
    const consistent = stored.equals(calculated);
    const difference = consistent ? Money.zero(wallet.currency) : stored.subtract(calculated);
    if (!consistent) {
      // Spec 9: divergência é logada + contabilizada em métrica + sinalizada
      // na resposta. NUNCA corrigida silenciosamente.
      this.metrics?.reconciliationDiverge();
      this.logger.warn(
        JSON.stringify({
          event: 'wallet.reconciliation_divergence',
          walletId: wallet.id,
          stored: stored.toJSON(),
          calculated: calculated.toJSON(),
          difference: difference.toJSON(),
          checkedEntries: entries.length,
        }),
      );
    }

    return {
      walletId: wallet.id,
      storedBalance: stored,
      calculatedBalance: calculated,
      consistent,
      difference,
      checkedEntries: entries.length,
    };
  }

  // -------------------------------------------------------------- queries

  async getWallet(walletId: string): Promise<Wallet | null> {
    const forkEm = this.em.fork();
    return forkEm.findOne(Wallet, { id: walletId });
  }

  async getTransactionById(transactionId: string): Promise<WagerTransaction | null> {
    const forkEm = this.em.fork();
    return forkEm.findOne(WagerTransaction, { id: transactionId });
  }

  async getTransactionByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const forkEm = this.em.fork();
    return forkEm.findOne(WagerTransaction, {
      providerId,
      externalTransactionId,
    });
  }

  async listLedger(
    walletId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<{
    entries: Array<{
      id: string;
      transactionId: string;
      direction: LedgerDirection;
      money: Money;
      balanceBefore: Money;
      balanceAfter: Money;
      createdAt: Date;
    }>;
    nextCursor?: string;
  }> {
    const forkEm = this.em.fork();

    const walletExists = await forkEm.findOne(Wallet, { id: walletId });
    if (!walletExists) {
      throw new WagerTransactionError('Wallet not found', FailureCode.WalletNotFound);
    }

    const safeLimit = Math.min(Math.max(limit, 1), 200);

    let where: any = { wallet: walletId };
    if (cursor) {
      const decoded = decodeLedgerCursor(cursor);
      where = {
        wallet: walletId,
        $or: [
          { createdAt: { $lt: decoded.createdAt } },
          { createdAt: decoded.createdAt, id: { $lt: decoded.id } },
        ],
      };
    }

    const rows = await forkEm.find(WalletLedgerEntry, where, {
      orderBy: { createdAt: 'DESC', id: 'DESC' },
      limit: safeLimit + 1,
    });

    const hasMore = rows.length > safeLimit;
    const page = hasMore ? rows.slice(0, safeLimit) : rows;
    const nextCursor =
      hasMore && page.length > 0
        ? encodeLedgerCursor(page[page.length - 1].createdAt, page[page.length - 1].id)
        : undefined;

    return {
      entries: page.map((e: WalletLedgerEntry) => ({
        id: e.id,
        transactionId: e.transactionId,
        direction: e.direction,
        money: e.money,
        balanceBefore: e.balanceBefore,
        balanceAfter: e.balanceAfter,
        createdAt: e.createdAt,
      })),
      nextCursor,
    };
  }

  // ---------------------------------------------- pending reference retry

  async retryPendingReference(
    txId: string,
    options?: {
      maxAttempts?: number;
      baseBackoffMs?: number;
      maxBackoffMs?: number;
    },
  ): Promise<'processed' | 'pending' | 'rejected' | 'skipped'> {
    const maxAttempts =
      options?.maxAttempts ?? Number(process.env.PENDING_REFERENCE_MAX_ATTEMPTS ?? 12);
    const baseBackoffMs =
      options?.baseBackoffMs ?? Number(process.env.PENDING_REFERENCE_BASE_BACKOFF_MS ?? 5_000);
    const maxBackoffMs =
      options?.maxBackoffMs ?? Number(process.env.PENDING_REFERENCE_MAX_BACKOFF_MS ?? 60_000);

    const probe = await this.em.fork().findOne(WagerTransaction, { id: txId });
    if (!probe || probe.status !== WagerTransactionStatus.PendingReference) {
      return 'skipped';
    }

    if (probe.pendingReferenceAttempts >= maxAttempts) {
      await this.rejectPendingReferenceTx(txId, FailureCode.ReferenceNotFound);
      return 'rejected';
    }

    let result: SubmitTransactionResult;
    try {
      result = await this.submitTransaction(this.toSubmitRequest(probe));
    } catch (err) {
      if (err instanceof WagerTransactionError) {
        await this.rejectPendingReferenceTx(txId, err.code as FailureCode);
        return 'rejected';
      }
      throw err;
    }

    if (result.status === WagerTransactionStatus.Processed) {
      return 'processed';
    }
    if (result.status === WagerTransactionStatus.Rejected) {
      return 'rejected';
    }

    const before = probe.pendingReferenceAttempts;
    const scheduled = await this.em.transactional(async (em) => {
      const fresh = await em.findOne(
        WagerTransaction,
        { id: txId },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      if (!fresh || fresh.status !== WagerTransactionStatus.PendingReference) return false;
      if (fresh.pendingReferenceAttempts !== before) return false;

      const nextAttemptAt = computeBackoffMs(
        new Date(),
        before + 1,
        baseBackoffMs,
        maxBackoffMs,
      );
      const ok = fresh.schedulePendingReferenceRetry(nextAttemptAt);
      if (ok) {
        em.persist(fresh);
        await em.flush();
      }
      return ok;
    });

    return scheduled ? 'pending' : 'skipped';
  }

  async rejectPendingReferenceTx(txId: string, reason: FailureCode): Promise<void> {
    return this.em.transactional(async (em) => {
      const tx = await em.findOne(
        WagerTransaction,
        { id: txId },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      if (!tx || tx.status !== WagerTransactionStatus.PendingReference) return;

      tx.reject(reason);
      em.persist(tx);

      await this.upsertIdempotency(
        em,
        tx,
        IdempotencyRecordStatus.Rejected,
        undefined,
        undefined,
      );

      await this.enqueue(
        em,
        WagerTransactionRejected.from(tx, reason, 'Reference did not arrive in time', {
          correlationId: tx.idempotencyKey,
          causationId: tx.id,
        }),
      );

      await em.flush();
    });
  }

  private toSubmitRequest(tx: WagerTransaction): SubmitTransactionRequest {
    return {
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      playerId: tx.playerId,
      walletId: tx.walletId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      money: tx.money,
      referenceExternalTransactionId: tx.referenceExternalTransactionId,
      payloadHash: tx.payloadHash,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers (fora da classe)

function encodeLedgerCursor(createdAt: Date, id: string): string {
  return Buffer.from(
    JSON.stringify({ createdAt: createdAt.toISOString(), id }),
    'utf8',
  ).toString('base64url');
}

function decodeLedgerCursor(cursor: string): { createdAt: Date; id: string } {
  let raw: string;
  try {
    raw = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new WagerTransactionError('Invalid cursor', FailureCode.InvalidStateTransition);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WagerTransactionError('Invalid cursor', FailureCode.InvalidStateTransition);
  }
  if (!parsed?.createdAt || !parsed?.id) {
    throw new WagerTransactionError('Invalid cursor', FailureCode.InvalidStateTransition);
  }
  return { createdAt: new Date(parsed.createdAt), id: String(parsed.id) };
}

function computeBackoffMs(
  now: Date,
  attempts: number,
  baseMs: number,
  maxMs: number,
): Date {
  const exponent = Math.max(0, attempts - 1);
  const raw = Math.min(maxMs, baseMs * Math.pow(2, exponent));
  const jitter = Math.floor(raw * 0.25 * Math.random());
  return new Date(now.getTime() + raw + jitter);
}
