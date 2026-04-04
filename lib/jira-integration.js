/**
 * Phase 8-R: Jira Integration
 *
 * Configuration:
 *   JIRA_URL - Jira instance URL (e.g. https://myteam.atlassian.net)
 *   JIRA_EMAIL - Jira user email
 *   JIRA_API_TOKEN - API token
 *   JIRA_DEFAULT_PROJECT - default project key
 */

const JIRA_URL = (process.env.JIRA_URL || "").replace(/\/$/, "");
const JIRA_EMAIL = process.env.JIRA_EMAIL || "";
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN || "";
const JIRA_DEFAULT_PROJECT = process.env.JIRA_DEFAULT_PROJECT || "";

const FETCH_TIMEOUT_MS = 15000;

function authHeaders() {
  const token = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64");
  return {
    Authorization: `Basic ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function jiraFetch(path, options = {}) {
  const url = `${JIRA_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: { ...authHeaders(), ...(options.headers || {}) },
    signal: options.signal || AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`Jira API error: HTTP ${res.status} - ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

/**
 * Check whether Jira integration is configured.
 */
export function isJiraConfigured() {
  return Boolean(JIRA_URL && JIRA_EMAIL && JIRA_API_TOKEN);
}

/**
 * Create a Jira issue.
 * @param {string} projectKey - Project key (e.g. "PROJ")
 * @param {string} summary - Issue summary/title
 * @param {string} description - Issue description
 * @param {object} [options] - { issueType?: string, priority?: string, labels?: string[], assignee?: string }
 * @returns {object} Created issue data
 */
export async function createJiraIssue(projectKey, summary, description, options = {}) {
  if (!isJiraConfigured()) throw new Error("Jira not configured");
  const project = projectKey || JIRA_DEFAULT_PROJECT;
  if (!project) throw new Error("Project key is required");
  if (!summary) throw new Error("Summary is required");

  const fields = {
    project: { key: project },
    summary,
    description,
    issuetype: { name: options.issueType || "Task" },
  };
  if (options.priority) fields.priority = { name: options.priority };
  if (Array.isArray(options.labels) && options.labels.length > 0) fields.labels = options.labels;
  if (options.assignee) fields.assignee = { name: options.assignee };

  return jiraFetch("/rest/api/2/issue", {
    method: "POST",
    body: JSON.stringify({ fields }),
  });
}

/**
 * Update a Jira issue.
 * @param {string} issueKey - Issue key (e.g. "PROJ-123")
 * @param {object} fields - Fields to update
 */
export async function updateJiraIssue(issueKey, fields) {
  if (!isJiraConfigured()) throw new Error("Jira not configured");
  if (!issueKey) throw new Error("Issue key is required");

  return jiraFetch(`/rest/api/2/issue/${encodeURIComponent(issueKey)}`, {
    method: "PUT",
    body: JSON.stringify({ fields }),
  });
}

/**
 * Get a single Jira issue by key.
 * @param {string} issueKey - Issue key (e.g. "PROJ-123")
 * @returns {object} Issue data
 */
export async function getJiraIssue(issueKey) {
  if (!isJiraConfigured()) throw new Error("Jira not configured");
  if (!issueKey) throw new Error("Issue key is required");

  return jiraFetch(`/rest/api/2/issue/${encodeURIComponent(issueKey)}`);
}

/**
 * Search Jira issues using JQL.
 * @param {string} jql - JQL query string
 * @returns {object} Search results
 */
export async function searchJiraIssues(jql) {
  if (!isJiraConfigured()) throw new Error("Jira not configured");
  if (!jql) throw new Error("JQL query is required");

  const params = new URLSearchParams({ jql, maxResults: "50" });
  return jiraFetch(`/rest/api/2/search?${params.toString()}`);
}
