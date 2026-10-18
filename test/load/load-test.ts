import * as crypto from 'crypto';

const API_URL = process.env.API_URL || 'http://localhost:3000';

async function runLoadTest() {
  console.log('🚀 Iniciando Teste de Carga e Concorrência...');
  console.log(`Target: ${API_URL}\n`);

  const playerId = crypto.randomUUID();
  const walletId = crypto.randomUUID();

  // 1. Criar a Wallet com saldo inicial de 100.00 BRL
  console.log('📦 Criando wallet de teste com 100.00 BRL...');
  const createWalletRes = await fetch(`${API_URL}/wallets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    }),
  });

  if (!createWalletRes.ok) {
    const errText = await createWalletRes.text();
    console.error('❌ Falha ao criar wallet para o teste de carga:', errText);
    process.exit(1);
  }

  // Sobrescreve o walletId com o gerado/retornado pelo servidor se necessário
  const walletData: any = await createWalletRes.json();
  const targetWalletId = walletData.id || walletId;
  console.log(`✅ Wallet criada com ID: ${targetWalletId}\n`);

  // 2. Cenário de Concorrência Extrema (Seção 8 e 13):
  // 50 requisições simultâneas de BET de 80.00 BRL (Saldo atual: 100.00)
  // Apenas UMA deve passar com PROCESSED, as outras 49 devem falhar por saldo insuficiente (REJECTED/400).
  console.log('🔥 Disparando 50 apostas simultâneas de 80.00 BRL (Concorrência de Saldo)...');

  const concurrentRequestsCount = 50;
  const startTime = performance.now();

  const promises = Array.from({ length: concurrentRequestsCount }, async (_, index) => {
    const idempotencyKey = `load-test:concurrency:${index}`;
    const externalTransactionId = `ext-bet-${index}`;

    const res = await fetch(`${API_URL}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        providerId: 'provider-load-test',
        externalTransactionId,
        playerId,
        walletId: targetWalletId,
        roundId: 'round-load-01',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '80.00', currency: 'BRL' },
      }),
    });

    const status = res.status;
    let body: any = {};
    try {
      body = await res.json();
    } catch {}

    return { status, body };
  });

  const results = await Promise.all(promises);
  const endTime = performance.now();
  const durationMs = endTime - startTime;

  // 3. Analisar Resultados
  const processed = results.filter(r => r.status === 201 || (r.body && r.body.status === 'PROCESSED'));
  const rejected = results.filter(r => r.status === 400 || (r.body && r.body.code === 'INSUFFICIENT_FUNDS'));
  const others = results.filter(r => !processed.includes(r) && !rejected.includes(r));

  console.log('\n📊 --- RELATÓRIO DO TESTE DE CONCORRÊNCIA ---');
  console.log(`⏱️ Tempo total: ${durationMs.toFixed(2)} ms`);
  console.log(`🚀 Throughput aproximado: ${((concurrentRequestsCount / durationMs) * 1000).toFixed(2)} req/s`);
  console.log(`✅ Sucessos (PROCESSED): ${processed.length} (Esperado: exatamente 1)`);
  console.log(`❌ Rejeitados por Saldo (INSUFFICIENT_FUNDS): ${rejected.length} (Esperado: 49)`);
  console.log(`⚠️ Outros erros inesperados: ${others.length}`);

  // 4. Verificar Saldo Final da Wallet
  const checkWalletRes = await fetch(`${API_URL}/wallets/${targetWalletId}`);
  const finalWalletData: any = await checkWalletRes.json();
  console.log(`💰 Saldo final da wallet: ${finalWalletData.balance?.amount} ${finalWalletData.balance?.currency} (Esperado: 20.00)`);

  // 5. Teste de Idempotência em Carga (Replay idêntico)
  console.log('\n🔄 Testando Replay Idêntico sob Carga...');
  const replayKey = 'load-test:replay:1';
  const payload = {
    providerId: 'provider-load-test',
    externalTransactionId: 'ext-replay-01',
    playerId,
    walletId: targetWalletId,
    roundId: 'round-load-02',
    gameId: 'fortune-chimp',
    kind: 'WIN',
    money: { amount: '50.00', currency: 'BRL' },
  };

  // Primeira chamada
  const firstRes = await fetch(`${API_URL}/wagering/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': replayKey },
    body: JSON.stringify(payload),
  });
  const firstData: any = await firstRes.json();

  // 10 chamadas concorrentes idênticas para testar replayed true
  const replayPromises = Array.from({ length: 10 }, () =>
    fetch(`${API_URL}/wagering/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': replayKey },
      body: JSON.stringify(payload),
    }).then(async r => ({ status: r.status, body: await r.json() }))
  );

  const replayResults = await Promise.all(replayPromises);
  const allReplaysValid = replayResults.every(r => r.body.idempotentReplay === true && r.body.transactionId === firstData.transactionId);

  console.log(`✅ Replays idênticos retornaram corretos e consistentes? ${allReplaysValid ? 'SIM' : 'NÃO'}`);

  // Validação final de assertions
  if (processed.length === 1 && rejected.length === 49 && finalWalletData.balance?.amount === '20.00' && allReplaysValid) {
    console.log('\n🎉 TESTE DE CARGA CONCLUÍDO COM SUCESSO ABSOLUTO! Todas as invariantes foram mantidas.');
    process.exit(0);
  } else {
    console.error('\n❌ TESTE DE CARGA FALHOU EM ALGUMA INVARIANTE!');
    process.exit(1);
  }
}

runLoadTest().catch(err => {
  console.error('❌ Erro fatal no teste de carga:', err);
  process.exit(1);
});
