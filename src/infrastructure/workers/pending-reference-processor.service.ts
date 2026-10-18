import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/postgresql';
import { WageringService } from '../../application/services/wagering.service.js';
import { WagerTransaction, WagerTransactionStatus } from '../../domain/entities/wager-transaction.js';
import { Wallet } from '../../domain/entities/wallet.js';
import { IdempotencyRecord, IdempotencyRecordStatus } from '../../domain/entities/idempotency-record.js';
import { OutboxMessage } from '../../domain/entities/outbox-message.js';
import { FailureCode, WagerTransactionError } from '../../domain/errors/wager-transaction.error.js';
import {
  WalletBalanceChanged,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../../domain/events/integration-events.js';
import { applyBalanceEffect } from '../../application/services/wallet-effect.js';

export interface PendingWorkerConfig {
  pollIntervalMs?: number;
  maxAttempts?: number;
}

/**
 * PendingReferenceWorker: reprocessa transações que chegaram antes da referência
 * (fora de ordem), conforme exigido na Seção 7.1 do desafio técnico.
 *
 * - Busca transações em PENDING_REFERENCE.
 * - Utiliza lock pessimista por wallet para garantir serialização.
 * - Esgotado o limite de tentativas: transiciona para REJECTED com REFERENCE_NOT_FOUND
 *   e publica evento WagerTransactionRejected na outbox.
 */
@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private isRunning = false;
  private intervalId: NodeJS.Timeout | null = null;
  private readonly pollIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly attemptsMap = new Map<string, number>();

  constructor(
    private readonly em: EntityManager,
    private readonly wageringService: WageringService,
    config: PendingWorkerConfig = {},
  ) {
    this.pollIntervalMs = config.pollIntervalMs ?? 2000;
    this.maxAttempts = config.maxAttempts ?? 5;
  }

  onModuleInit() {
    this.isRunning = true;
    this.intervalId = setInterval(() => {
      if (this.isRunning) {
        this.processPendingReferences().catch((err) =>
          this.logger.error('Error processing pending references', err),
        );
      }
    }, this.pollIntervalMs);
  }

  onModuleDestroy() {
    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async processPendingReferences(): Promise<void> {
    const forkEm = this.em.fork();
    const pendingTxs = await forkEm.find(
      WagerTransaction,
      { status: WagerTransactionStatus.PendingReference },
      { orderBy: { createdAt: 'ASC' }, limit: 20 },
    );

    for (const tx of pendingTxs) {
      await this.processOne(tx.id);
    }
  }

  private async processOne(txId: string): Promise<void> {
    const attempts = (this.attemptsMap.get(txId) ?? 0) + 1;
    this.attemptsMap.set(txId, attempts);

    await this.em.fork().transactional(async (em) => {
      const tx = await em.findOne(WagerTransaction, { id: txId });
      if (!tx || tx.status !== WagerTransactionStatus.PendingReference) {
        this.attemptsMap.delete(txId);
        return;
      }

      // 1. Lock pessimista na wallet
      const wallet = await em.findOne(Wallet, { id: tx.walletId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      if (!wallet) return;

      // 2. Tenta encontrar a transação referenciada
      const reference = await em.findOne(WagerTransaction, {
        providerId: tx.providerId,
        externalTransactionId: tx.referenceExternalTransactionId,
      });

      if (reference && reference.status === WagerTransactionStatus.Processed) {
        // Referência agora existe e está PROCESSED!
        try {
          const ledgerEntry = applyBalanceEffect(wallet, tx, reference);
          if (ledgerEntry) ledgerEntry.id = crypto.randomUUID();

          tx.markProcessed(reference.id, new Date());
          em.persist([wallet, tx]);
          if (ledgerEntry) em.persist(ledgerEntry);

          // Atualiza idempotency record
          const idempRecord = await em.findOne(IdempotencyRecord, { idempotencyKey: tx.idempotencyKey });
          if (idempRecord) {
            idempRecord.status = IdempotencyRecordStatus.Processed;
            idempRecord.response = {
              transactionId: tx.id,
              status: tx.status,
              balanceAfter: wallet.balance.toJSON(),
              walletVersion: wallet.version,
            };
            em.persist(idempRecord);
          }

          // Outbox
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
                { correlationId: tx.idempotencyKey, causationId: tx.id },
              ),
            );
          }
          await this.enqueue(
            em,
            WagerTransactionProcessed.from(tx, wallet.balance.toJSON(), wallet.version, {
              correlationId: tx.idempotencyKey,
              causationId: tx.id,
            }),
          );

          this.attemptsMap.delete(txId);
          await em.flush();
          this.logger.log(`Pending reference resolved successfully for tx ${tx.id}`);
          return;
        } catch (err) {
          if (err instanceof WagerTransactionError) {
            tx.reject(err.code as FailureCode);
            em.persist(tx);
            await this.enqueue(
              em,
              WagerTransactionRejected.from(tx, err.code, err.message, {
                correlationId: tx.idempotencyKey,
                causationId: tx.id,
              }),
            );
            this.attemptsMap.delete(txId);
            await em.flush();
            return;
          }
          throw err;
        }
      }

      // Se a referência ainda não chegou e as tentativas esgotaram:
      if (attempts >= this.maxAttempts) {
        tx.reject(FailureCode.ReferenceNotFound);
        em.persist(tx);

        const idempRecord = await em.findOne(IdempotencyRecord, { idempotencyKey: tx.idempotencyKey });
        if (idempRecord) {
          idempRecord.status = IdempotencyRecordStatus.Rejected;
          idempRecord.failureCode = FailureCode.ReferenceNotFound;
          idempRecord.response = {
            transactionId: tx.id,
            status: tx.status,
            balanceAfter: null,
            walletVersion: null,
          };
          em.persist(idempRecord);
        }

        await this.enqueue(
          em,
          WagerTransactionRejected.from(tx, FailureCode.ReferenceNotFound, 'Referenced transaction not found after TTL', {
            correlationId: tx.idempotencyKey,
            causationId: tx.id,
          }),
        );

        this.attemptsMap.delete(txId);
        await em.flush();
        this.logger.warn(`Pending reference timed out for tx ${tx.id} — marked as REJECTED`);
      }
    });
  }

  private async enqueue(em: any, event: any): Promise<void> {
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
}
