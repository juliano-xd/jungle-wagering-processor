#!/usr/bin/env bash
#
# Renomeia *.spec.ts dentro de _backup-specs/ para *.spec.ts.bak
# para que o Bun não os trate como testes. Preserva o conteúdo para
# inspeção manual, mas tira do caminho do bun test.
#
# Uso:
#   ./scripts/fix-backup-specs.sh
#
# Idempotente: rodar 2× não faz mal.

set -euo pipefail
cd "$(dirname "$0")/.."

BACKUP_DIR="_backup-specs"

if [[ ! -d "$BACKUP_DIR" ]]; then
  echo "Nada a fazer: $BACKUP_DIR/ não existe."
  exit 0
fi

# Renomeia todos *.spec.ts → *.spec.ts.bak (recursivo, preserva estrutura).
count=0
while IFS= read -r -d '' f; do
  if [[ "$f" != *.bak ]]; then
    mv "$f" "${f}.bak"
    echo "  renomeado: $f → ${f}.bak"
    count=$((count + 1))
  fi
done < <(find "$BACKUP_DIR" -type f -name "*.spec.ts" -print0)

echo
echo "Total renomeados: $count"
echo "Rode 'bun run test:unit' novamente — os arquivos em $BACKUP_DIR/ não serão mais varridos."
