/**
 * Phase 8-R: Linear Integration
 *
 * Configuration:
 *   LINEAR_API_KEY - Linear API key
 *   LINEAR_DEFAULT_TEAM - default team ID
 */

const LINEAR_API_KEY = process.env.LINEAR_API_KEY || "";
const LINEAR_DEFAULT_TEAM = process.env.LINEAR_DEFAULT_TEAM || "";
const LINEAR_API_URL = "https://api.linear.app/graphql";
const FETCH_TIMEOUT_MS = 15000;

async function linearGql(query, variables = {}) {
  const res = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      Authorization: LINEAR_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`Linear API error: HTTP ${res.status} - ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  if (data.errors && data.errors.length > 0) {
    throw new Error(`Linear GraphQL error: ${data.errors[0].message}`);
  }
  return data.data;
}

/**
 * Check whether Linear integration is configured.
 */
export function isLinearConfigured() {
  return Boolean(LINEAR_API_KEY);
}

/**
 * Create a Linear issue.
 * @param {string} teamId - Team ID
 * @param {string} title - Issue title
 * @param {string} description - Issue description (markdown)
 * @param {object} [options] - { priority?: number, labels?: string[], assigneeId?: string, stateId?: string }
 * @returns {object} Created issue data
 */
export async function createLinearIssue(teamId, title, description, options = {}) {
  if (!isLinearConfigured()) throw new Error("Linear not configured");
  const team = teamId || LINEAR_DEFAULT_TEAM;
  if (!team) throw new Error("Team ID is required");
  if (!title) throw new Error("Title is required");

  const input = {
    teamId: team,
    title,
    description: description || "",
  };
  if (options.priority != null) input.priority = options.priority;
  if (options.assigneeId) input.assigneeId = options.assigneeId;
  if (options.stateId) input.stateId = options.stateId;
  if (Array.isArray(options.labels) && options.labels.length > 0) {
    input.labelIds = options.labels;
  }

  const data = await linearGql(
    `mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue {
          id
          identifier
          title
          url
          state { name }
          createdAt
        }
      }
    }`,
    { input },
  );
  return data.issueCreate;
}

/**
 * Update a Linear issue.
 * @param {string} issueId - Issue ID
 * @param {object} fields - Fields to update (title, description, stateId, priority, assigneeId)
 * @returns {object} Updated issue data
 */
export async function updateLinearIssue(issueId, fields) {
  if (!isLinearConfigured()) throw new Error("Linear not configured");
  if (!issueId) throw new Error("Issue ID is required");

  const data = await linearGql(
    `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success
        issue {
          id
          identifier
          title
          url
          state { name }
          updatedAt
        }
      }
    }`,
    { id: issueId, input: fields },
  );
  return data.issueUpdate;
}

/**
 * Search Linear issues by query text.
 * @param {string} query - Search query
 * @returns {object} Search results
 */
export async function searchLinearIssues(query) {
  if (!isLinearConfigured()) throw new Error("Linear not configured");
  if (!query) throw new Error("Query is required");

  const data = await linearGql(
    `query SearchIssues($query: String!) {
      searchIssues(query: $query, first: 50) {
        nodes {
          id
          identifier
          title
          description
          url
          state { name }
          priority
          assignee { name email }
          createdAt
          updatedAt
        }
      }
    }`,
    { query },
  );
  return data.searchIssues;
}
