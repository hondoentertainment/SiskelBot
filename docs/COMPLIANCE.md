# Compliance Reports

SiskelBot includes tooling to generate evidence reports for common
compliance frameworks from audit log data. These reports are intended
to help engineering and security teams prepare for third-party audits
and to satisfy data subject rights under GDPR.

> **Disclaimer**: These reports are a tooling aid and are **not** a
> substitute for an actual third-party audit, a legal assessment, or
> advice from a qualified compliance professional. The mapping between
> audit events and framework controls is heuristic. Before presenting
> any report to an auditor, validate it against your own evidence and
> control narratives.

## Supported frameworks

| Framework | Source | Implementation |
|-----------|--------|---------------|
| SOC 2 | AICPA Trust Services Criteria | `SOC2_CONTROLS` in `lib/compliance.js` |
| HIPAA | 45 CFR 164.308 / 164.312 Security Rule | `HIPAA_CONTROLS` in `lib/compliance.js` |
| GDPR | EU 2016/679 | `GDPR_CONTROLS` in `lib/compliance.js` |

The controls enumerated in each catalog are a curated subset focused on
controls where SiskelBot audit data can reasonably provide evidence.
Controls that are typically satisfied by physical security, HR policies,
or vendor contracts are intentionally out of scope.

## Control mapping methodology

The report generator walks each audit event returned by
`lib/audit-query.js` within the requested reporting window and maps
event `action` strings to one or more controls in each framework.

The mapping rules live in `ACTION_CONTROL_MAP` inside
`lib/compliance.js` and are expressed as regexes against the lowercased
event action, for example:

- `login`, `signin`, `auth.success` &rarr; SOC 2 CC6_1 / CC6_2, HIPAA 164.308(a)(4), 164.312(a)(1)
- `api_key.create` &rarr; SOC 2 CC6_3 / CC8_1, HIPAA 164.308(a)(4)
- `role.assign` &rarr; SOC 2 CC6_3 / CC8_1, HIPAA 164.308(a)(3), 164.308(a)(4)
- `data_subject_request` / `export.user` &rarr; GDPR Art. 15 / 20
- `right_to_erasure` / `delete.user` &rarr; GDPR Art. 17

Each control is then assigned a status based on the number of matching
events during the reporting window:

| Status | Criterion |
|--------|-----------|
| `ok` | 3 or more events |
| `weak` | 1 to 2 events |
| `no_evidence` | 0 events |

The overall framework **coverage** percentage is the ratio of `ok`
controls to total controls in that framework's catalog.

To extend or adjust the mapping, edit `ACTION_CONTROL_MAP` and redeploy.
Contributions should include a brief rationale in the commit message
explaining why the audit event should satisfy the relevant control.

## Using the reports

### Web UI

Visit `/compliance.html` while authenticated with an admin key. The page
provides:

- **Framework tabs** for SOC 2, HIPAA, GDPR, and an overview dashboard.
- **Date range picker** to bound the reporting window.
- **Control list** with evidence counts and red/yellow/green status.
- **Export** buttons for JSON and CSV output.
- **Data subject tools** section for DSR / erasure / portability.

### API

All endpoints require admin authentication (ADMIN_API_KEY or a
QUOTA_ADMIN_USER_IDS session).

| Endpoint | Description |
|----------|-------------|
| `GET /api/v1/compliance/soc2?startDate=&endDate=` | Generate SOC 2 report |
| `GET /api/v1/compliance/hipaa?startDate=&endDate=` | Generate HIPAA report |
| `GET /api/v1/compliance/gdpr?startDate=&endDate=` | Generate GDPR report |
| `GET /api/v1/compliance/dashboard` | Summary across all frameworks |
| `POST /api/v1/compliance/data-subject-request?userId=X` | GDPR Article 15 access |
| `POST /api/v1/compliance/right-to-erasure?userId=X&confirm=true` | GDPR Article 17 erasure |
| `GET /api/v1/compliance/export/:userId?format=json` | GDPR Article 20 portability |

Example:

