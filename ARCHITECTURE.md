# ARCHITECTURE.md — Distributed Wagering Processor

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

## 12. O que não está implementado (limitações)

- **Autenticação**: fora de escopo por spec 2. `AuthGuard` no-op é o ponto
  de extensão explícito; `ProviderIdentityPort` desenhado mas não
  implementado.
- **Teste de carga**: `bun run test:load` esboçado, não entregue.
  Diferencial opcional.
- **OpenTelemetry traces**: opcional por spec 12. Não implementado.
- **Double-entry ledger**: opcional. Não implementado (ledger é
  single-entry por wallet).
- **DLQ explícita no in-memory adapter**: após `maxReceiveCount`, o
  adaptador in-memory move para DLQ interna. No SQS real, DLQ via
  `SQS_DLQ_URL` (envio explícito) ou `RedrivePolicy` nativa. Ambos
  testados em dev.

## 13. Como testar

```bash
# Schema invariantes (trigger, NUMERIC, uniques)
bun run db:verify

# Integração — PostgreSQL real (todos os eliminatórios)
bun test test/integration/concurrency/race-condition.integration.spec.ts

# E2E — cenário 13.7 (mensagem fora de ordem)
./scripts/test-out-of-order.sh

# E2E — consumer de fila (in-memory)
DEV_QUEUE_ENDPOINT=true bun run start:dev
./scripts/test-queue.sh

# Métricas
curl -s http://localhost:3000/metrics | grep -E '^(wager_|outbox_|queue_|pending_reference_)'
