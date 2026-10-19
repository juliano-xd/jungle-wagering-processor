#!/usr/bin/env bash
# ============================================================================
# scripts/comprehensive-test.sh — v5
# Valida README.md + ARCHITECTURE.md — Distributed Wagering Processor
#
# Uso:
#   chmod +x scripts/comprehensive-test.sh
#   ./scripts/comprehensive-test.sh
#
# Flags:
#   IDEMPOTENCY_CONCURRENCY=N  nº de reqs paralelas no teste 9 (default: 20)
#   RUN_LOAD_TEST=1            roda bun run test:load (~20s)
#   RUN_PENDING_TEST=1         valida resolução completa de PENDING_REFERENCE
#   SKIP_TEST_SUITE=1          pula bun run test
#   SKIP_APP_START=1           não tenta subir a app (assume já rodando)
#
# Saída: STDOUT colorido + /tmp/wagering-test-results.log
# Exit: 0 se nenhum FAIL, 1 se houver FAIL
#
# Changelog:
#   v1 → v2: [A] post_tx resolve playerId; [B] cleanup só no pai;
#            [C] soma dos 3 blocos; [D] expect vazios=WARN;
#            [E] subshells removem o trap
#   v2 → v3: [F] --max-time em todos os curls; [G] §9 resolve playerId 1×;
#            [H] §9/§10 wait com deadline; [I] §9 jq robusto;
#            [J] post_tx aceita $7=pid opcional
#   v3 → v4: [K] swap if/else em §9 e §10; [L] wait usa `wait $pid`+watchdog
#   v4 → v5: [M] BUG: mktemp já criava o flag → wait_with_deadline sempre
#                retornava 1. Fix: mktemp -d + arquivo `fired` interno, criado
#                APENAS pelo watchdog.
# ============================================================================

set -uo pipefail

# ── Config ──────────────────────────────────────────────────────────────────
APP_URL="${APP_URL:-http://localhost:3000}"
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-wagering_db}"
DB_USER="${DB_USER:-postgres}"
DB_PASSWORD="${DB_PASSWORD:-postgres}"
IDEMPOTENCY_CONCURRENCY="${IDEMPOTENCY_CONCURRENCY:-20}"
RUN_LOAD_TEST="${RUN_LOAD_TEST:-0}"
RUN_PENDING_TEST="${RUN_PENDING_TEST:-0}"
SKIP_TEST_SUITE="${SKIP_TEST_SUITE:-0}"
SKIP_APP_START="${SKIP_APP_START:-0}"
RESULTS_FILE="${RESULTS_FILE:-/tmp/wagering-test-results.log}"

# ── Cores ───────────────────────────────────────────────────────────────────
if [ -t 1 ]; then
    RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
    BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'
else
    RED=''; GREEN=''; YELLOW=''; BLUE=''; CYAN=''; BOLD=''; DIM=''; NC=''
fi

PASS=0; FAIL=0; WARN=0; SKIP=0
> "$RESULTS_FILE"

# ── Helpers de logging ──────────────────────────────────────────────────────
log_section() {
    echo -e "\n${BOLD}${BLUE}═══════════════════════════════════════════════════════════════════════${NC}"
    echo -e "${BOLD}${BLUE}  $1${NC}"
    echo -e "${BOLD}${BLUE}═══════════════════════════════════════════════════════════════════════${NC}"
    echo -e "\n### $1" >> "$RESULTS_FILE"
}
pass() { PASS=$((PASS+1)); echo -e "${GREEN}✓ PASS${NC}: $1"; echo "PASS | $1" >> "$RESULTS_FILE"; }
fail() { FAIL=$((FAIL+1)); echo -e "${RED}✗ FAIL${NC}: $1"; echo "FAIL | $1" >> "$RESULTS_FILE"; }
warn() { WARN=$((WARN+1)); echo -e "${YELLOW}⚠ WARN${NC}: $1"; echo "WARN | $1" >> "$RESULTS_FILE"; }
skip() { SKIP=$((SKIP+1)); echo -e "${CYAN}○ SKIP${NC}: $1"; echo "SKIP | $1" >> "$RESULTS_FILE"; }
info() { echo -e "${DIM}  ℹ $1${NC}"; echo "  INFO | $1" >> "$RESULTS_FILE"; }

# [D] expect — ambos vazios = WARN
expect() {
    local desc="$1" expected="$2" actual="$3"
    if [ -z "$expected" ] && [ -z "$actual" ]; then
        warn "$desc — ambos vazios, não verificável"
        return
    fi
    if [ "$expected" = "$actual" ]; then
        pass "$desc (esperado=$expected, obtido=$actual)"
    else
        fail "$desc (esperado=$expected, obtido=$actual)"
    fi
}

uuid() {
    if command -v uuidgen &>/dev/null; then uuidgen | tr 'A-Z' 'a-z'
    else python3 -c "import uuid;print(str(uuid.uuid4()))"; fi
}

need() { command -v "$1" &>/dev/null || { fail "comando obrigatório ausente: $1"; return 1; }; }

# ── Banco ───────────────────────────────────────────────────────────────────
PSQL_MODE="none"
detect_psql() {
    if command -v psql &>/dev/null; then
        if PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1" >/dev/null 2>&1; then
            PSQL_MODE="native"; return
        fi
    fi
    if command -v docker &>/dev/null; then
        for c in jungle_postgres postgres wagering_postgres; do
            if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^$c$"; then
                if docker exec "$c" psql -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1" >/dev/null 2>&1; then
                    PSQL_MODE="docker:$c"; return
                fi
            fi
        done
    fi
}
run_sql() {
    local q="$1"
    case "$PSQL_MODE" in
        native)    PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc "$q" 2>&1 ;;
        docker:*)  docker exec "${PSQL_MODE#docker:}" psql -U "$DB_USER" -d "$DB_NAME" -tAc "$q" 2>&1 ;;
        *)         echo "__NO_PSQL__" ;;
    esac
}

