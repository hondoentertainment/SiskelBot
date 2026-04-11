/**
 * Runbook automation: generate incident response playbooks from templates
 * and recent audit/metric data.
 *
 * Phase 31.5 — On-call runbook automation.
 *
 * Provides a catalog of named incident templates (symptoms, severity,
 * investigation steps, commands, metric queries) and two generation helpers:
 *   - generateIncidentRunbook(incident) — returns a runbook enriched with
 *     recent audit events and current system metrics.
 *   - generateIncidentReport(incident, resolution) — returns a post-mortem
 *     report suitable for archiving alongside the incident record.
 */

const RUNBOOK_TEMPLATES = {
  high_error_rate: {
    title: "High Error Rate",
    symptoms: [
      "5xx errors > 5% of requests",
      "User-facing failures or failed chat completions",
      "Error-rate alerts firing in Grafana",
    ],
    severity: "high",
    steps: [
      "Check /health/ready — is the server reachable and backend connected?",
      "Check /metrics for error rate trend over the last hour",
      "Check circuit breaker state: GET /api/v1/admin/routing/stats",
      "Check backend connectivity (Ollama/vLLM/OpenAI status pages)",
      "Check recent deployments — rollback if correlated with error onset",
      "Scale up replicas if the spike is traffic-related",
      "Inspect audit log for repeated failures from a single workspace/user",
    ],
    commands: [
      "curl http://localhost:3000/health/ready",
      "curl http://localhost:3000/metrics | grep http_requests_total",
      "curl -H 'x-admin-key: $ADMIN_API_KEY' http://localhost:3000/api/v1/admin/routing/stats",
    ],
    metrics: [
      'http_requests_total{status=~"5.."}',
      "experimentagent_circuit_breaker_open",
      "backend_request_failures_total",
    ],
    remediation: [
      "Rollback recent deployment if correlated",
      "Open circuit breaker manually via admin endpoint if backend is flapping",
      "Scale replicas horizontally via deployment config",
    ],
    prevention: [
      "Set conservative circuit-breaker thresholds",
      "Add canary deploys and automated rollback on error-rate SLO breach",
      "Enforce per-key rate limits to protect the backend",
    ],
  },

  latency_spike: {
    title: "Latency Spike",
    symptoms: [
      "p95 latency > 2x baseline",
      "Streaming stalls, clients timing out",
      "Latency alerts firing",
    ],
    severity: "medium",
    steps: [
      "Check /metrics for p50/p95/p99 latency histograms",
      "Check backend latency (Ollama/vLLM inference time)",
      "Check CPU and memory utilisation on app hosts",
      "Check for ongoing batch jobs / scheduled tasks consuming resources",
      "Inspect recent chat-completion trace spans for slow segments",
      "Check database pool health: GET /api/v1/admin/pool-health",
    ],
    commands: [
      "curl http://localhost:3000/metrics | grep request_duration",
      "curl http://localhost:3000/health/integrations",
    ],
    metrics: [
      'http_request_duration_seconds{quantile="0.95"}',
      "backend_request_duration_seconds",
      "db_pool_in_use",
    ],
    remediation: [
      "Pause non-critical scheduled jobs until latency recovers",
      "Route traffic away from slow backend via smart router",
      "Shed load by lowering rate limits temporarily",
    ],
    prevention: [
      "Enforce request timeouts via REQUEST_TIMEOUT_MS",
      "Autoscale workers based on latency targets",
      "Stagger scheduled job windows",
    ],
  },

  quota_exhausted: {
    title: "Quota Exhausted",
    symptoms: [
      "429 responses from /v1/chat/completions",
      "Workspaces reporting 'quota exceeded' errors",
      "Usage dashboard shows workspaces at 100% of limit",
    ],
    severity: "medium",
    steps: [
      "Identify affected workspaces via GET /api/v1/usage?workspace=...",
      "Check quota configuration for the workspace",
      "Verify the user is using the correct workspace",
      "Check for runaway agent loops generating excessive requests",
      "If legitimate growth, raise the quota limit",
    ],
    commands: [
      "curl -H 'authorization: Bearer $API_KEY' http://localhost:3000/api/v1/usage",
      "curl -H 'x-admin-key: $ADMIN_API_KEY' http://localhost:3000/api/v1/admin/quotas",
    ],
    metrics: [
      "workspace_quota_used",
      'http_requests_total{status="429"}',
    ],
    remediation: [
      "Temporarily raise quota for the affected workspace",
      "Identify and stop runaway agent sessions",
      "Apply stricter per-user rate limits inside the workspace",
    ],
    prevention: [
      "Alert at 80% quota consumption instead of 100%",
      "Cap agent-loop iterations and require HITL for high-cost tools",
    ],
  },

  backend_down: {
    title: "Backend Down",
    symptoms: [
      "All chat completions failing",
      "/health/ready returns not ready with backend error",
      "Circuit breaker is open",
    ],
    severity: "critical",
    steps: [
      "Check backend health directly (curl $OLLAMA_URL or $VLLM_URL)",
      "Check backend process/container status",
      "Check network connectivity from app host to backend host",
      "Check backend logs for crash or OOM",
      "Restart backend if unresponsive",
      "If OpenAI backend, check https://status.openai.com",
      "Switch to fallback backend via BACKEND env change + restart",
    ],
    commands: [
      "curl $OLLAMA_URL/api/tags",
      "curl http://localhost:3000/health/ready",
      "curl http://localhost:3000/health/integrations",
    ],
    metrics: [
      "backend_up",
      "experimentagent_circuit_breaker_open",
      "backend_request_failures_total",
    ],
    remediation: [
      "Restart the backend process",
      "Failover to a healthy region via region-health router",
      "Switch BACKEND env variable to a healthy provider and restart",
    ],
    prevention: [
      "Run multiple backend replicas behind a load balancer",
      "Configure multi-region failover",
      "Monitor backend liveness with short-interval probes",
    ],
  },

  database_slow: {
    title: "Database Slow",
    symptoms: [
      "Storage operations taking >1s",
      "Pool exhaustion warnings in logs",
      "API endpoints timing out on storage-heavy paths",
    ],
    severity: "high",
    steps: [
      "Check pool health: GET /api/v1/admin/pool-health",
      "Check database server CPU, memory, and disk IO",
      "Look for long-running queries or lock contention",
      "Check for missing indexes on hot tables",
      "Check for recent schema migrations that may have locked tables",
      "Consider failing over to a read replica if one is available",
    ],
    commands: [
      "curl -H 'x-admin-key: $ADMIN_API_KEY' http://localhost:3000/api/v1/admin/pool-health",
      "curl http://localhost:3000/metrics | grep db_",
    ],
    metrics: [
      "db_query_duration_seconds",
      "db_pool_in_use",
      "db_pool_waiting",
    ],
    remediation: [
      "Kill long-running queries",
      "Raise pool size temporarily",
      "Failover to read replica",
    ],
    prevention: [
      "Run EXPLAIN on hot queries during load tests",
      "Set statement_timeout on database",
      "Regularly review slow-query logs",
    ],
  },

  webhook_dlq_growing: {
    title: "Webhook DLQ Growing",
    symptoms: [
      "Webhook delivery dead-letter queue size increasing",
      "External consumers reporting missed events",
      "Retry backlog alerts firing",
    ],
    severity: "medium",
    steps: [
      "Check DLQ size: GET /api/v1/webhooks/dlq",
      "Inspect DLQ entries for common error patterns",
      "Check downstream endpoints for availability",
      "Verify webhook signing keys have not rotated unexpectedly",
      "Replay DLQ entries once downstream is healthy",
    ],
    commands: [
      "curl -H 'authorization: Bearer $API_KEY' http://localhost:3000/api/v1/webhooks/dlq",
    ],
    metrics: [
      "webhook_dlq_size",
      "webhook_delivery_failures_total",
    ],
    remediation: [
      "Pause webhook delivery to failing consumer",
      "Contact consumer operator if 5xx persist",
      "Replay DLQ after downstream recovery",
    ],
    prevention: [
      "Set alert on DLQ size > threshold",
      "Validate webhook endpoints on registration",
      "Apply exponential backoff with capped retries",
    ],
  },

  memory_leak: {
    title: "Memory Leak",
    symptoms: [
      "Process RSS growing unbounded",
      "OOM kills recurring",
      "GC pauses increasing",
    ],
    severity: "high",
    steps: [
      "Check process memory over time in Grafana",
      "Capture heap snapshot via Node inspector",
      "Correlate growth with deployed version or workload type",
      "Restart affected instances to restore capacity",
      "Roll back to last known-good version if growth is recent",
    ],
    commands: [
      "node --inspect=0.0.0.0:9229 server.js",
      "ps -o rss= -p $(pgrep -f 'node .*server.js')",
    ],
    metrics: [
      "process_resident_memory_bytes",
      "nodejs_heap_size_used_bytes",
      "nodejs_gc_duration_seconds",
    ],
    remediation: [
      "Rolling restart of affected replicas",
      "Roll back to last healthy version",
      "Set conservative --max-old-space-size",
    ],
    prevention: [
      "Run periodic heap-growth regression tests",
      "Alert on RSS growth trend across restarts",
      "Use WeakRefs/caches with bounded size",
    ],
  },

  disk_full: {
    title: "Disk Full",
    symptoms: [
      "Write failures in storage layer",
      "Log rotation failing",
      "Alerts on disk utilisation > 90%",
    ],
    severity: "high",
    steps: [
      "Check disk usage: df -h",
      "Identify largest directories under data/ and logs/",
      "Trim audit archive via audit-trim CLI",
      "Rotate and compress old logs",
      "Run a backup and prune older backups",
      "Extend volume if underlying infra allows",
    ],
    commands: [
      "df -h",
      "du -sh /home/user/SiskelBot/data/*",
      "du -sh /home/user/SiskelBot/backups/*",
    ],
    metrics: [
      "node_filesystem_avail_bytes",
      "node_filesystem_size_bytes",
    ],
    remediation: [
      "Delete old backups and audit archives",
      "Rotate logs immediately",
      "Extend disk volume",
    ],
    prevention: [
      "Alert on disk > 80%",
      "Schedule periodic audit trim",
      "Archive old data to object storage",
    ],
  },
};

