export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export interface EnqueueOutboxProps {
  id: string;
  aggregateId: string;
  eventType: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: Record<string, unknown>;
}

/** Backoff exponencial com jitter. */
const BASE_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 30_000;
/** Fração de jitter sobre o delay calculado (0.25 = ±25%). */
const JITTER_FRACTION = 0.25;

/**
 * Calcula o próximo `nextAttemptAt` com backoff exponencial e jitter simétrico.
 *
 * Jitter ∈ [-JITTER_FRACTION, +JITTER_FRACTION] × delay (default ±25%).
 * O sinal simétrico evita thundering herd tão bem quanto jitter positivo
 * (Google SRE book / AWS architecture blog), mas mantém a distribuição
 * centrada em `delay` — o delay efetivo nunca desvia mais que ±25%.
 *
 * ⚠️ Nota histórica: a implementação anterior usava
 * `delay * (0.5 * (1 - Math.random()))`, que produzia jitter em `[0, 50%]`
 * (sempre positivo), apesar do comentário dizer "±25%". O teste
 * `backoff limitado a 30s (jitter ±25% incluído)` expôs a discrepância
 * em CI (delay de 41.491ms > 37.500ms esperado). Corrigido para ±25% real.
 */
function nextAttemptAt(now: Date, attempts: number): Date {
  const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, attempts));
  const jitter = delay * JITTER_FRACTION * (2 * Math.random() - 1);
  return new Date(now.getTime() + delay + jitter);
}

/**
 * OutboxMessage: mensagens de integração pendentes de publicação.
 * O worker publica e marca `publishedAt`; falhas incrementam `attempts` e
 * adiam `nextAttemptAt` com backoff exponencial.
 */
export class OutboxMessage {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt: Date = new Date();
  attempts: number = 0;
  nextAttemptAt?: Date;
  publishedAt?: Date;

  private constructor() {}

  static enqueue(props: EnqueueOutboxProps): OutboxMessage {
    const msg = new OutboxMessage();
    msg.id = props.id;
    msg.aggregateId = props.aggregateId;
    msg.eventType = props.eventType;
    msg.payload = {
      eventId: props.id,
      eventType: props.eventType,
      aggregateId: props.aggregateId,
      correlationId: props.correlationId,
      causationId: props.causationId,
      occurredAt: props.occurredAt.toISOString(),
      data: props.data,
    };
    msg.occurredAt = props.occurredAt;
    msg.attempts = 0;
    return msg;
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    const msg = new OutboxMessage();
    msg.id = state.id;
    msg.aggregateId = state.aggregateId;
    msg.eventType = state.eventType;
    msg.payload = state.payload as Record<string, unknown>;
    msg.occurredAt = state.occurredAt;
    msg.attempts = state.attempts;
    msg.nextAttemptAt = state.nextAttemptAt;
    msg.publishedAt = state.publishedAt;
    return msg;
  }

  isPending(): boolean {
    return !this.publishedAt;
  }

  isDue(now: Date): boolean {
    if (!this.isPending()) return false;
    if (!this.nextAttemptAt) return true;
    return now.getTime() >= this.nextAttemptAt.getTime();
  }

  markPublished(at: Date): void {
    this.publishedAt = at;
  }

  scheduleRetry(now: Date): void {
    this.attempts += 1;
    this.nextAttemptAt = nextAttemptAt(now, this.attempts);
  }
}
