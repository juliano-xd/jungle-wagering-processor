import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  Post,
} from '@nestjs/common';
import { QUEUE_PUBLISHER } from './queue.port.js';
import type { QueuePublisherPort } from './queue.port.js';
import { InMemoryQueueAdapter } from './in-memory-queue.adapter.js';

/**
 * Endpoint de DESENVOLVIMENTO — injeta mensagens na fila in-memory para
 * testar o consumer sem LocalStack.
 *
 * Gated por `DEV_QUEUE_ENDPOINT=true`. Em produção não existe.
 */
@Controller('_dev/queue')
@Injectable()
export class DevQueueController {
  constructor(
    @Inject(QUEUE_PUBLISHER) private readonly publisher: QueuePublisherPort,
    private readonly inMemory: InMemoryQueueAdapter,
  ) {}

  @Post('publish')
  @HttpCode(HttpStatus.ACCEPTED)
  async publish(@Body() body: unknown): Promise<{ accepted: true }> {
    this.assertDevEnabled();

    if (!body || typeof body !== 'object') {
      throw new BadRequestException({
        error: 'INVALID_BODY',
        message: 'Envelope JSON required',
      });
    }

    const envelope = body as Record<string, unknown>;
    if (
      typeof envelope.messageId !== 'string' ||
      envelope.type !== 'WagerTransactionRequested' ||
      !envelope.data ||
      typeof envelope.data !== 'object'
    ) {
      throw new BadRequestException({
        error: 'INVALID_ENVELOPE',
        message:
          'Envelope must have messageId (string), type="WagerTransactionRequested", data (object)',
      });
    }

    await this.publisher.send(JSON.stringify(body));
    return { accepted: true };
  }

  @Get('stats')
  stats(): ReturnType<InMemoryQueueAdapter['stats']> {
    this.assertDevEnabled();
    return this.inMemory.stats();
  }

  private assertDevEnabled(): void {
    if (process.env.DEV_QUEUE_ENDPOINT !== 'true') {
      throw new BadRequestException({
        error: 'DEV_ENDPOINT_DISABLED',
        message: 'Set DEV_QUEUE_ENDPOINT=true to enable this endpoint',
      });
    }
  }
}