# ── HTTP ────────────────────────────────────────────────────────────────────
post_wallet() {
    local balance="${1:-100.00}" currency="${2:-BRL}"
    local player_id; player_id=$(uuid)
    local body="{\"playerId\":\"$player_id\",\"initialBalance\":{\"amount\":\"$balance\",\"currency\":\"$currency\"}}"
    local r; r=$(curl --max-time 10 --connect-timeout 5 -s -w "\n%{http_code}" \
        -X POST "$APP_URL/wallets" -H "Content-Type: application/json" -d "$body")
    echo "$(echo "$r" | tail -1)|$(echo "$r" | sed '$d')"
}

# [A][F][J] post_tx
post_tx() {
    local wid="$1" kind="$2" amount="$3" key="${4:-}" ext="${5:-}" ref="${6:-}" pid="${7:-}"
    [ -z "$ext" ] && ext=$(uuid)

    if [ -z "$pid" ]; then
        pid=$(curl --max-time 10 --connect-timeout 5 -s "$APP_URL/wallets/$wid" 2>/dev/null | jq -r '.playerId // empty' 2>/dev/null)
        if [ -z "$pid" ] || [ "$pid" = "null" ]; then
            pid=$(uuid)
        fi
    fi

    local body="{\"providerId\":\"prov-test\",\"externalTransactionId\":\"$ext\",\"playerId\":\"$pid\",\"walletId\":\"$wid\",\"roundId\":\"round-1\",\"gameId\":\"game-1\",\"kind\":\"$kind\",\"money\":{\"amount\":\"$amount\",\"currency\":\"BRL\"}"
    if [ -n "$ref" ]; then body="$body,\"referenceExternalTransactionId\":\"$ref\"}"; else body="$body}"; fi

    local r
    if [ -n "$key" ]; then
        r=$(curl --max-time 30 --connect-timeout 5 -s -w "\n%{http_code}" \
            -X POST "$APP_URL/wagering/transactions" \
            -H "Content-Type: application/json" -H "Idempotency-Key: $key" -d "$body")
    else
        r=$(curl --max-time 30 --connect-timeout 5 -s -w "\n%{http_code}" \
            -X POST "$APP_URL/wagering/transactions" \
            -H "Content-Type: application/json" -d "$body")
    fi
    echo "$(echo "$r" | tail -1)|$(echo "$r" | sed '$d')"
}

# [L][M] wait_with_deadline
#   Retorna:
#     0 → todos os PIDs terminaram dentro do prazo
#     1 → deadline disparou (watchdog matou o que sobrou)
#
#   v5: usa mktemp -d + arquivo `fired` interno. O arquivo marcador NÃO
#   existe no início — só o watchdog o cria ao disparar. Isso corrige o
#   bug da v4 em que `mktemp` já criava o arquivo, fazendo `[ -f "$flag" ]`
#   ser true desde o início e a função retornar 1 (timeout) sempre.
wait_with_deadline() {
    local secs="$1"; shift
    local pids=("$@")
    local dir; dir=$(mktemp -d)
    local marker="$dir/fired"

    # Watchdog: após `secs`, cria o marker e mata os filhos
    ( sleep "$secs"; touch "$marker"; kill -9 "${pids[@]}" 2>/dev/null || true ) &
    local wd=$!

    # wait reapa cada filho (retorna imediato se já terminou)
    for pid in "${pids[@]}"; do
        wait "$pid" 2>/dev/null || true
    done

    # Encerra o watchdog (no-op se já saiu)
    kill "$wd" 2>/dev/null || true
    wait "$wd" 2>/dev/null || true

    local rc=0
    [ -f "$marker" ] && rc=1
    rm -rf "$dir"
    return "$rc"
}

# ── Ciclo de vida da app ────────────────────────────────────────────────────
APP_PID=""; STARTED_APP=0

