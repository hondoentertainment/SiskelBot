# Usage Reports

Wave 18C: invoicing and usage reports — monthly CSV export, usage summary endpoint, and threshold alerting.

## API Endpoints

All endpoints require authentication when auth is configured (`USER_API_KEYS` or equivalent).

### GET /api/v1/usage/summary

Returns aggregated usage for a workspace over a date range.

Query parameters:

| Parameter   | Default         | Description                         |
|-------------|-----------------|-------------------------------------|
| `workspace` | `default`       | Workspace ID to query               |
| `from`      | first of month  | Start date (UTC), format YYYY-MM-DD |
| `to`        | end of month    | End date (UTC), format YYYY-MM-DD   |

Response shape:

```json
{
  "workspaceId": "acme",
  "period": { "from": "2026-04-01", "to": "2026-04-30" },
  "requests": 1240,
  "inputTokens": 540000,
  "outputTokens": 210000,
  "estimatedCostUsd": 1.5,
  "storageBytes": 8388608,
  "topModels": [
    { "model": "gpt-4o", "requests": 800, "tokens": 600000 },
    { "model": "llama3", "requests": 440, "tokens": 150000 }
  ]
}
```

### GET /api/v1/usage/export

Downloads a CSV of daily usage for a workspace.

Query parameters: same as `/usage/summary`.

Response headers:

- `Content-Type: text/csv`
- `Content-Disposition: attachment; filename="usage-YYYY-MM.csv"`

### CSV format

```
date,requests,input_tokens,output_tokens,estimated_cost_usd
2026-04-01,42,18000,7200,0.0504
2026-04-02,38,16000,6400,0.0448
```

One row per calendar day in the requested range. Days with no activity have zero values. All dates are UTC.

### GET /api/v1/usage/alerts

Lists recent threshold alerts for a workspace (most recent first, up to 50).

Query parameters:

| Parameter   | Default   | Description        |
|-------------|-----------|--------------------|
| `workspace` | `default` | Workspace ID       |

Response:

```json
{
  "workspaceId": "acme",
  "alerts": [
    {
      "id": "alerts:acme:1714521600000",
      "workspaceId": "acme",
      "alerts": [
        {
          "type": "tokens_per_day",
          "threshold": 0.8,
          "current": 850000,
          "limit": 1000000
        }
      ],
      "createdAt": "2026-04-01T00:00:00.000Z"
    }
  ]
}
```

### POST /api/v1/admin/usage/check-thresholds

Admin-only endpoint. Triggers threshold checks for one or more workspaces. Returns alert details for each workspace checked.

Request body:

```json
{ "workspaceIds": ["acme", "beta-corp"] }
```

If `workspaceIds` is omitted or empty, checks the `default` workspace.

Response:

```json
{
  "results": [
    {
      "workspaceId": "acme",
      "alerts": [
        { "type": "tokens_per_day", "threshold": 0.8, "current": 900000, "limit": 1000000 }
      ]
    }
  ]
}
```

Requires an admin API key (`adminAuth`). For automated daily checks, schedule calls to this endpoint from a cron job or use a process manager.

## Alert Thresholds

Alerts are triggered when:

- `requestsThisMinute > 80%` of `requestsPerMinute` limit
- `tokensToday > 80%` of `tokensPerDay` limit

Limits are read from `lib/tenant-quotas.js`, which merges environment defaults with per-workspace overrides stored in `tenant_quotas/<workspaceId>`.

Default limits (configurable via environment):

| Variable                    | Default       |
|-----------------------------|---------------|
| `DEFAULT_REQUESTS_PER_MINUTE` | 60          |
| `DEFAULT_TOKENS_PER_DAY`      | 1,000,000   |

Override a workspace's limits via `PUT /api/v1/admin/quotas/:workspaceId`.

## Cost Estimation

Costs are estimated at **$0.002 per 1,000 tokens** (combined input + output). This is a rough approximation for billing reconciliation. Actual charges depend on the model and provider pricing in effect.

## Monthly Report for Billing Reconciliation

1. Call `GET /api/v1/usage/export?workspace=<id>&from=YYYY-MM-01&to=YYYY-MM-31` to download the daily CSV.
2. Sum the `estimated_cost_usd` column for a total monthly cost estimate.
3. Cross-reference with `GET /api/v1/billing/invoice?workspace=<id>&period=YYYY-MM` for the formal invoice.
4. For model-level breakdown, use `GET /api/v1/usage/summary` and inspect `topModels`.

For a full workspace list to iterate over, use `GET /api/v1/admin/quotas` (admin key required) which lists all workspaces with quota data.
