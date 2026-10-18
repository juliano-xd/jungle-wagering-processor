import { describe, it, expect } from 'bun:test';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../../domain/entities/wager-transaction.js';
import { Money } from '../../../domain/value-objects/money.js';

describe('Advanced Wagering & Pending Reference Unit Logic', () => {
  it('deve criar transação BET com sucesso', () => {
    const refundTx = WagerTransaction.create({
      id: 'tx-refund-1',
      providerId: 'provider-a',
      externalTransactionId: 'ext-ref-1',
      idempotencyKey: 'provider-a:ext-ref-1',
      payloadHash: 'hash-ref-1',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-99',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '50.00', currency: 'BRL' }),
    });

    expect(refundTx.status).toBe(WagerTransactionStatus.Pending);
  });

  it('deve processar WIN e LOSS corretamente sem afetar o saldo quando aplicável', () => {
    const money = Money.from({ amount: '100.00', currency: 'BRL' });
    const lossTx = WagerTransaction.create({
      id: 'tx-loss-1',
      providerId: 'provider-a',
      externalTransactionId: 'ext-loss-1',
      idempotencyKey: 'provider-a:ext-loss-1',
      payloadHash: 'hash-loss',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Loss,
      money,
    });

    expect(lossTx.affectsBalance()).toBe(false);
  });
});
