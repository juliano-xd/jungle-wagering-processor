import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { MikroORM, EntityManager } from '@mikro-orm/postgresql';
import config from '../../../mikro-orm.config';
import { WageringService } from '../../../src/application/services/wagering.service';
import { Money } from '../../../src/domain/value-objects/money';
import { WagerTransactionKind, WagerTransactionStatus } from '../../../src/domain/entities/wager-transaction';
import { WalletLedgerEntry } from '../../../src/domain/entities/wallet-ledger-entry';
import { FailureCode, WagerTransactionError } from '../../../src/domain/errors/wager-transaction.error';
import { payloadHashOf } from '../../../src/domain/services/canonical-json';

describe('WageringService Financial Business Logic (Integration)', () => {
  let orm: MikroORM;
  let em: EntityManager;
  let service: WageringService;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
    em = orm.em.fork();
    service = new WageringService(em);
  });

  afterAll(async () => {
    await orm.close();
  });

  beforeEach(async () => {
    const conn = em.getConnection();
    await conn.execute('TRUNCATE TABLE "outbox_messages", "idempotency_records", "inbox_messages", "wallet_ledger_entries", "wager_transactions", "wallets" CASCADE;');
    em.clear();
  });

  it('1. deve criar uma carteira com saldo inicial e registrar transação OPENING no ledger', async () => {
    const playerId = crypto.randomUUID();
    const result = await service.createWallet({
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    expect(result.walletId).toBeDefined();
    expect(result.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(result.version).toBe(1);

    const rec = await service.reconcileWallet(result.walletId);
    expect(rec.consistent).toBe(true);
    expect(rec.checkedEntries).toBe(1);
    expect(rec.storedBalance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(rec.calculatedBalance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
  });

  it('2. deve processar uma BET com sucesso gerando débito e lançamento no ledger', async () => {
    const playerId = crypto.randomUUID();
    const { walletId } = await service.createWallet({
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    const betDto = {
      providerId: 'prov-1',
      externalTransactionId: 'bet-1',
      idempotencyKey: 'prov-1:bet-1',
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '40.00', currency: 'BRL' }),
      payloadHash: payloadHashOf({ bet: '1' }),
    };

    const res = await service.submitTransaction(betDto);
    expect(res.status).toBe(WagerTransactionStatus.Processed);
    expect(res.balanceAfter.toJSON()).toEqual({ amount: '60.00', currency: 'BRL' });
    expect(res.idempotentReplay).toBe(false);

    const rec = await service.reconcileWallet(walletId);
    expect(rec.consistent).toBe(true);
    expect(rec.checkedEntries).toBe(2); // OPENING + BET
    expect(rec.storedBalance.toJSON()).toEqual({ amount: '60.00', currency: 'BRL' });
  });

  it('3. deve REJEITAR uma BET com saldo insuficiente com INSUFFICIENT_FUNDS (via resultado, não exceção)', async () => {
    const playerId = crypto.randomUUID();
    const { walletId } = await service.createWallet({
      playerId,
      initialBalance: Money.from({ amount: '50.00', currency: 'BRL' }),
    });

    const betDto = {
      providerId: 'prov-1',
      externalTransactionId: 'bet-too-big',
      idempotencyKey: 'prov-1:bet-too-big',
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '80.00', currency: 'BRL' }),
      payloadHash: payloadHashOf({ bet: 'too-big' }),
    };

    // Spec 7.6: rejeição de negócio é resultado persistido, NÃO exceção.
    // O IdempotencyRecord fica com status REJECTED para replay fiel (7.7).
    const res = await service.submitTransaction(betDto);
    expect(res.status).toBe(WagerTransactionStatus.Rejected);
    expect(res.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(res.idempotentReplay).toBe(false);

    // Saldo permanece intacto
    const rec = await service.reconcileWallet(walletId);
    expect(rec.storedBalance.toJSON()).toEqual({ amount: '50.00', currency: 'BRL' });

    // Replay do mesmo payload devolve o MESMO REJECTED (resultado auditável)
    const replay = await service.submitTransaction(betDto);
    expect(replay.status).toBe(WagerTransactionStatus.Rejected);
    expect(replay.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(replay.idempotentReplay).toBe(true);
  });

  it('4. deve processar WIN gerando crédito no ledger', async () => {
    const playerId = crypto.randomUUID();
    const { walletId } = await service.createWallet({
      playerId,
      initialBalance: Money.from({ amount: '50.00', currency: 'BRL' }),
    });

    const winDto = {
      providerId: 'prov-1',
      externalTransactionId: 'win-1',
      idempotencyKey: 'prov-1:win-1',
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Win,
      money: Money.from({ amount: '70.00', currency: 'BRL' }),
      payloadHash: payloadHashOf({ win: '1' }),
    };

    const res = await service.submitTransaction(winDto);
    expect(res.status).toBe(WagerTransactionStatus.Processed);
    expect(res.balanceAfter.toJSON()).toEqual({ amount: '120.00', currency: 'BRL' });

    const rec = await service.reconcileWallet(walletId);
    expect(rec.consistent).toBe(true);
    expect(rec.storedBalance.toJSON()).toEqual({ amount: '120.00', currency: 'BRL' });
  });

  it('5. deve processar LOSS sem alterar saldo e sem criar entrada no ledger', async () => {
    const playerId = crypto.randomUUID();
    const { walletId } = await service.createWallet({
      playerId,
      initialBalance: Money.from({ amount: '50.00', currency: 'BRL' }),
    });

    const lossDto = {
      providerId: 'prov-1',
      externalTransactionId: 'loss-1',
      idempotencyKey: 'prov-1:loss-1',
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Loss,
      money: Money.from({ amount: '50.00', currency: 'BRL' }),
      payloadHash: payloadHashOf({ loss: '1' }),
    };

    const res = await service.submitTransaction(lossDto);
    expect(res.status).toBe(WagerTransactionStatus.Processed);
    expect(res.balanceAfter.toJSON()).toEqual({ amount: '50.00', currency: 'BRL' });

    const rec = await service.reconcileWallet(walletId);
    expect(rec.checkedEntries).toBe(1); // apenas OPENING
    expect(rec.storedBalance.toJSON()).toEqual({ amount: '50.00', currency: 'BRL' });
  });

  it('6. deve processar REFUND de uma BET revertendo o valor e creditando a carteira', async () => {
    const playerId = crypto.randomUUID();
    const { walletId } = await service.createWallet({
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    // 1. Faz a BET
    await service.submitTransaction({
      providerId: 'prov-1',
      externalTransactionId: 'bet-to-refund',
      idempotencyKey: 'prov-1:bet-to-refund',
      playerId,
      walletId,
      roundId: 'round-ref',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '35.00', currency: 'BRL' }),
      payloadHash: payloadHashOf({ bet: 'refund' }),
    });

    // 2. Faz o REFUND
    const refundRes = await service.submitTransaction({
      providerId: 'prov-1',
      externalTransactionId: 'refund-1',
      idempotencyKey: 'prov-1:refund-1',
      playerId,
      walletId,
      roundId: 'round-ref',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: '35.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'bet-to-refund',
      payloadHash: payloadHashOf({ ref: '1' }),
    });

    expect(refundRes.status).toBe(WagerTransactionStatus.Processed);
    expect(refundRes.balanceAfter.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });

    const rec = await service.reconcileWallet(walletId);
    expect(rec.consistent).toBe(true);
    expect(rec.storedBalance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
  });

  it('7. deve REJEITAR segundo REFUND na mesma BET com REFERENCE_ALREADY_REVERTED (via resultado)', async () => {
    const playerId = crypto.randomUUID();
    const { walletId } = await service.createWallet({
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    await service.submitTransaction({
      providerId: 'prov-1',
      externalTransactionId: 'bet-double-ref',
      idempotencyKey: 'prov-1:bet-double-ref',
      playerId,
      walletId,
      roundId: 'round-d-ref',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '30.00', currency: 'BRL' }),
      payloadHash: payloadHashOf({ bet: 'd' }),
    });

    await service.submitTransaction({
      providerId: 'prov-1',
      externalTransactionId: 'refund-first',
      idempotencyKey: 'prov-1:refund-first',
      playerId,
      walletId,
      roundId: 'round-d-ref',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: '30.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'bet-double-ref',
      payloadHash: payloadHashOf({ ref: 'first' }),
    });

    // Segunda tentativa de refund na mesma referência — rejeição, não exceção
    const res = await service.submitTransaction({
      providerId: 'prov-1',
      externalTransactionId: 'refund-second',
      idempotencyKey: 'prov-1:refund-second',
      playerId,
      walletId,
      roundId: 'round-d-ref',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: '30.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'bet-double-ref',
      payloadHash: payloadHashOf({ ref: 'second' }),
    });

    expect(res.status).toBe(WagerTransactionStatus.Rejected);
    expect(res.failureCode).toBe(FailureCode.ReferenceAlreadyReverted);

    // Saldo NÃO muda (rejeição é terminal, ledger intacto)
    const rec = await service.reconcileWallet(walletId);
    expect(rec.storedBalance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
  });

  it('8. deve processar ROLLBACK de um WIN debitando da wallet', async () => {
    const playerId = crypto.randomUUID();
    const { walletId } = await service.createWallet({
      playerId,
      initialBalance: Money.from({ amount: '50.00', currency: 'BRL' }),
    });

    // 1. WIN de 40.00 -> saldo vira 90.00
    await service.submitTransaction({
      providerId: 'prov-1',
      externalTransactionId: 'win-to-rb',
      idempotencyKey: 'prov-1:win-to-rb',
      playerId,
      walletId,
      roundId: 'round-win-rb',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Win,
      money: Money.from({ amount: '40.00', currency: 'BRL' }),
      payloadHash: payloadHashOf({ win: 'rb' }),
    });

    // 2. ROLLBACK do WIN -> deve debitar 40.00 e saldo voltar para 50.00
    const rbRes = await service.submitTransaction({
      providerId: 'prov-1',
      externalTransactionId: 'rb-of-win',
      idempotencyKey: 'prov-1:rb-of-win',
      playerId,
      walletId,
      roundId: 'round-win-rb',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Rollback,
      money: Money.from({ amount: '40.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'win-to-rb',
      payloadHash: payloadHashOf({ rb: 'win' }),
    });

    expect(rbRes.status).toBe(WagerTransactionStatus.Processed);
    expect(rbRes.balanceAfter.toJSON()).toEqual({ amount: '50.00', currency: 'BRL' });

    const rec = await service.reconcileWallet(walletId);
    expect(rec.consistent).toBe(true);
    expect(rec.storedBalance.toJSON()).toEqual({ amount: '50.00', currency: 'BRL' });
  });

  it('9. deve REJEITAR ROLLBACK de WIN se produziria saldo negativo com NEGATIVE_BALANCE_WOULD_RESULT (via resultado)', async () => {
    const playerId = crypto.randomUUID();
    const { walletId } = await service.createWallet({
      playerId,
      initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
    });

    // WIN 100.00 → saldo 110.00
    await service.submitTransaction({
      providerId: 'prov-1',
      externalTransactionId: 'win-to-drain',
      idempotencyKey: 'prov-1:win-to-drain',
      playerId,
      walletId,
      roundId: 'round-drain',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Win,
      money: Money.from({ amount: '100.00', currency: 'BRL' }),
      payloadHash: payloadHashOf({ win: 'drain' }),
    });

    // BET 95.00 → saldo 15.00
    await service.submitTransaction({
      providerId: 'prov-1',
      externalTransactionId: 'bet-after-win',
      idempotencyKey: 'prov-1:bet-after-win',
      playerId,
      walletId,
      roundId: 'round-drain-2',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '95.00', currency: 'BRL' }),
      payloadHash: payloadHashOf({ bet: 'after' }),
    });

    // ROLLBACK do WIN (100.00) produziria -85.00 → rejeitado, não lança
    const res = await service.submitTransaction({
      providerId: 'prov-1',
      externalTransactionId: 'rb-win-fail',
      idempotencyKey: 'prov-1:rb-win-fail',
      playerId,
      walletId,
      roundId: 'round-drain',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Rollback,
      money: Money.from({ amount: '100.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'win-to-drain',
      payloadHash: payloadHashOf({ rb: 'fail' }),
    });

    expect(res.status).toBe(WagerTransactionStatus.Rejected);
    expect(res.failureCode).toBe(FailureCode.NegativeBalanceWouldResult);

    // Saldo NÃO muda — 15.00 preservado
    const rec = await service.reconcileWallet(walletId);
    expect(rec.storedBalance.toJSON()).toEqual({ amount: '15.00', currency: 'BRL' });
  });

  it('10. deve retornar replay idêntico para mesma idempotencyKey e mesmo payload', async () => {
    const playerId = crypto.randomUUID();
    const { walletId } = await service.createWallet({
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    const txDto = {
      providerId: 'prov-1',
      externalTransactionId: 'tx-replay',
      idempotencyKey: 'prov-1:tx-replay',
      playerId,
      walletId,
      roundId: 'round-replay',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '20.00', currency: 'BRL' }),
      payloadHash: payloadHashOf({ action: 'replay-test' }),
    };

    const first = await service.submitTransaction(txDto);
    expect(first.idempotentReplay).toBe(false);
    expect(first.balanceAfter.toJSON()).toEqual({ amount: '80.00', currency: 'BRL' });

    const second = await service.submitTransaction(txDto);
    expect(second.idempotentReplay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(second.balanceAfter.toJSON()).toEqual({ amount: '80.00', currency: 'BRL' });

    // Saldo no banco deve continuar 80.00, sem débito duplicado
    const rec = await service.reconcileWallet(walletId);
    expect(rec.storedBalance.toJSON()).toEqual({ amount: '80.00', currency: 'BRL' });
  });

  it('11. deve lançar DUPLICATE_IDEMPOTENCY_KEY se a mesma chave for enviada com payload diferente', async () => {
    const playerId = crypto.randomUUID();
    const { walletId } = await service.createWallet({
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    const baseDto = {
      providerId: 'prov-1',
      externalTransactionId: 'tx-conflict',
      idempotencyKey: 'prov-1:tx-conflict',
      playerId,
      walletId,
      roundId: 'round-conflict',
      gameId: 'slot-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '20.00', currency: 'BRL' }),
      payloadHash: payloadHashOf({ action: 'first-payload' }),
    };

    await service.submitTransaction(baseDto);

    // Segundo envio com payload diferente
    const conflictingDto = {
      ...baseDto,
      payloadHash: payloadHashOf({ action: 'DIFFERENT-payload' }),
    };

    let caughtErr: any;
    try {
      await service.submitTransaction(conflictingDto);
    } catch (e) {
      caughtErr = e;
    }

    expect(caughtErr).toBeInstanceOf(WagerTransactionError);
    expect(caughtErr.code).toBe(FailureCode.DuplicateIdempotencyKey);
  });
});
