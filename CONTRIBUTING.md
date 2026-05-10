# Contributing to SiskelBot

Thanks for contributing. This is a practical guide to getting set up, running the project locally, and submitting changes.

## 1. Getting started

```bash
git clone https://github.com/hondoentertainment/SiskelBot.git
cd SiskelBot
npm ci
npm test
```

SiskelBot requires **Node.js >= 18** (see `engines.node` in `package.json`). Node 22 LTS is recommended and is what the devcontainer uses.

## 2. Recommended: devcontainer

The fastest way to get a working environment is to open the repo in VS Code and choose **"Reopen in Container"**. The devcontainer (`.devcontainer/`) ships with Node, Postgres client, Redis tools, `helm`, `kubectl`, `jq`, and the recommended VS Code extensions pre-installed. `npm ci` runs automatically on first create.

If you don't use VS Code, the same image works with any devcontainer-compatible tool (e.g. `devcontainer` CLI, JetBrains Gateway).

## 3. Local dev workflow

```bash
npm run dev          # auto-reload server (node --watch)
npm run lint         # before committing
npm test             # full test suite
```

The dev server listens on port **3000**.

To run against a local Ollama backend:

```bash
BACKEND=ollama OLLAMA_URL=http://localhost:11434 npm run dev
```

See `.env.example` for the full list of environment variables. Copy it to `.env` and edit as needed.

## 4. Project structure

A quick tour of the top-level layout:

- `server.js` + `routes/` — Express app and HTTP/WebSocket routes
- `lib/` — business logic (agents, storage, knowledge graph, workflows, etc.)
- `client/` — vanilla JS SPA, served as static files (no build step required for development)
- `tests/` — Node built-in test runner + supertest
- `docs/` — operator and contributor deep-dive docs
- `bin/siskelbot.js` — `siskelbot` CLI entry point
- `scripts/` — build, lint, test, migrate, OpenAPI, eval, and load-test helpers

For an architecture deep-dive, see `CLAUDE.md` and the docs under `docs/` (e.g. `ARCHITECTURE.md`, `DEPLOYMENT.md`, `AGENT_MODE.md`).

## 5. Code conventions

Pulled from `CLAUDE.md`:

- **ES modules only** (`import`/`export`). No CommonJS `require`. Files are `.js` with `"type": "module"` in `package.json`. Electron-side CommonJS lives in `electron/*.cjs`.
- **No TypeScript.** `jsconfig.json` and `tsconfig.json` exist for editor hints only — do not add `.ts` files.
- **No new build tooling for client code.** If you touch `client/`, keep it plain JS that runs in the browser directly.
- **Imperative commit messages** ("Add X", "Fix Y"). Phase numbers are sometimes used (e.g. `Phase 33: Add WebSocket presence tracking`) — match what's already on the branch.
- **Minimal comments.** The repo prefers self-documenting code.

## 6. Tests

- `npm test` — runs the full suite via `scripts/run-tests.mjs` (Node built-in runner + supertest)
- `npm run test:coverage` — c8 coverage with the critical-path gate
- `npm run test:ci` — what CI runs (coverage + critical-path gate, CI mode)
- `npm run test:e2e` — Playwright (requires `npx playwright install` first)
- `npm run test:chaos` — chaos suite (slower; intentional failure injection)
- `npm run test:load` — load test via `scripts/load-test.mjs`
- `npm run eval:golden` — offline golden JSON gate (`data/eval-sets/golden.json`, no server; runs in CI lint job)
- `npm run eval:ci` — eval set regression gate

Single test file:

```bash
node --test tests/foo.test.js
```

When adding a test, match patterns in `tests/health-deep.test.js` or `tests/server.test.js`.

### Deployment (GitHub + Vercel)

- **GitHub:** Push branches and open PRs against `main`. CI runs on every PR (lint, tests, smoke, golden evals, etc.).
- **Vercel previews:** In the [Vercel dashboard](https://vercel.com), link this GitHub repo so each PR receives a **Preview** deployment automatically.
- **Production:** Merge to `main` triggers Production when Git integration is enabled; you can also deploy from a trusted machine with `npx vercel deploy --prod --yes` from the repo root (requires `vercel link` once).
- **Smoke checks:** After deploy, `npm run smoke-test -- https://your-deployment.vercel.app` (or set `BASE_URL`). CI runs offline golden evals via `npm run eval:golden`; the **Production smoke** workflow exercises live `/health/live` and `/config` on a schedule.
- **Workspace root:** Open the repository folder that contains `package.json` and `.git` (not an empty parent directory).

## 7. Submitting a PR

1. Branch from `main`: `git checkout -b your-branch-name`
2. Make your changes, then run:
   ```bash
   npm run lint && npm test
   ```
3. Commit with an imperative-mood message.
4. Push your branch and open a PR against `main`.
5. CI runs lint, test, smoke, e2e, load, evals, CodeQL, and Trivy. Fix any failures before requesting review.

The PR template is at `.github/PULL_REQUEST_TEMPLATE.md`.

## 8. Reporting bugs

Use the issue templates under `.github/ISSUE_TEMPLATE/` (`bug_report.yml`, `feature_request.yml`, `plugin_submission.yml`). Include reproduction steps, environment details (Node version, OS, backend, storage), and relevant logs.

## 9. Security

**Do not open public issues for security vulnerabilities.** See `SECURITY.md` for the disclosure policy. If `SECURITY.md` is missing, email `security@hondoentertainment.com`.