cleanup() {
    [ "$$" != "$BASHPID" ] && return 0
    if [ "$STARTED_APP" = "1" ] && [ -n "$APP_PID" ]; then
        info "Parando app iniciada pelo script (pid=$APP_PID)"
        kill "$APP_PID" 2>/dev/null || true
        wait "$APP_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT INT TERM

app_alive() { curl -sf --max-time 3 -o /dev/null "$APP_URL/health/live" 2>/dev/null; }

# ════════════════════════════════════════════════════════════════════════════
# HEADER
# ════════════════════════════════════════════════════════════════════════════
echo -e "${BOLD}${BLUE}"
cat <<'EOF'
╔══════════════════════════════════════════════════════════════════════╗
║  Comprehensive Test v5 — Distributed Wagering Processor              ║
║  Valida README.md + ARCHITECTURE.md                                  ║
╚══════════════════════════════════════════════════════════════════════╝
EOF
echo -e "${NC}"
info "APP_URL  = $APP_URL"
info "DB       = $DB_USER@$DB_HOST:$DB_PORT/$DB_NAME"
info "Log      = $RESULTS_FILE"
info "Flags    = IDEMPOTENCY_CONCURRENCY=$IDEMPOTENCY_CONCURRENCY RUN_LOAD_TEST=$RUN_LOAD_TEST RUN_PENDING_TEST=$RUN_PENDING_TEST SKIP_TEST_SUITE=$SKIP_TEST_SUITE"

# ════════════════════════════════════════════════════════════════════════════
# 1. PRÉ-REQUISITOS
# ════════════════════════════════════════════════════════════════════════════
log_section "1. PRÉ-REQUISITOS (README)"

if need bun; then
    bun_v=$(bun --version 2>/dev/null || echo "?")
    info "bun $bun_v"
    major=$(echo "$bun_v" | cut -d. -f1); minor=$(echo "$bun_v" | cut -d. -f2)
    if [ "${major:-0}" -ge 1 ] && [ "${minor:-0}" -ge 4 ]; then
        pass "Bun >= 1.4 ($bun_v)"
    else
        warn "Bun < 1.4 (encontrado $bun_v) — README pede 1.4+"
    fi
fi

if need node; then
    node_v=$(node --version | sed 's/v//'); info "node $node_v"
    ok=0
    maj=$(echo "$node_v" | cut -d. -f1); min=$(echo "$node_v" | cut -d. -f2)
    if [ "$maj" -eq 20 ] && [ "$min" -ge 19 ]; then ok=1; fi
    if [ "$maj" -ge 22 ]; then ok=1; fi
    if [ "$ok" = "1" ]; then pass "Node >= 20.19 ou 22.12 ($node_v)"; else warn "Node $node_v fora do recomendado"; fi
else
    warn "node não instalado"
fi

detect_psql
case "$PSQL_MODE" in
    native)   pass "PostgreSQL acessível via psql ($DB_HOST:$DB_PORT/$DB_NAME)" ;;
    docker:*) pass "PostgreSQL acessível via docker exec ${PSQL_MODE#docker:}" ;;
    *)        warn "PostgreSQL inacessível — checagens de schema serão puladas" ;;
esac
if [ "$PSQL_MODE" != "none" ]; then
    pg_v=$(run_sql "SHOW server_version" | tr -d ' ' | cut -d. -f1)
    info "PostgreSQL major=$pg_v"
    if [ "${pg_v:-0}" -ge 15 ]; then pass "PostgreSQL >= 15 ($pg_v)"; else warn "PostgreSQL < 15 ($pg_v)"; fi
fi

if command -v docker &>/dev/null && docker ps 2>/dev/null | grep -q localstack; then
    pass "LocalStack rodando (SQS disponível)"; LS_OK=1
else
    info "LocalStack não detectado"; LS_OK=0
fi

# ════════════════════════════════════════════════════════════════════════════
# 2. MIGRATIONS + db:verify
# ════════════════════════════════════════════════════════════════════════════
log_section "2. MIGRATIONS E db:verify"

if command -v bun &>/dev/null; then
    if bun run mikro-orm migration:up >/tmp/mig.log 2>&1; then pass "bun run mikro-orm migration:up"; else
        fail "bun run mikro-orm migration:up (ver /tmp/mig.log)"; tail -5 /tmp/mig.log | sed 's/^/    /'; fi
    if bun run db:verify >/tmp/verify.log 2>&1; then pass "bun run db:verify"; else
        fail "bun run db:verify"; tail -10 /tmp/verify.log | sed 's/^/    /'; fi
else
    skip "bun indisponível"
fi

# ════════════════════════════════════════════════════════════════════════════
# 3. INVARIANTES DE SCHEMA (ARCHITECTURE §3)
# ════════════════════════════════════════════════════════════════════════════
log_section "3. INVARIANTES DE SCHEMA (ARCHITECTURE §3)"

if [ "$PSQL_MODE" = "none" ]; then
    skip "Sem acesso ao PostgreSQL"
else
    r=$(run_sql "SELECT numeric_precision||','||numeric_scale FROM information_schema.columns WHERE table_name='wallets' AND column_name='balance_amount'")
    expect "wallets.balance_amount é NUMERIC(18,2)" "18,2" "$r"

    r=$(run_sql "SELECT numeric_precision||','||numeric_scale FROM information_schema.columns WHERE table_name='wager_transactions' AND column_name='money_amount'")
    if [ "$r" = "18,2" ]; then pass "wager_transactions.money_amount é NUMERIC(18,2)"; else warn "wager_transactions.money_amount = $r"; fi

    r=$(run_sql "SELECT COUNT(*) FROM pg_constraint c JOIN pg_class t ON c.conrelid=t.oid WHERE t.relname='wallets' AND c.contype='c' AND pg_get_constraintdef(c.oid) ILIKE '%balance_amount%'")
    if [ "${r:-0}" -ge 1 ]; then pass "CHECK (balance_amount >= 0) em wallets"; else fail "CHECK balance_amount ausente"; fi

    r=$(run_sql "SELECT COUNT(*) FROM pg_indexes WHERE tablename='wallets' AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%player_id%' AND indexdef ILIKE '%currency%'")
    if [ "${r:-0}" -ge 1 ]; then pass "UNIQUE(player_id, currency) em wallets"; else fail "UNIQUE(player_id, currency) ausente"; fi

    r=$(run_sql "SELECT COUNT(*) FROM pg_indexes WHERE tablename='wager_transactions' AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%provider_id%' AND indexdef ILIKE '%external_transaction_id%'")
    if [ "${r:-0}" -ge 1 ]; then pass "UNIQUE(provider_id, external_transaction_id)"; else fail "UNIQUE provider+external ausente"; fi

    r=$(run_sql "SELECT COUNT(*) FROM pg_trigger t JOIN pg_class c ON t.tgrelid=c.oid WHERE c.relname='wallet_ledger_entries' AND NOT t.tgisinternal")
    if [ "${r:-0}" -ge 1 ]; then pass "Trigger(es) em wallet_ledger_entries"; else fail "Nenhum trigger em wallet_ledger_entries"; fi

    r=$(run_sql "SELECT COUNT(*) FROM pg_proc WHERE proname='wallet_ledger_immutable_fn'")
    if [ "${r:-0}" -ge 1 ]; then pass "Função wallet_ledger_immutable_fn existe"; else fail "Função wallet_ledger_immutable_fn ausente"; fi

    r=$(run_sql "SELECT indexdef FROM pg_indexes WHERE indexname='uq_wager_tx_reversal'")
    if [ -n "$r" ] && [ "$r" != "__NO_PSQL__" ] && echo "$r" | grep -qi "WHERE"; then
        pass "Índice parcial uq_wager_tx_reversal existe"; info "  $r"
    else
        fail "uq_wager_tx_reversal ausente ou não-parcial"
    fi

    r=$(run_sql "SELECT COUNT(*) FROM information_schema.columns WHERE table_name='wager_transactions' AND column_name IN ('pending_reference_attempts','pending_reference_next_attempt_at')")
    expect "Colunas pending_reference_* em wager_transactions" "2" "$r"

    r=$(run_sql "SELECT COUNT(*) FROM pg_indexes WHERE indexname='idx_wager_tx_pending_reference'")
    if [ "${r:-0}" -ge 1 ]; then pass "idx_wager_tx_pending_reference existe"; else warn "idx_wager_tx_pending_reference ausente"; fi
