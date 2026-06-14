# Status page automation

## 1. Overview

SiskelBot can auto-publish production incidents to a public status page by
receiving Prometheus Alertmanager webhooks and translating them into status
page incidents. When a critical alert fires, SiskelBot opens an incident on
your status page; when the alert resolves, it marks the incident resolved and
the affected component back to operational.

This is independent of SiskelBot's built-in status page (`GET /api/v1/status`),
which is intended for internal observability — the bridge described here is for
externally-facing customer-facing status pages.

## 2. Supported providers

| Provider                  | `STATUS_PAGE_PROVIDER` | Notes                                  |
| ------------------------- | ---------------------- | -------------------------------------- |
| Atlassian Statuspage.io   | `statuspage`           | Hosted; requires API key + page ID.    |
| cstate (self-hosted)      | `cstate`               | File-based; currently TODO (see code). |

## 3. Configuration

| Env var                        | Required | Description                                                              |
| ------------------------------ | -------- | ------------------------------------------------------------------------ |
| `STATUS_PAGE_ENABLED`          | yes      | `1` to enable the bridge. Anything else short-circuits and skips alerts. |
| `STATUS_PAGE_PROVIDER`         | yes      | `statuspage` or `cstate`. Defaults to `statuspage`.                      |
| `STATUSPAGE_API_KEY`           | for SP   | Atlassian Statuspage OAuth token (User → API).                           |
| `STATUSPAGE_PAGE_ID`           | for SP   | The page ID — visible in the Statuspage URL.                             |
| `STATUS_PAGE_COMPONENT_MAP`    | yes      | JSON object mapping SiskelBot alert names → Statuspage component IDs.    |
| `ALERTMANAGER_WEBHOOK_SECRET`  | optional | If set, the webhook receiver requires `Authorization: Bearer <secret>`.  |

## 4. Statuspage.io setup

1. In the Statuspage UI, create the components you want to expose, e.g.
   `API`, `Inference`, `Webhooks`. Each component gets a unique ID.
2. In Statuspage, go to **User → API** and create an OAuth token.
3. Set on the SiskelBot side:
   ```bash
   export STATUS_PAGE_ENABLED=1
   export STATUS_PAGE_PROVIDER=statuspage
   export STATUSPAGE_API_KEY=spk_live_xxx
   export STATUSPAGE_PAGE_ID=abcd1234
   export STATUS_PAGE_COMPONENT_MAP='{"SiskelBotProbeDown":"comp-api","SiskelBotHighErrorRate":"comp-api","SiskelBotNoPodAvailable":"comp-api","SiskelBotErrorBudgetBurnFast":"comp-api"}'
   export ALERTMANAGER_WEBHOOK_SECRET=$(openssl rand -hex 32)
   ```
4. Restart SiskelBot. The webhook receiver mounts at
   `POST /api/v1/alertmanager/webhook`.

## 5. Alertmanager configuration

In your Alertmanager config, add a receiver pointing at the SiskelBot webhook:

```yaml
receivers:
  - name: siskelbot-statuspage
    webhook_configs:
      - url: https://siskelbot.example.com/api/v1/alertmanager/webhook
        http_config:
          authorization:
            type: Bearer
            credentials: $ALERTMANAGER_WEBHOOK_SECRET
        send_resolved: true
```

Then route critical alerts to it:

```yaml
route:
  routes:
    - matchers:
        - severity = "critical"
        - alertname =~ "SiskelBot(ProbeDown|NoPodAvailable|ErrorBudgetBurnFast)"
      receiver: siskelbot-statuspage
      continue: true   # also route to your normal pager
```

`send_resolved: true` is required so the bridge can flip components back to
`operational` when the underlying alert clears.

## 6. Recommended alerts to bridge

These are the alerts that map cleanly to a public status page (high signal,
customer-visible). All of them are defined in
`helm/siskelbot/templates/prometheusrule.yaml`.

- `SiskelBotNoPodAvailable` (critical) — full outage
- `SiskelBotProbeDown` (critical) — the user-facing probe is failing
- `SiskelBotErrorBudgetBurnFast` (critical) — fast-burn SLO breach
- `SiskelBotHighErrorRate` (warning) — bridges as a `minor` incident

**Do not** bridge these (too noisy or internal):

- Cost alerts (`SiskelBotWorkspaceCostBudget`)
- Performance warnings (`SiskelBotHighLatency`, `SiskelBotProbeSlowResponse`)
- Capacity warnings (`SiskelBotPodMemoryHigh`, `SiskelBotEmbeddingCacheThrashing`)
- Internal queue alerts (`SiskelBotWebhookDLQGrowing`)

Alerts not present in `STATUS_PAGE_COMPONENT_MAP` are silently skipped — the
component map is the allowlist.

## 7. Testing the integration

Send a synthetic firing alert:

```bash
curl -X POST https://siskelbot.example.com/api/v1/alertmanager/webhook \
  -H "Authorization: Bearer $ALERTMANAGER_WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"alerts":[{"status":"firing","labels":{"alertname":"SiskelBotProbeDown","severity":"critical"},"annotations":{"summary":"Probe failing","description":"test"}}]}'
```

Expected response:

```json
{ "status": "ok", "posted": 1, "skipped": 0, "errors": [] }
```

Then resolve it:

```bash
curl -X POST https://siskelbot.example.com/api/v1/alertmanager/webhook \
  -H "Authorization: Bearer $ALERTMANAGER_WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"alerts":[{"status":"resolved","labels":{"alertname":"SiskelBotProbeDown","severity":"critical"},"annotations":{"summary":"Probe failing","description":"recovered"}}]}'
```

The Statuspage incident should flip to `resolved` and the component back to
`operational`.

## 8. Troubleshooting

| Symptom                                     | Likely cause / fix                                                                                                            |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Response shows `skipped: N, posted: 0`      | Alert names don't match `STATUS_PAGE_COMPONENT_MAP` keys, or `STATUS_PAGE_ENABLED` is unset.                                  |
| `errors[].error: Statuspage API 401`        | `STATUSPAGE_API_KEY` is invalid or expired. Regenerate in Statuspage UI.                                                       |
| `errors[].error: Statuspage API 404`        | `STATUSPAGE_PAGE_ID` is wrong, or the component ID in the map doesn't exist on that page.                                     |
| `errors[].error: Statuspage API 422`        | Request body rejected — usually impact / status enums. Check that severity labels are `critical`/`warning`/`info`.            |
| `errors[].error: Statuspage API 429`        | Rate-limited. Statuspage limits posts per page; reduce alert frequency or batch via Alertmanager `group_wait`/`group_interval`. |
| 401 from SiskelBot endpoint                 | `Authorization: Bearer` header mismatch with `ALERTMANAGER_WEBHOOK_SECRET`.                                                    |
| Webhook never reaches SiskelBot             | Network/firewall — Alertmanager must have egress to your SiskelBot URL. Check Alertmanager logs.                              |

## 9. References

- Alertmanager webhook receiver: `routes/alertmanager-webhook.js`
- Bridge implementation: `lib/status-page.js` (search for
  `processAlertmanagerPayload`)
- Prometheus alert definitions: `helm/siskelbot/templates/prometheusrule.yaml`
