import { NestFactory } from '@nestjs/core';
import { INestApplication, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';

// Validação é intencionalmente manual nos controllers (interfaces TS, não
// classes decoradas). Introduzir `ValidationPipe`/`class-validator` exigiria
// reescrever todos os DTOs — decisão consciente do projeto.

function setupCors(app: INestApplication): void {
  app.enableCors({
    origin: process.env.CORS_ORIGINS?.split(',') ?? '*',
    credentials: false,
  });
}

function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('Distributed Wagering Processor')
    .setDescription(
      'Serviço financeiro distribuído para processamento de apostas multi-provider.\n\n' +
        '**Invariantes**: idempotência persistente, ledger imutável, lock pessimista por wallet, ' +
        'saldo nunca negativo.\n\n' +
        '**Idempotência**: `Idempotency-Key` header obrigatório em `POST /wagering/transactions`. ' +
        'Recomendado: `{providerId}:{externalTransactionId}`.\n\n' +
        '**Payload hash**: SHA-256 do JSON canônico dos campos de negócio.',
    )
    .setVersion('1.0.0')
    .addTag('wallets', 'Criação, consulta e reconciliação de wallets')
    .addTag('wagering', 'Submissão e consulta de transações de apostas')
    .addTag('providers', 'Consulta por provedor externo')
    .addTag('health', 'Liveness e readiness')
    .addTag('metrics', 'Métricas Prometheus')
    .addApiKey(
      { type: 'apiKey', in: 'header', name: 'Idempotency-Key' },
      'idempotency-key',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document, {
    swaggerOptions: { persistAuthorization: true, tagsSorter: 'alpha' },
  });
}

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  setupCors(app);
  app.enableShutdownHooks();
  setupSwagger(app);

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);

  logger.log(`🚀 Application listening on http://localhost:${port}`);
  logger.log(`📖 OpenAPI spec at http://localhost:${port}/api`);
  logger.log(`📊 Prometheus metrics at http://localhost:${port}/metrics`);
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