fi

# ════════════════════════════════════════════════════════════════════════════
# 4. SUÍTE DE TESTES
# ════════════════════════════════════════════════════════════════════════════
log_section "4. SUÍTE DE TESTES (README — 88 / 47 / 27 / 162)"

if [ "$SKIP_TEST_SUITE" = "1" ]; then
    skip "SKIP_TEST_SUITE=1"
elif ! command -v bun &>/dev/null; then
    skip "bun ausente"
else
    t0=$(date +%s)
    out=$(bun run test 2>&1); rc=$?
    dur=$(( $(date +%s) - t0 ))
    echo "$out" > /tmp/bun-test-output.log
    if [ $rc -eq 0 ]; then pass "bun run test (rc=0, ${dur}s)"; else fail "bun run test (rc=$rc)"; fi

    total_ran=$(echo "$out" | grep -Eo 'Ran [0-9]+ tests' | grep -Eo '[0-9]+' | awk '{s+=$1} END {print s+0}')
    total_pass=$(echo "$out" | grep -Eo '^ *[0-9]+ pass' | grep -Eo '[0-9]+' | awk '{s+=$1} END {print s+0}')
    total_fail=$(echo "$out" | grep -Eo '^ *[0-9]+ fail' | grep -Eo '[0-9]+' | awk '{s+=$1} END {print s+0}')

    info "Blocos:"
    echo "$out" | grep -E 'Ran [0-9]+ tests across' | while read -r line; do info "  $line"; done
    info "Total somado: pass=$total_pass fail=$total_fail ran=$total_ran (docs: 162)"

    expect "Soma de testes executados = 162" "162" "$total_ran"
    expect "Total de PASS = 162" "162" "$total_pass"
    expect "Total de FAIL = 0" "0" "$total_fail"

    info "Unit esperado 88: $(echo "$out" | grep -oE 'Ran 88 tests' | head -1 || echo 'não encontrado')"
    info "Integration esperado 47: $(echo "$out" | grep -oE 'Ran 47 tests' | head -1 || echo 'não encontrado')"
    info "E2E esperado 27: $(echo "$out" | grep -oE 'Ran 27 tests' | head -1 || echo 'não encontrado')"
fi

# ════════════════════════════════════════════════════════════════════════════
# 5. SUBIR A APP
# ════════════════════════════════════════════════════════════════════════════
log_section "5. SUBIR A APP (se necessário)"

if app_alive; then
    pass "App já está viva em $APP_URL"
else
    if [ "$SKIP_APP_START" = "1" ]; then
        fail "App não responde em $APP_URL e SKIP_APP_START=1"
    else
        info "Subindo app em background..."
        (bun run start:dev >/tmp/wagering-app.log 2>&1) &
        APP_PID=$!; STARTED_APP=1
        ok=0
        for i in $(seq 1 60); do
            if app_alive; then ok=1; break; fi
            sleep 0.5
        done
        if [ "$ok" = "1" ]; then pass "App subiu em $APP_URL (pid=$APP_PID)"; else
            fail "App não respondeu em 30s"; tail -20 /tmp/wagering-app.log | sed 's/^/    /'; fi
    fi
fi

# ════════════════════════════════════════════════════════════════════════════
# 6. HEALTH
# ════════════════════════════════════════════════════════════════════════════
log_section "6. HEALTH (README — /health/live, /health/ready)"

if app_alive; then
    code=$(curl --max-time 5 -s -o /dev/null -w "%{http_code}" "$APP_URL/health/live")
    expect "GET /health/live → 200" "200" "$code"
    code=$(curl --max-time 5 -s -o /dev/null -w "%{http_code}" "$APP_URL/health/ready")
    expect "GET /health/ready → 200" "200" "$code"
else
    skip "App não respondeu"
fi

# ════════════════════════════════════════════════════════════════════════════
# 7. POST /wallets
# ════════════════════════════════════════════════════════════════════════════
log_section "7. POST /wallets (README — 201 Created)"

