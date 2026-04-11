# Runbook: Webhook DLQ Growing

## Symptoms
- Webhook delivery dead-letter queue (DLQ) size trending up.
- External consumers reporting missed events.
- Retry backlog alerts firing.

## Severity
**medium** — downstream integrations out of sync; core product unaffected.

## Investigation Steps
1. List DLQ entries: `GET /api/v1/webhooks/dlq`.
2. Group DLQ entries by error reason to find the common failure mode (TLS error, 5xx, timeout, signature mismatch).
3. Probe the failing consumer endpoint directly to confirm it's unreachable or returning errors.
4. Verify webhook signing secrets have not rotated unexpectedly on either side.
5. Check recent changes to the webhook delivery client.

## Remediation
- Pause webhook delivery to the failing consumer until the downstream is healthy.
- Contact the consumer operator for 5xx or auth failures.
- Once downstream is healthy, replay the DLQ via the admin endpoint.
- Purge entries that are too old to be meaningful.

## Prevention
- Alert when DLQ size crosses a configurable threshold.
- Validate webhook endpoints on registration (TLS reachable, 2xx on test event).
- Use exponential backoff with a capped retry budget.
- Sign webhooks and rotate secrets via a documented process.
