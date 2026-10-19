/**
 * Teste de carga — diferencial opcional da spec 14.
 *
 * **Metodologia**:
 *   - App sobe in-process via `NestFactory.create` (sem servidor externo).
 *   - 2 cenários:
 *       A) Contenção:  1 wallet, N BETs paralelas → mede lock contention
 *       B) Throughput: M wallets, N BETs paralelas → mede teto de RPS
 *   - Cada request registra duração individual; agrega em p50/p95/p99.
 *   - Lê métricas Prometheus antes/depois (outbox lag, lock conflicts).
 *   - Erros transitórios (5xx) contam como falha; rejeições de negócio (422)
 *     contam como sucesso (é resposta esperada).
 *
 * **Não há meta de RPS** — o objetivo é medir com honestidade e reportar.
 *
 * Uso:
 *   bun run test:load
 *   LOAD_CONCURRENCY=100 LOAD_BURST=1000 bun run test:load
 */
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { EntityManager, MikroORM } from '@mikro-orm/core';
import { AppModule } from '../../src/app.module.js';

const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 100);
const BURST = Number(process.env.LOAD_BURST ?? 1000);
const SCENARIO_A_WALLET_BALANCE = '10000.00';
const SCENARIO_B_WALLET_COUNT = 100;
const SCENARIO_B_BALANCE = '1000.00';

type Result = { status: number; durationMs: number; ok: boolean; error?: string };

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  LOAD TEST — Distributed Wagering Processor');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  concurrency : ${CONCURRENCY}`);
  console.log(`  burst       : ${BURST}`);
  console.log('');

  // 1. Boot in-process
  process.env.WAGER_CONSUMER_ENABLED = 'false';
  process.env.PENDING_REFERENCE_WORKER_ENABLED = 'false';
  process.env.OUTBOX_POLL_INTERVAL_MS = '1000';
  process.env.DEV_QUEUE_ENDPOINT = 'true';
  process.env.NODE_ENV = 'test';

  const app: INestApplication = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0);
  const baseUrl = (await app.getUrl()).replace(/\/$/, '');
  const orm = app.get(MikroORM);

  // 2. Truncar para estado limpo (usa DB de teste)
  await orm.em.getConnection().execute(
    'TRUNCATE TABLE "outbox_messages", "idempotency_records", "inbox_messages", "wallet_ledger_entries", "wager_transactions", "wallets" CASCADE;',
  );

  try {
    await runScenario(
      'A) Contenção — 1 wallet, N BETs paralelas',
      baseUrl,
      async () => {
        const wallet = await createWallet(baseUrl, SCENARIO_A_WALLET_BALANCE);
        return Array.from({ length: BURST }, (_, i) => () =>
          submitBet(baseUrl, wallet.walletId, wallet.playerId, '1.00', `bet-a-${i}`));
      },
      orm,
    );

    await runScenario(
      'B) Throughput — M wallets, N BETs paralelas',
      baseUrl,
      async () => {
        const wallets = await Promise.all(
          Array.from({ length: SCENARIO_B_WALLET_COUNT }, () =>
            createWallet(baseUrl, SCENARIO_B_BALANCE)),
        );
        const perWallet = Math.ceil(BURST / SCENARIO_B_WALLET_COUNT);
        return wallets.flatMap((w, wi) =>
          Array.from({ length: perWallet }, (_, i) => () =>
            submitBet(baseUrl, w.walletId, w.playerId, '1.00', `bet-b-${wi}-${i}`)),
        );
      },
      orm,
    );
  } finally {
    await app.close();
  }
}

// ---------------------------------------------------------------------------