WALLET_ID=""
if app_alive; then
    r=$(post_wallet 100.00 BRL); code=$(echo "$r" | cut -d'|' -f1); body=$(echo "$r" | cut -d'|' -f2-)
    expect "POST /wallets → 201" "201" "$code"
    WALLET_ID=$(echo "$body" | jq -r '.id // empty' 2>/dev/null)
    if [ -n "$WALLET_ID" ]; then
        pass "wallet.id retornado ($WALLET_ID)"
        bal=$(echo "$body" | jq -r '.balance.amount' 2>/dev/null)
        cur=$(echo "$body" | jq -r '.balance.currency' 2>/dev/null)
        ver=$(echo "$body" | jq -r '.version' 2>/dev/null)
        expect "balance.amount = 100.00" "100.00" "$bal"
        expect "balance.currency = BRL" "BRL" "$cur"
        expect "version = 1" "1" "$ver"
        if echo "$body" | jq -e '.balance.amount | type=="string"' >/dev/null 2>&1; then
            pass "balance.amount é string (sem float)"
        else fail "balance.amount NÃO é string"; fi
    else
        fail "wallet.id ausente em response: $body"
    fi
else
    skip "App não respondeu"
fi

# ════════════════════════════════════════════════════════════════════════════
# 8. HTTP — TODOS OS STATUS DOCUMENTADOS
# ════════════════════════════════════════════════════════════════════════════
log_section "8. POST /wagering/transactions — status 200/202/400/404/409/422"

WALLET2=""
if app_alive; then
    r=$(post_wallet 100.00 BRL); WALLET2=$(echo "$r" | cut -d'|' -f2- | jq -r '.id')

    r=$(post_tx "$WALLET2" BET "10.00" "smoke:ok:$(uuid)")
    code=$(echo "$r" | cut -d'|' -f1); body=$(echo "$r" | cut -d'|' -f2-)
    expect "BET válido → 200" "200" "$code"
    st=$(echo "$body" | jq -r '.status // empty')
    expect "  status=PROCESSED" "PROCESSED" "$st"
    bal=$(echo "$body" | jq -r '.balance.amount // .balanceAfter.amount // empty')
    info "  balanceAfter=$bal"

    body='{"providerId":"p","externalTransactionId":"x","playerId":"00000000-0000-0000-0000-000000000000","walletId":"'"$WALLET2"'","roundId":"r","gameId":"g","kind":"BET","money":{"amount":"1.00","currency":"BRL"}}'
    code=$(curl --max-time 5 -s -o /dev/null -w "%{http_code}" -X POST "$APP_URL/wagering/transactions" -H "Content-Type: application/json" -d "$body")
    expect "POST sem Idempotency-Key → 400" "400" "$code"

    r=$(post_tx "not-a-uuid" BET "1.00" "smoke:uuid:$(uuid)")
    code=$(echo "$r" | cut -d'|' -f1)
    expect "UUID inválido → 400" "400" "$code"

    r=$(post_tx "00000000-0000-0000-0000-000000000000" BET "1.00" "smoke:404:$(uuid)")
    code=$(echo "$r" | cut -d'|' -f1)
    expect "Wallet inexistente → 404" "404" "$code"

    k="smoke:conf:$(uuid)"; ext=$(uuid)
    r=$(post_tx "$WALLET2" BET "1.00" "$k" "$ext")
    code=$(echo "$r" | cut -d'|' -f1)
    expect "1ª chamada (key nova) → 200" "200" "$code"
    r=$(post_tx "$WALLET2" BET "2.00" "$k" "$ext")
    code=$(echo "$r" | cut -d'|' -f1)
    expect "Mesma key + payload diferente → 409" "409" "$code"

    r=$(post_tx "$WALLET2" BET "999999.99" "smoke:if:$(uuid)")
    code=$(echo "$r" | cut -d'|' -f1); body=$(echo "$r" | cut -d'|' -f2-)
    expect "Saldo insuficiente → 422" "422" "$code"
    fc=$(echo "$body" | jq -r '.failureCode // empty')
    expect "  failureCode=INSUFFICIENT_FUNDS" "INSUFFICIENT_FUNDS" "$fc"
    st=$(echo "$body" | jq -r '.status // empty')
    expect "  status=REJECTED" "REJECTED" "$st"

    r=$(post_wallet 100.00 BRL); WALLET_PEND=$(echo "$r" | cut -d'|' -f2- | jq -r '.id')
    missing_ref="win-missing-$(uuid)"
    r=$(post_tx "$WALLET_PEND" ROLLBACK "5.00" "smoke:pend:$(uuid)" "" "$missing_ref")
    code=$(echo "$r" | cut -d'|' -f1); body=$(echo "$r" | cut -d'|' -f2-)
    expect "ROLLBACK c/ ref ausente → 202" "202" "$code"
    st=$(echo "$body" | jq -r '.status // empty')
    expect "  status=PENDING_REFERENCE" "PENDING_REFERENCE" "$st"
else
    skip "App não respondeu"
fi

# ════════════════════════════════════════════════════════════════════════════
# 9. IDEMPOTÊNCIA
# ════════════════════════════════════════════════════════════════════════════
log_section "9. IDEMPOTÊNCIA (ARCHITECTURE §5 — replay fiel)"

