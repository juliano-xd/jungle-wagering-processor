#!/usr/bin/env bash
#
# Criação automática das filas SQS FIFO no LocalStack.
#
# Executado pelo LocalStack automaticamente (mount em /etc/localstack/init/ready.d/).
# Pode também ser rodado manualmente:
#   docker exec jungle_localstack /etc/localstack/init/ready.d/init-queues.sh
#
# Idempotente: reexecutar não falha.

set -euo pipefail

echo "▶ Criando filas SQS..."

# ─── 1. DLQ primeiro (RedrivePolicy da main referencia o ARN dela) ───────────
DLQ_URL=$(awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes '{
    "FifoQueue": "true",
    "ContentBasedDeduplication": "false",
    "MessageRetentionPeriod": "1209600"
  }' \
  --query 'QueueUrl' --output text)

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "$DLQ_URL" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' --output text)

echo "  ✅ DLQ: $DLQ_URL"

# ─── 2. Fila principal (RedrivePolicy aponta para a DLQ) ─────────────────────
awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "{
    \"FifoQueue\": \"true\",
    \"ContentBasedDeduplication\": \"false\",
    \"VisibilityTimeout\": \"30\",
    \"MessageRetentionPeriod\": \"1209600\",
    \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"
  }" > /dev/null

echo "  ✅ Fila principal: wager-transactions.fifo"

echo "▶ Estado final:"
awslocal sqs list-queues
