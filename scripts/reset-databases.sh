#!/usr/bin/env bash
#
# Recria banco de teste e/ou dev do zero, aplicando migrations na ordem correta.
#
# Uso:
#   ./scripts/reset-databases.sh test       # só wagering_db_test
#   ./scripts/reset-databases.sh all        # test + dev (APAGA dados do dev)
#   ./scripts/reset-databases.sh migrate    # roda migrations em ambos

set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-test}"

bun_sql() {
  bun -e "
    const { Client } = await import('pg');
    const c = new Client({
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USER ?? 'postgres',
      password: process.env.DB_PASSWORD ?? 'postgres',
      database: 'postgres',
    });
    await c.connect();
    try {
      $1
    } catch (e) {
      console.error('❌', e.message);
      process.exit(1);
    } finally {
      await c.end();
    }
  "
}

drop_db()  { bun_sql "await c.query('DROP DATABASE IF EXISTS \"$1\" WITH (FORCE)'); console.log('✅ dropado $1');"; }
create_db(){ bun_sql "await c.query('CREATE DATABASE \"$1\"'); console.log('✅ criado $1');"; }

migrate_db() {
  echo
  echo "▶ Migrando $1"
  DB_NAME="$1" bun run mikro-orm migration:up
}

case "$MODE" in
  test)
    drop_db "wagering_db_test"
    create_db "wagering_db_test"
    migrate_db "wagering_db_test"
    ;;
  all)
    drop_db "wagering_db_test"
    create_db "wagering_db_test"
    drop_db "wagering_db"
    create_db "wagering_db"
    migrate_db "wagering_db_test"
    migrate_db "wagering_db"
    ;;
  migrate)
    migrate_db "wagering_db_test"
    migrate_db "wagering_db"
    ;;
  *)
    echo "Uso: $0 [test|all|migrate]" >&2
    exit 1
    ;;
esac

echo
echo "✅ Pronto."