```bash
curl -H "x-admin-api-key: $ADMIN_API_KEY" \
  "https://example.com/api/v1/compliance/soc2?startDate=2025-01-01&endDate=2025-03-31" \
  | jq
```

### Preparing for an audit

1. Set a reporting window matching your audit period.
2. Generate the report for the relevant framework.
3. For each control, review the `evidence` array. Each entry points to a
   specific audit log line that the tool considered relevant.
4. Cross-check with your storage and monitoring systems to ensure the
   audit log is complete and uncorrupted. See `docs/RUNBOOK.md` for the
   audit archival / integrity procedures.
5. Export the report (JSON for archival, CSV for spreadsheets).
6. Provide the report plus your control narratives to the auditor.

Do **not** rely on the generated report as the sole evidence. Auditors
will typically want raw logs, policies, architecture diagrams, access
reviews, and contract documentation. The compliance report is intended
to speed up evidence gathering, not replace it.

## Data subject rights

Under GDPR (and similar laws like CCPA), users have the right to:

- **Access** their data (Article 15)
- **Erase** their data (Article 17, "right to be forgotten")
- **Portability** of their data in machine-readable form (Article 20)

### Data subject access request

Use `POST /api/v1/compliance/data-subject-request?userId=X` to fetch
a consolidated report of everything SiskelBot has stored for a user:

- Conversations
- Knowledge base documents
- Agent memory
- Audit entries attributed to the user
- Feedback submissions

The caller is responsible for transmitting the result to the user via
an authenticated channel.

### Right to erasure

`POST /api/v1/compliance/right-to-erasure?userId=X` defaults to **dry
run** mode and returns a count of what would be deleted. Pass
`?confirm=true` to perform the actual deletion.

By default, audit entries are preserved even during erasure because
most regulators expect audit logs to survive for legal reasons. To
include audit deletion in the count, pass `preserveAudit: false` in the
request body. The implementation intentionally stops short of deleting
audit rows &mdash; that step requires deliberate operator action to
avoid accidental log destruction.

### Data portability export

`GET /api/v1/compliance/export/:userId?format=json|csv|zip` returns a
downloadable file containing the data subject request payload. JSON is
the preferred format; CSV is provided for spreadsheet workflows; ZIP
currently falls back to JSON until an archive dependency is enabled.

## Retention policies

Audit retention is configured via `lib/audit-lifecycle.js` and the
environment variables `AUDIT_RETENTION_DAYS`, `AUDIT_ARCHIVE_AFTER_DAYS`,
and `AUDIT_DELETE_AFTER_DAYS`. Keep these values high enough to cover
your expected audit reporting windows &mdash; the compliance report can
only cite events that still exist in the audit log or its archives.

See `docs/RUNBOOK.md` for operational procedures around audit rotation
and S3 archiving.

## Limitations

- The action-to-control mapping is pattern-based and may miss custom
  event names. Update `ACTION_CONTROL_MAP` in `lib/compliance.js` if
  your deployment emits non-standard event actions.
- A control marked `ok` means there is audit evidence of related
  activity; it does **not** prove that the control is implemented
  correctly. Auditors will still need to verify the control itself.
- Evidence arrays are truncated to the most recent 25 events per
  control to keep report sizes manageable. Use the audit query API
  directly for exhaustive searches.
- Some controls (e.g., SOC 2 CC6_7 data-at-rest encryption) are really
  infrastructure-level and cannot be verified from audit events alone.
  Supplement the report with infrastructure evidence.
- Erasure does not guarantee removal from backups or S3 audit
  archives. Coordinate with your backup retention policy to ensure
  downstream deletion happens within your committed SLA.

## See also

- `lib/compliance.js` &mdash; implementation
- `routes/compliance.js` &mdash; HTTP routes
- `tests/compliance.test.js` &mdash; unit tests
- `docs/RUNBOOK.md` &mdash; operational runbook
- `docs/AUDIT.md` &mdash; audit log architecture (if present)

## Audit log immutability

SiskelBot uses SHA-256 hash-chaining to make the audit log tamper-evident. Each
entry records a cryptographic hash of itself together with the hash of the
previous entry, forming a chain. Any modification to a historical entry causes
its stored hash to diverge from the recomputed hash, and the divergence
propagates visibly forward through the chain.