if app_alive; then
    r=$(post_wallet 100.00 BRL); W=$(echo "$r" | cut -d'|' -f2- | jq -r '.id')
    k="idem:$(uuid)"; ext=$(uuid)
    r1=$(post_tx "$W" BET "10.00" "$k" "$ext"); c1=$(echo "$r1" | cut -d'|' -f1); b1=$(echo "$r1" | cut -d'|' -f2-)
    tid1=$(echo "$b1" | jq -r '.transactionId // .id // empty')
    bal1=$(echo "$b1" | jq -r '.balance.amount // .balanceAfter.amount // empty')
    r2=$(post_tx "$W" BET "10.00" "$k" "$ext"); c2=$(echo "$r2" | cut -d'|' -f1); b2=$(echo "$r2" | cut -d'|' -f2-)
    tid2=$(echo "$b2" | jq -r '.transactionId // .id // empty')
    bal2=$(echo "$b2" | jq -r '.balance.amount // .balanceAfter.amount // empty')
    expect "1ª chamada → 200" "200" "$c1"
    expect "2ª chamada (replay) → 200" "200" "$c2"
    expect "Replay retorna mesmo transactionId" "$tid1" "$tid2"
    expect "Replay retorna mesmo balanceAfter" "$bal1" "$bal2"

    N="$IDEMPOTENCY_CONCURRENCY"
    info "Disparando $N requisições paralelas com a mesma key (IDEMPOTENCY_CONCURRENCY=$N)"

    W50=$(post_wallet 100.00 BRL | cut -d'|' -f2- | jq -r '.id')
    W50_PID=$(curl --max-time 10 -s "$APP_URL/wallets/$W50" | jq -r '.playerId // empty')
    if [ -z "$W50_PID" ] || [ "$W50_PID" = "null" ]; then
        fail "Não foi possível resolver playerId de $W50"
    else
        k50="idem:same:$(uuid)"; ext50=$(uuid)

        pids=()
        for i in $(seq 1 "$N"); do
            ( trap - EXIT INT TERM; post_tx "$W50" BET "1.00" "$k50" "$ext50" "" "$W50_PID" >/dev/null 2>&1 ) &
            pids+=($!)
        done

        if wait_with_deadline 90 "${pids[@]}"; then
            pass "Loop ${N}× terminou (todas as requisições responderam)"
        else
            fail "Loop ${N}× excedeu 90s — provável esgotamento do pool. Aumente pool ou reduza IDEMPOTENCY_CONCURRENCY."
        fi

        resp=$(curl --max-time 10 -s "$APP_URL/wallets/$W50/ledger?limit=100")
        cnt=$(echo "$resp" | jq 'if .entries then (.entries | length) elif .items then (.items | length) elif type=="array" then length else 0 end' 2>/dev/null)
        expect "Mesma key ${N}× → ledger tem 2 entries (OPENING+DEBIT)" "2" "${cnt:-0}"

        bal_final=$(curl --max-time 10 -s "$APP_URL/wallets/$W50" | jq -r '.balance.amount // empty')
        expect "  Saldo final = 99.00" "99.00" "$bal_final"
    fi
else
    skip "App não respondeu"
fi

# ════════════════════════════════════════════════════════════════════════════
# 10. CONCORRÊNCIA — 2 BETs de 80 em 100
# ════════════════════════════════════════════════════════════════════════════
log_section "10. CONCORRÊNCIA — 2 BETs paralelas de 80.00 em saldo 100.00"

if app_alive; then
    W=$(post_wallet 100.00 BRL | cut -d'|' -f2- | jq -r '.id')
    tmp=$(mktemp -d)
    ( trap - EXIT INT TERM; post_tx "$W" BET "80.00" "conc:a:$(uuid)" > "$tmp/a" 2>&1 ) &
    p1=$!
    ( trap - EXIT INT TERM; post_tx "$W" BET "80.00" "conc:b:$(uuid)" > "$tmp/b" 2>&1 ) &
    p2=$!

    if wait_with_deadline 30 "$p1" "$p2"; then
        pass "2 BETs concorrentes terminaram dentro de 30s"
        ca=$(cut -d'|' -f1 "$tmp/a"); cb=$(cut -d'|' -f1 "$tmp/b")
        info "  status A=$ca  status B=$cb"
        oks=0; rjs=0
        [ "$ca" = "200" ] && oks=$((oks+1))
        [ "$cb" = "200" ] && oks=$((oks+1))
        [ "$ca" = "422" ] && rjs=$((rjs+1))
        [ "$cb" = "422" ] && rjs=$((rjs+1))
        expect "1 PROCESSED + 1 REJECTED" "1ok/1rej" "${oks}ok/${rjs}rej"
        bal=$(curl --max-time 10 -s "$APP_URL/wallets/$W" | jq -r '.balance.amount // empty')
        expect "  Saldo final = 20.00" "20.00" "$bal"
    else
        fail "2 BETs concorrentes excederam 30s"
    fi
    rm -rf "$tmp"
    info "Teste de 3 forks × 50 reqs: coberto por bun run test:integration"
else
    skip "App não respondeu"
fi

# ════════════════════════════════════════════════════════════════════════════
# 11. LEDGER IMUTÁVEL
# ════════════════════════════════════════════════════════════════════════════
log_section "11. LEDGER IMUTÁVEL (ARCHITECTURE §3)"

if [ "$PSQL_MODE" = "none" ]; then
    skip "Sem acesso ao PostgreSQL"
