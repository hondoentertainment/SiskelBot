# Knowledge / RAG pipeline v2 (Phase 72)

This document describes server-side knowledge indexing, chunking, semantic refresh, and URL ingestion.

## Storage layout

- Per-workspace JSON indexes live under `data/knowledge/{workspace}.json` (or `KNOWLEDGE_DATA_DIR`).
- Documents are stored as an array of `{ id, workspace, title?, content, createdAt, embedding? }`.

## Chunking

When `KNOWLEDGE_CHUNKING=1`, `POST /api/v1/knowledge/index` splits large text into multiple documents using `lib/knowledge-chunking.js`.

- `KNOWLEDGE_CHUNK_MAX_CHARS` (default 4000), `KNOWLEDGE_CHUNK_OVERLAP` (default 200).
- `KNOWLEDGE_MAX_CHUNKS_PER_DOC` caps chunks per upload (default 50, max 200).

Embeddings for chunked docs run per chunk when `OPENAI_API_KEY` is set (otherwise chunks are keyword-searchable only unless you pass vectors manually).

## Semantic search

- `GET /api/v1/knowledge/search?q=...&workspace=...&semantic=1` uses stored embeddings.
- `KNOWLEDGE_AUTO_EMBED=1` enables automatic embedding for single-piece (non-chunked) uploads without `computeEmbedding: true`.

## Incremental reindex

- `POST /api/v1/knowledge/reindex` with body `{ "workspace": "default" }` recomputes embeddings for every document in that workspace index. Requires `OPENAI_API_KEY`. Rate-limited like the embeddings API.

## URL connector (allowlist)

- `POST /api/v1/knowledge/fetch` with `{ "url": "https://...", "workspace": "default", "title"?: "...", "computeEmbedding"?: true }`.
- **Security:** Set `KNOWLEDGE_URL_ALLOWLIST` to a comma-separated list of allowed hostnames (e.g. `raw.githubusercontent.com,example.com`) or full URL prefixes (e.g. `https://raw.githubusercontent.com/myorg/`). If unset or empty, fetch is rejected.
- `KNOWLEDGE_FETCH_MAX_BYTES` (default 524288), `KNOWLEDGE_FETCH_TIMEOUT_MS` (default 15000).

Redirects are followed only when each hop’s URL remains allowlisted.

## Related env vars

See `.env.example` (Phase 72 block).
