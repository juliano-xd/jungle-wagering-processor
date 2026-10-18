#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE_URL:-http://localhost:3000}"
PLAYER_ID=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen | tr A-Z a-z)
RUN_ID="$(date +%s)-$$"

echo "▶ Criando wallet (player=$PLAYER_ID)"
WALLET_ID=$(curl -s -X POST "$BASE/wallets" \
  -H 'Content-Type: application/json' \
  -d "{\"playerId\":\"$PLAYER_ID\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}" \
  | jq -r '.id')
echo "✅ WALLET_ID=$WALLET_ID"

echo
echo "▶ Enfileirando BET de 30.00 via _dev/queue/publish"
curl -s -X POST "$BASE/_dev/queue/publish" \
  -H 'Content-Type: application/json' \
  -d "{
    \"messageId\": \"msg-bet-$RUN_ID\",
    \"type\": \"WagerTransactionRequested\",
    \"occurredAt\": \"$(date -u +%FT%TZ)\",
    \"data\": {
      \"providerId\": \"prov-1\",
      \"externalTransactionId\": \"bet-$RUN_ID\",
      \"idempotencyKey\": \"prov-1:bet-$RUN_ID\",
      \"playerId\": \"$PLAYER_ID\",
      \"walletId\": \"$WALLET_ID\",
      \"roundId\": \"round-$RUN_ID\",
      \"gameId\": \"slot-1\",
      \"kind\": \"BET\",
      \"money\": { \"amount\": \"30.00\", \"currency\": \"BRL\" }
    }
  }" | jq

echo
echo "⏳ Aguardando consumer processar (3s)..."
sleep 3

echo
echo "▶ Saldo após consumer (espera 70.00)"
curl -s "$BASE/wallets/$WALLET_ID" | jq

echo
echo "▶ Reenviando a MESMA mensagem (messageId idêntico) → deve ser replay, sem novo débito"
curl -s -X POST "$BASE/_dev/queue/publish" \
  -H 'Content-Type: application/json' \
  -d "{
    \"messageId\": \"msg-bet-$RUN_ID\",
    \"type\": \"WagerTransactionRequested\",
    \"occurredAt\": \"$(date -u +%FT%TZ)\",
    \"data\": {
      \"providerId\": \"prov-1\",
      \"externalTransactionId\": \"bet-$RUN_ID\",
      \"idempotencyKey\": \"prov-1:bet-$RUN_ID\",
      \"playerId\": \"$PLAYER_ID\",
      \"walletId\": \"$WALLET_ID\",
      \"roundId\": \"round-$RUN_ID\",
      \"gameId\": \"slot-1\",
      \"kind\": \"BET\",
      \"money\": { \"amount\": \"30.00\", \"currency\": \"BRL\" }
    }
  }" | jq

sleep 3
echo
echo "▶ Saldo após replay (deve continuar 70.00)"
curl -s "$BASE/wallets/$WALLET_ID" | jq

echo
echo "▶ Stats da fila in-memory"
curl -s "$BASE/_dev/queue/stats" | jq
