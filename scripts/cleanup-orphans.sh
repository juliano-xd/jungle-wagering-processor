#!/usr/bin/env bash
#
# Remove órfãos CONFIRMADOS do projeto.
#
# NÃO remove:
#   - src/presentation/http/* — possível false positive; verificar com verify-imports.sh
#   - src/infrastructure/auth/provider-identity.guard.ts — verificar
#   - src/infrastructure/workers/pending-reference-processor.service.ts — em uso pelo teste
#   - src/infrastructure/persistence/schemas/*.schema.ts — usados por mikro-orm.config.ts
#
# Uso:
#   ./scripts/cleanup-orphans.sh --dry-run   # mostra o que faria
#   ./scripts/cleanup-orphans.sh             # aplica

set -euo pipefail
cd "$(dirname "$0")/.."

DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

BACKUP_DIR="_backup-cleanup"
[[ "$DRY" == "1" ]] || mkdir -p "$BACKUP_DIR"

REMOVE=(
  # Build artifacts (gitignore deve impedir que voltem)
  "mikro-orm.config.js"
  "mikro-orm.config.js.map"
  "mikro-orm.config.d.ts"

  # Logs acidentais
  "start:dev.txt"

  # Refactor artifacts
  "src/application/services/wallet.service.spec.ts.legacy-REMOVED"
  "src/infrastructure/aws/sqs-consumer.integration.spec.ts.legacy-REMOVED"

  # NestJS boilerplate — nenhum AppModule atual usa
  "src/app.controller.ts"
  "src/app.service.ts"

  # Substituídos por src/infrastructure/queue/*
  "src/infrastructure/aws/sqs-consumer.service.ts"
  "src/infrastructure/aws/sqs-publisher.ts"
  "src/infrastructure/aws/adapters/sqs-message-publisher.ts"
  "src/infrastructure/aws/adapters/message-publisher.interface.ts"

  # Substituído por src/infrastructure/outbox/outbox-publisher.worker.ts
  "src/infrastructure/workers/outbox-processor.service.ts"

  # Órfãos com basename único (grep não pode errar)
  "src/infrastructure/database/types/money.type.ts"
  "src/domain/errors/wallet.error.ts"
  "test/helpers.db.ts"           # substituído por test/helpers/db.ts (padrão de pasta)
  "test/app.e2e-spec.ts"         # boilerplate Nest
  "test/load/load-test.ts"       # stub nunca implementado
  "db-fresh.ts"
  "smoke.ts"
  "load-test.ts"
)

# O arquivo glob é LITERALMENTE "*_ledger_immutable.ts" (asterisco no nome).
# Vamos ler como string literal via `find`, não via glob do shell.
GLOB_FILE_LITERAL='*_ledger_immutable.ts'

remove_file() {
  local f="$1"
  if [[ ! -e "$f" ]]; then
    echo "  SKIP (não existe): $f"
    return
  fi
  if [[ "$DRY" == "1" ]]; then
    echo "  rm  $f"
  else
    mkdir -p "$BACKUP_DIR/$(dirname "$f")"
    cp -p "$f" "$BACKUP_DIR/$f"
    if git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
      git rm -f -- "$f" >/dev/null
      echo "  git rm  $f  (backup em $BACKUP_DIR/$f)"
    else
      rm -f -- "$f"
      echo "  rm  $f  (backup em $BACKUP_DIR/$f)"
    fi
  fi
}

echo "▶ Removendo órfãos confirmados"
for f in "${REMOVE[@]}"; do
  remove_file "$f"
done

# O literal "*_ledger_immutable.ts" (asterisco no nome do arquivo, não glob)
if [[ -f "src/infrastructure/database/migrations/${GLOB_FILE_LITERAL}" ]]; then
  remove_file "src/infrastructure/database/migrations/${GLOB_FILE_LITERAL}"
fi

echo
echo "▶ Investigar manualmente (NÃO removidos por segurança):"
echo "  src/presentation/http/health.controller.ts"
echo "  src/presentation/http/wagering.controller.ts"
echo "  src/infrastructure/auth/provider-identity.guard.ts"
echo "  src/infrastructure/workers/pending-reference-processor.service.ts"
echo
echo "  → Use: ./scripts/verify-imports.sh <file>"
echo
echo "▶ Não remover (importados por mikro-orm.config.ts):"
echo "  src/infrastructure/persistence/schemas/inbox-message.schema.ts"
echo "  src/infrastructure/persistence/schemas/outbox-message.schema.ts"
echo

if [[ "$DRY" == "0" ]]; then
  echo "▶ Rodando bun run test para confirmar 136/136..."
  if bun run test; then
    echo
    echo "✅ Cleanup ok. Todos os 136 testes continuam verdes."
    echo "   Próximo: git add -A && git commit -m 'chore: remove órfãos confirmados'"
  else
    echo
    echo "❌ Testes falharam após cleanup."
    echo "   Restaure com: git checkout HEAD -- <arquivo>"
    echo "   Ou: mv _backup-cleanup/<path> <path>"
    exit 1
  fi
fi
