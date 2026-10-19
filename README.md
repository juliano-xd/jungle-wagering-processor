# Distributed Wagering Processor 🦧

Serviço financeiro distribuído para processamento de transações de apostas multi-provider, com foco em **correção financeira sob concorrência**, **idempotência persistente** e **consistência entre saldo e ledger**.

**Stack:** Bun · TypeScript estrito · NestJS 12 · MikroORM 7 · PostgreSQL · LocalStack (SQS FIFO)

---

## Índice

- [Arquitetura](#arquitetura)
- [Pré-requisitos](#pré-requisitos)
- [Quick start](#quick-start)
- [Comandos](#comandos)
- [Variáveis de ambiente](#variáveis-de-ambiente)
- [API HTTP](#api-http)
- [Processamento assíncrono](#processamento-assíncrono)
- [Testes](#testes)
- [Mensageria real com SQS](#mensageria-real-sqs--localstack)
- [Teste de carga](#teste-de-carga)
- [Decisões de design](#decisões-de-design)
- [Limitações](#limitações)
- [Licença](#licença)

---

## Arquitetura

```text
HTTP POST /wagering/transactions       SQS: wager-transactions.fifo
               │                                  │
               ▼                                  ▼
      WageringController                WagerTransactionConsumer
               │                                  │
               └────────────────┬─────────────────┘
                                ▼
                       WageringService
                 (único ponto de mutação financeira)
                                │
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                 ▼
      IdempotencyRecord       Wallet             Ledger
                           (lock pessimista)   (imutável)
                                │
                                ▼
                         Outbox (atômica)
                                │
                                ▼
                    OutboxPublisherWorker → fila
```

Principais garantias:

- **Idempotência:** `IdempotencyRecord` persistido e `payloadHash` canônico.
- **Concorrência:** lock `PESSIMISTIC_WRITE` por wallet.
- **Atomicidade:** wallet, ledger, idempotency, inbox e outbox são gravados na mesma transação SQL.
- **Eventos fora de ordem:** `PENDING_REFERENCE`, worker com backoff e TTL.

Consulte [`ARCHITECTURE.md`](ARCHITECTURE.md) para o detalhamento completo.

---

## Pré-requisitos

| Ferramenta | Versão mínima / observação |
|---|---|
| Bun | 1.4+ |
| Node.js | 20.19+ ou 22.12+ |
| PostgreSQL | 15+ (local ou via Docker Compose) |
| Docker + Compose | Necessário para LocalStack; opcional em desenvolvimento com `QUEUE_BACKEND=memory` |

---

## Quick start

### Opção A — Docker Compose

Sobe PostgreSQL e LocalStack. As filas SQS são criadas automaticamente.

```bash
# 1. Subir a infraestrutura
chmod +x scripts/localstack-init.sh
docker compose up -d

# 2. Confirmar as filas
docker exec jungle_localstack awslocal sqs list-queues

# 3. Criar a configuração local
cp .env.example .env

# Configure, conforme necessário:
# DB_PORT=5433
# QUEUE_BACKEND=aws
# SQS_ENDPOINT=http://localhost:4566

# 4. Instalar dependências e aplicar migrations
bun install
bun run migration:up

# 5. Criar o banco de testes e executar a suíte
bun run db:create-test
bun run test

# 6. Iniciar a aplicação
bun run start:dev
```

Filas esperadas:

- `wager-transactions.fifo`
- `wager-transactions-dlq.fifo`

### Opção B — PostgreSQL local + fila em memória

Opção mais rápida para desenvolvimento. Requer PostgreSQL acessível em `127.0.0.1:5432`.

```bash
# 1. Criar a configuração local
cp .env.example .env

# Defaults esperados:
# DB_PORT=5432
# QUEUE_BACKEND=memory
# OUTBOX_PUBLISHER_BACKEND=console

# 2. Instalar dependências e aplicar migrations
bun install
bun run migration:up

# 3. Criar o banco de testes e executar a suíte
bun run db:create-test
bun run test

# 4. Iniciar a aplicação
bun run start:dev
```

---

## Comandos

| Comando | Descrição |
|---|---|
| `bun install` | Instala as dependências |
| `bun run start:dev` | Inicia o NestJS em modo watch |
| `bun run build` | Compila para `dist/` |
| `bun run start:prod` | Executa `dist/src/main.js` |
| `bun run mikro-orm migration:up` | Aplica as migrations |
| `bun run mikro-orm migration:down` | Desfaz a última migration |
| `bun run mikro-orm migration:create` | Gera uma nova migration |
| `bun run db:create-test` | Cria `wagering_db_test`, se não existir |
| `bun run db:reset-test` | Apaga e recria `wagering_db_test`, depois aplica as migrations |
| `bun run db:reset-all` | Apaga e recria os bancos de desenvolvimento e teste |
| `bun run db:verify` | Verifica invariantes do schema: triggers, `NUMERIC` e constraints únicas |
| `bun run db:reset-outbox` | Redefine `next_attempt_at` das mensagens pendentes |
| `bun run test` | Executa unit, integration e E2E em série, usando o banco de testes |
| `bun run test:unit` | Executa somente os testes unitários (aprox. < 300 ms) |
| `bun run test:integration` | Executa somente os testes de integração (aprox. 10 s, PostgreSQL real) |
| `bun run test:e2e` | Executa somente os testes E2E (aprox. 6 s, HTTP in-memory) |
| `bun run test:watch` | Executa testes unitários em modo watch |
| `./scripts/test-out-of-order.sh` | Executa smoke test manual do cenário 13.7 via HTTP |
| `./scripts/test-queue.sh` | Executa smoke test manual do consumer via HTTP |
| `bun run test:sqs` | Executa os testes de integração com SQS |
| `bun run test:load` | Executa o teste de carga opcional |

> Os tempos são aproximados e dependem do ambiente.

---

## Variáveis de ambiente

Todas as variáveis estão documentadas em [`.env.example`](.env.example).

Principais configurações:

| Variável | Padrão | Descrição |
|---|---|---|
| `DB_HOST` / `DB_PORT` | `127.0.0.1` / `5432` | Endereço do PostgreSQL; o Docker Compose usa a porta `5433` no host |
| `DB_NAME` / `DB_NAME_TEST` | `wagering_db` / `wagering_db_test` | Bancos de desenvolvimento e teste |
| `QUEUE_BACKEND` | `memory` | Backend da fila: `memory` ou `aws` |
| `OUTBOX_PUBLISHER_BACKEND` | `console` | Publicador da outbox: `console` ou `queue` |
| `DEV_QUEUE_ENDPOINT` | `false` | Habilita `/_dev/queue/*`; use somente em desenvolvimento |
| `SQS_QUEUE_URL` / `SQS_DLQ_URL` | — | URLs obrigatórias quando `QUEUE_BACKEND=aws` |

---

## API HTTP

A aplicação fica disponível, por padrão, em `http://localhost:3000`.

### Criar uma wallet

**Requisição**

```http
POST /wallets
Content-Type: application/json
```

```json
{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": {
    "amount": "100.00",
    "currency": "BRL"
  }
}
```

**Resposta — `201 Created`**

```json
{
  "id": "...",
  "playerId": "...",
  "balance": {
    "amount": "100.00",
    "currency": "BRL"
  },
  "version": 1
}
```

### Submeter uma transação

**Requisição**

```http
POST /wagering/transactions
Content-Type: application/json
Idempotency-Key: prov-1:tx-123
```

```json
{
  "providerId": "prov-1",
  "externalTransactionId": "tx-123",
  "playerId": "0192...",
  "walletId": "0192...",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": {
    "amount": "25.00",
    "currency": "BRL"
  }
}
```

### Códigos de resposta

| HTTP | Significado |
|---|---|
| `200` | Transação processada (`PROCESSED`) |
| `202` | Transação pendente (`PENDING_REFERENCE`); a referência ainda não chegou |
| `400` | Payload inválido, `Idempotency-Key` ausente ou UUID inválido |
| `404` | Wallet não encontrada |
| `409` | Conflito de idempotência: mesma chave com payload diferente |
| `422` | Rejeição de regra de negócio, como `INSUFFICIENT_FUNDS` |
| `503` | Erro transitório, passível de retry |

Exemplo de corpo de rejeição:

```json
{
  "status": "REJECTED",
  "failureCode": "INSUFFICIENT_FUNDS"
}
```

### Endpoints de consulta e operação

| Método | Endpoint | Finalidade |
|---|---|---|
| `GET` | `/wallets/:walletId` | Consulta a wallet e seu saldo |
| `GET` | `/wallets/:walletId/ledger?cursor=<opaco>&limit=50` | Consulta paginada do ledger |
| `GET` | `/wagering/transactions/:transactionId` | Consulta por ID da transação |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta pela referência externa do provider |
| `POST` | `/wallets/:walletId/reconciliation` | Executa a reconciliação da wallet |
| `GET` | `/metrics` | Métricas da aplicação |
| `GET` | `/health/live` | Verifica se o processo está vivo |
| `GET` | `/health/ready` | Verifica se a aplicação está pronta |

**Chave de idempotência recomendada:** `"{providerId}:{externalTransactionId}"`.

O `payloadHash` é um SHA-256 do JSON canônico dos campos de negócio, sem headers ou metadados.

Implementação: [`src/domain/services/canonical-json.ts`](src/domain/services/canonical-json.ts).

---

## Processamento assíncrono

### Mensagem de entrada — `wager-transactions.fifo`

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": {
    "providerId": "prov-1",
    "externalTransactionId": "tx-123",
    "idempotencyKey": "prov-1:tx-123",
    "playerId": "...",
    "walletId": "...",
    "roundId": "...",
    "gameId": "...",
    "kind": "BET",
    "money": {
      "amount": "25.00",
      "currency": "BRL"
    }
  }
}
```

O consumer:

- Reutiliza `WageringService.submitTransaction`.
- Deduplica por `(consumerName, messageId)` usando `InboxMessage`.
- Confirma a mensagem (`ack`) somente após o commit.
- Rejeita temporariamente (`nack`) em erros transitórios; encaminha para a DLQ após `maxReceiveCount=5`.
- Executa graceful shutdown por meio de `onApplicationShutdown`.

### Eventos de saída — outbox → fila

O `OutboxPublisherWorker` publica os seguintes eventos:

- `WagerTransactionProcessed`
- `WagerTransactionRejected`
- `WagerTransactionPendingReference`
- `WalletBalanceChanged`

Quando `OUTBOX_PUBLISHER_BACKEND=queue`, os eventos são publicados na fila configurada para `QUEUE_BACKEND` (`memory` ou SQS).

---

## Testes

| Nível | Runner | Tempo aproximado | Quantidade | Cobertura |
|---|---|---|---|---|
| Unit | `bun test` | < 300 ms | **88 testes** | Domínio puro, sem banco de dados |
| Integration | `bun test` | ~10 s | **47 testes** | PostgreSQL real e workers |
| E2E | `bun test` | ~6 s | **27 testes** | HTTP in-memory e fila |
| **Total** | `bun run test` | Varia por ambiente | **162 testes** | Suíte completa |

Execução completa:

```bash
bun run test
```

A suíte documentada contém **162 testes**: 88 unitários, 47 de integração e 27 E2E. Os tempos são aproximados e podem variar conforme o ambiente.

### Isolamento e concorrência

- Os testes usam `NODE_ENV=test` e `DB_NAME_TEST` (`wagering_db_test`); a aplicação em desenvolvimento usa `wagering_db`.
- Os testes de integração e E2E devem ser serializados com `--max-concurrency=1`, pois compartilham o banco e operações `TRUNCATE` podem colidir em paralelo.

### Cenários de concorrência e consistência cobertos

- `NUMERIC(18,2)`: testes de schema.
- Ledger imutável: trigger e testes de `UPDATE`/`DELETE`.
- `PESSIMISTIC_WRITE`: cenários de concorrência, incluindo 50 operações paralelas.
- Idempotência persistente: reinício e 50 requisições com a mesma chave.
- Publicação de evento somente após commit: teste de rollback.
- Multi-instância: três processos simultâneos.
- Ausência de débito duplicado: 50 requisições resultam em um débito; redelivery reproduz o resultado anterior.

### Validação da documentação

O script `scripts/comprehensive-test.sh` valida que as afirmações de `README.md` e `ARCHITECTURE.md` continuam verdadeiras após qualquer mudança.

Ele executa 88+ checagens contra o estado real do código, banco e API — não contra a documentação.

```bash
# Execução padrão (~2 min)
./scripts/comprehensive-test.sh

# Com todos os cenários opcionais (load test + PENDING_REFERENCE) (~5 min)
RUN_LOAD_TEST=1 RUN_PENDING_TEST=1 ./scripts/comprehensive-test.sh
```

O que ele valida:

- **§1–2:** pré-requisitos, `migration:up` e `db:verify`.
- **§3:** invariantes de schema (`NUMERIC(18,2)`, `CHECK`, `UNIQUE`, trigger e índice parcial).
- **§4:** contagem de testes (88/47/27 = **162**).
- **§5–8:** HTTP: health, criação de wallet e todos os status (`200`, `202`, `400`, `404`, `409`, `422`).
- **§9:** idempotência: replay fiel + 20 requisições paralelas = 1 débito.
- **§10:** concorrência: 2 BETs de 80 em saldo 100 → 1 `PROCESSED` + 1 `REJECTED`.
- **§11:** ledger imutável: trigger bloqueia `UPDATE`/`DELETE`.
- **§12:** endpoints GET + `reconciliation`.
- **§13:** 16 métricas Prometheus.
- **§14:** drenagem da outbox.
- **§15:** `PENDING_REFERENCE` (opcional, `RUN_PENDING_TEST=1`).
- **§16:** SQS LocalStack + `maxReceiveCount=5`.
- **§17:** teste de carga (opcional, `RUN_LOAD_TEST=1`).

**Resultado esperado:** `PASS=87+`, `FAIL=0`, `WARN=0`.

---

## Mensageria real (SQS + LocalStack)

### Preparar o ambiente

```bash
# 1. Subir PostgreSQL e LocalStack
docker compose up -d

# 2. Confirmar que as filas foram criadas
docker exec jungle_localstack awslocal sqs list-queues
```

Filas esperadas:

- `wager-transactions.fifo`
- `wager-transactions-dlq.fifo`

### Executar a aplicação com SQS

```bash
QUEUE_BACKEND=aws \
OUTBOX_PUBLISHER_BACKEND=queue \
SQS_ENDPOINT=http://localhost:4566 \
SQS_REGION=us-east-1 \
SQS_QUEUE_URL=http://localhost:4566/000000000000/wager-transactions.fifo \
SQS_DLQ_URL=http://localhost:4566/000000000000/wager-transactions-dlq.fifo \
AWS_ACCESS_KEY_ID=test \
AWS_SECRET_ACCESS_KEY=test \
bun run start:dev
```

### Testar a integração

```bash
bun run test:sqs
```

O teste `sqs-real.integration.spec.ts` é executado quando o LocalStack está disponível e, caso contrário, é ignorado automaticamente.

Ele cobre:

- Criação de fila FIFO e `RedrivePolicy`.
- Fluxo completo de envio, recebimento e confirmação (`send → receive → ack`).
- Deduplicação por `MessageDeduplicationId`.
- Encaminhamento para a DLQ após exceder `maxReceiveCount`.

---

## Teste de carga

O teste de carga é opcional, está **entregue e já foi executado**. A metodologia, os resultados reais e a análise estão descritos na seção 14 de [`ARCHITECTURE.md`](ARCHITECTURE.md).

```bash
# Padrão: 100 concorrentes e 1.000 requisições por cenário
bun run test:load

# Exemplo de configuração personalizada
LOAD_CONCURRENCY=50 LOAD_BURST=500 bun run test:load
```

São avaliados dois cenários:

1. **Contenção:** uma wallet recebe N apostas (`BET`) paralelas de R$ 1; mede a contenção pelo lock.
2. **Throughput:** 100 wallets recebem N apostas paralelas; mede o limite de requisições por segundo (RPS).

O relatório inclui RPS, p50/p95/p99, taxa de erro, `lock_conflicts`, `outbox_pending` e contadores do banco (`PROCESSED` versus `REJECTED`).

O teste falha nas seguintes condições de sanidade:

- Há erros HTTP 5xx.
- Nenhuma transação termina como `PROCESSED`.
- A outbox não é drenada (`outbox_pending > 0`) ao final.

Não há uma meta de RPS predefinida: o objetivo é medir o desempenho em um ambiente controlado.

---

## Decisões de design

Consulte [`ARCHITECTURE.md`](ARCHITECTURE.md) para a justificativa completa.

| Decisão | Motivo |
|---|---|
| `Money` como Value Object imutável, com `Decimal` interno | Precisão exata e isolamento em relação ao ORM |
| Lock pessimista por wallet | Consistência entre múltiplas instâncias sem esgotamento de retries |
| Rejeição de negócio como resultado, não exceção | Rejeição auditável e replay fiel |
| Transactional Outbox com `SKIP LOCKED` | Publicação concorrente por múltiplos workers sem perda de eventos |
| Consumer independente do provider (`memory` + SQS) | Testes sem LocalStack e troca de backend por variável de ambiente |
| Migrations versionadas; `schema:update` proibido | Triggers e índices parciais não são representados integralmente pelo ORM |
| Autenticação no-op via `ProviderIdentityPort` | Autenticação fora do escopo definido para o projeto |
| Bancos separados por ambiente | Testes isolados do banco de desenvolvimento |

---

## Limitações

- **Autenticação:** não implementada por decisão de escopo (spec 2). Ponto de extensão em `src/application/ports/provider-identity.port.ts` + `NoopAuthGuard` (registrado como `APP_GUARD` em `HttpModule`).
- **Traces OpenTelemetry:** não implementados; opcionais por spec 12.
- **Teste de carga:** `bun run test:load` **está entregue** e foi executado. Metodologia, números reais e análise estão em [`ARCHITECTURE.md`](ARCHITECTURE.md), seção 14. Não há meta de RPS — o experimento é reportado com honestidade.
- **Ledger double-entry:** não implementado; ledger é single-entry por wallet (spec 6.4 diz "diferencial opcional").
- **`schema:update` do MikroORM:** não deve ser usado neste projeto. Triggers e índices parciais não são modelados pelo ORM e poderiam ser removidos silenciosamente. Migrations são a única fonte de verdade.
- **Métrica `wager_submit_duration_seconds` p99 no load test:** o parser do histograma Prometheus tem dificuldade com buckets `le="+Inf"`. A métrica funciona em `/metrics`, mas o `test:load` reporta `p99: 0.0ms` (limitação conhecida do parser, não do sistema).

---

## Licença

Projeto desenvolvido para o desafio técnico da Jungle Gaming. **Sem licença de distribuição definida.**
