export interface InboxMessageState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}

export interface InboxMessageRow {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
}

/**
 * InboxMessage: deduplicação persistente de mensagens recebidas.
 * A tupla (messageId, consumerName) é única no banco.
 */
export class InboxMessage {
  messageId!: string;
  consumerName!: string;
  payloadHash!: string;
  receivedAt: Date = new Date();
  processedAt?: Date;

  private constructor() {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    const msg = new InboxMessage();
    msg.messageId = props.messageId;
    msg.consumerName = props.consumerName;
    msg.payloadHash = props.payloadHash;
    msg.receivedAt = new Date();
    return msg;
  }

  static rehydrate(state: InboxMessageState | InboxMessageRow): InboxMessage {
    const msg = new InboxMessage();
    msg.messageId = state.messageId;
    msg.consumerName = state.consumerName;
    msg.payloadHash = state.payloadHash;
    msg.receivedAt = state.receivedAt;
    msg.processedAt = state.processedAt;
    return msg;
  }

  isProcessed(): boolean {
    return !!this.processedAt;
  }

  markProcessed(at: Date): void {
    this.processedAt = at;
  }
}
