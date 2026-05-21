# Repo RAG (Phase 63.1)

Workspace-scoped **keyword / token index** over repository file contents. Each index entry records **repo id, file path, line number, and token counts** so search results can cite lines. This is **not** embedding RAG: there is no vector store or LLM retrieval in this module.

## Purpose

- **Index**: replace all prior postings for a `(workspaceId, repoId)` pair with a fresh inverted index built from supplied `files[{ path, content, language? }]`.
- **Search**: tokenize the query, intersect posting lists, rank by summed term frequency (TF) per `(repoId, path)`.
- **Admin**: stats, list repos, delete a repo’s index and metadata.

## HTTP routes

Registered with **`apiRoute`**: **`/api/v1`** + suffix below, and legacy **`/api`** + suffix (deprecation headers). All use **`adminAuth`**.

| Method | Path | Notes |
|--------|------|--------|
| `POST` | `/repo-rag/index` | Body: `workspaceId?`, **`repoId`** (required), **`files`** (required array). Each file: `{ path, content?, language? }` |
| `GET` | `/repo-rag/search` | Query: `workspaceId?`, **`query`**, `limit?` |
| `GET` | `/repo-rag/stats` | Query: `workspaceId?` |
| `GET` | `/repo-rag/repos` | Query: `workspaceId?` |
| `DELETE` | `/repo-rag/repos/:repoId` | Query: `workspaceId?` — **204** if removed, **404** if unknown |

Missing `workspaceId` resolves to sanitized **`"default"`** (same helper as other Phase 63 stores).

## Environment and storage

No repo-RAG-specific environment variables. State lives at `data/repo-rag/{workspaceId}.json` under `getDataDir()` / `STORAGE_PATH`, with optional Postgres or SQLite KV via `json-path-store` (same as PR review).

## Tokenization and languages

- **Tokenizer**: lowercase, split on non-word chars; keep tokens with length **2–63** inclusive.
- **Language**: optional per file; otherwise inferred from extension via a fixed map (`js/ts/py/go/...` → label; unknown → `"plaintext"`).

Inputs with empty or missing **content** still create a file record with **zero** line tokens.

## Limits (implemented)

| Item | Behavior |
|------|----------|
| Search `limit` | Parsed as number; clamped to **[1, 500]**; default **20** |
| Hit `lines` in response | Up to **20** distinct line numbers per `(repoId, path)` |
| Index size | **Env caps:** `REPO_RAG_MAX_FILES` (default **5000**), `REPO_RAG_MAX_BYTES` (default **50 MiB**). Exceeding returns **413** on index. |

Re-indexing the same `repoId` **clears** that repo’s postings before inserting the new corpus (atomic per file lock).

## Failure modes

- **400** on index if `repoId` missing or `files` not an array (`routes/repo-rag.js`).
- **500** from `lib` if `repoId` empty after sanitize, or **`files`** not an array (stricter guard in library).
- **404** on delete when repo id not present.
- **Empty search**: whitespace-only or tokenless query → `{ hits: [] }` without error.
- **Operational risk**: huge `files[]` payloads in one POST can stress CPU/memory (full pass per file, per-line token map).

There is **no quota or rate limit** implemented inside this route module beyond global server middleware.

## Human-in-the-loop (HITL)

**None.** No connection to `agent-hitl-store` or approval flows.

## Disabling or reducing exposure

- Remove **`mountRepoRagRoutes`** from `routes/index.js` for deployments that should not expose indexing.
- Protect with **`adminAuth`** and network ACLs.
- **`DELETE /repo-rag/repos/:repoId`** removes one repo’s data from the workspace store; wiping the workspace file clears everything for that tenant key.

Developer hook: **`_reset(workspaceId?)`** in `lib/repo-rag.js` clears store in tests—**not** a public operator endpoint.