### How hash-chaining works

Each audit entry is extended with three fields:

| Field | Description |
|-------|-------------|
| `hash` | SHA-256 of `prevHash + JSON.stringify({ event, userId, workspaceId, createdAt, metadata })` |
| `prevHash` | `hash` of the immediately preceding entry in the same workspace chain |
| `sequence` | Monotonically increasing integer per workspace (starts at 1) |

The first entry in each workspace chain uses the genesis `prevHash` value
`"0000000000000000"` (16 zeros).

The chain is maintained per workspace. An in-process lock serialises concurrent
writes so that `sequence` values are gapless and `prevHash` references are
consistent.

### Verifying the chain

Use the admin API to verify chain integrity:

```
GET  /api/v1/admin/audit/chain/verify?workspaceId=<id>&limit=100
     — recomputes the hash for each of the last N entries and compares
       to the stored hash; returns { valid, entriesChecked, firstBadSequence }

GET  /api/v1/admin/audit/chain/head?workspaceId=<id>
     — returns the current chain head { hash, sequence, lastEntryAt }

POST /api/v1/admin/audit/chain/verify-all
     — verifies all workspaces; returns { workspacesChecked, allValid, invalidWorkspaces }
```

All three endpoints require admin authentication.

Programmatically, import `verifyChain` from `lib/audit-chain.js`:

```javascript
import { verifyChain } from "./lib/audit-chain.js";
const result = await verifyChain("my-workspace-id", { limit: 500 });
// result.valid === false  →  tamper detected
// result.firstBadSequence →  sequence number of the first compromised entry
```

### What tamper evidence looks like

When an entry's fields are modified after the fact, `verifyChain` returns:

```json
{
  "valid": false,
  "entriesChecked": 100,
  "firstBadSequence": 42,
  "verifiedAt": "2026-04-29T00:00:00.000Z"
}
```

`firstBadSequence` identifies the earliest sequence number whose stored `hash`
no longer matches the recomputed value. All entries with `sequence >=
firstBadSequence` should be treated as potentially compromised.

Note that hash-chaining detects tampering with already-written entries but does
not prevent deletion of entries from the end of the log. Pair it with the
on-chain Merkle anchoring provided by `lib/audit-anchor.js` for stronger
non-repudiation guarantees.

### Storage notes

- **JSON-file / SQLite backend**: chain heads are stored as separate
  `audit-chain-head-<workspaceId>.json` files alongside the main
  `execution-audit.json` log.
- **PostgreSQL backend**: the `007_add_audit_chain_columns` migration adds
  `hash TEXT`, `prev_hash TEXT`, and `sequence BIGINT` columns (all
  `DEFAULT NULL`) to the `audit_log` table so existing rows are unaffected.

Implementation: `lib/audit-chain.js` &mdash; tests: `tests/audit-chain.test.js`

---

## GDPR Tooling (Wave 19B)

SiskelBot includes a PII scanner, a DPIA (Data Protection Impact Assessment)
template generator, and self-service data-subject endpoints. These tools
supplement the compliance report endpoints above.

### PII Scanner

`lib/pii-scanner.js` provides synchronous, regex-based PII detection with no
external dependencies. It detects:

| Pattern | Severity |
|---------|----------|
| Email addresses | high |
| US Social Security Numbers (XXX-XX-XXXX) | high |
| Credit card numbers (Luhn-validated, 13–19 digits) | high |
| API keys / tokens (high-entropy strings ≥ 32 chars) | high |
| Phone numbers (E.164 and common US formats) | medium |
| IPv4 and IPv6 addresses | low |
| Names near "name:" labels (best-effort) | low |

**Scan a workspace for PII via the API:**

```bash
curl -X POST https://example.com/api/v1/gdpr/pii-scan \
  -H "x-api-key: $USER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"workspaceId": "my-workspace", "sampleSize": 100}'
```

The response includes:

