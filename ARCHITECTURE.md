# ARCHITECTURE.md — Distributed Wagering Processor

## Índice

- [1. Objetivo](#1-objetivo)
- [2. Modelo de domínio](#2-modelo-de-domínio)
- [3. Persistência — MikroORM + PostgreSQL](#3-persistência--mikroorm--postgresql)
- [4. Concorrência — lock pessimista por wallet](#4-concorrência--lock-pessimista-por-wallet)
- [5. Idempotência](#5-idempotência--persistente-fonte-única-de-verdade)
- [6. Inbox / Outbox](#6-inbox--outbox--transactional-boundaries)
- [7. Mensageria](#7-mensageria--provider-agnóstica)
- [8. `PENDING_REFERENCE`](#8-pending_reference--worker-com-backoff--ttl)
- [9. HTTP](#9-http--mapeamento-de-status-consistente)
- [10. Observabilidade](#10-observabilidade)
- [11. Decisões e trade-offs](#11-decisões-e-trade-offs)
- [12. Estratégia de testes](#12-estratégia-de-testes)
- [13. Limitações e funcionalidades não implementadas](#13-limitações-e-funcionalidades-não-implementadas)
- [14. Teste de carga](#14-load-test--metodologia)

---

## 1. Objetivo

Processar transações de apostas recebidas de múltiplos provedores com
**correção financeira sob concorrência, idempotência persistente e
consistência entre saldo materializado e ledger**. O sistema permanece
correto quando mensagens chegam duplicadas, fora de ordem, simultaneamente,
com crash entre commit e ack, ou com eventos publicados mais de uma vez
(spec seção 3).

## 2. Modelo de domínio

- **Aggregate Root**: `Wallet`.
- **Value Object**: `Money` — imutável, string decimal, escala 2. Sem
  `number`/`float`/`double` em nenhuma camada.
- **Entidades**: `WagerTransaction`, `WalletLedgerEntry` (imutável),
  `IdempotencyRecord`, `InboxMessage`, `OutboxMessage`.
- **Eventos de integração**: `IntegrationEvent<T>` abstrata; subclasses
  concretas (`WagerTransactionProcessed`, `WalletBalanceChanged`,
  `WagerTransactionRejected`, `WagerTransactionPendingReference`). Payload
  serializa `MoneyProps` (string), nunca instância de `Money`.
- **Boundaries**: domínio puro (sem MikroORM/NestJS) + camada de
  aplicação (`WageringService`) + infraestrutura (MikroORM, HTTP, SQS,
  workers). Testes de integração exercitam o agregado real contra
  PostgreSQL.

### 2.1 Fluxos principais

#### Fluxo síncrono (HTTP POST /wagering/transactions)

```mermaid
sequenceDiagram
    autonumber
    participant C as Cliente
    participant WC as WageringController
    participant WS as WageringService
    participant DB as PostgreSQL
    participant OB as Outbox

    C->>WC: POST /wagering/transactions (Idempotency-Key)
    WC->>WC: validate body + UUID
    WC->>WC: compute payloadHash
    WC->>WS: submitTransaction(dto)

    WS->>DB: BEGIN
    WS->>DB: SELECT wallet FOR UPDATE (PESSIMISTIC_WRITE)
    WS->>DB: SELECT idempotency_record (key)
    alt IdempotencyRecord existe + hash igual
        DB-->>WS: record anterior
        WS->>DB: COMMIT
        WS-->>WC: { status, balanceAfter, idempotentReplay: true }
    else IdempotencyRecord existe + hash diferente
        WS->>DB: ROLLBACK
        WS-->>WC: throw DuplicateIdempotencyKey
        WC-->>C: 409 Conflict
    else Não existe
        WS->>DB: INSERT wager_transaction
        WS->>DB: INSERT wallet_ledger_entry
        WS->>DB: UPDATE wallet (balance, version)
        WS->>DB: INSERT idempotency_record
        WS->>OB: INSERT outbox (WalletBalanceChanged, Processed)
        WS->>DB: COMMIT
        WS-->>WC: { status: PROCESSED, balanceAfter }
        WC-->>C: 200 OK
    end

Fluxo PENDING_REFERENCE (referência fora de ordem)

sequenceDiagram
    autonumber
    participant PR as Provider
    participant WS as WageringService
    participant DB as PostgreSQL
    participant WK as PendingReferenceWorker

    Note over PR,WK: ROLLBACK chega ANTES do WIN referenciado
    PR->>WS: ROLLBACK ref=win-x
    WS->>DB: BEGIN + lock wallet
    WS->>DB: SELECT wager_tx WHERE ext_id='win-x'
    DB-->>WS: null
    WS->>DB: INSERT wager_tx (PENDING_REFERENCE)
    WS->>DB: INSERT outbox (PendingReference)
    WS->>DB: COMMIT
    WS-->>PR: 202 Accepted

    loop a cada 5s (backoff exponencial)
        WK->>DB: SELECT PENDING_REFERENCE due
        WK->>WS: retryPendingReference(txId)
        WS->>DB: SELECT ref
        alt referência ausente
            WS->>DB: UPDATE attempts++, nextAttemptAt
            WS-->>WK: 'pending'
        else referência chegou
            WS->>DB: aplica ROLLBACK + idempotency + outbox
            WS-->>WK: 'processed'
        else attempts > MAX
            WS->>DB: REJECTED + failureCode=REFERENCE_NOT_FOUND
            WS-->>WK: 'rejected'
        end
    end

    Note over PR,WS: WIN-x chega
    PR->>WS: WIN ext_id='win-x'
    WS->>DB: INSERT wager_tx (PROCESSED, balance 130.00)
    WS-->>PR: 200 OK

    WK->>WS: retryPendingReference(rollback-tx-id)
    WS->>DB: resolve reference → aplica ROLLBACK (balance 100.00)
    WS-->>WK: 'processed'

Fluxo de fila (SQS consumer)

sequenceDiagram
    autonumber
    participant SQS as SQS wager-transactions.fifo
    participant CON as WagerTransactionConsumer
    participant WS as WageringService
    participant DB as PostgreSQL
    participant DLQ as SQS DLQ

    loop poll a cada 1s
        CON->>SQS: receiveMessage (long polling)
        SQS-->>CON: [{ body, receiptHandle }]
        CON->>CON: JSON.parse(body)
        alt envelope inválido
            CON->>SQS: deleteMessage (ack)
        else envelope válido
            CON->>WS: submitTransaction({ ...body, inboxMessage })
            alt PROCESSED / PENDING_REFERENCE / REJECTED
                WS-->>CON: resultado terminal
                CON->>SQS: deleteMessage (ack pós-commit)
            else WagerTransactionError (negócio)
                WS-->>CON: throw
                CON->>SQS: deleteMessage (ack + log — terminal)
            else erro transitório (DB, timeout)
                WS-->>CON: throw
                alt receiveCount < maxReceiveCount
                    CON->>SQS: changeMessageVisibility (nack, backoff)
                else receiveCount >= maxReceiveCount
                    SQS->>DLQ: RedrivePolicy move automaticamente
                end
            end
        end
    end

## 3. Persistência — MikroORM + PostgreSQL

**Valor monetário**: colunas `NUMERIC(18,2)` no banco, mapeadas para string
decimal em `Money`. O `EntitySchema` declara
`{ type: 'decimal', precision: 18, scale: 2 }` — sintaxe MikroORM 6
correta. A forma `'decimal(18,2)'` cai em fallback `numeric(10,0)` e quebra
centavos; bug detectado por `schema:update --dump` e corrigido.

**Schema como fonte de verdade** — garantias que o edital exige estão no
banco, não apenas em código:

- `CHECK (balance_amount >= 0)` na `wallets`.
- Trigger `wallet_ledger_immutable_fn` bloqueia `UPDATE`/`DELETE` no
  `wallet_ledger_entries` (migration `Migration20260101000000`).
- `UNIQUE (player_id, currency)` em `wallets`.
- `UNIQUE (provider_id, external_transaction_id)` em `wager_transactions`
  — necessário para resolução determinística de referências
  (`REFUND`/`ROLLBACK`).
- Índice parcial `uq_wager_tx_reversal`
  (`WHERE status='PROCESSED' AND reference_external_transaction_id IS NOT NULL`)
  impede que uma referência seja revertida 2× pelo mesmo `kind`. Defesa de
  banco em paralelo à checagem em `resolveReferenceTx`.

**Migrations versionadas e reversíveis**. `schema:update` é proibido neste
projeto: o auto-diff do MikroORM dropa triggers e índices parciais que ele
não modela. A regra está explícita no README e no `db:verify`.

## 4. Concorrência — lock pessimista por wallet

- **Unidade de concorrência**: `walletId` (spec 8).
- **Estratégia**: `PESSIMISTIC_WRITE` (`SELECT ... FOR UPDATE`) em
  `submitTransaction`, dentro da transação SQL. Serializa operações sobre
  a mesma wallet; permite paralelismo entre wallets distintas. Sem locks
  globais, sem otimista-com-retry.
- **Ordem de persistência**: `wallets` sempre em um `flush` isolado ANTES
  de `wager_transactions`. Sem isso, o MikroORM não infere a FK
  `wager_transactions.wallet_id → wallets.id` (a coluna é `uuid` puro, sem
  `kind: 'm:1'`) e insere na ordem errada, violando a constraint.
  Atomicidade preservada porque ambos os `flush` estão na mesma SQL
  transaction.
- **Cenários provados** (`test/integration/concurrency/race-condition.integration.spec.ts`):
  - duas apostas de 80.00 disputando 100.00 → 1 `PROCESSED` + 1 `REJECTED`,
    saldo final 20.00, **1 débito** no ledger;
  - mesma aposta 50× → 1 débito, 49 replays;
  - rollback antes da referência → `PENDING_REFERENCE` → reprocessado;
  - dois forks independentes disputando a mesma wallet em paralelo.

## 5. Idempotência — persistente, fonte única de verdade

- **`IdempotencyRecord`** persiste `(idempotencyKey, payloadHash, status,
  response)`. Mesma key + mesmo hash → **replay** fiel. Mesma key + hash
  diferente → **409**.
- **`payloadHash`**: SHA-256 de JSON canônico (chaves ordenadas) do
  subconjunto de negócio. Header e metadados de transporte não entram.
- **Replay**: devolve `transactionId`, `status` e `balanceAfter` do momento
  original — não recalcula (spec 7.7). Status `PENDING` é **reprocessado**
  (única forma de resolver `PENDING_REFERENCE` quando a referência chega).
- **Rejeição de negócio** (`INSUFFICIENT_FUNDS`, `REFERENCE_*`) **não lança
  exceção**: é persistida como `REJECTED`, evento publicado, resultado
  devolvido. Isso mantém a rejeição auditável e evita rollback do
  `IdempotencyRecord`.
- **Idempotência da OPENING**: a criação de wallet grava um
  `IdempotencyRecord` com `system:opening:{walletId}` — reexecução da
  criação devolve conflito.

## 6. Inbox / Outbox — transactional boundaries

- **Inbox** (`(messageId, consumerName)`): dedup persistente de mensagens
  da fila. `submitTransaction` marca `processedAt` **na mesma transação
  SQL** da aplicação financeira. Reentrega com a mesma `messageId` →
  replay sem novo débito (validado pelo `scripts/test-queue.sh`).
- **Outbox**: transação financeira + eventos de integração gravados na
  **mesma SQL transaction**. Publicação é feita por
  `OutboxPublisherWorker` usando `FOR UPDATE SKIP LOCKED` + `UPDATE
  published_at`. Múltiplas instâncias drenam sem duplicação indefinida;
  duplicação eventual (crash entre publish e commit) é absorvida pelo
  inbox do consumer.
- **Evento único na transição**: `WagerTransactionPendingReference` só é
  enfileirado na transição `PENDING → PENDING_REFERENCE`, não em cada
  retry do worker (bug detectado em E2E e corrigido).

## 7. Mensageria — provider-agnóstica

- **Duas implementações** da mesma porta `QueueConsumerPort`:
  `InMemoryQueueAdapter` (dev/testes, `QUEUE_BACKEND=memory`) e
  `AwsSqsQueueAdapter` (LocalStack/AWS, `QUEUE_BACKEND=aws`). Import
  dinâmico de `@aws-sdk/client-sqs` — só exige o pacote quando
  `QUEUE_BACKEND=aws`.
- **Consumer** (`WagerTransactionConsumer`) reusa o mesmo use case da
  entrada HTTP. Distingue:
  - **sucesso** (incluindo `REJECTED`) → **ack pós-commit**;
  - **erro de domínio** (`WagerTransactionError`) → **ack + log** (retry
    não ajuda);
  - **transitório** (DB down, timeout) → **nack** com backoff; DLQ após
    `SQS_MAX_RECEIVE_COUNT`.
- **Endpoints de dev** (`POST /_dev/queue/publish`, `GET /_dev/queue/stats`)
  permitem testar o consumer sem LocalStack; gated por
  `DEV_QUEUE_ENDPOINT=true`.

## 8. `PENDING_REFERENCE` — worker com backoff + TTL

- Transações `REFUND`/`ROLLBACK` com referência ausente viram
  `PENDING_REFERENCE` com evento próprio.
- **Worker** (`PendingReferenceWorker`) poll a cada 5s. Para cada transação
  devida: chama `retryPendingReference`, que reusa `submitTransaction`
  (mesma idempotência, mesmo lock).
- **Backoff** exponencial com jitter, configurável por env
  (`PENDING_REFERENCE_BASE_BACKOFF_MS`, `PENDING_REFERENCE_MAX_BACKOFF_MS`).
- **TTL** via `PENDING_REFERENCE_MAX_ATTEMPTS` (default 12). Esgotado,
  transição → `REJECTED` com `failureCode=REFERENCE_NOT_FOUND` + evento
  publicado (spec 7.1).
- **Idempotência do worker**: CAS via `pending_reference_attempts` sob
  `PESSIMISTIC_WRITE`; se outra instância incrementou no meio-tempo, o
  incremento é abortado sem duplo retry contado.
- **Colunas dedicadas**: `pending_reference_attempts` +
  `pending_reference_next_attempt_at` + índice parcial
  `idx_wager_tx_pending_reference` (migration
  `Migration20260101000002`).

## 9. HTTP — mapeamento de status consistente

| Situação | HTTP | Corpo |
|---|---|---|
| Payload inválido (shape, UUID, moeda) | 400 | `{ error: 'INVALID_BODY', ... }` |
| Wallet/transação não encontrada | 404 | `{ error: 'WALLET_NOT_FOUND', ... }` |
| IdempotencyKey reutilizada com payload divergente | 409 | `{ error: 'DUPLICATE_IDEMPOTENCY_KEY' }` |
| Rejeição de regra de negócio | 422 | `{ status: 'REJECTED', failureCode, ... }` |
| Aceita aguardando referência | 202 | `{ status: 'PENDING_REFERENCE', ... }` |
| Processado | 200 | `{ status: 'PROCESSED', balance, ... }` |
| Infraestrutura transitória | 503 | `{ error: 'INFRA_*', retryable: true }` |

Rejeições de negócio **não viram 4xx mascarado**: vêm em 422 com
`failureCode` legível por máquina (spec 7.2).

`Idempotency-Key` obrigatório em `POST /wagering/transactions`; default
recomendado `{providerId}:{externalTransactionId}`.

## 10. Observabilidade

- **Logs estruturados JSON** com `correlationId`, `messageId`,
  `transactionId`, `walletId`, `providerId`. Nenhum payload financeiro
  completo nos logs.
- **Métricas Prometheus** (`GET /metrics`, `prom-client`):
  - `wager_transactions_total{status}` — transações por status.
  - `wager_submit_duration_seconds` — latência do use case.
  - `wager_idempotency_replays_total`, `wager_idempotency_conflicts_total`.
  - `wager_lock_conflicts_total` — contenção de lock.
  - `outbox_published_total`, `outbox_publish_failed_total`,
    `outbox_pending`, `outbox_event_age_seconds` — lag da outbox.
  - `pending_reference_outcome_total{outcome}`.
  - `queue_messages_received_total`, `queue_messages_acked_total{reason}`,
    `queue_messages_nacked_total`, `queue_messages_dlq_total`.
  - `http_errors_total{status}`.
  - `nodejs_*` (default metrics do `prom-client`).
- **Health**: `/health/live` (processo vivo), `/health/ready` (PostgreSQL
  + SQS alcançáveis). Nenhum dos dois exige autenticação.

## 11. Decisões e trade-offs

| Decisão | Por quê | Trade-off |
|---|---|---|
| `Money` como VO com `Decimal` interno | Precisão exata, imutável, sem vazamento do ORM | Verboso; toda operação cria nova instância |
| Lock pessimista (não otimista+retry) | Serializa corretamente sob múltiplas instâncias; retry pode esgotar | Contenção sob mesma wallet quente; resolvida por short-lived lock |
| Rejeição de negócio como **resultado**, não exceção | Rejeição auditável, replay fiel, sem rollback de idempotency | Camadas acima devem checar `result.status` |
| Worker de outbox com `SKIP LOCKED` (não `LISTEN/NOTIFY`) | Multi-instance pronto, sem complexidade de canal de notificação | Latência mínima de 1s (polling) |
| Consumer provider-agnóstico (in-memory + SQS) | Testável sem LocalStack; troca por env var | ~150 linhas extras |
| Reuso de `submitTransaction` no consumer e no worker `PENDING_REFERENCE` | Uma implementação da regra financeira | Custo de lock na wallet mesmo em retries que vão resultar em `pending` |
| `schema:update` proibido no projeto | Triggers e índices parciais que o MikroORM não modela seriam dropados | Migrations manuais para tudo; regra documentada |
| `playerId` como UUID (v7 no edital) | Contrato do edital (seção 9); `wager_transactions.player_id` é UUID | Validador aceita forma canônica `8-4-4-4-12`, sem exigir versão específica |
| `metrics` opcional nos construtores | Testes de integração instanciam `new WageringService(em)` sem Nest | Parâmetro `?` evita obrigatoriedade |

---

## 12. Estratégia de testes

**Stack:** Bun test (runner) + `@nestjs/testing` (DI) + `supertest` (HTTP) + PostgreSQL real.

### Pirâmide

| Nível | Comando | Tempo | Quantidade |
|---|---|---|---|
| **Unit** | `bun run test:unit` | ~150ms | 85 testes |
| **Integration** | `bun run test:integration` | ~7s | 44 testes |
| **E2E** | `bun run test:e2e` | ~2s | 25 testes |
| **Total** | `bun run test` | ~10s | **154 testes** |

### Decisões

- **Unit puro**: sem DB, sem Nest. Roda em <200ms — feedback instantâneo para TDD.
- **Integration com PostgreSQL real**: **sem mocks**. `TRUNCATE CASCADE` no `beforeEach`.
- **E2E in-memory**: `Test.createTestingModule` + `supertest`. Sobe o `AppModule` completo, sem `start:dev`.
- **Serialização**: `--max-concurrency=1` obrigatório em integration/E2E (DB compartilhado, `TRUNCATE` colide em paralelo).
- **Bun test**: runner nativo, Jest-compatible. Compatível com `@nestjs/testing@12` (runner-agnostic).

### Cobertura por spec do edital

| Spec | Cobertura |
|---|---|
| 5 (invioláveis) | ✅ 12 testes de schema + concorrência |
| 6 (domínio) | ✅ 85 unit tests |
| 7 (regras) | ✅ 11 integration + 5 E2E |
| 8 (concorrência) | ✅ 16 testes (50x paralelo, N wallets, 3 forks, crash) |
| 9 (HTTP) | ✅ 16 E2E HTTP (200/201/202/400/404/409/422) |
| 10 (SQS) | ✅ 4 integration SQS + 4 E2E consumer |
| 11 (outbox) | ✅ 5 integration SKIP LOCKED + 3 E2E out-of-order |
| 12 (obs) | ✅ `/metrics` E2E |
| 13 (testes) | ✅ 8/8 cenários da spec 13 |

---

## 13. Limitações e funcionalidades não implementadas

- **Autenticação**: fora de escopo por spec 2. `NoopAuthGuard` +
  `ProviderIdentityPort` são o ponto de extensão explícito.
- **OpenTelemetry traces**: opcional por spec 12. Não implementado.
- **Double-entry ledger**: opcional por spec 6.4. Não implementado
  (ledger é single-entry por wallet).
- **`test:load` métricas de histograma**: métrica Prometheus
  `wager_submit_duration_seconds` funciona em `/metrics`, mas o parser
  do load test não lê o bucket `le="+Inf"` corretamente → reporta
  `p99: 0.0ms`. Limitação do parser, não do sistema.
- **DLQ explícita no in-memory adapter**: após `maxReceiveCount`, o
  adaptador in-memory move para DLQ interna. No SQS real, `RedrivePolicy`
  nativa (criada pelo `localstack-init.sh`) move automaticamente.
  Ambos testados: `test/integration/queue/dlq.integration.spec.ts` (memory)
  e `test/integration/aws/sqs-real.integration.spec.ts` (SQS real).

## 14. Load test — metodologia e resultados

**Diferencial opcional da spec 14, entregue.** `bun run test:load` executa
2 cenários e reporta com honestidade.

### Ambiente

- **App**: in-process (`NestFactory.create`), sem servidor externo. Cada
  request passa pelo pipeline HTTP + service + Postgres reais (sem mock).
- **DB**: `wagering_db_test` (isolado, `TRUNCATE` no início).
- **Workers**: `WAGER_CONSUMER_ENABLED=false` e
  `PENDING_REFERENCE_WORKER_ENABLED=false` — só o `OutboxPublisherWorker`
  roda, para medir `outbox lag` real.
- **Hardware**: notebook do autor, `bun 1.4.0`, PostgreSQL 15 em Docker
  Compose (host `:5433`), sem isolamento de CPU/RAM.

### Metodologia

**2 cenários** (default 1000 requests por cenário):

| Cenário | Config | O que mede |
|---|---|---|
| **A) Contenção** | 1 wallet × 1000 BETs paralelas de R$1 | Lock contention sob hot wallet |
| **B) Throughput** | 100 wallets × 10 BETs cada, paralelas | Teto de RPS com paralelismo real |

- **Concorrência**: `LOAD_CONCURRENCY=100` requests simultâneos via
  `Promise.allSettled` em batches de 100.
- **Amostras**: cada request registra `performance.now()` antes/depois do
  `fetch`. Percentis sobre a amostra completa (não bucket).
- **Erros**: 2xx = sucesso; 422 = rejeição de negócio (esperado); 5xx/rede
  = falha do teste.
- **Outbox**: espera drenagem **até 30s**. Falha só se não drenar; tempo
  de drenagem é reportado.

### Números reais (execução 2026-10-19)

**Cenário A — contenção (1 wallet × 1000 BETs)**

| Métrica | Resultado |
|---|---:|
| Duração wall | 8.163 s |
| Throughput | **122.5 req/s** |
| p50 | **415 ms** |
| p95 | **1.023 ms** |
| p99 | **1.359 ms** |
| Erros | 0 |
| `lock_conflicts` | 0 |
| Outbox drenado em | ~14 s |
| Banco | 1001 PROCESSED |

**Cenário B — throughput (100 wallets × 10 BETs)**

| Métrica | Resultado |
|---|---:|
| Duração wall | 4.306 s |
| Throughput | **232.2 req/s** |
| p50 | **224 ms** |
| p95 | **413 ms** |
| p99 | **471 ms** |
| Erros | 0 |
| `lock_conflicts` | 0 |
| Outbox drenado em | ~9 s |
| Banco | 2101 PROCESSED |

### Análise

**Contenção (A) vs throughput (B)**: A é ~1.9× mais lento em throughput e
~2× pior em p50. Confirma que a **hot wallet** pesa, mas **não é o único
gargalo**.

**Gargalo real**: `lock_conflicts = 0` mostra que o `PESSIMISTIC_WRITE`
**serializa corretamente sem deadlock**. O limite de throughput vem de:

1. **Pool de conexões do DB**: MikroORM default ≈ 10-20 conexões. Com
   concorrência 100, ~80-90 requests esperam conexão a cada momento.
2. **Overhead do pipeline**: NestJS + express + validation + domain +
   MikroORM + fetch.
3. **Commit síncrono do Postgres**: cada `submitTransaction` faz
   `BEGIN` + `SELECT FOR UPDATE` + INSERTs + `COMMIT` com fsync (~2-5ms).
4. **Dois eventos de outbox por request** (`WalletBalanceChanged` +
   `WagerTransactionProcessed`). Sob burst, o `OutboxPublisherWorker` fica
   para trás — o outbox **drena**, mas leva 9-14s depois do pico.

**p95/p99 altos no cenário A** são o trade-off esperado de
`PESSIMISTIC_WRITE`: a 99ª pior requisição esperou ~100 locks antes de
rodar. Um sistema otimista-com-retry teria cauda diferente (menor latência
individual, mas risco de fome sob alta contenção).

**O que escalaria**: PgBouncer (pool dimensionado para a concorrência
alvo) + múltiplas instâncias + sharding por `walletId` para distribuir hot
wallets. A invariante de corretude é preservada — só o throughput muda.

### Limitações do experimento

- **Single machine** — não mede latência de rede entre app e DB.
- **Sem isolamento de CPU** — medições variam ±20% entre runs.
- **Sem ramp-up** — todos os 100 workers disparam ao mesmo tempo.
- **Sem teste de caos** — não simula falhas de DB ou SQS durante o teste.
- **Amostra única** — sem intervalo de confiança; uma execução.
- **Métrica `wager_submit_duration_seconds` no relatório**: o histograma
  Prometheus retorna o **limite do bucket** (2.5s no último bucket), não a
  p99 real. Por isso, o relatório usa a **p99 client-side** (mais honesta)
  e omite o histograma do bloco principal. A métrica `outbox_event_age_seconds`
  fornece o lag real.

Um teste de carga mais rigoroso usaria:
- `k6` ou `vegeta` com ramp-up + duração fixa + warmup explícito
- DB e app em hosts distintos
- PgBouncer + pool dimensionado para a concorrência alvo
- Chaos hooks durante a execução
