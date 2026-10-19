#!/usr/bin/env bash
#
# Cleanup final — remove os 4 suspeitos investigados.
#
# Requisitos antes de rodar:
#   1. ./scripts/verify-imports.sh 4 arquivos abaixo → todos devem ser "ÓRFÃO"
#   2. test/integration/workers/pending-reference-worker.integration.spec.ts
#      já foi reescrito para usar WageringService (não PendingReferenceProcessorService)
#
# Uso:
#   ./scripts/cleanup-final.sh --dry-run
#   ./scripts/cleanup-final.sh

set -euo pipefail
cd "$(dirname "$0")/.."

DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

BACKUP_DIR="_backup-cleanup"
[[ "$DRY" == "1" ]] || mkdir -p "$BACKUP_DIR"

REMOVE=(
  # Presentation layer duplicado (NestJS controllers duplicados; os de verdade
  # moram em `src/infrastructure/http/`)
  "src/presentation/http/health.controller.ts"
  "src/presentation/http/wagering.controller.ts"

  # Auth guard no-op (apenas presentation/wagering.controller.ts importava).
  # Spec 2: "Se você optar por NÃO implementar autenticação, isso é aceito".
  # Removemos para limpar o legado; a decisão fica documentada em
  # ARCHITECTURE.md seção 12.
  "src/infrastructure/auth/provider-identity.guard.ts"

  # Serviço legado substituído por `src/infrastructure/pending-reference/
  # pending-reference.worker.ts`. Após reescrever o teste de integração,
  # ninguém mais importa este.
  "src/infrastructure/workers/pending-reference-processor.service.ts"
)

# Diretórios que ficam vazios após a remoção (removemos também)
EMPTY_DIRS=(
  "src/presentation/http"
  "src/presentation"
  "src/infrastructure/workers"
)

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
      echo "  git rm  $f"
    else
      rm -f -- "$f"
      echo "  rm  $f"
    fi
  fi
}

echo "▶ Removendo suspeitos restantes"
for f in "${REMOVE[@]}"; do remove_file "$f"; done

echo
echo "▶ Removendo diretórios vazios"
for d in "${EMPTY_DIRS[@]}"; do
  if [[ -d "$d" && -z "$(ls -A "$d")" ]]; then
    if [[ "$DRY" == "1" ]]; then
      echo "  rmdir  $d"
    else
      rmdir "$d"
      echo "  rmdir  $d"
    fi
  else
    echo "  SKIP (não existe ou não está vazio): $d"
  fi
done

echo
if [[ "$DRY" == "1" ]]; then
  echo "Dry-run concluído. Rode sem --dry-run para aplicar."
  exit 0
fi

echo "▶ Rodando bun run test para confirmar 136/136..."
if bun run test; then
  echo
  echo "✅ Cleanup final ok. Todos os 136 testes continuam verdes."
  echo "   Próximo: git add -A && git commit -m 'chore: remove presentation layer legado + processor antigo'"
else
  echo
  echo "❌ Testes falharam. Restaure com:"
  echo "   mv _backup-cleanup/<path> <path>"
  exit 1
fi
