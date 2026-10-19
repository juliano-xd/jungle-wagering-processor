import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import {
  SQSClient,
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import { AwsSqsQueueAdapter } from '../../../src/infrastructure/queue/aws-sqs-queue.adapter.js';

const ENDPOINT = process.env.SQS_ENDPOINT ?? 'http://localhost:4566';
const REGION = process.env.SQS_REGION ?? 'us-east-1';
const CREDS = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
};

async function isLocalStackReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${ENDPOINT}/_localstack/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { services?: { sqs?: string } };
    const sqs = body?.services?.sqs;
    return sqs === 'running' || sqs === 'available';
  } catch {
    return false;
  }
}

const localstackOk = await isLocalStackReachable();

describe.skipIf(!localstackOk)('SQS real — LocalStack', () => {
  const runId = Date.now();
  const queueName = `wager-transactions-test-${runId}.fifo`;
  const dlqName = `wager-transactions-dlq-test-${runId}.fifo`;

  let client: SQSClient;
  let queueUrl: string;
  let dlqUrl: string;

  beforeAll(async () => {
    client = new SQSClient({
      endpoint: ENDPOINT,
      region: REGION,
      credentials: CREDS,
    });

    const dlq = await client.send(
      new CreateQueueCommand({
        QueueName: dlqName,
        Attributes: {
          FifoQueue: 'true',
          ContentBasedDeduplication: 'false',
          MessageRetentionPeriod: '3600',
        },
      }),
    );
    dlqUrl = dlq.QueueUrl!;

    const dlqArn = (
      await client.send(
        new GetQueueAttributesCommand({
          QueueUrl: dlqUrl,
          AttributeNames: ['QueueArn'],
        }),
      )
    ).Attributes?.QueueArn;

    const main = await client.send(
      new CreateQueueCommand({
        QueueName: queueName,
        Attributes: {
          FifoQueue: 'true',
          ContentBasedDeduplication: 'false',
          VisibilityTimeout: '1',
          MessageRetentionPeriod: '3600',
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: dlqArn,
            maxReceiveCount: '3',
          }),
        },
      }),
    );
    queueUrl = main.QueueUrl!;
  });

  afterAll(async () => {
    try {
      if (queueUrl) await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      if (dlqUrl) await client.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }));
    } catch {
      // ignore
    }
  });

  function makeAdapter(): AwsSqsQueueAdapter {
    return new AwsSqsQueueAdapter({
      region: REGION,
      endpoint: ENDPOINT,
      queueUrl,
      dlqUrl,
      accessKeyId: CREDS.accessKeyId,
      secretAccessKey: CREDS.secretAccessKey,
    });
  }

  it('cria fila FIFO válida com RedrivePolicy configurada', async () => {
    const attrs = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ['FifoQueue', 'QueueArn', 'RedrivePolicy', 'VisibilityTimeout'],
      }),
    );
    expect(attrs.Attributes?.FifoQueue).toBe('true');
    expect(attrs.Attributes?.QueueArn).toBeDefined();
    expect(attrs.Attributes?.VisibilityTimeout).toBe('1');

    const redrive = JSON.parse(attrs.Attributes?.RedrivePolicy ?? '{}');
    // ⚠️ SQS retorna os atributos internos como STRING (AWS spec).
    // `JSON.parse` devolve `{ maxReceiveCount: "3" }` — cast para Number.
    expect(Number(redrive.maxReceiveCount)).toBe(3);
  });

  it('AwsSqsQueueAdapter faz roundtrip completo (send → receive → ack)', async () => {
    const adapter = makeAdapter();
    const body = JSON.stringify({ hello: 'world', ts: runId });

    await adapter.send(body, `roundtrip-${runId}`, 'group-1');

    let received: any[] = [];
    for (let i = 0; i < 10; i++) {
      received = await adapter.receiveBatch(1, 1);
      if (received.length > 0) break;
      await new Promise((r) => setTimeout(r, 300));
    }

    expect(received.length).toBe(1);
    expect(JSON.parse(received[0].body)).toMatchObject({ hello: 'world' });

    await adapter.ack(received[0]);

    let remaining = -1;
    for (let i = 0; i < 15; i++) {
      const attrs = await client.send(
        new GetQueueAttributesCommand({
          QueueUrl: queueUrl,
          AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
        }),
      );
      remaining =
        Number(attrs.Attributes?.ApproximateNumberOfMessages ?? '0') +
        Number(attrs.Attributes?.ApproximateNumberOfMessagesNotVisible ?? '0');
      if (remaining === 0) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(remaining).toBe(0);
  });

  it('MessageDeduplicationId evita duplicata (janela FIFO 5min)', async () => {
    const adapter = makeAdapter();
    const dedupId = `dedup-test-${runId}`;
    const body = JSON.stringify({ test: 'dedup', ts: runId });

    await adapter.send(body, dedupId, 'group-dedup');
    await adapter.send(body, dedupId, 'group-dedup');
    await adapter.send(body, `${dedupId}-other`, 'group-dedup');

    await new Promise((r) => setTimeout(r, 1500));

    const received = await adapter.receiveBatch(10, 2);
    expect(received.length).toBe(2);

    for (const m of received) await adapter.ack(m);
  });

  it('DLQ recebe mensagem após maxReceiveCount=3 excedido', async () => {
    const adapter = makeAdapter();
    const body = JSON.stringify({ test: 'dlq', ts: runId });
    await adapter.send(body, `dlq-${runId}`, 'group-dlq');

    for (let i = 0; i < 4; i++) {
      await adapter.receiveBatch(1, 1);
      await new Promise((r) => setTimeout(r, 1500));
    }

    let dlqCount = 0;
    for (let i = 0; i < 30; i++) {
      const attrs = await client.send(
        new GetQueueAttributesCommand({
          QueueUrl: dlqUrl,
          AttributeNames: ['ApproximateNumberOfMessages'],
        }),
      );
      dlqCount = Number(attrs.Attributes?.ApproximateNumberOfMessages ?? '0');
      if (dlqCount > 0) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(dlqCount).toBeGreaterThanOrEqual(1);
  }, 40_000);
});