/**
 * Return a runbook template by name.
 * @param {string} name
 * @returns {object|null}
 */
export function getRunbook(name) {
  if (!name || typeof name !== "string") return null;
  const tpl = RUNBOOK_TEMPLATES[name];
  if (!tpl) return null;
  return { name, ...tpl };
}

/**
 * List all runbook template names and titles.
 * @returns {Array<{ name: string, title: string, severity: string }>}
 */
export function listRunbooks() {
  return Object.entries(RUNBOOK_TEMPLATES).map(([name, tpl]) => ({
    name,
    title: tpl.title,
    severity: tpl.severity,
    symptoms: tpl.symptoms,
  }));
}

/**
 * Attempt to gather a small snapshot of recent audit entries and current
 * metrics for runbook enrichment. Both lookups are best-effort: any failure
 * falls through to an empty snapshot so generation never throws.
 *
 * @returns {Promise<{ audit: Array<object>, metrics: object|null, collectedAt: string }>}
 */
async function collectSystemSnapshot() {
  const snapshot = { audit: [], metrics: null, collectedAt: new Date().toISOString() };
  try {
    const mod = await import("./audit-query.js");
    if (typeof mod.queryAudit === "function") {
      const q = await mod.queryAudit({ limit: 10 });
      snapshot.audit = Array.isArray(q?.entries) ? q.entries.slice(0, 10) : [];
    }
  } catch (_) {
    // best-effort: audit store may be unavailable in tests
  }
  try {
    const mod = await import("./metrics.js");
    if (typeof mod.getMetricsSnapshot === "function") {
      snapshot.metrics = await mod.getMetricsSnapshot();
    } else if (typeof mod.snapshot === "function") {
      snapshot.metrics = await mod.snapshot();
    }
  } catch (_) {
    // best-effort: metrics may be disabled
  }
  return snapshot;
}

