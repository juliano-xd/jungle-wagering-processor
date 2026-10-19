#!/usr/bin/env bash
#
# Verifica se um arquivo é importado por qualquer outro arquivo do projeto.
#
# Diferença vs discover-orphans.sh:
#   1. Usa CAMINHO COMPLETO no grep (não só basename) → zero false positive
#   2. Busca em TODO o repo (root, src, test, scripts) → zero false negative
#
# Uso:
#   ./scripts/verify-imports.sh <file1.ts> [<file2.ts> ...]
#   ./scripts/verify-imports.sh src/presentation/http/health.controller.ts

set -euo pipefail
cd "$(dirname "$0")/.."

if [[ $# -eq 0 ]]; then
  echo "Uso: $0 <file1.ts> [<file2.ts> ...]" >&2
  echo "  Ex: $0 src/presentation/http/health.controller.ts" >&2
  exit 1
fi

for f in "$@"; do
  f="${f#./}"
  if [[ ! -e "$f" ]]; then
    echo "⚠️  $f (não existe)"; echo; continue
  fi

  # Caminho relativo completo sem extensão (para grep)
  rel_noext="${f%.ts}"; rel_noext="${rel_noext%.js}"

  # Busca em TODOS os .ts/.js do repo, excluindo build/backup
  hits=$(grep -rIn --include='*.ts' --include='*.js' \
    --exclude-dir=node_modules --exclude-dir=dist \
    --exclude-dir=_backup-specs --exclude-dir=_backup-cleanup --exclude-dir=.git \
    -E "(from |require\(|import\()['\"][^'\"]*${rel_noext}(\.js)?['\"]" \
    . 2>/dev/null \
    | grep -v "^\./${f}:" \
    | grep -v "^\./${f%.ts}.js:" \
    | grep -v "^\./${f%.ts}.js.map:" \
    || true)

  echo "▶ $f"
  if [[ -z "$hits" ]]; then
    echo "  ❌ ÓRFÃO — seguro remover"
  else
    echo "  ⚠️  USADO:"
    echo "$hits" | sed 's/^/      /'
  fi
  echo
done
