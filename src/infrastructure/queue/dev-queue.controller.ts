import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpStatus,
  Inject,
  Injectable,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
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
  async publish(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    if (process.env.DEV_QUEUE_ENDPOINT !== 'true') {
      throw new BadRequestException({
        error: 'DEV_ENDPOINT_DISABLED',
        message: 'Set DEV_QUEUE_ENDPOINT=true to enable this endpoint',
      });
    }
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
      !envelope.data
    ) {
      throw new BadRequestException({
        error: 'INVALID_ENVELOPE',
        message:
          'Envelope must have messageId (string), type="WagerTransactionRequested", data (object)',
      });
    }
    await this.publisher.send(JSON.stringify(body));
    res.status(HttpStatus.ACCEPTED);
    return { accepted: true };
  }

  @Get('stats')
  stats() {
    if (process.env.DEV_QUEUE_ENDPOINT !== 'true') {
      throw new BadRequestException({
        error: 'DEV_ENDPOINT_DISABLED',
        message: 'Set DEV_QUEUE_ENDPOINT=true to enable this endpoint',
      });
    }
    return this.inMemory.stats();
  }
}
