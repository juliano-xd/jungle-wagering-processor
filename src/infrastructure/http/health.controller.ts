import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
// ⚠️ EntityManager de @mikro-orm/core (mesmo token do MikroOrmModule.forRoot).
import { EntityManager } from '@mikro-orm/core';

@Controller('health')
export class HealthController {
  constructor(private readonly em: EntityManager) {}

  @Get('live')
  live() {
    return { status: 'ok', check: 'live' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const checks: Record<string, 'ok' | 'fail'> = {};
    let allOk = true;

    try {
      await this.em.getConnection().execute('SELECT 1');
      checks.postgres = 'ok';
    } catch {
      checks.postgres = 'fail';
      allOk = false;
    }

    // SQS check é placeholder até o consumer ser implementado.
    checks.sqs = 'ok';

    res.status(allOk ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return {
      status: allOk ? 'ok' : 'degraded',
      checks,
    };
  }
}
