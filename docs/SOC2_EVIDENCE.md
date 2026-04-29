# SOC2 Evidence Collection

SiskelBot includes an automated evidence collector (`lib/compliance-evidence.js`) that snapshots compliance-relevant state for SOC2 audits. Evidence is collected nightly and stored durably so auditors can review historical posture.

## What is collected and which SOC2 criteria it satisfies

| Control category | Fields collected | SOC2 criteria |
|---|---|---|
| **Access control** | Workspace count, user count, admin user count, MFA configured flag | CC6.1 — Logical access controls; CC6.2 — Authentication; CC6.3 — Role-based access |
| **Audit logging** | Login events (last 30 days), failed logins (last 30 days), retention days | CC7.2 — Monitoring of system operations; CC7.3 — Evaluation of security events |
| **Auth methods** | OIDC, SAML, GitHub OAuth, Google OAuth, LDAP enabled flags | CC6.2 — Multi-factor and federated authentication |
| **Data protection** | Storage backend type, database SSL flag, session secret configured flag | CC6.7 — Data-at-rest and in-transit encryption; CC9.2 — Vendor risk |
| **Availability** | Process uptime (seconds), Node.js version, OS platform | A1.2 — Environmental protections; A1.3 — Backup and recovery |

The `mfaConfigured` flag is `true` when at least one of OIDC, SAML, or WebAuthn (`WEBAUTHN_ENABLED=1`) is configured, indicating that a second-factor-capable authentication method is available.

The `databaseSsl` flag is `true` when `DATABASE_URL` contains `sslmode=require` or `ssl=true`, indicating encrypted transport to the database.

## How to run evidence collection

### Automatic (nightly)

When `ENABLE_SCHEDULED_RECIPES=1` is set, the scheduler (`lib/scheduler.js`) automatically collects and saves a snapshot at **02:00 UTC** every day. Snapshots are stored under `data/compliance/evidence-YYYY-MM-DD.json` (or in the configured KV backend).

### Manual via API

```bash
# Collect and save a snapshot immediately
curl -X POST \
  -H "x-admin-api-key: $ADMIN_API_KEY" \
  http://localhost:3000/api/v1/admin/compliance/evidence/collect

# Run collection without saving (inspect only)
curl -H "x-admin-api-key: $ADMIN_API_KEY" \
  http://localhost:3000/api/v1/admin/compliance/evidence

# List stored snapshots (most recent first)
curl -H "x-admin-api-key: $ADMIN_API_KEY" \
  http://localhost:3000/api/v1/admin/compliance/evidence/history

# Retrieve a specific snapshot by date
curl -H "x-admin-api-key: $ADMIN_API_KEY" \
  http://localhost:3000/api/v1/admin/compliance/evidence/history/2026-04-29
```

All endpoints require `ADMIN_API_KEY` (via `Authorization: Bearer <key>` or `x-admin-api-key` header) or a session user in `QUOTA_ADMIN_USER_IDS`.

### Manual via cron (when scheduler is disabled)

If `ENABLE_SCHEDULED_RECIPES` is not enabled, add this to your system crontab:

```cron
0 2 * * * curl -s -X POST -H "x-admin-api-key: $ADMIN_API_KEY" http://localhost:3000/api/v1/admin/compliance/evidence/collect
```

## How to export for auditors

Use the CLI script to export up to 90 days of snapshots to a JSON file and print a summary table:

```bash
# Print summary table (last 90 days)
node scripts/export-compliance-evidence.mjs

# Export last 30 days to a file
node scripts/export-compliance-evidence.mjs --days 30 --output compliance-export.json

# Export last year
node scripts/export-compliance-evidence.mjs --days 365 --output audit-2026.json
```

Output table format:

```
| Date         | Workspaces   | Auth Methods                             | DB SSL   |
|--------------|--------------|------------------------------------------|----------|
| 2026-04-29   | 12           | oidc, github                             | yes      |
```

The JSON export contains full evidence objects including all control categories, timestamps, and version metadata.

## Recommended schedule

| Task | Frequency | Method |
|---|---|---|
| Collect evidence snapshot | Daily at 02:00 UTC | Automatic via scheduler or cron |
| Export for quarterly audit | Quarterly | `export-compliance-evidence.mjs --days 90` |
| Review auth method changes | After any SSO/IdP change | Manual `POST /collect` + review |
| Verify DB SSL posture | After infra changes | Inspect `dataProtection.databaseSsl` in evidence |

## Interpreting the evidence

- `mfaConfigured: false` does not mean MFA is unavailable — it means no OIDC/SAML/WebAuthn env var is set. Auditors should cross-check with IdP documentation.
- `adminCount` is the count of user IDs in `QUOTA_ADMIN_USER_IDS` that also appear in the user store. Users authenticated via `ADMIN_API_KEY` are not counted as named admins.
- `loginEventsLast30Days` is counted from the audit log (`data/execution-audit.json`). If the log is rotated or archived, this count may be 0 for older entries; use the audit query API for exhaustive searches.
- Evidence snapshots are supplementary. Auditors will also need raw audit logs, network diagrams, HR policies, and vendor contracts.

## See also

- `lib/compliance-evidence.js` — implementation
- `lib/compliance.js` — SOC2/HIPAA/GDPR control reports (separate from evidence snapshots)
- `routes/compliance.js` — all compliance HTTP routes
- `docs/COMPLIANCE.md` — compliance framework reports (SOC2, HIPAA, GDPR)
- `scripts/export-compliance-evidence.mjs` — auditor export CLI
