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

function nextAttemptAt(now: Date, attempts: number): Date {
  const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, attempts));
  // jitter ±25%
  const jitter = delay * (0.5 * (1 - Math.random()));
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