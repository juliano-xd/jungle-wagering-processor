#!/usr/bin/env bash
#
# Corrige o CLI do MikroORM v7:
#   1. Instala @mikro-orm/cli como dependência local (breaking change v7)
#   2. Força Bun como runtime (evita Node tentar resolver .ts sem TS loader)
#   3. Ajusta package.json para usar `bun ./node_modules/.bin/mikro-orm`
#
# Uso:
#   ./scripts/fix-mikro-orm-cli.sh

set -euo pipefail
cd "$(dirname "$0")/.."

echo "▶ Instalando @mikro-orm/cli@^7.0.2 como devDependency"
bun add -d @mikro-orm/cli@^7.0.2

echo
echo "▶ Ajustando scripts do package.json"
bun -e '
  const fs = require("node:fs");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));

  // Força Bun como runtime do CLI. `bun ./node_modules/.bin/mikro-orm` invoca o
  // symlink → Bun executa o alvo com runtime Bun → .ts nativo, sem ts-node/tsx.
  pkg.scripts = {
    ...pkg.scripts,
    "mikro-orm": "bun ./node_modules/.bin/mikro-orm",
    "migration:up": "bun run mikro-orm migration:up",
    "migration:down": "bun run mikro-orm migration:down",
    "migration:create": "bun run mikro-orm migration:create",
  };

  fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
  console.log("✅ scripts atualizados");
'

echo
echo "▶ Verificando"
bun run mikro-orm --version
