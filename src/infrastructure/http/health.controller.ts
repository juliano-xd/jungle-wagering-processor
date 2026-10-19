import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiOkResponse, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { EntityManager } from '@mikro-orm/core';
import {
  SQSClient,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';

/**
 * Health checks — nunca exigem auth (spec 9).
 *
 * /health/live  → processo vivo, sem tocar DB/SQS
 * /health/ready → ping real de Postgres + SQS (se QUEUE_BACKEND=aws)
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  private readonly sqs?: SQSClient;
  private readonly queueUrl?: string;

  constructor(private readonly em: EntityManager) {
    if ((process.env.QUEUE_BACKEND ?? 'memory').toLowerCase() === 'aws') {
      this.sqs = new SQSClient({
        region: process.env.SQS_REGION ?? 'us-east-1',
        endpoint: process.env.SQS_ENDPOINT,
        credentials:
          process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
            ? {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
              }
            : undefined,
      });
      this.queueUrl = process.env.SQS_QUEUE_URL;
    }
  }

  @Get('live')
  @ApiOkResponse({ description: 'Processo vivo' })
  live() {
    return { status: 'ok', check: 'live' };
  }

  @Get('ready')
  @ApiOkResponse({ description: 'Tudo pronto' })
  @ApiServiceUnavailableResponse({ description: 'Algum check falhou' })
  async ready(@Res({ passthrough: true }) res: Response) {
    const checks: Record<string, 'ok' | 'fail' | 'skipped'> = {};
    let allOk = true;

    // 1. PostgreSQL — ping real
    try {
      await this.em.getConnection().execute('SELECT 1');
      checks.postgres = 'ok';
    } catch {
      checks.postgres = 'fail';
      allOk = false;
    }

    // 2. SQS — ping real (só se QUEUE_BACKEND=aws)
    if (!this.sqs || !this.queueUrl) {
      checks.sqs = 'skipped';
    } else {
      try {
        await this.sqs.send(
          new GetQueueAttributesCommand({
            QueueUrl: this.queueUrl,
            AttributeNames: ['ApproximateNumberOfMessages'],
          }),
        );
        checks.sqs = 'ok';
      } catch {
        checks.sqs = 'fail';
        allOk = false;
      }
    }

    res.status(allOk ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: allOk ? 'ok' : 'degraded', checks };
  }
}
