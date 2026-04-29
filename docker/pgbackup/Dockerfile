# Postgres backup image: pg_dump 16 + AWS CLI v2 + gzip
# Builds: ghcr.io/hondoentertainment/pgbackup:16-aws
#
# Note: We install awscli v1 from PyPI for simplicity. v1 is sufficient for
# the `s3 cp`, `s3 ls`, and `s3 rm` operations the backup CronJob performs.
# v2 is heavier and would require the bundled installer (commented below).
# coreutils is required because the CronJob uses GNU date (`date -u -d
# "<N> days ago"`) and GNU stat (`stat -c%s`) — BusyBox versions in
# postgres:16-alpine do not support these flags.
FROM postgres:16-alpine

RUN apk add --no-cache \
    python3 \
    py3-pip \
    bash \
    coreutils \
    ca-certificates \
  && pip3 install --no-cache-dir --break-system-packages awscli==1.33.0 \
  && rm -rf /var/cache/apk/* /tmp/* /root/.cache

# Alternative: AWS CLI v2 via official binary (uncomment to switch)
# RUN apk add --no-cache curl unzip groff less \
#   && curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip -o /tmp/aws.zip \
#   && unzip -q /tmp/aws.zip -d /tmp \
#   && /tmp/aws/install \
#   && rm -rf /tmp/aws*

# Verify tools are available
RUN pg_dump --version && aws --version && gzip --version | head -1

# Default to a sane shell entrypoint; the Helm CronJob supplies the actual command
ENTRYPOINT ["/bin/bash", "-c"]
CMD ["echo 'Run via Helm CronJob backup-cronjob.yaml'"]

LABEL org.opencontainers.image.source=https://github.com/hondoentertainment/SiskelBot
LABEL org.opencontainers.image.description="Postgres 16 + AWS CLI for SiskelBot backups"
LABEL org.opencontainers.image.licenses=MIT
