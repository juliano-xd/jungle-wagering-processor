import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { MikroORM, EntityManager, LockMode } from '@mikro-orm/postgresql';
import config from '../../../mikro-orm.config';
import { OutboxMessage } from '../../../src/domain/entities/outbox-message';
import { InboxMessage } from '../../../src/domain/entities/inbox-message';

/**
 * Teste TDD para o OutboxWorker com FOR UPDATE SKIP LOCKED.
 *
 * O SKIP LOCKED garante que múltiplos workers concorrentes não processem
 * a mesma mensagem duas vezes — cada worker seleciona somente linhas que
 * não estejam bloqueadas por outro worker.
 */
describe('OutboxWorker — FOR UPDATE SKIP LOCKED (TDD)', () => {
  let orm: MikroORM;
  let em: EntityManager;

  const clearDb = async (em: EntityManager) => {
    const conn = em.getConnection();
    await conn.execute('TRUNCATE TABLE "outbox_messages", "idempotency_records", "inbox_messages", "wallet_ledger_entries", "wager_transactions", "wallets" CASCADE;');
    em.clear();
  };

  beforeEach(async () => {
    if (!orm) {
      orm = await MikroORM.init(config);
    }
    em = orm.em.fork();
    await clearDb(em);
  });

  afterAll(async () => {
    if (orm) {
      await orm.close();
    }
  });

  const enqueueMsg = (overrides: Partial<{ eventType: string; aggregateId: string; nextAttemptAt?: Date }> = {}): OutboxMessage => {
    const msg = OutboxMessage.enqueue({
      id: crypto.randomUUID(),
      aggregateId: overrides.aggregateId ?? crypto.randomUUID(),
      eventType: overrides.eventType ?? 'WalletBalanceChanged',
      correlationId: 'corr-test',
      occurredAt: new Date(),
      data: { amount: '50.00' },
    });
    if (overrides.nextAttemptAt !== undefined) {
      msg.nextAttemptAt = overrides.nextAttemptAt;
    }
    return msg;
  };

  it('1. deve selecionar mensagens pendentes com FOR UPDATE SKIP LOCKED', async () => {
    const msgs = [enqueueMsg(), enqueueMsg(), enqueueMsg()];
    for (const m of msgs) {
      em.persist(m);
    }
    await em.flush();

    // Dois workers concorrentes: worker A bloqueia, worker B deve obter SKIP LOCKED sem travar
    const worker1Em = orm.em.fork();
    const worker2Em = orm.em.fork();

    let worker1Messages: OutboxMessage[] = [];
    let worker2Messages: OutboxMessage[] = [];

    // Worker 1 abre transação e bloqueia todas as 3 mensagens
    await worker1Em.transactional(async (tx1) => {
      worker1Messages = await tx1.find(OutboxMessage, {
        publishedAt: null,
      }, {
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE, // FOR UPDATE SKIP LOCKED
        limit: 10,
        orderBy: { occurredAt: 'ASC' },
      });

      // Worker 2 tenta obter mensagens enquanto worker 1 ainda está na transação
      await worker2Em.transactional(async (tx2) => {
        worker2Messages = await tx2.find(OutboxMessage, {
          publishedAt: null,
        }, {
          lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE, // FOR UPDATE SKIP LOCKED
          limit: 10,
          orderBy: { occurredAt: 'ASC' },
        });
      });
      // Worker 2 não deve ter conseguido nenhuma mensagem (todas bloqueadas pelo worker 1)
      expect(worker2Messages.length).toBe(0);
    });

    // Agora que worker 1 commitou, worker1Messages deve ter 3 mensagens
    expect(worker1Messages.length).toBe(3);
  });

  it('2. deve ignorar mensagens com nextAttemptAt no futuro', async () => {
    const msgDue = enqueueMsg({ eventType: 'EventoDue' });
    const msgNotDue = enqueueMsg({ eventType: 'EventoNotDue' });
    msgNotDue.nextAttemptAt = new Date(Date.now() + 60_000); // 1 minuto no futuro

    em.persist(msgDue);
    em.persist(msgNotDue);
    await em.flush();

    const now = new Date();
    await em.transactional(async (tx) => {
      const pending = await tx.find(OutboxMessage, {
        publishedAt: null,
        $or: [
          { nextAttemptAt: null } as any,
          { nextAttemptAt: { $lte: now } as any },
        ],
      }, {
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
        limit: 10,
        orderBy: { occurredAt: 'ASC' },
      });

      // Só a mensagem "due" deve ser selecionada
      expect(pending.length).toBe(1);
      expect(pending[0].eventType).toBe('EventoDue');
    });
  });

  it('3. deve incrementar tentativas e agendar próxima tentativa com backoff em caso de falha', async () => {
    const msg = enqueueMsg();
    em.persist(msg);
    await em.flush();

    const now = new Date();
    const beforeRetry = msg.attempts;

    msg.scheduleRetry(now);

    expect(msg.attempts).toBe(beforeRetry + 1);
    expect(msg.nextAttemptAt).toBeDefined();
    expect(msg.nextAttemptAt!.getTime()).toBeGreaterThan(now.getTime());
    expect(msg.isPending()).toBe(true); // ainda pendente (não marcado como publicado)
  });

  it('4. deve marcar mensagem como publicada atomicamente ao persistir', async () => {
    const msg = enqueueMsg();
    em.persist(msg);
    await em.flush();
    em.clear();

    const forkedEm = orm.em.fork();
    await forkedEm.transactional(async (tx) => {
      const [found] = await tx.find(OutboxMessage, {
        publishedAt: null,
      }, {
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
        limit: 1,
      });

      found.markPublished(new Date());
      // Flush dentro da transação — commit atômico
    });

    // Verificar que foi marcado como publicado
    const reloaded = await orm.em.fork().findOne(OutboxMessage, { id: msg.id });
    expect(reloaded?.publishedAt).toBeDefined();
    expect(reloaded?.isPending()).toBe(false);
  });

  it('5. dois workers paralelos não devem publicar a mesma mensagem duas vezes', async () => {
    const msg = enqueueMsg();
    em.persist(msg);
    await em.flush();

    const published: string[] = [];

    // Simula dois workers concorrentes tentando publicar a mesma mensagem
    const worker = async (workerId: string) => {
      const workerEm = orm.em.fork();
      await workerEm.transactional(async (tx) => {
        const [found] = await tx.find(OutboxMessage, {
          publishedAt: null,
        }, {
          lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
          limit: 1,
        });

        if (!found) return; // SKIP LOCKED: nenhuma linha disponível

        // Simula pequeno delay do publish (e.g. chamada SQS)
        await new Promise((r) => setTimeout(r, 10));

        found.markPublished(new Date());
        published.push(workerId);
        // flush acontece ao sair da transação
      });
    };

    // Ambos os workers rodam "em paralelo"
    await Promise.all([worker('W1'), worker('W2')]);

    // Exatamente um deve ter conseguido a mensagem (o outro via SKIP LOCKED não viu nada)
    expect(published.length).toBe(1);

    // Verificar que foi publicado exatamente uma vez
    const reloaded = await orm.em.fork().findOne(OutboxMessage, { id: msg.id });
    expect(reloaded?.publishedAt).toBeDefined();
  });
});