```json
{
  "workspaceId": "my-workspace",
  "scannedAt": "2026-04-29T12:00:00.000Z",
  "documentsScanned": 45,
  "piiFindings": [
    { "documentId": "abc123", "type": "email", "count": 3 }
  ],
  "summary": { "high": 3, "medium": 0, "low": 0 }
}
```

To redact PII programmatically, use `redactPii(text)` from `lib/pii-scanner.js`.
Each match is replaced with `[REDACTED:<type>]` (e.g. `[REDACTED:email]`).

### DPIA Template Generator

`lib/dpia.js` generates a Markdown DPIA document inferred from the current
environment (enabled features, configured third-party providers, retention
settings). Sections included:

1. Processing description
2. Purpose and legal basis
3. Data categories processed (auto-detected from env vars)
4. Data retention periods (reads `AUDIT_RETENTION_DAYS`)
5. Third-party processors (OpenAI, Stripe, GitHub, Google, Slack, Discord)
6. Risk assessment with mitigations
7. Safeguards already in place
8. Data subject rights and endpoints

**Generate a DPIA via the API:**

```bash
# JSON response
curl -H "x-api-key: $USER_API_KEY" \
  "https://example.com/api/v1/gdpr/dpia?workspaceId=my-workspace"

# Markdown download
curl -H "x-api-key: $USER_API_KEY" \
  -H "Accept: text/markdown" \
  "https://example.com/api/v1/gdpr/dpia?workspaceId=my-workspace" \
  -o dpia-my-workspace.md
```

> **Important:** The generated DPIA is a starting point. It must be reviewed
> and validated by a qualified Data Protection Officer before being used for
> regulatory purposes.

### Self-Service Data-Subject Endpoints

These endpoints allow authenticated users to exercise their GDPR rights
without requiring operator intervention for the initial request. Operators
are responsible for completing the underlying data operations.

| Endpoint | Description |
|----------|-------------|
| `POST /api/v1/gdpr/pii-scan` | Scan workspace for PII (requires `read` scope) |
| `GET  /api/v1/gdpr/dpia` | Generate DPIA template (requires `read` scope) |
| `POST /api/v1/gdpr/data-export` | Queue a data-export job for the authenticated user |
| `POST /api/v1/gdpr/data-deletion` | Queue a data-deletion request (body: `{"confirmation":"DELETE_MY_DATA"}`) |
| `GET  /api/v1/gdpr/data-deletion/status` | Check status of the most recent deletion request |

Data export and deletion are **async operations**. The endpoints return a
`jobId` and `estimatedReadyAt`. Operators must complete the actual data
extraction or deletion and notify the user within 30 days (GDPR Article 12).
Job records are stored in `data/gdpr-jobs.json` (or the active KV backend).

**Request a data deletion:**

```bash
curl -X POST https://example.com/api/v1/gdpr/data-deletion \
  -H "x-api-key: $USER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"confirmation": "DELETE_MY_DATA"}'
```

### Third-Party Processor List

The following third-party processors may receive personal data, depending on
which integrations are enabled (detected from environment variables):

| Processor | Trigger | Data transferred |
|-----------|---------|-----------------|
| **OpenAI** | `OPENAI_API_KEY` set | User prompts and conversation content |
| **Stripe** | `STRIPE_SECRET_KEY` set | Billing email, subscription metadata |
| **GitHub** | `GITHUB_CLIENT_ID` set | OAuth profile (email, username) |
| **Google** | `GOOGLE_CLIENT_ID` set | OAuth profile (email, name) |
| **Slack** | `SLACK_BOT_TOKEN` set | Messages forwarded to the bot |
| **Discord** | `DISCORD_BOT_TOKEN` set | Messages forwarded to the bot |

A Data Processing Agreement (DPA) must be in place with each active processor
before deploying to users in the EU/EEA.

### See also (GDPR tooling)

- `lib/pii-scanner.js` &mdash; PII detection and redaction
- `lib/dpia.js` &mdash; DPIA template generator
- `routes/gdpr.js` &mdash; GDPR HTTP endpoints
- `tests/gdpr.test.js` &mdash; unit and route tests
