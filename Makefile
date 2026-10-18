.PHONY: up down db-reset test evaluate build

up:
	docker compose up -d postgres localstack

down:
	docker compose down -v

db-reset:
	bun --bun x mikro-orm schema:fresh --run --config=./mikro-orm.config.ts

build:
	bun build --no-bundle --outdir ./dist src/main.ts

test:
	bun test

evaluate: up
	@echo "⏳ Aguardando PostgreSQL e LocalStack..."
	@until docker exec jungle_postgres pg_isready -U postgres > /dev/null 2>&1; do sleep 1; done
	@until curl -s http://127.0.0.1:4566/health > /dev/null 2>&1; do sleep 1; done
	@echo "🚀 Serviços prontos! Executando reset e suíte completa de testes..."
	@make db-reset
	@make test