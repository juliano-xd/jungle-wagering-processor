#!/usr/bin/env bash
#
# Renomeia as migrations do autor para rodarem DEPOIS do schema base.
#
# Antes (ordem errada):
#   Migration20260101000000_LedgerImmutable          ← janeiro 2026
#   Migration20260101000001_WagerTxProviderExtUnique
#   Migration20260101000002_PendingReferenceRetry
#   Migration20261017000000                          ← schema base
#   Migration20261018000000
#   Migration20261018001000
#
# Depois (ordem correta):
#   Migration20261017000000                          ← schema base
#   Migration20261018000000
#   Migration20261018001000
#   Migration20261018002000_LedgerImmutable          ← renomeadas
#   Migration20261018002001_WagerTxProviderExtUnique
#   Migration20261018002002_PendingReferenceRetry
#
# Uso:
#   ./scripts/fix-migration-order.sh          # aplica
#   ./scripts/fix-migration-order.sh --dry    # só lista

set -euo pipefail
cd "$(dirname "$0")/.."

DRY=0
[[ "${1:-}" == "--dry" ]] && DRY=1

DIR="src/infrastructure/database/migrations"

RENAMES=(
  "Migration20260101000000_LedgerImmutable.ts:Migration20261018002000_LedgerImmutable.ts"
  "Migration20260101000001_WagerTxProviderExtUnique.ts:Migration20261018002001_WagerTxProviderExtUnique.ts"
  "Migration20260101000002_PendingReferenceRetry.ts:Migration20261018002002_PendingReferenceRetry.ts"
)

for pair in "${RENAMES[@]}"; do
  old="$DIR/${pair%%:*}"
  new="$DIR/${pair##*:}"

  if [[ ! -f "$old" ]]; then
    echo "  SKIP (não existe): $old"
    continue
  fi
  if [[ -f "$new" ]]; then
    echo "  SKIP (já renomeado): $new"
    continue
  fi

  if [[ "$DRY" == "1" ]]; then
    echo "  mv  $old → $new"
  else
    if git ls-files --error-unmatch "$old" >/dev/null 2>&1; then
      git mv "$old" "$new"
    else
      mv "$old" "$new"
    fi
    echo "  ✅ $old → $new"
  fi
done

echo
if [[ "$DRY" == "1" ]]; then
  echo "Dry-run concluído."
  exit 0
fi

echo "Próximos passos:"
echo "  1. bun run db:reset-test      # recria wagering_db_test do zero"
echo "  2. bun run test               # aplica migrations na ordem certa"
echo
echo "⚠️  Sobre wagering_db (dev): as migrations antigas JÁ estão registradas"
echo "   com os nomes antigos em mikro_orm_migrations. Renomear NÃO atualiza"
echo "   automaticamente essa tabela. Opções:"
echo "   a) Rodar o bloco 'UPDATE mikro_orm_migrations' abaixo"
echo "   b) Ou: bun run db:reset-all  (recria wagering_db também — PERDE dados)"
