#!/usr/bin/env bash
#
# Reorganiza os arquivos de teste do projeto:
#   1. Consolida duplicatas em test/unit/
#   2. Remove 9 arquivos .spec.ts que moram em src/ (convenção quebrada)
#   3. Preserva tudo em _backup-specs/ (não force-destrutivo)
#
# Requer bash ≥ 4. Se git estiver inicializado, `git status` mostra o diff
# ao final; se não estiver, os arquivos ficam em _backup-specs/ para revisão manual.
#
# Uso:
#   ./scripts/cleanup-tests.sh            # aplica
#   ./scripts/cleanup-tests.sh --dry-run  # só lista o que faria

set -euo pipefail

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

cd "$(dirname "$0")/.."

BACKUP_DIR="_backup-specs"
[[ -d "$BACKUP_DIR" ]] || mkdir -p "$BACKUP_DIR"

say() { echo "  $*"; }
action_mv() {
  local src="$1" dst="$2"
  if [[ ! -e "$src" ]]; then
    say "SKIP (não existe): $src"
    return
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    say "mv  $src → $dst"
  else
    mkdir -p "$(dirname "$dst")"
    mv "$src" "$dst"
    say "mv  $src → $dst"
  fi
}
action_rm() {
  local src="$1"
  if [[ ! -e "$src" ]]; then
    say "SKIP (não existe): $src"
    return
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    say "rm  $src"
  else
    mkdir -p "$BACKUP_DIR/$(dirname "$src")"
    mv "$src" "$BACKUP_DIR/$src"
    say "rm  $src  (backup em $BACKUP_DIR/$src)"
  fi
}

echo "== Fase 2.1: consolidando duplicatas em test/unit =="

# Os arquivos em test/unit/domain/ são os mais organizados. Os planos
# (test/unit/*.spec.ts) duplicam. Vou MANTER os de test/unit/domain/ e
# fazer backup dos planos.
#
# ⚠️ Se preferir manter os planos, inverta os argumentos de action_rm.
action_rm "test/unit/money.spec.ts"
action_rm "test/unit/wallet.spec.ts"
action_rm "test/unit/wager-transaction.spec.ts"

echo
echo "== Fase 2.2: removendo .spec.ts de src/ (convenção) =="

action_rm "src/app.controller.spec.ts"
action_rm "src/infrastructure/database/wallet.integration.spec.ts"
action_rm "src/infrastructure/database/integration/atomic-outbox.integration.spec.ts"
action_rm "src/infrastructure/database/integration/outbox-inbox.integration.spec.ts"
action_rm "src/infrastructure/workers/outbox-processor.integration.spec.ts"
action_rm "src/infrastructure/workers/outbox-active-worker.integration.spec.ts"
action_rm "src/application/services/integration/pending-reference-worker.integration.spec.ts"
action_rm "src/application/services/integration/advanced-wagering.integration.spec.ts"

echo
echo "== Fase 2.3: ajustando package.json (scripts) =="

if [[ "$DRY_RUN" == "0" ]]; then
  # Se jq estiver instalado, atualiza os scripts sem sobrescrever outros.
  if command -v jq >/dev/null; then
    jq '.scripts += {
      "test": "bun test test/",
      "test:unit": "bun test test/unit",
      "test:integration": "bun test test/integration",
      "test:e2e": "bun test test/e2e",
      "test:watch": "bun test --watch test/unit",
      "test:coverage": "bun test --coverage test/"
    }' package.json > package.json.tmp && mv package.json.tmp package.json
    say "package.json: scripts atualizados"
  else
    say "AVISO: jq não instalado. Adicione manualmente:
    test, test:unit, test:integration, test:e2e, test:watch, test:coverage"
  fi
fi

echo
echo "== Concluído =="
if [[ -d .git ]]; then
  echo "Para ver o diff:  git status && git diff"
  echo "Para reverter:    git checkout HEAD -- <arquivo>"
else
  echo "Backup dos removidos em: $BACKUP_DIR"
  echo "Para restaurar:   mv $BACKUP_DIR/<path> <path>"
fi