/**
 * Generate an incident runbook enriched with recent system state.
 *
 * @param {object} incident
 * @param {string} incident.type - runbook template name (e.g. "high_error_rate")
 * @param {string} [incident.severity]
 * @param {string} [incident.startTime] - ISO 8601
 * @param {object} [incident.metrics] - incident-specific metric values
 * @param {string} [incident.description]
 * @returns {Promise<object>}
 */
export async function generateIncidentRunbook(incident) {
  if (!incident || typeof incident !== "object") {
    throw new Error("incident is required");
  }
  const type = incident.type;
  if (!type || typeof type !== "string") {
    throw new Error("incident.type is required");
  }
  const template = RUNBOOK_TEMPLATES[type];
  if (!template) {
    throw new Error(`Unknown runbook type: ${type}`);
  }

  const snapshot = await collectSystemSnapshot();

  const generatedAt = new Date().toISOString();
  const incidentId =
    "inc_" +
    Date.now().toString(36) +
    "_" +
    Math.random().toString(36).slice(2, 8);

  return {
    _version: 1,
    incidentId,
    generatedAt,
    incident: {
      type,
      severity: incident.severity || template.severity,
      startTime: incident.startTime || generatedAt,
      description: incident.description || null,
      metrics: incident.metrics || null,
    },
    runbook: {
      name: type,
      title: template.title,
      severity: template.severity,
      symptoms: template.symptoms,
      steps: template.steps,
      commands: template.commands,
      metrics: template.metrics,
      remediation: template.remediation || [],
      prevention: template.prevention || [],
    },
    context: {
      recentAudit: snapshot.audit,
      currentMetrics: snapshot.metrics,
      collectedAt: snapshot.collectedAt,
    },
  };
}

