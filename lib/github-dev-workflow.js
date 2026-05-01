import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

function workflowPath(workspaceId) {
  return join(getDataDir(), "github-workflows", `${workspaceId}.json`);
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
    "User-Agent": "SiskelBot/1.0",
  };
}

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

async function githubRequest(method, url, body, token) {
  const opts = { method, headers: githubHeaders(token) };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { message: text };
  }
  if (!res.ok) {
    throw new Error(`GitHub API ${method} ${url} → ${res.status}: ${json.message || text}`);
  }
  return json;
}

export async function createWorkflowRun(options) {
  const { workspaceId, owner, repo, issueNumber, branch } = options;
  const path = workflowPath(workspaceId);
  return withPathLock(path, async () => {
    const store = await readJsonPath(path, { runs: [] });
    if (!Array.isArray(store.runs)) store.runs = [];
    const now = Date.now();
    const run = {
      runId: randomUUID(),
      workspaceId,
      owner,
      repo,
      issueNumber,
      branch,
      status: "started",
      createdAt: now,
      updatedAt: now,
      steps: [],
      prNumber: null,
      prUrl: null,
    };
    store.runs.push(run);
    await writeJsonPath(path, store);
    return run;
  });
}

export async function updateWorkflowStep(workspaceId, runId, step) {
  const path = workflowPath(workspaceId);
  return withPathLock(path, async () => {
    const store = await readJsonPath(path, { runs: [] });
    if (!Array.isArray(store.runs)) return null;
    const run = store.runs.find((r) => r.runId === runId);
    if (!run) return null;
    run.steps.push({ ...step, at: step.at || Date.now() });
    run.updatedAt = Date.now();
    if (step.status === "failed") run.status = "failed";
    else if (step.status === "done" && step.name === "push_pr") run.status = "pr_open";
    await writeJsonPath(path, store);
    return run;
  });
}

export async function getWorkflowRun(workspaceId, runId) {
  const path = workflowPath(workspaceId);
  const store = await readJsonPath(path, { runs: [] });
  if (!Array.isArray(store.runs)) return null;
  return store.runs.find((r) => r.runId === runId) || null;
}

export async function listWorkflowRuns(workspaceId) {
  const path = workflowPath(workspaceId);
  const store = await readJsonPath(path, { runs: [] });
  if (!Array.isArray(store.runs)) return [];
  return store.runs.slice().sort((a, b) => b.createdAt - a.createdAt);
}

export async function startWorkflowFromIssue(options) {
  const {
    owner,
    repo,
    issueNumber,
    workspaceId,
    token: optToken,
    sandboxId,
    model,
    maxIterations,
  } = options;
  const token = optToken || process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required");

  const issue = await githubRequest(
    "GET",
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`,
    null,
    token
  );

  const branch = `devin/${issueNumber}-${slugify(issue.title)}`;

  const defaultRef = await githubRequest(
    "GET",
    `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${issue.base?.ref || "main"}`,
    null,
    token
  ).catch(() =>
    githubRequest(
      "GET",
      `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/main`,
      null,
      token
    ).catch(() =>
      githubRequest(
        "GET",
        `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/master`,
        null,
        token
      )
    )
  );

  await githubRequest(
    "POST",
    `https://api.github.com/repos/${owner}/${repo}/git/refs`,
    { ref: `refs/heads/${branch}`, sha: defaultRef.object.sha },
    token
  );

  const run = await createWorkflowRun({
    workspaceId,
    owner,
    repo,
    issueNumber,
    branch,
    sandboxId,
    model,
    maxIterations,
  });

  return {
    workflowRunId: run.runId,
    branch,
    issueTitle: issue.title,
    status: "started",
  };
}

export async function openPullRequest(options) {
  const { owner, repo, branch, base, title, body, token: optToken } = options;
  const token = optToken || process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required");

  const pr = await githubRequest(
    "POST",
    `https://api.github.com/repos/${owner}/${repo}/pulls`,
    { head: branch, base: base || "main", title, body: body || "" },
    token
  );

  return {
    prNumber: pr.number,
    prUrl: pr.html_url,
    prId: pr.id,
  };
}

export async function postReviewComment(options) {
  const { owner, repo, prNumber, body, token: optToken } = options;
  const token = optToken || process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required");

  return githubRequest(
    "POST",
    `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`,
    { body },
    token
  );
}

export async function handlePrReviewWebhook(payload, workspaceId) {
  const eventType = payload.action;
  let prNumber = null;
  let rawComments = [];

  if (payload.pull_request) {
    prNumber = payload.pull_request.number;
  } else if (payload.issue && payload.issue.pull_request) {
    prNumber = payload.issue.number;
  }

  if (payload.review && payload.review.body) {
    rawComments.push({ body: payload.review.body, path: null, line: null });
  }

  if (payload.comment && payload.comment.body) {
    rawComments.push({ body: payload.comment.body, path: null, line: null });
  }

  if (Array.isArray(payload.comments)) {
    for (const c of payload.comments) {
      rawComments.push({ body: c.body || "", path: c.path || null, line: c.line || null });
    }
  }

  if (prNumber === null) return { runId: null, comments: rawComments };

  const path = workflowPath(workspaceId);
  const store = await readJsonPath(path, { runs: [] });
  if (!Array.isArray(store.runs)) return { runId: null, comments: rawComments };

  const run = store.runs.find((r) => r.prNumber === prNumber);
  return { runId: run ? run.runId : null, comments: rawComments };
}
