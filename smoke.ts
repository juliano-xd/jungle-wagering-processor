import { MikroORM } from '@mikro-orm/postgresql';
import config from './mikro-orm.config.js';
import { WageringService } from './src/application/services/wagering.service.js';
import { Money } from './src/domain/value-objects/money.js';
import { WagerTransactionKind } from './src/domain/entities/wager-transaction.js';
import { payloadHashOf } from './src/domain/services/canonical-json.js';
import { Wallet } from './src/domain/entities/wallet.js';

const orm = await MikroORM.init(config);
const em = orm.em.fork();
const svc = new WageringService(em);

const PLAYER_ID = crypto.randomUUID();

// 1. Create wallet with 100.00 BRL
const created = await svc.createWallet({
  playerId: PLAYER_ID,
  initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
});
console.log('wallet created:', created.walletId, created.balance.toJSON(), 'v=', created.version);

// Verify wallet is persisted
const check = await em.findOne(Wallet, { id: created.walletId });
console.log('wallet persisted:', !!check, check?.balance.toJSON());

// 2. Submit BET 25.00
const betDto = {
  providerId: 'provider-a',
  externalTransactionId: 'tx-1',
  idempotencyKey: 'provider-a:tx-1',
  playerId: PLAYER_ID,
  walletId: created.walletId,
  roundId: 'round-1',
  gameId: 'game-1',
  kind: WagerTransactionKind.Bet,
  money: Money.from({ amount: '25.00', currency: 'BRL' }),
  payloadHash: payloadHashOf({ providerId: 'provider-a', externalTransactionId: 'tx-1', money: { amount: '25.00', currency: 'BRL' } }),
};
const bet = await svc.submitTransaction(betDto);
console.log('bet:', bet.transactionId, bet.status, bet.balanceAfter.toJSON(), 'replay=', bet.idempotentReplay);

// 3. Idempotent replay
const replay = await svc.submitTransaction(betDto);
console.log('replay:', replay.transactionId, replay.status, 'replay=', replay.idempotentReplay);

// 4. Insufficient funds
const bigDto = { ...betDto, idempotencyKey: 'provider-a:tx-2', externalTransactionId: 'tx-2', payloadHash: payloadHashOf({ providerId: 'provider-a', externalTransactionId: 'tx-2', money: { amount: '90.00', currency: 'BRL' } }), money: Money.from({ amount: '90.00', currency: 'BRL' }) };
try {
  await svc.submitTransaction(bigDto);
  console.log('ERROR: should have thrown');
} catch (e) {
  console.log('insufficient funds rejected:', (e as Error).message);
}

// 5. Reconcile
const rec = await svc.reconcileWallet(created.walletId);
console.log('reconcile:', rec.storedBalance.toJSON(), rec.calculatedBalance.toJSON(), 'consistent=', rec.consistent, 'entries=', rec.checkedEntries);

await orm.close();
console.log('SMOKE OK');
