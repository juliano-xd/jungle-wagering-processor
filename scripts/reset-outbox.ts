/**
 * Reset das mensagens travadas na outbox.
 *
 * Uso:   bun run scripts/reset-outbox.ts
 *
 * Zera `attempts` e `next_attempt_at` de todas as mensagens não publicadas,
 * para que o worker tente novamente imediatamente. Útil quando um bug (ex.:
 * `occurred_at` como string) já foi corrigido e as mensagens ficaram em
 * backoff exponencial acumulado.
 */
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../mikro-orm.config.js';

async function main() {
  const orm = await MikroORM.init(config);
  const conn = orm.em.getConnection();

  const before = await conn.execute<Array<{ count: string }>>(
    `SELECT count(*)::text AS count FROM outbox_messages WHERE published_at IS NULL`,
  );
  console.log(
    `[reset-outbox] Mensagens pendentes antes: ${before[0]?.count ?? '0'}`,
  );

  await conn.execute(
    `UPDATE outbox_messages
        SET attempts = 0,
            next_attempt_at = NULL
      WHERE published_at IS NULL`,
  );

  const after = await conn.execute<Array<{ count: string }>>(
    `SELECT count(*)::text AS count FROM outbox_messages WHERE published_at IS NULL`,
  );
  console.log(
    `[reset-outbox] Mensagens pendentes após reset: ${after[0]?.count ?? '0'}`,
  );
  console.log(
    '[reset-outbox] O worker vai drenar no próximo tick (≤1s).',
  );

  await orm.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
