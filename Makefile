# Phase 35: Optional Makefile targets for Docker

.PHONY: docker-build docker-run docker-down docker-logs

docker-build:
	docker compose build

docker-run:
	docker compose up -d

docker-down:
	docker compose down

docker-logs:
	docker compose logs -f siskelbot
