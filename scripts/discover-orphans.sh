#!/usr/bin/env bash
#
# Descobre arquivos candidatos a remoção (não deleta nada).
# Verifica para cada suspeito se algum outro arquivo do src/ o importa.
#
# Uso:
#   ./scripts/discover-orphans.sh
#   ./scripts/discover-orphans.sh > /tmp/orphans.txt   # salva o relatório

set -euo pipefail
cd "$(dirname "$0")/.."

# Lista de suspeitos conhecidos do commit inicial.
SUSPECTS=(
  # Build artifacts
  "mikro-orm.config.js"
  "mikro-orm.config.js.map"
  "mikro-orm.config.d.ts"

  # Logs / accidental
  "start:dev.txt"

  # Refactor artifacts
  "src/application/services/wallet.service.spec.ts.legacy-REMOVED"
  "src/infrastructure/aws/sqs-consumer.integration.spec.ts.legacy-REMOVED"
  "src/infrastructure/database/migrations/*_ledger_immutable.ts"

  # Boilerplate NestJS
  "src/app.controller.ts"
  "src/app.service.ts"

  # Duplicatas estruturais (podem não ser — o grep decide)
  "src/presentation/http/health.controller.ts"
  "src/presentation/http/wagering.controller.ts"
  "src/infrastructure/aws/sqs-consumer.service.ts"
  "src/infrastructure/aws/sqs-publisher.ts"
  "src/infrastructure/aws/adapters/message-publisher.interface.ts"
  "src/infrastructure/aws/adapters/sqs-message-publisher.ts"
  "src/infrastructure/workers/outbox-processor.service.ts"
  "src/infrastructure/workers/pending-reference-processor.service.ts"
  "src/infrastructure/persistence/schemas/inbox-message.schema.ts"
  "src/infrastructure/persistence/schemas/outbox-message.schema.ts"
  "src/infrastructure/database/types/money.type.ts"
  "src/infrastructure/auth/provider-identity.guard.ts"
  "src/domain/errors/wallet.error.ts"

  # Test helpers duplicados
  "test/helpers.db.ts"
  "test/app.e2e-spec.ts"
  "test/load/load-test.ts"

  # Outros
  "db-fresh.ts"
  "smoke.ts"
  "load-test.ts"
)

printf "%-70s %s\n" "ARQUIVO" "USADO POR (import) ?"
printf "%s\n" "$(printf '%.0s─' {1..100})"

for f in "${SUSPECTS[@]}"; do
  # Glob
  for match in $f; do
    [[ -e "$match" ]] || continue

    # Nome base sem extensão, sem prefixo de pasta
    base="$(basename "$match")"
    base_noext="${base%.*}"
    # Remove sufixos comuns que quebram grep (.ts, .js, .legacy-REMOVED)
    base_noext="${base_noext%.legacy-REMOVED}"

    # Procura por "from '.../<base_noext>" ou "from '.../<base_noext>.js'" ou
    # "require('.../<base_noext>')" ou "import('<.../<base_noext>')"
    # Ignorando o próprio arquivo e node_modules.
    hits=$(grep -rIl --exclude-dir=node_modules --exclude-dir=dist \
      --exclude-dir=_backup-specs --exclude-dir=.git \
      -E "from ['\"][^'\"]*/${base_noext}(\.js)?['\"]|require\(['\"][^'\"]*/${base_noext}(\.js)?['\"]\)|import\(['\"][^'\"]*/${base_noext}(\.js)?['\"]\)" \
      src test 2>/dev/null \
      | grep -v "^${match}$" \
      | grep -v "^${match%.legacy-REMOVED}$" \
      || true)

    if [[ -z "$hits" ]]; then
      printf "%-70s %s\n" "$match" "❌ ÓRFÃO (seguro remover)"
    else
      count=$(echo "$hits" | wc -l | tr -d ' ')
      printf "%-70s %s\n" "$match" "⚠️  USADO ($count arquivo[s])"
      echo "$hits" | sed 's/^/      → /'
    fi
  done
done

echo
echo "─────────────────────────────────────────────────────────────────"
echo "Como ler:"
echo "  ❌ ÓRFÃO          → nenhum arquivo importa. Candidato a remoção."
echo "  ⚠️  USADO         → referenciado por outros arquivos. NÃO remover."
echo
echo "⚠️  ATENÇÃO com arquivos de configuração (mikro-orm.config.js, etc.):"
echo "   podem ser usados indiretamente (runtime, package.json, Makefile)."
echo "   Verifique o arquivo antes de remover."