async function runScenario(
  label: string,
  baseUrl: string,
  buildRequests: () => Promise<Array<() => Promise<Result>>>,
  orm: MikroORM,
): Promise<void> {
  console.log('───────────────────────────────────────────────────────');
  console.log(`  ${label}`);
  console.log('───────────────────────────────────────────────────────');

  const beforeMetrics = await readMetrics(baseUrl);
  const requests = await buildRequests();
  const totalReq = requests.length;

  console.log(`  requests    : ${totalReq}`);
  console.log('  rodando...');

  const wallStart = performance.now();
  const results = await runInBatches(requests, CONCURRENCY);
  const wallMs = performance.now() - wallStart;

  // ── Drenar outbox (até 30s) ─────────────────────────────────────
  // Under burst, o outbox lag é ESPERADO. Transactional outbox troca
  // latência por durabilidade. O que importa é: drena em tempo razoável?
  const drainStart = performance.now();
  let lastPending = -1;
  let drainedAt = -1;
  while (performance.now() - drainStart < 30_000) {
    const m = await readMetrics(baseUrl);
    const pending = gaugeValue(m, 'outbox_pending');
    lastPending = pending;
    if (pending === 0) {
      drainedAt = performance.now();
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  const drainMs = drainedAt === -1 ? -1 : drainedAt - wallStart;
  const afterMetrics = await readMetrics(baseUrl);

  // Agrega resultados
  const durations = results.map((r) => r.durationMs).sort((a, b) => a - b);
  const ok = results.filter((r) => r.status >= 200 && r.status < 300).length;
  const bizReject = results.filter((r) => r.status === 422).length;
  const errors = results.filter((r) => r.status === 0 || r.status >= 500).length;
  const otherHttp = results.filter(
    (r) =>
      r.status !== 0 && r.status !== 422 && (r.status < 200 || r.status >= 300) && r.status < 500,
  ).length;

  // Estado final no banco
  const txProcessed = await countRow(
    orm,
    `SELECT count(*)::text AS c FROM wager_transactions WHERE status = 'PROCESSED'`,
  );
  const txRejected = await countRow(
    orm,
    `SELECT count(*)::text AS c FROM wager_transactions WHERE status = 'REJECTED'`,
  );

  // Deltas
  const lockDelta = counterDelta(beforeMetrics, afterMetrics, 'wager_lock_conflicts_total');
  const outboxPublishedDelta = counterDelta(
    beforeMetrics,
    afterMetrics,
    'outbox_published_total',
  );
  const outboxPendingFinal = gaugeValue(afterMetrics, 'outbox_pending');
  const outboxMaxAge = histogramPercentile(
    afterMetrics,
    'outbox_event_age_seconds',
    0.99,
  );

  // Report
  const rps = (totalReq / wallMs) * 1000;
  const p = (n: number) => percentile(durations, n);

  console.log('');
  console.log('  ── RESULTADO (client-side) ─────────────────────────');
  console.log(`  duração wall        : ${wallMs.toFixed(0)}ms`);
  console.log(`  throughput          : ${rps.toFixed(1)} req/s`);
  console.log(`  sucesso (2xx)       : ${ok}`);
  console.log(`  rejeições negócio   : ${bizReject} (422 — esperado)`);
  console.log(`  erros (5xx / rede)  : ${errors}`);
  if (otherHttp > 0) console.log(`  outros 4xx          : ${otherHttp}`);
  console.log('');
  console.log(`  latência p50        : ${p(50).toFixed(1)}ms`);
  console.log(`  latência p95        : ${p(95).toFixed(1)}ms`);
  console.log(`  latência p99        : ${p(99).toFixed(1)}ms`);
  console.log(`  latência max        : ${p(100).toFixed(1)}ms`);
  console.log('');
  console.log('  ── OUTBOX / DB ─────────────────────────────────────');
  console.log(`  outbox publicados   : ${outboxPublishedDelta} (deltas)`);
  console.log(
    `  outbox drenado em   : ${
      drainMs === -1 ? '❌ NÃO drenou em 30s' : `${drainMs.toFixed(0)}ms`
    }`,
  );
  console.log(`  outbox pending (fim): ${outboxPendingFinal}`);
  console.log(
    `  outbox event age p99: ${(outboxMaxAge * 1000).toFixed(0)}ms (via histograma)`,
  );
  console.log(`  lock conflicts      : ${lockDelta}`);
  console.log('');
  console.log(`  banco: PROCESSED=${txProcessed} REJECTED=${txRejected}`);
  console.log('');

  // Sanity checks — apenas o que é REALMENTE falha
  const failures: string[] = [];
  if (errors > 0) failures.push(`${errors} erros 5xx/rede`);
  if (txProcessed === '0') failures.push('nenhuma transação PROCESSED no banco');
  if (drainMs === -1) failures.push('outbox NÃO drenou em 30s');

  if (failures.length > 0) {
    console.log('  ❌ FALHAS:');
    for (const f of failures) console.log(`     - ${f}`);
  } else {
    console.log('  ✅ OK');
  }
  console.log('');
}

// ---------------------------------------------------------------------------

async function runInBatches(
  reqs: Array<() => Promise<Result>>,
  batchSize: number,
): Promise<Result[]> {
  const all: Result[] = [];
  for (let i = 0; i < reqs.length; i += batchSize) {
    const batch = reqs.slice(i, i + batchSize).map((fn) => fn());
    const settled = await Promise.allSettled(batch);
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        all.push(s.value);
      } else {
        all.push({ status: 0, durationMs: 0, ok: false, error: String(s.reason) });
      }
    }
  }
  return all;
}

