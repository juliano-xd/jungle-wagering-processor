#!/usr/bin/env bash
#
# E2E do cenário 13.7 (mensagem fora de ordem).
#
# Cada execução gera:
#   - um PLAYER_ID novo (UUID aleatório), a menos que você exporte antes
#   - chaves únicas para rollback e win (sufixadas com RUN_ID)
#   - o ROLLBACK referencia o MESMO externalTransactionId que o WIN vai ter
#
# Motivo do RUN_ID: o serviço REJEITA (409) idempotencyKey reutilizada com
# payload diferente — comportamento correto do edital (seção 9). Keys fixas
# quebrariam na 2ª execução.

set -euo pipefail

BASE="${BASE_URL:-http://localhost:3000}"
RUN_ID="$(date +%s)-$$"

if [[ -z "${PLAYER_ID:-}" ]]; then
  if [[ -r /proc/sys/kernel/random/uuid ]]; then
    PLAYER_ID=$(cat /proc/sys/kernel/random/uuid)
  else
    PLAYER_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
  fi
fi

ROLLBACK_EXT_ID="rollback-${RUN_ID}"
WIN_EXT_ID="win-${RUN_ID}"
# ⚠️ CORREÇÃO: o ROLLBACK aponta para o ID que o WIN **terá** quando chegar.
# Antes, eu criava um `win-ref-${RUN_ID}` separado — o ROLLBACK procurava
# um ID que ninguém nunca criaria, e o worker ficava em pending para sempre.
REF_EXT_ID="$WIN_EXT_ID"

echo "════════════════════════════════════════════════════════════════"
echo "  Cenário 13.7 — ROLLBACK antes da referência"
echo "  PLAYER_ID       = $PLAYER_ID"
echo "  ROLLBACK_EXT_ID = $ROLLBACK_EXT_ID"
echo "  WIN_EXT_ID      = $WIN_EXT_ID"
echo "  REF_EXT_ID      = $REF_EXT_ID  (= WIN_EXT_ID, é o que o ROLLBACK aponta)"
echo "════════════════════════════════════════════════════════════════"

step() { echo; echo "▶ $*"; }
fail() { echo "❌ $*" >&2; exit 1; }
require() { command -v "$1" >/dev/null || fail "comando '$1' não encontrado"; }

require curl
require jq

# ---------------------------------------------------------------------------
step "1/5  Criando wallet (saldo 100.00)"

RESP=$(curl -s -w $'\n%{http_code}' -X POST "$BASE/wallets" \
  -H 'Content-Type: application/json' \
  -d "{\"playerId\":\"$PLAYER_ID\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}")

BODY=$(echo "$RESP" | sed '$d')
CODE=$(echo "$RESP" | tail -n1)
echo "$BODY" | jq

if [[ "$CODE" != "201" ]]; then
  fail "Wallet não criada (HTTP $CODE). Se for 409, exporte PLAYER_ID=<outro uuid>."
fi

WALLET_ID=$(echo "$BODY" | jq -r '.id // empty')
if [[ -z "$WALLET_ID" || "$WALLET_ID" == "null" ]]; then
  fail "Resposta sem .id — algo deu errado antes mesmo do cenário."
fi
echo "✅ WALLET_ID = $WALLET_ID"

# ---------------------------------------------------------------------------
step "2/5  ROLLBACK antes do WIN (espera 202 + PENDING_REFERENCE)"

RESP=$(curl -s -w $'\n%{http_code}' -X POST "$BASE/wagering/transactions" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: prov-1:${ROLLBACK_EXT_ID}" \
  -d "{
    \"providerId\":\"prov-1\",
    \"externalTransactionId\":\"$ROLLBACK_EXT_ID\",
    \"playerId\":\"$PLAYER_ID\",
    \"walletId\":\"$WALLET_ID\",
    \"roundId\":\"round-${RUN_ID}\",
    \"gameId\":\"slot-1\",
    \"kind\":\"ROLLBACK\",
    \"money\":{\"amount\":\"30.00\",\"currency\":\"BRL\"},
    \"referenceExternalTransactionId\":\"$REF_EXT_ID\"
  }")

BODY=$(echo "$RESP" | sed '$d')
CODE=$(echo "$RESP" | tail -n1)
echo "$BODY" | jq

if [[ "$CODE" != "202" ]]; then
  fail "ROLLBACK deveria retornar 202, veio $CODE"
fi
STATUS=$(echo "$BODY" | jq -r '.status')
if [[ "$STATUS" != "PENDING_REFERENCE" ]]; then
  fail "ROLLBACK deveria ter status PENDING_REFERENCE, veio $STATUS"
fi
echo "✅ ROLLBACK em PENDING_REFERENCE (saldo inalterado)"

# ---------------------------------------------------------------------------
step "3/5  Aguardando 8s — worker deve logar outcome:'pending'"

sleep 8
echo "   (verifique os logs do app por {\"event\":\"pending_reference.retry\",\"outcome\":\"pending\"})"

# ---------------------------------------------------------------------------
step "4/5  WIN chega com externalTransactionId=$WIN_EXT_ID (espera 200 + saldo 130.00)"

RESP=$(curl -s -w $'\n%{http_code}' -X POST "$BASE/wagering/transactions" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: prov-1:${WIN_EXT_ID}" \
  -d "{
    \"providerId\":\"prov-1\",
    \"externalTransactionId\":\"$WIN_EXT_ID\",
    \"playerId\":\"$PLAYER_ID\",
    \"walletId\":\"$WALLET_ID\",
    \"roundId\":\"round-${RUN_ID}\",
    \"gameId\":\"slot-1\",
    \"kind\":\"WIN\",
    \"money\":{\"amount\":\"30.00\",\"currency\":\"BRL\"}
  }")

BODY=$(echo "$RESP" | sed '$d')
CODE=$(echo "$RESP" | tail -n1)
echo "$BODY" | jq

if [[ "$CODE" != "200" ]]; then
  fail "WIN deveria retornar 200, veio $CODE"
fi
BAL=$(echo "$BODY" | jq -r '.balance.amount')
if [[ "$BAL" != "130.00" ]]; then
  fail "Saldo após WIN deveria ser 130.00, veio $BAL"
fi
echo "✅ WIN processado, saldo 130.00"

# ---------------------------------------------------------------------------
step "5/5  Aguardando 15s — worker deve resolver o ROLLBACK"

sleep 15

RESP=$(curl -s "$BASE/wallets/$WALLET_ID")
echo "$RESP" | jq
FINAL=$(echo "$RESP" | jq -r '.balance.amount')
FINAL_V=$(echo "$RESP" | jq -r '.version')

if [[ "$FINAL" != "100.00" ]]; then
  fail "Saldo final deveria ser 100.00 (ROLLBACK reverteu WIN), veio $FINAL"
fi
if [[ "$FINAL_V" != "3" ]]; then
  fail "wallet.version deveria ser 3 (opening→v1, win→v2, rollback→v3), veio $FINAL_V"
fi

echo
echo "════════════════════════════════════════════════════════════════"
echo "  ✅ CENÁRIO 13.7 PASSOU"
echo "  Saldo final: $FINAL   |   version: $FINAL_V"
echo "  WALLET_ID: $WALLET_ID"
echo "════════════════════════════════════════════════════════════════"
echo
echo "Ledger:"
curl -s "$BASE/wallets/$WALLET_ID/ledger?limit=10" \
  | jq '.entries[] | {direction, money, balanceBefore, balanceAfter}'
