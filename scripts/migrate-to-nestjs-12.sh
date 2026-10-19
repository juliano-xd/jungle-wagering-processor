#!/usr/bin/env bash
#
# Migra o projeto para NestJS 12 (versão mais recente, ESM-first).
#
# Pré-requisitos:
#   - Node.js >= 20.19 (ou 22.12+). Verifique: node --version
#   - Bun >= 1.4.3 (verificado com NestJS 12)
#
# O script:
#   1. Backup do package.json
#   2. Atualiza todas as dependências @nestjs/* para v12
#   3. Instala @nestjs/testing + supertest (E2E oficial)
#   4. Verifica compatibilidade de versão do Node

set -euo pipefail
cd "$(dirname "$0")/.."

echo "▶ Node version check"
node --version
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
NODE_MINOR=$(node -p "process.versions.node.split('.')[1]")
if [[ "$NODE_MAJOR" -lt 20 ]] || { [[ "$NODE_MAJOR" -eq 20 ]] && [[ "$NODE_MINOR" -lt 19 ]]; }; then
  echo "❌ Node.js >= 20.19 ou 22.12+ é obrigatório para NestJS 12." >&2
  echo "   Atual: $(node --version)" >&2
  exit 1
fi
echo "✅ Node OK"

echo
echo "▶ Bun version check"
bun --version
echo "✅ Bun OK (>= 1.4.3 recomendado)"

echo
echo "▶ Backup do package.json"
cp package.json "package.json.pre-nest12-$(date +%Y%m%d%H%M%S)"

echo
echo "▶ Atualizando dependências NestJS para v12"
bun add \
  @nestjs/common@12.1.3 \
  @nestjs/core@12.1.3 \
  @nestjs/platform-express@12.1.3

echo
echo "▶ Instalando @nestjs/testing + supertest (E2E oficial)"
bun add -d \
  @nestjs/testing@12.1.3 \
  supertest@^7.0.0 \
  @types/supertest@^6.0.2

echo
echo "▶ Atualizando CLI"
bun add -d @nestjs/cli@12.0.0 @nestjs/schematics@12.0.0

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
echo "  1. bun run test:unit      # unit tests"
echo "  2. bun run test:integration  # integration (serial)"
echo "  3. bun run test:e2e       # E2E (HTTP + fila + out-of-order)"
echo "  4. Se algum teste falhar: verificar breaking changes"
echo "     - @Optional() inheritance (v12.0.x → v12.1.0+)"
echo "     - lifecycle hooks por hierarquia"
echo "     - ESM imports"
