import { describe, it, expect } from 'bun:test';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../../domain/entities/wager-transaction.js';
import { Money } from '../../../domain/value-objects/money.js';

describe('Pending Reference Worker Unit Logic', () => {
  it('deve validar transação com status PENDING e transicionar para PROCESSED', () => {
    const refundTx = WagerTransaction.create({
      id: 'tx-refund-worker',
      providerId: 'provider-x',
      externalTransactionId: 'ext-ref-worker',
      idempotencyKey: 'key-ref-worker',
      payloadHash: 'hash-ref-worker',
      walletId: 'wallet-worker',
      playerId: 'player-worker',
      roundId: 'round-worker',
      gameId: 'game-worker',
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: '20.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'ext-bet-original',
    });

    expect(refundTx.status).toBe(WagerTransactionStatus.Pending);

    // Transiciona para o estado terminal processado após validação da referência
    refundTx.markProcessed('tx-bet-original-id', new Date());
    expect(refundTx.status).toBe(WagerTransactionStatus.Processed);
  });
});