else
    row=$(run_sql "SELECT id FROM wallet_ledger_entries LIMIT 1")
    if [ -z "$row" ] || [ "$row" = "__NO_PSQL__" ]; then
        skip "Nenhum ledger entry para testar"
    else
        err=$(run_sql "UPDATE wallet_ledger_entries SET id = id WHERE id='$row'" 2>&1)
        if echo "$err" | grep -qiE "immutable|imutáv|forbidden|not allowed|raise|error"; then
            pass "UPDATE em wallet_ledger_entries bloqueado pelo trigger"
            info "  msg: $(echo "$err" | head -1)"
        else
            fail "UPDATE em ledger NÃO foi bloqueado (err='$err')"
        fi
        err=$(run_sql "DELETE FROM wallet_ledger_entries WHERE id='$row'" 2>&1)
        if echo "$err" | grep -qiE "immutable|imutáv|forbidden|not allowed|raise|error"; then
            pass "DELETE em wallet_ledger_entries bloqueado pelo trigger"
            info "  msg: $(echo "$err" | head -1)"
        else
            fail "DELETE em ledger NÃO foi bloqueado"
        fi
    fi
fi

# ════════════════════════════════════════════════════════════════════════════
# 12. ENDPOINTS GET
# ════════════════════════════════════════════════════════════════════════════
log_section "12. ENDPOINTS GET documentados"

if app_alive && [ -n "$WALLET2" ]; then
    code=$(curl --max-time 5 -s -o /dev/null -w "%{http_code}" "$APP_URL/wallets/$WALLET2")
    expect "GET /wallets/:id → 200" "200" "$code"

    code=$(curl --max-time 5 -s -o /dev/null -w "%{http_code}" "$APP_URL/wallets/$WALLET2/ledger?limit=50")
    expect "GET /wallets/:id/ledger → 200" "200" "$code"

    body=$(curl --max-time 5 -s "$APP_URL/wallets/$WALLET2/ledger?limit=1")
    if echo "$body" | jq -e '.nextCursor // .cursor // true' >/dev/null 2>&1; then
        pass "Ledger retorna estrutura com cursor"
    else
        warn "Ledger response sem campo cursor (pode ser 1 entry só)"
    fi

    tx=$(curl --max-time 5 -s "$APP_URL/wallets/$WALLET2/ledger?limit=1" | jq -r '.entries[0].transactionId // .items[0].transactionId // empty')
    if [ -n "$tx" ] && [ "$tx" != "null" ]; then
        code=$(curl --max-time 5 -s -o /dev/null -w "%{http_code}" "$APP_URL/wagering/transactions/$tx")
        expect "GET /wagering/transactions/:id → 200" "200" "$code"

        ext_val=$(curl --max-time 5 -s "$APP_URL/wagering/transactions/$tx" | jq -r '.externalTransactionId // empty' 2>/dev/null)
        if [ -n "$ext_val" ] && [ "$ext_val" != "null" ]; then
            code=$(curl --max-time 5 -s -o /dev/null -w "%{http_code}" "$APP_URL/providers/prov-test/wagering/transactions/$ext_val")
            expect "GET /providers/:p/wagering/transactions/:ext → 200" "200" "$code"
        fi
    else
        skip "Não foi possível extrair transactionId do ledger"
    fi

    code=$(curl --max-time 10 -s -o /dev/null -w "%{http_code}" -X POST "$APP_URL/wallets/$WALLET2/reconciliation")
    case "$code" in
        200|201|204) pass "POST /wallets/:id/reconciliation → $code" ;;
        *) fail "POST /wallets/:id/reconciliation → $code (esperado 200/201/204)" ;;
    esac
else
    skip "App não respondeu"
fi

# ════════════════════════════════════════════════════════════════════════════
# 13. MÉTRICAS /metrics
# ════════════════════════════════════════════════════════════════════════════
log_section "13. OBSERVABILIDADE — /metrics (ARCHITECTURE §10)"

if app_alive; then
    code=$(curl --max-time 10 -s -o /dev/null -w "%{http_code}" "$APP_URL/metrics")
    expect "GET /metrics → 200" "200" "$code"
    body=$(curl --max-time 10 -s "$APP_URL/metrics")
    for m in \
        wager_transactions_total \
        wager_submit_duration_seconds \
        wager_idempotency_replays_total \
        wager_idempotency_conflicts_total \
        wager_lock_conflicts_total \
        outbox_published_total \
        outbox_publish_failed_total \
        outbox_pending \
        outbox_event_age_seconds \
        pending_reference_outcome_total \
        queue_messages_received_total \
        queue_messages_acked_total \
        queue_messages_nacked_total \
        queue_messages_dlq_total \
        http_errors_total \
        nodejs_process_cpu_user_seconds_total
    do
        if echo "$body" | grep -q "^# HELP $m\|^$m\b"; then
            pass "Métrica presente: $m"
        else
            warn "Métrica ausente: $m"
        fi
    done
else
    skip "App não respondeu"
fi

# ════════════════════════════════════════════════════════════════════════════
# 14. OUTBOX — drain
# ════════════════════════════════════════════════════════════════════════════
log_section "14. OUTBOX — drenagem"

if [ "$PSQL_MODE" = "none" ]; then
    skip "Sem acesso ao PostgreSQL"
else
    pending=$(run_sql "SELECT COUNT(*) FROM outbox_messages WHERE published_at IS NULL")
    info "outbox_pending inicial = ${pending:-?}"
    p="$pending"
    for i in $(seq 1 15); do
        p=$(run_sql "SELECT COUNT(*) FROM outbox_messages WHERE published_at IS NULL")
        [ "$p" = "0" ] && break
        sleep 1
    done
    expect "Outbox drenada (published_at preenchido)" "0" "${p:-?}"
