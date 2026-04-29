import { join } from "path";
import { writeJsonPath, readJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const DEFAULT_RETENTION_DAYS = 90;

function dpiaStorePath() {
  return join(getDataDir(), "dpia-records.json");
}

export function generateDpiaTemplate(config = {}) {
  const now = new Date().toISOString();
  const description = config.description || "SiskelBot — AI assistant proxy and workspace platform";
  const retentionDays = process.env.AUDIT_RETENTION_DAYS
    ? parseInt(process.env.AUDIT_RETENTION_DAYS, 10)
    : DEFAULT_RETENTION_DAYS;

  const dataCategories = ["Conversation data (user prompts, assistant responses)"];
  dataCategories.push("Authentication data (API keys, session tokens, email addresses)");
  dataCategories.push("Usage and telemetry data (request counts, latency, feature usage)");
  if (process.env.EMBEDDING_BACKEND || process.env.OPENAI_API_KEY) {
    dataCategories.push("Knowledge documents and embeddings (uploaded files, chunked text, vector representations)");
  }
  if (process.env.STRIPE_SECRET_KEY) {
    dataCategories.push("Billing data (subscription plan, payment status — processed by Stripe)");
  }
  if (process.env.GITHUB_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || process.env.OIDC_ISSUER || process.env.SAML_ENTRY_POINT) {
    dataCategories.push("SSO/OAuth attributes (profile name, email, provider ID from external identity providers)");
  }

  const thirdParties = [];
  if (process.env.OPENAI_API_KEY) {
    thirdParties.push("**OpenAI** — LLM inference (prompts and completions transmitted for processing; subject to OpenAI data processing addendum)");
  }
  if (process.env.STRIPE_SECRET_KEY) {
    thirdParties.push("**Stripe** — Payment processing (billing email, subscription metadata; subject to Stripe DPA)");
  }
  if (process.env.GITHUB_CLIENT_ID) {
    thirdParties.push("**GitHub** — OAuth SSO provider (profile email and username returned on login)");
  }
  if (process.env.GOOGLE_CLIENT_ID) {
    thirdParties.push("**Google** — OAuth SSO provider (profile email and name returned on login)");
  }
  if (process.env.SLACK_BOT_TOKEN || process.env.SLACK_SIGNING_SECRET) {
    thirdParties.push("**Slack** — Bot integration (workspace messages forwarded for processing)");
  }
  if (process.env.DISCORD_BOT_TOKEN) {
    thirdParties.push("**Discord** — Bot integration (guild messages forwarded for processing)");
  }
  if (thirdParties.length === 0) {
    thirdParties.push("No third-party processors currently configured.");
  }

  const lines = [
    `# Data Protection Impact Assessment (DPIA)`,
    ``,
    `**Generated:** ${now}  `,
    `**System:** SiskelBot  `,
    `**Version:** 1.0  `,
    ``,
    `---`,
    ``,
    `## 1. Processing Description`,
    ``,
    description,
    ``,
    `SiskelBot acts as a realtime streaming assistant proxy, routing user prompts to configured`,
    `LLM backends (Ollama, vLLM, OpenAI) and returning streamed completions. It also manages`,
    `workspaces, user authentication, knowledge bases, agent orchestration, and integrations`,
    `with external developer tools.`,
    ``,
    `---`,
    ``,
    `## 2. Purpose and Legal Basis`,
    ``,
    `| Purpose | Legal Basis |`,
    `|---------|-------------|`,
    `| Providing AI assistant services to authenticated users | Legitimate interests / contractual necessity |`,
    `| Storing conversation history for continuity | Legitimate interests (user benefit) |`,
    `| Security and audit logging | Legal obligation / legitimate interests |`,
    `| Knowledge base indexing and search | Legitimate interests / user consent |`,
    `| Billing and subscription management | Contractual necessity |`,
    ``,
    `---`,
    ``,
    `## 3. Data Categories Processed`,
    ``,
    ...dataCategories.map((c) => `- ${c}`),
    ``,
    `---`,
    ``,
    `## 4. Data Retention Periods`,
    ``,
    `| Data Type | Retention |`,
    `|-----------|-----------|`,
    `| Conversation messages | Until user deletion or workspace deletion |`,
    `| Knowledge documents | Until explicitly deleted by user |`,
    `| Audit logs | ${retentionDays} days (configurable via \`AUDIT_RETENTION_DAYS\`) |`,
    `| API keys | Until revoked by user or administrator |`,
    `| Usage/telemetry | Aggregated; raw data retained for ${retentionDays} days |`,
    `| Billing records | As required by financial regulations (typically 7 years) |`,
    ``,
    `---`,
    ``,
    `## 5. Third-Party Processors`,
    ``,
    ...thirdParties.map((t) => `- ${t}`),
    ``,
    `Operators must ensure a Data Processing Agreement (DPA) is in place with each`,
    `third-party processor before going live in an EU/EEA deployment.`,
    ``,
    `---`,
    ``,
    `## 6. Risk Assessment`,
    ``,
    `| Risk | Likelihood | Impact | Mitigation |`,
    `|------|------------|--------|------------|`,
    `| Unauthorised access to conversation data | Medium | High | API key auth + RBAC + TLS in transit |`,
    `| PII in conversation logs | Medium | High | Log sanitizer redacts keys; PII scan tooling available |`,
    `| Data breach via compromised API key | Low | High | Key rotation, audit logging, rate limiting |`,
    `| LLM provider data retention | Medium | Medium | Use provider DPAs; consider self-hosted Ollama/vLLM |`,
    `| Cross-workspace data leakage | Low | High | Storage scoped by userId + workspaceId |`,
    `| Backup data not erased after DSR | Medium | Medium | Coordinate backup lifecycle with erasure policy |`,
    ``,
    `---`,
    ``,
    `## 7. Safeguards`,
    ``,
    `- **Encryption in transit:** TLS enforced for all external connections.`,
    `- **Encryption at rest:** Optional field-level encryption via \`FIELD_ENCRYPTION_KEY\`.`,
    `- **Access controls:** RBAC with scoped API keys (read/write/admin/embed).`,
    `- **Audit logging:** All sensitive operations recorded in the audit log.`,
    `- **Rate limiting:** Per-user and per-workspace rate limits prevent abuse.`,
    `- **Log sanitization:** \`lib/log-sanitizer.js\` redacts secrets from logs automatically.`,
    `- **PII scanning:** \`lib/pii-scanner.js\` can detect and redact PII in content.`,
    `- **Data residency:** Workspace data can be pinned to a geographic region.`,
    `- **Circuit breaker:** Backend failures isolated; no uncontrolled data forwarding.`,
    ``,
    `---`,
    ``,
    `## 8. Data Subject Rights`,
    ``,
    `| Right | Implementation |`,
    `|-------|---------------|`,
    `| Right of access (Art. 15) | \`POST /api/v1/compliance/data-subject-request?userId=X\` |`,
    `| Right to erasure (Art. 17) | \`POST /api/v1/compliance/right-to-erasure?userId=X&confirm=true\` |`,
    `| Right to portability (Art. 20) | \`GET /api/v1/compliance/export/:userId?format=json\` |`,
    `| Right to deletion (self-service) | \`POST /api/v1/gdpr/data-deletion\` (requires \`confirmation\`) |`,
    `| Right to export (self-service) | \`POST /api/v1/gdpr/data-export\` |`,
    ``,
    `Operators must respond to verified data subject requests within 30 days (GDPR Article 12).`,
    ``,
    `---`,
    ``,
    `*This DPIA was auto-generated by SiskelBot. It must be reviewed and validated by a`,
    `qualified Data Protection Officer before being relied upon for regulatory purposes.*`,
  ];

  return lines.join("\n");
}

export async function generateAndSaveDpia(workspaceId, config = {}) {
  const markdown = generateDpiaTemplate(config);
  const generatedAt = new Date().toISOString();
  const key = `dpia:${workspaceId}:${Date.now()}`;

  const storePath = dpiaStorePath();
  await withPathLock(storePath, async () => {
    const data = await readJsonPath(storePath, { _version: 1, records: [] });
    if (!Array.isArray(data.records)) data.records = [];
    data.records.push({ key, workspaceId, generatedAt });
    await writeJsonPath(storePath, data);
  });

  return { key, markdown, generatedAt };
}
