#!/usr/bin/env bash
#
# Migra o projeto de MikroORM v6 → v7 (native ESM) para compatibilidade com
# NestJS 12 ESM.
#
# Pré-requisitos:
#   - Node.js >= 22.17 (v7 exige)
#   - TypeScript >= 5.8 (v7 exige)
#   - tsconfig.json com "moduleResolution": "nodenext"
#
# O script:
#   1. Verifica versões de Node/TS
#   2. Instala @mikro-orm/* v7 + @swc-node/register
#   3. Remove @mikro-orm/nestjs v6 antigo (evita duplicação)
#   4. Roda typecheck

set -euo pipefail
cd "$(dirname "$0")/.."

echo "▶ Verificando Node.js"
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
NODE_MINOR=$(node -p "process.versions.node.split('.')[1]")
if [[ "$NODE_MAJOR" -lt 22 ]] || { [[ "$NODE_MAJOR" -eq 22 ]] && [[ "$NODE_MINOR" -lt 17 ]]; }; then
  echo "❌ Node.js >= 22.17 é obrigatório para MikroORM v7." >&2
  echo "   Atual: $(node --version)" >&2
  exit 1
fi
echo "✅ Node $(node --version)"

echo
echo "▶ Verificando TypeScript"
TS_VERSION=$(bunx tsc --version | grep -oP '\d+\.\d+')
TS_MAJOR=${TS_VERSION%%.*}
TS_MINOR=${TS_VERSION#*.}
if [[ "$TS_MAJOR" -lt 5 ]] || { [[ "$TS_MAJOR" -eq 5 ]] && [[ "$TS_MINOR" -lt 8 ]]; }; then
  echo "❌ TypeScript >= 5.8 é obrigatório para MikroORM v7." >&2
  echo "   Atual: $TS_VERSION" >&2
  exit 1
fi
echo "✅ TypeScript $TS_VERSION"

echo
echo "▶ Backup do package.json"
cp package.json "package.json.pre-mikro7-$(date +%Y%m%d%H%M%S)"

echo
echo "▶ Removendo @mikro-orm/* v6"
bun remove @mikro-orm/core @mikro-orm/migrations @mikro-orm/nestjs @mikro-orm/postgresql 2>/dev/null || true

echo
echo "▶ Instalando @mikro-orm/* v7"
bun add \
  @mikro-orm/core@^7.0.2 \
  @mikro-orm/migrations@^7.0.2 \
  @mikro-orm/nestjs@^7.0.2 \
  @mikro-orm/postgresql@^7.0.2

echo
echo "▶ Instalando @swc-node/register (loader TS do CLI v7)"
bun add -d @swc-node/register@^1.10.9

echo
echo "▶ Rodando bun install (resolve peer deps)"
bun install

echo
echo "▶ Typecheck"
bunx tsc --noEmit

echo
echo "✅ Migração concluída."
echo
echo "Próximos passos:"
echo "  1. Verificar se mikro-orm.config.ts usa 'defineConfig' (mantido no v7)"
echo "  2. bun run test:unit"
echo "  3. bun run test:integration"
echo "  4. bun run test:e2e"
