import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { MikroORM, EntityManager } from '@mikro-orm/postgresql';
import config from '../../mikro-orm.config.js';
import { WageringService } from '../../src/application/services/wagering.service.js';
import { InMemoryQueueAdapter } from '../../src/infrastructure/queue/in-memory-queue.adapter.js';
import { WagerTransactionConsumer } from '../../src/infrastructure/queue/wager-transaction.consumer.js';
import { Money } from '../../src/domain/value-objects/money.js';
import { payloadHashOf } from '../../src/domain/services/canonical-json.js';
import type { WagerTransactionRequestedEnvelope } from '../../src/infrastructure/queue/queue.port.js';

/**
 * E2E do consumer de fila (spec 10):
 *   - Inbox dedup persistente
 *   - Ack pós-commit
 *   - Reentrega da mesma messageId → replay sem novo débito
 *
 * Tradução determinística de `scripts/test-queue.sh`. Em vez de `sleep 3`
 * para deixar o loop pegar a mensagem, chama `consumer.processOne` direto —
 * determinístico, ~300ms em vez de 6s.
 *
 * Usa `InMemoryQueueAdapter` (dev). O `AwsSqsQueueAdapter` (produção) tem a
 * mesma interface — o teste cobre o contrato, não o backend.
 */
describe('E2E — queue consumer + inbox dedup', () => {
  let orm: MikroORM;
  let em: EntityManager;
  let service: WageringService;
  let queue: InMemoryQueueAdapter;
  let consumer: WagerTransactionConsumer;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
    try {
      const anyOrm = orm as unknown as {
        getMigrator?: () => { up: () => Promise<unknown> };
        migrator?: { up: () => Promise<unknown> };
      };
      const migrator = anyOrm.getMigrator?.() ?? anyOrm.migrator;
      if (migrator && typeof migrator.up === 'function') {
        await migrator.up();
      }
    } catch {
      // migrations já aplicadas
    }
  });

  afterAll(async () => {
    await orm.close();
  });

  beforeEach(async () => {
    em = orm.em.fork();
    service = new WageringService(em);
    queue = new InMemoryQueueAdapter();
    // `consumer` não é ligado via `onApplicationBootstrap` (não queremos o
    // loop); chamamos `processOne` diretamente para determinismo.
    consumer = new WagerTransactionConsumer(service, queue);

    await em.getConnection().execute(
      'TRUNCATE TABLE "outbox_messages", "idempotency_records", "inbox_messages", "wallet_ledger_entries", "wager_transactions", "wallets" CASCADE;',
    );
    em.clear();
  });

  it('BET via fila → débito aplicado, inbox marcado como processado', async () => {
    const { playerId, walletId } = await openWallet(service, '100.00');
    const messageId = `msg-bet-${crypto.randomUUID()}`;

    const envelope = makeEnvelope({
      messageId,
      providerId: 'prov-1',
      externalTransactionId: `bet-${crypto.randomUUID()}`,
      idempotencyKey: `prov-1:bet-${crypto.randomUUID()}`,
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'slot-1',
      kind: 'BET',
      money: { amount: '30.00', currency: 'BRL' },
    });

    await queue.send(JSON.stringify(envelope));

    const batch = await queue.receiveBatch(10, 0);
    expect(batch.length).toBe(1);
    await consumer.processOne(batch[0]);

    // Saldo reflete o débito
    em.clear();
    const wallet = await service.getWallet(walletId);
    expect(wallet!.balance.toJSON()).toEqual({ amount: '70.00', currency: 'BRL' });
    expect(wallet!.version).toBe(2);

    // Fila vazia (ack pós-commit)
    const stats = queue.stats();
    expect(stats.queued).toBe(0);
    expect(stats.dlq).toBe(0);
  });

  it('reentrega da MESMA messageId → replay (idempotente, sem novo débito)', async () => {
    const { playerId, walletId } = await openWallet(service, '100.00');
    const messageId = `msg-bet-${crypto.randomUUID()}`;
    const externalTransactionId = `bet-${crypto.randomUUID()}`;

    const envelope = makeEnvelope({
      messageId,
      providerId: 'prov-1',
      externalTransactionId,
      idempotencyKey: `prov-1:${externalTransactionId}`,
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'slot-1',
      kind: 'BET',
      money: { amount: '30.00', currency: 'BRL' },
    });

    // 1ª entrega — aplica
    await queue.send(JSON.stringify(envelope));
    const batch1 = await queue.receiveBatch(10, 0);
    await consumer.processOne(batch1[0]);

    // 2ª entrega (mesmo body, mesmo messageId) — replay
    await queue.send(JSON.stringify(envelope));
    const batch2 = await queue.receiveBatch(10, 0);
    await consumer.processOne(batch2[0]);

    // Saldo continua 70.00 (não 40.00)
    em.clear();
    const wallet = await service.getWallet(walletId);
    expect(wallet!.balance.toJSON()).toEqual({ amount: '70.00', currency: 'BRL' });
    expect(wallet!.version).toBe(2); // opening + 1 BET

    // Ledger: 2 entradas (opening + BET), não 3
    const ledger = await service.listLedger(walletId, undefined, 10);
    expect(ledger.entries.length).toBe(2);

    // Fila vazia
    const stats = queue.stats();
    expect(stats.queued).toBe(0);
    expect(stats.dlq).toBe(0);
  });

  it('envelope inválido → ack sem efeito (não vai pra DLQ nem para retry)', async () => {
    const { playerId, walletId } = await openWallet(service, '100.00');

    await queue.send(JSON.stringify({ garbage: true, messageId: 'x' }));
    const batch = await queue.receiveBatch(10, 0);
    expect(batch.length).toBe(1);
    await consumer.processOne(batch[0]);

    // Envelope inválido NÃO altera saldo
    em.clear();
    const wallet = await service.getWallet(walletId);
    expect(wallet!.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });

    // E é ack'd (fila vazia, sem retry, sem DLQ)
    const stats = queue.stats();
    expect(stats.queued).toBe(0);
    expect(stats.dlq).toBe(0);
  });

  it('erro de domínio (INSUFFICIENT_FUNDS via fila) → REJECTED mas ack (terminal)', async () => {
    const { playerId, walletId } = await openWallet(service, '10.00');
    const messageId = `msg-bet-${crypto.randomUUID()}`;

    const envelope = makeEnvelope({
      messageId,
      providerId: 'prov-1',
      externalTransactionId: `bet-${crypto.randomUUID()}`,
      idempotencyKey: `prov-1:bet-${crypto.randomUUID()}`,
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'slot-1',
      kind: 'BET',
      money: { amount: '50.00', currency: 'BRL' }, // > 10.00
    });

    await queue.send(JSON.stringify(envelope));
    const batch = await queue.receiveBatch(10, 0);
    // Não lança — `submitTransaction` retorna REJECTED; consumer ack.
    await consumer.processOne(batch[0]);

    // Saldo intacto
    em.clear();
    const wallet = await service.getWallet(walletId);
    expect(wallet!.balance.toJSON()).toEqual({ amount: '10.00', currency: 'BRL' });

    // Fila vazia, sem DLQ (rejeição é terminal → não retry)
    const stats = queue.stats();
    expect(stats.queued).toBe(0);
    expect(stats.dlq).toBe(0);
  });

  it('OPENING via fila → ack + log (viola spec 6.3)', async () => {
    const queue = new InMemoryQueueAdapter();
    const consumer = new WagerTransactionConsumer(service, queue);

    const messageId = `msg-opening-${crypto.randomUUID()}`;
    const envelope: WagerTransactionRequestedEnvelope = {
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'prov-1',
        externalTransactionId: `opening-ext-${crypto.randomUUID()}`,
        idempotencyKey: `prov-1:opening-${crypto.randomUUID()}`,
        playerId: crypto.randomUUID(),
        walletId: crypto.randomUUID(),
        roundId: 'round-opening',
        gameId: 'slot-1',
        kind: 'OPENING',
        money: { amount: '100.00', currency: 'BRL' },
      },
    };

    await queue.send(JSON.stringify(envelope));
    const batch = await queue.receiveBatch(1, 0);
    await consumer.processOne(batch[0]);

    // OPENING é interno (spec 6.3) → consumer faz ack + log, sem processar
    const stats = queue.stats();
    expect(stats.queued).toBe(0);  // ack
    expect(stats.dlq).toBe(0);     // não é falha transitória, não vai pra DLQ
  });
});

// ---------------------------------------------------------------------------
async function openWallet(
  service: WageringService,
  initialBalance: string,
): Promise<{ playerId: string; walletId: string }> {
  const playerId = crypto.randomUUID();
  const { walletId } = await service.createWallet({
    playerId,
    initialBalance: Money.from({ amount: initialBalance, currency: 'BRL' }),
  });
  return { playerId, walletId };
}

function makeEnvelope(
  overrides: {
    messageId: string;
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: string;
    money: { amount: string; currency: string };
    referenceExternalTransactionId?: string;
  },
): WagerTransactionRequestedEnvelope {
  return {
    messageId: overrides.messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: overrides.providerId,
      externalTransactionId: overrides.externalTransactionId,
      idempotencyKey: overrides.idempotencyKey,
      playerId: overrides.playerId,
      walletId: overrides.walletId,
      roundId: overrides.roundId,
      gameId: overrides.gameId,
      kind: overrides.kind,
      money: overrides.money,
      referenceExternalTransactionId: overrides.referenceExternalTransactionId,
    },
  };
}
