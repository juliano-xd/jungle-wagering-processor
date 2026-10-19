import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { MikroORM } from '@mikro-orm/core';
import { AppModule } from '../../src/app.module.js';

describe('HTTP API — mapeamento de status consistente (spec 9)', () => {
  let app: INestApplication;
  let httpServer: unknown;
  let orm: MikroORM;

  beforeAll(async () => {
    process.env.WAGER_CONSUMER_ENABLED = 'false';
    process.env.PENDING_REFERENCE_WORKER_ENABLED = 'false';
    process.env.OUTBOX_POLL_INTERVAL_MS = '3600000';
    process.env.DEV_QUEUE_ENDPOINT = 'true';

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    httpServer = app.getHttpServer();
    orm = app.get(MikroORM);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await orm.em.getConnection().execute(
      'TRUNCATE TABLE "outbox_messages", "idempotency_records", "inbox_messages", "wallet_ledger_entries", "wager_transactions", "wallets" CASCADE;',
    );
  });

  async function createWallet(playerId = crypto.randomUUID()) {
    const res = await request(httpServer)
      .post('/wallets')
      .send({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } })
      .expect(201);
    return { playerId, walletId: res.body.id as string };
  }

  function makeBetDto(walletId: string, playerId: string, amount = '30.00') {
    const extId = `bet-${crypto.randomUUID()}`;
    return {
      providerId: 'prov-1',
      externalTransactionId: extId,
      idempotencyKey: `prov-1:${extId}`,
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'slot-1',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
    };
  }

  function submitTransaction(dto: Record<string, unknown>) {
    return request(httpServer)
      .post('/wagering/transactions')
      .set('Idempotency-Key', String(dto.idempotencyKey))
      .send(dto);
  }

  // ---------------- wallet ----------------

  it('POST /wallets → 201', async () => {
    const playerId = crypto.randomUUID();
    const res = await request(httpServer)
      .post('/wallets')
      .send({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } })
      .expect(201);
    expect(res.body.playerId).toBe(playerId);
    expect(res.body.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(res.body.version).toBe(1);
  });

  it('POST /wallets playerId inválido → 400', async () => {
    const res = await request(httpServer)
      .post('/wallets')
      .send({ playerId: 'not-a-uuid', initialBalance: { amount: '100.00', currency: 'BRL' } })
      .expect(400);
    expect(res.body.error).toBe('INVALID_BODY');
  });

  it('POST /wallets duplicada → 409', async () => {
    const { playerId } = await createWallet();
    const res = await request(httpServer)
      .post('/wallets')
      .send({ playerId, initialBalance: { amount: '50.00', currency: 'BRL' } })
      .expect(409);
    expect(res.body.error).toBe('DUPLICATE_IDEMPOTENCY_KEY');
  });

  // ---------------- wagering ----------------

  it('POST /wagering/transactions válido → 200 PROCESSED', async () => {
    const { playerId, walletId } = await createWallet();
    const dto = makeBetDto(walletId, playerId);
    const res = await submitTransaction(dto).expect(200);
    expect(res.body.status).toBe('PROCESSED');
    expect(res.body.balance).toEqual({ amount: '70.00', currency: 'BRL' });
    expect(res.body.idempotentReplay).toBe(false);
  });

  it('POST /wagering/transactions ROLLBACK sem referência → 202 PENDING_REFERENCE', async () => {
    const { playerId, walletId } = await createWallet();
    const extId = `rb-${crypto.randomUUID()}`;
    const dto = {
      providerId: 'prov-1',
      externalTransactionId: extId,
      idempotencyKey: `prov-1:${extId}`,
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'slot-1',
      kind: 'ROLLBACK',
      money: { amount: '30.00', currency: 'BRL' },
      referenceExternalTransactionId: `win-never-${crypto.randomUUID()}`,
    };
    const res = await submitTransaction(dto).expect(202);
    expect(res.body.status).toBe('PENDING_REFERENCE');
    expect(res.body.balance).toEqual({ amount: '100.00', currency: 'BRL' });
  });

  it('POST /wagering/transactions BET > saldo → 422 REJECTED', async () => {
    const { playerId, walletId } = await createWallet();
    const dto = makeBetDto(walletId, playerId, '500.00');
    const res = await submitTransaction(dto).expect(422);
    expect(res.body.status).toBe('REJECTED');
    expect(res.body.failureCode).toBe('INSUFFICIENT_FUNDS');
  });

  it('POST /wagering/transactions sem Idempotency-Key → 400', async () => {
    const { playerId, walletId } = await createWallet();
    const dto = makeBetDto(walletId, playerId);
    const res = await request(httpServer)
      .post('/wagering/transactions')
      .send(dto)
      .expect(400);
    expect(res.body.error).toBe('MISSING_IDEMPOTENCY_KEY');
  });

  it('POST /wagering/transactions body inválido → 400', async () => {
    const res = await request(httpServer)
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'whatever')
      .send({ kind: 'BET' })
      .expect(400);
    expect(res.body.error).toBe('INVALID_BODY');
  });

  it('POST /wagering/transactions walletId inexistente → 404', async () => {
    const dto = makeBetDto(crypto.randomUUID(), crypto.randomUUID());
    const res = await submitTransaction(dto).expect(404);
    expect(res.body.error).toBe('WALLET_NOT_FOUND');
  });

  it('POST /wagering/transactions conflito de idempotência → 409', async () => {
    const { playerId, walletId } = await createWallet();
    const dto = makeBetDto(walletId, playerId);
    await submitTransaction(dto).expect(200);
    const conflicting = { ...dto, money: { amount: '99.99', currency: 'BRL' } };
    const res = await submitTransaction(conflicting).expect(409);
    expect(res.body.error).toBe('DUPLICATE_IDEMPOTENCY_KEY');
  });

  // ---------------- queries ----------------

  it('GET /wallets/:id → 200', async () => {
    const { walletId, playerId } = await createWallet();
    const res = await request(httpServer).get(`/wallets/${walletId}`).expect(200);
    expect(res.body.playerId).toBe(playerId);
    expect(res.body.balance).toEqual({ amount: '100.00', currency: 'BRL' });
  });

  it('GET /wallets/:id inexistente → 404', async () => {
    const res = await request(httpServer).get(`/wallets/${crypto.randomUUID()}`).expect(404);
    expect(res.body.error).toBe('WALLET_NOT_FOUND');
  });

  it('GET /wallets/:id UUID inválido → 400', async () => {
    const res = await request(httpServer).get('/wallets/not-a-uuid').expect(400);
    expect(res.body.error).toBe('INVALID_PARAM');
  });

  // ---------------- ops ----------------

  it('GET /metrics → 200 text/plain', async () => {
    const res = await request(httpServer)
      .get('/metrics')
      .expect(200)
      .expect('Content-Type', /text\/plain/);
    expect(typeof res.text).toBe('string');
    expect(res.text).toContain('# HELP');
  });

  it('GET /health/live → 200', async () => {
    const res = await request(httpServer).get('/health/live').expect(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET /health/ready → 200', async () => {
    const res = await request(httpServer).get('/health/ready').expect(200);
    expect(res.body.checks.postgres).toBe('ok');
  });
});