async function createWallet(
  baseUrl: string,
  initialBalance: string,
): Promise<{ walletId: string; playerId: string }> {
  const playerId = crypto.randomUUID();
  const res = await fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      playerId,
      initialBalance: { amount: initialBalance, currency: 'BRL' },
    }),
  });
  if (res.status !== 201) {
    throw new Error(`createWallet: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { id: string };
  return { walletId: body.id, playerId };
}

async function submitBet(
  baseUrl: string,
  walletId: string,
  playerId: string,
  amount: string,
  suffix: string,
): Promise<Result> {
  const t0 = performance.now();
  try {
    const extId = `loadtest-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `load:${extId}`,
      },
      body: JSON.stringify({
        providerId: 'prov-load',
        externalTransactionId: extId,
        idempotencyKey: `load:${extId}`,
        playerId,
        walletId,
        roundId: 'round-load',
        gameId: 'slot-1',
        kind: 'BET',
        money: { amount, currency: 'BRL' },
      }),
    });
    return {
      status: res.status,
      durationMs: performance.now() - t0,
      ok: res.status >= 200 && res.status < 300,
    };
  } catch (err) {
    return {
      status: 0,
      durationMs: performance.now() - t0,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function readMetrics(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/metrics`);
  return res.text();
}

function counterDelta(before: string, after: string, name: string): number {
  const parse = (text: string) =>
    text
      .split('\n')
      .filter((l) => l.startsWith(name) && !l.startsWith(`${name}_bucket`))
      .reduce((sum, l) => sum + Number(l.split(' ').pop() ?? '0'), 0);
  return parse(after) - parse(before);
}

function gaugeValue(text: string, name: string): number {
  const line = text.split('\n').find((l) => l.startsWith(`${name} `));
  return line ? Number(line.split(' ').pop() ?? '0') : 0;
}

function histogramPercentile(text: string, name: string, p: number): number {
  const buckets: Array<{ le: number; count: number }> = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith(`${name}_bucket`)) continue;
    const parts = line.trim().split(/\s+/);
    // parts[0] = `name_bucket{le="..."}`, parts[1] = count
    const leMatch = parts[0]?.match(/le="([^"]+)"/);
    if (!leMatch || parts.length < 2) continue;
    const le = leMatch[1] === '+Inf' ? Infinity : Number(leMatch[1]);
    const count = Number(parts[1]);
    if (Number.isFinite(count)) buckets.push({ le, count });
  }
  const total = buckets.find((b) => b.le === Infinity)?.count ?? 0;
  if (total === 0) return 0;
  const target = p * total;
  for (const b of buckets) {
    if (b.count >= target) return Number.isFinite(b.le) ? b.le : 0;
  }
  return 0;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function countRow(orm: MikroORM, sql: string): Promise<string> {
  const [{ c }] = await orm.em.getConnection().execute<Array<{ c: string }>>(sql);
  return String(c);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
