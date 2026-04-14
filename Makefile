.PHONY: start stop logs restart update backup shell audit check-updates upgrade-deps maintain test build dev

start:
	docker compose up -d

stop:
	docker compose down

logs:
	docker compose logs -f

restart:
	docker compose restart

update:
	docker compose build && docker compose up -d

backup:
	cp -r ./data ./data.backup-$(shell date +%Y%m%d-%H%M%S)
	@echo "Backup created"

shell:
	docker compose exec sshweb sh

# Development
dev:
	npm run dev

build:
	npm run build

test:
	node --test "tests/**/*.test.js"

# Dependency management
audit:
	npm audit

check-updates:
	npx npm-check-updates

upgrade-deps:
	npx npm-check-updates -u && npm install && npm audit

# Monthly maintenance: audit + check updates + rebuild with latest base image
maintain:
	@echo "=== npm audit ===" && npm audit; \
	echo "=== outdated packages ===" && npx npm-check-updates; \
	echo "=== rebuilding with latest base image ===" && \
	docker compose build --pull && docker compose up -d
