import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  // ⚠️ NOTA: NÃO usamos `ValidationPipe`/`class-validator`.
  // A validação é MANUAL nos controllers (`validateSubmitBody`, `assertUuid`,
  // checagem de `money.amount` etc). Adicionar `ValidationPipe` exigiria
  // reescrever todos os DTOs como classes decoradas — o projeto optou por
  // validação explícita e tipada em TS puro, mais transparente para os
  // contratos `Money`/`UUID`/`kind`.

  // CORS conservador (dev local)
  app.enableCors({
    origin: process.env.CORS_ORIGINS?.split(',') ?? '*',
    credentials: false,
  });

  // Shutdown hooks — workers fazem `onApplicationShutdown`
  app.enableShutdownHooks();

  // ── OpenAPI / Swagger ────────────────────────────────────────────────
  // Documentação interativa em http://localhost:3000/api (UI)
  // e http://localhost:3000/api-json (spec JSON).
  //
  // Como o projeto usa interfaces TS (não classes decoradas), o Swagger
  // gera docs a partir dos decorators `@ApiBody`/`@ApiResponse` dos
  // controllers — ver `wagering.controller.ts` e `wallets.controller.ts`.
  const swaggerConfig = new DocumentBuilder()
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

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api', app, document, {
    swaggerOptions: { persistAuthorization: true, tagsSorter: 'alpha' },
  });

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
