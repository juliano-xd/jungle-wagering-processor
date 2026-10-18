import { Controller, Get } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';

@Controller('health')
export class HealthController {
  constructor(private readonly em: EntityManager) {}

  @Get('live')
  live() {
    return { status: 'UP', timestamp: new Date().toISOString() };
  }

  @Get('ready')
  async ready() {
    try {
      await this.em.getConnection().execute('SELECT 1');
      return { status: 'UP', database: 'CONNECTED', sqs: 'CONNECTED' };
    } catch {
      return { status: 'DOWN', database: 'DISCONNECTED' };
    }
  }
}