/**
 * Generate a post-mortem report for a resolved incident.
 *
 * @param {object} incident - incident record
 * @param {object} resolution
 * @param {Array<{ at: string, note: string }>} [resolution.timeline]
 * @param {Array<string>} [resolution.actionsRun]
 * @param {string} [resolution.outcome]
 * @param {string} [resolution.owner]
 * @returns {Promise<object>}
 */
export async function generateIncidentReport(incident, resolution) {
  if (!incident || typeof incident !== "object") {
    throw new Error("incident is required");
  }
  if (!resolution || typeof resolution !== "object") {
    throw new Error("resolution is required");
  }
  const type = incident.type || "unknown";
  const template = RUNBOOK_TEMPLATES[type] || null;

  const start = incident.startTime ? Date.parse(incident.startTime) : null;
  const end = resolution.endTime ? Date.parse(resolution.endTime) : Date.now();
  const durationMs = start && Number.isFinite(start) ? Math.max(0, end - start) : null;

  const timeline = Array.isArray(resolution.timeline) ? resolution.timeline.slice() : [];
  const actionsRun = Array.isArray(resolution.actionsRun) ? resolution.actionsRun.slice() : [];

  const generatedAt = new Date().toISOString();
  const reportId =
    "pm_" +
    Date.now().toString(36) +
    "_" +
    Math.random().toString(36).slice(2, 8);

  const summaryLines = [
    `# Post-Mortem: ${template?.title || type}`,
    "",
    `- Incident ID: ${incident.id || "n/a"}`,
    `- Type: ${type}`,
    `- Severity: ${incident.severity || template?.severity || "unknown"}`,
    `- Started: ${incident.startTime || "unknown"}`,
    `- Ended: ${resolution.endTime || new Date(end).toISOString()}`,
    `- Duration: ${durationMs != null ? Math.round(durationMs / 1000) + "s" : "unknown"}`,
    `- Owner: ${resolution.owner || "unassigned"}`,
    `- Outcome: ${resolution.outcome || "resolved"}`,
    "",
    "## Timeline",
    ...(timeline.length
      ? timeline.map((t) => `- ${t.at || ""}: ${t.note || ""}`)
      : ["- (no timeline entries recorded)"]),
    "",
    "## Actions Run",
    ...(actionsRun.length ? actionsRun.map((a) => `- ${a}`) : ["- (no actions recorded)"]),
    "",
    "## Prevention",
    ...(template?.prevention?.length
      ? template.prevention.map((p) => `- ${p}`)
      : ["- (no prevention notes)"]),
    "",
  ];

  return {
    _version: 1,
    reportId,
    generatedAt,
    incident: {
      id: incident.id || null,
      type,
      severity: incident.severity || template?.severity || "unknown",
      startTime: incident.startTime || null,
      endTime: resolution.endTime || new Date(end).toISOString(),
      durationMs,
    },
    resolution: {
      owner: resolution.owner || null,
      outcome: resolution.outcome || "resolved",
      timeline,
      actionsRun,
    },
    prevention: template?.prevention || [],
    markdown: summaryLines.join("\n"),
  };
}
