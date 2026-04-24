# Runbook: Webhook DLQ Drain

**Time to resolve:** 10–30 minutes (longer if downstream fix required)

## Symptoms
- `SiskelBotWebhookDLQGrowing` alert firing.
- `siskelbot_webhook_dlq_size` metric rising (visible at `GET /metrics` when `ENABLE_METRICS=1`).
- User reports of missed webhook events or stale integrations.
- `[webhook-delivery]` warn lines in logs showing repeated failed attempts.

## Severity
**medium** — downstream integrations out of sync; core product unaffected.

## Triage

Inspect DLQ contents to identify the failing endpoint and error pattern:

```bash
curl https://siskelbot.example.com/api/v1/webhooks/dlq \
  -H "Authorization: Bearer $ADMIN_API_KEY"
```

Group by `error` and `url` fields to find the common failure mode. The DLQ holds up to 500 entries (`DLQ_MAX`); entries beyond that are dropped, so act promptly.

## Common causes

| Symptom | Likely cause |
|---|---|
| `ECONNREFUSED` / `ENOTFOUND` | Target URL is unreachable (host down, DNS failure) |
| `certificate verify failed` | Expired or self-signed TLS cert on the target |
| `HTTP 5xx` | Target endpoint is erroring |
| `HTTP 401` / `403` | Signing secret mismatch or rotated credentials |
| `AbortError` / timeout | Target is too slow; default fetch timeout is 15 s |

## Retry DLQ

After fixing the underlying issue on the consumer side, replay all DLQ entries:

```bash
curl -X POST https://siskelbot.example.com/api/v1/webhooks/dlq/retry \
  -H "Authorization: Bearer $ADMIN_API_KEY"
```

Monitor logs to confirm deliveries succeed:

```bash
kubectl logs -n siskelbot -l app=siskelbot --follow | grep "webhook-delivery"
```

## Purge DLQ

If events are stale and can be safely discarded:

```bash
curl -X DELETE https://siskelbot.example.com/api/v1/webhooks/dlq \
  -H "Authorization: Bearer $ADMIN_API_KEY"
```

Confirm with the integration owner before purging — purged events cannot be recovered.

## Prevent recurrence

1. **Validate endpoints on registration** — probe the URL with a test event before accepting the webhook subscription.
2. **Review retry budget** — the delivery client uses exponential backoff (1 s, 4 s by default). After `MAX_RETRIES` (default 3) exhausted attempts the payload moves to the DLQ. Adjust via env if needed.
3. **Circuit breaker** — configure a circuit breaker on the consumer side so transient outages do not fill the DLQ before the endpoint recovers.
4. **Alert threshold** — set `siskelbot_webhook_dlq_size` alert at a low threshold (e.g. 10 entries) so the queue is caught early.
5. **Signing secret rotation** — follow the documented rotation process; update both sides before invalidating the old secret.

Relevant env vars:

| Var | Default | Purpose |
|---|---|---|
| `WEBHOOK_MAX_RETRIES` | 3 | Max delivery attempts before DLQ |
| `WEBHOOK_RETRY_DELAY_MS` | 1000 | Base backoff delay in ms (doubles each retry) |
| `WEBHOOK_TIMEOUT_MS` | 15000 | Per-request fetch timeout |
| `ALLOW_WEBHOOK_LOCALHOST` | — | Allow localhost targets (dev only; never in prod) |
