# pgbackup

## Purpose

Postgres 16 backup utility image used by `helm/siskelbot/templates/backup-cronjob.yaml`.
The Helm CronJob runs `pg_dump`, `gzip`, and `aws s3 cp/ls/rm` against this image.

## Tags

- `16-aws` — current stable, tracked by the Helm chart default (`backup.image.tag`)
- `16-aws-<sha>` — pinned to a specific commit; useful for reproducible deployments

## What's inside

- `pg_dump` 16 (from `postgres:16-alpine`)
- `aws` CLI (v1, via PyPI)
- `gzip`
- `bash`
- `coreutils` (GNU `date` and `stat`, required by the CronJob script)
- `ca-certificates`

## Build locally

```bash
./docker/pgbackup/build.sh                # tags as 16-aws-local
./docker/pgbackup/build.sh 16-aws-myfix   # custom tag
```

## Test locally

```bash
docker run --rm -e PGPASSWORD=test \
  ghcr.io/hondoentertainment/pgbackup:16-aws-local \
  -c "pg_dump --version"
```

## CI

Built and pushed by `.github/workflows/build-pgbackup.yml` whenever changes
land under `docker/pgbackup/**`. The workflow:

1. Builds the image
2. Scans with Trivy (fails on `CRITICAL`)
3. Pushes to `ghcr.io/hondoentertainment/pgbackup:16-aws` and `:16-aws-<sha>`
4. Signs the image with cosign (keyless / OIDC)

## Update Postgres major version

1. Bump the `FROM postgres:<NN>-alpine` line in `Dockerfile`
2. Retag the workflow output (e.g. `17-aws`)
3. Update `helm/siskelbot/templates/backup-cronjob.yaml` (or `values.yaml`)
   to reference the new tag
