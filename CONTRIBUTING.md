# Contributing to SiskelBot

Thank you for your interest in contributing to SiskelBot. This guide covers how to get started, make changes, and submit them for review.

## Getting started

1. **Clone the repository:**
   ```bash
   git clone <repo-url>
   cd SiskelBot
   ```

2. **Install dependencies:**
   ```bash
   npm ci
   ```

3. **Set up environment:**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` to configure your backend (`BACKEND=ollama` is the default). See the README for all environment variables.

4. **Start the development server:**
   ```bash
   npm run dev
   ```
   The app runs at `http://localhost:3000`.

## Development workflow

1. Create a feature branch from `main`:
   ```bash
   git checkout -b my-feature
   ```
2. Make your changes.
3. Run tests and lint:
   ```bash
   npm test
   npm run lint
   ```
4. Commit your changes (see commit message guidelines below).
5. Push and open a pull request.

## Code style

- **ES modules** (`import`/`export`) throughout. No CommonJS `require`.
- **No TypeScript.** Plain JavaScript only.
- **Express patterns.** Routes use standard `(req, res, next)` middleware signatures.
- **Minimal comments.** Prefer clear naming and structure over inline commentary.
- **No build step** for the frontend. Vanilla JS in `client/` served as static files.

## Testing requirements

All tests must pass before a pull request can be merged.

```bash
# Run lint + tests (same as CI)
npm run lint && npm test

# Run a single test file
node --test tests/foo.test.js

# Run with spec reporter
node --test tests/**/*.test.js --test-reporter=spec
```

Tests use the Node.js built-in test runner (`node --test`) with supertest for HTTP assertions. Test files live in `tests/`.

## How to add a new API route

1. Create the route handler. If it belongs to an existing domain, add it to the relevant section in `server.js`. For larger feature areas, create a module in `lib/` and wire it into `server.js`.
2. Use the `dualRegister` pattern to mount routes at both `/api/` (legacy) and `/api/v1/` (current).
3. Use the `apiError` helper for error responses.
4. Add tests in `tests/` covering the new endpoint (happy path, error cases, auth).

## How to add a new lib module

1. Create the module in `lib/` (e.g., `lib/my-feature.js`).
2. Use ES module exports (`export function ...` or `export default`).
3. Import it where needed (typically `server.js` or other `lib/` modules).
4. Add corresponding tests in `tests/` (e.g., `tests/my-feature.test.js`).

## Commit message style

- Use **imperative mood** ("Add feature", not "Added feature" or "Adds feature").
- Keep the first line concise (under 72 characters).
- Reference phase numbers where relevant (e.g., "Phase 21: Add per-user quota enforcement").
- Examples:
  - `Add webhook retry logic with exponential backoff`
  - `Fix circuit breaker cooldown reset on success`
  - `Phase 33: Add WebSocket presence tracking`

## Pull request guidelines

- **Keep PRs focused.** One feature or fix per PR. Avoid mixing unrelated changes.
- **Include test coverage.** New features and bug fixes should have corresponding tests.
- **Describe what changed and why** in the PR description. Include context on the approach taken.
- **Run the full test suite** before submitting: `npm run lint && npm test`.
- PRs that break existing tests will not be merged.

## Bug reports

When filing a bug report, include:

- **Reproduction steps:** Minimal steps to reproduce the issue.
- **Environment details:** Node.js version, OS, backend type (Ollama/vLLM/OpenAI), storage backend.
- **Relevant logs:** Server output, browser console errors, or network responses.
- **Expected vs. actual behavior.**

## Operational documentation

For operational runbooks, troubleshooting guides, and deployment procedures, see [docs/RUNBOOK.md](docs/RUNBOOK.md).