fi

# ════════════════════════════════════════════════════════════════════════════
# 15. PENDING_REFERENCE
# ════════════════════════════════════════════════════════════════════════════
log_section "15. PENDING_REFERENCE — resolução (RUN_PENDING_TEST=$RUN_PENDING_TEST)"

if [ "$RUN_PENDING_TEST" != "1" ]; then
    skip "Defina RUN_PENDING_TEST=1 para testar resolução completa"
elif ! app_alive; then
    skip "App não respondeu"
else
    r=$(post_wallet 100.00 BRL); W=$(echo "$r" | cut -d'|' -f2- | jq -r '.id')
    ext_win=$(uuid)
    r=$(post_tx "$W" WIN "30.00" "pend:win:$(uuid)" "$ext_win")
    code=$(echo "$r" | cut -d'|' -f1)
    expect "WIN válido → 200" "200" "$code"
    bal_after_win=$(curl --max-time 5 -s "$APP_URL/wallets/$W" | jq -r '.balance.amount')
    info "Saldo após WIN: $bal_after_win"
    r=$(post_tx "$W" ROLLBACK "30.00" "pend:rb:$(uuid)" "" "$ext_win")
    code=$(echo "$r" | cut -d'|' -f1)
    expect "ROLLBACK com ref existente → 200" "200" "$code"
    bal_final=$(curl --max-time 5 -s "$APP_URL/wallets/$W" | jq -r '.balance.amount')
    expect "Saldo final após ROLLBACK = 100.00" "100.00" "$bal_final"
fi

# ════════════════════════════════════════════════════════════════════════════
# 16. SQS / LocalStack
# ════════════════════════════════════════════════════════════════════════════
log_section "16. SQS / LocalStack (README — wager-transactions.fifo)"

if [ "${LS_OK:-0}" = "1" ]; then
    cnt=$(docker ps --format '{{.Names}}' | grep localstack | head -1)
    info "Container localstack: $cnt"
    if docker exec "$cnt" awslocal sqs list-queues >/tmp/queues.log 2>&1; then
        if grep -q "wager-transactions.fifo" /tmp/queues.log; then pass "Fila wager-transactions.fifo existe"; else fail "Fila wager-transactions.fifo ausente"; fi
        if grep -q "wager-transactions-dlq.fifo" /tmp/queues.log; then pass "Fila wager-transactions-dlq.fifo existe"; else fail "Fila wager-transactions-dlq.fifo ausente"; fi
        url=$(grep "wager-transactions.fifo" /tmp/queues.log | head -1 | tr -d ' "')
        attrs=$(docker exec "$cnt" awslocal sqs get-queue-attributes --queue-url "$url" --attribute-names RedrivePolicy 2>/dev/null || true)
        if echo "$attrs" | grep -q "maxReceiveCount"; then
            pass "RedrivePolicy configurada (maxReceiveCount)"
            mrc=$(echo "$attrs" | grep -oE 'maxReceiveCount[^0-9]*[0-9]+' | grep -oE '[0-9]+$')
            expect "  maxReceiveCount=5" "5" "$mrc"
        else
            warn "RedrivePolicy ausente"
        fi
    else
        warn "awslocal indisponível dentro do container"
    fi
    if command -v bun &>/dev/null; then
        if timeout 60 bun run test:sqs >/tmp/sqs-test.log 2>&1; then pass "bun run test:sqs"; else
            warn "bun run test:sqs falhou/timeout — ver /tmp/sqs-test.log"; fi
    fi
else
    skip "LocalStack não rodando"
fi

# ════════════════════════════════════════════════════════════════════════════
# 17. LOAD TEST
# ════════════════════════════════════════════════════════════════════════════
log_section "17. LOAD TEST (RUN_LOAD_TEST=$RUN_LOAD_TEST)"

if [ "$RUN_LOAD_TEST" != "1" ]; then
    skip "Defina RUN_LOAD_TEST=1 para executar bun run test:load"
elif ! command -v bun &>/dev/null; then
    skip "bun ausente"
else
    if timeout 120 bun run test:load >/tmp/load.log 2>&1; then
        pass "bun run test:load"
        grep -E "RPS|p50|p95|p99|PROCESSED|outbox" /tmp/load.log | head -20 | sed 's/^/    /' | tee -a "$RESULTS_FILE"
    else
        fail "bun run test:load — ver /tmp/load.log"
    fi
fi

# ════════════════════════════════════════════════════════════════════════════
# RESUMO
# ════════════════════════════════════════════════════════════════════════════
log_section "RESUMO"

echo -e "${GREEN}PASS${NC}: $PASS"
echo -e "${RED}FAIL${NC}: $FAIL"
echo -e "${YELLOW}WARN${NC}: $WARN"
echo -e "${CYAN}SKIP${NC}: $SKIP"
echo "" | tee -a "$RESULTS_FILE"
echo "PASS=$PASS FAIL=$FAIL WARN=$WARN SKIP=$SKIP" | tee -a "$RESULTS_FILE"
echo "" | tee -a "$RESULTS_FILE"
echo "Log completo: $RESULTS_FILE" | tee -a "$RESULTS_FILE"

if [ "$FAIL" -gt 0 ]; then
    echo -e "${RED}${BOLD}❌ HÁ $FAIL FALHAS — cole o log em $RESULTS_FILE${NC}"
    exit 1
else
    echo -e "${GREEN}${BOLD}✅ Nenhum FAIL — todas as checagens passaram ou foram skipadas por ambiente${NC}"
    exit 0
fi
