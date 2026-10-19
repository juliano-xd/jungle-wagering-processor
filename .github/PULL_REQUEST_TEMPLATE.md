## O que mudou

<!-- 1-2 frases sobre o objetivo da mudança -->

## Como testar

- [ ] `bunx tsc --noEmit`
- [ ] `bun run test` (156 testes)
- [ ] `bun run test:sqs` (4 testes SQS real, precisa Docker)
- [ ] `bun run test:load` (opcional — load test)
- [ ] `bun run db:verify` (invariantes de schema)

## Checklist

- [ ] Não usa `number`/`float` para dinheiro
- [ ] Nenhum `em.clear()` no root EM
- [ ] Novas migrations têm `up`/`down` reversíveis
- [ ] `schema:update` NÃO foi rodado (triggers seriam dropados)
- [ ] Logs incluem `correlationId`, `walletId`, `providerId`
- [ ] Métricas relevantes foram adicionadas

## Trade-offs

<!-- O que foi considerado e descartado -->
