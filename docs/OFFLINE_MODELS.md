# Offline Model Bundles (Phase 40.5)

SiskelBot ships an optional catalog of small, quantized GGUF models that can
run fully offline. They exist for three scenarios:

1. **Air-gapped deployment.** Government, manufacturing, healthcare, and other
   environments that cannot reach `api.openai.com` or a hosted Ollama.
2. **Cost sensitivity.** Local inference is free of per-token billing.
3. **Privacy and data residency.** Prompts and outputs never leave the host.

The offline bundle subsystem covers four things: a curated catalog, download
with integrity verification, hardware-aware recommendations, and tarball
bundling for sneakernet distribution.

## When NOT to use offline models

Offline models in this catalog are 1B-3B parameter Q4 quantizations. They are
**not** drop-in replacements for GPT-4 or Claude. Use them when:

- The task is short-form (chat, autocomplete, classification, embeddings).
- Latency tolerance is in the hundreds of milliseconds, not tens.
- You have enough CPU/RAM to load the model (see the table below).

For long-form reasoning, prefer routing to a hosted backend with the smart
router (`lib/smart-router.js`).

## Catalog

| ID                      | Params | Quant | Size  | Capabilities         | Min RAM | License             |
|-------------------------|--------|-------|-------|----------------------|---------|---------------------|
| `tinyllama-1.1b-q4`     | 1.1B   | Q4    | 650MB | chat, completion     | 2 GB    | Apache-2.0          |
| `phi-2-q4`              | 2.7B   | Q4    | 1.6GB | chat, code, reason   | 4 GB    | MIT                 |
| `gemma-2b-q4`           | 2.0B   | Q4    | 1.5GB | chat, completion     | 4 GB    | Gemma ToU           |
| `nomic-embed-text-q4`   | 137M   | Q4    | 84MB  | embeddings           | 1 GB    | Apache-2.0          |

The full catalog (with download URLs and SHA-256 placeholders) lives in
`lib/offline-models.js`. To customize, replace the placeholder SHA-256 values
with the canonical digests for your distribution. Until you do, downloads will
succeed but `verify` will report `"no canonical checksum (placeholder)"`.

## Hardware requirements

| Model              | RAM (idle) | RAM (peak) | Disk  | Notes                              |
|--------------------|-----------:|-----------:|------:|------------------------------------|
| TinyLlama 1.1B Q4  |    1.5 GB  |    2.0 GB  | 1 GB  | Runs on Raspberry Pi 4 (8GB)       |
| Phi-2 Q4           |    3.0 GB  |    4.0 GB  | 2 GB  | Best reasoning per byte            |
| Gemma 2B Q4        |    3.0 GB  |    4.0 GB  | 2 GB  | 8K context, good for RAG           |
| Nomic Embed Q4     |    0.5 GB  |    1.0 GB  | 1 GB  | Pair with any chat model           |

## Download and verify

### CLI

```sh
# List the catalog
siskelbot models list

# List what is currently on disk
siskelbot models list --downloaded

# Recommend models for this device
siskelbot models list --recommend --ram 8 --storage 50

# Download a model (shows percent progress)
siskelbot models download tinyllama-1.1b-q4

# Verify integrity (re-hash the file)
siskelbot models verify tinyllama-1.1b-q4

# Remove a downloaded model
siskelbot models remove tinyllama-1.1b-q4
```

### HTTP API

| Method | Path                                              | Description                            |
|-------:|---------------------------------------------------|----------------------------------------|
| GET    | `/api/v1/models/offline/available`                | List catalog                           |
| GET    | `/api/v1/models/offline/downloaded`               | List downloaded models on disk         |
| GET    | `/api/v1/models/offline/recommendations`          | Device-aware recommendations           |
| POST   | `/api/v1/models/offline/:id/download`             | Trigger download (SSE progress stream) |
| GET    | `/api/v1/models/offline/:id/verify`               | Re-hash the file                       |
| DELETE | `/api/v1/models/offline/:id`                      | Delete from disk                       |

The download endpoint streams Server-Sent Events when the request includes
`Accept: text/event-stream`. Otherwise it returns a single JSON response when
the download finishes.

Example SSE stream:

```
event: start
data: {"id":"tinyllama-1.1b-q4","startedAt":"2026-04-11T10:00:00.000Z"}

event: progress
data: {"id":"tinyllama-1.1b-q4","received":65000000,"total":650000000,"percent":10}

event: done
data: {"id":"tinyllama-1.1b-q4","path":"/data/models/offline/tinyllama-1.1b-q4.gguf","size":650000000,"checksum":"..."}
```

## Local inference (llama.cpp)

The optional `lib/llama-cpp-backend.js` module loads downloaded GGUF files via
the `node-llama-cpp` native binding. It is **not a hard dependency** of
SiskelBot — if the package is not installed, the rest of the server still
works and `isLlamaCppAvailable()` returns `false`.

```sh
npm install node-llama-cpp
```

```js
import { isLlamaCppAvailable, createLlamaCppBackend } from "./lib/llama-cpp-backend.js";

if (await isLlamaCppAvailable()) {
  const backend = await createLlamaCppBackend({
    modelPath: "./data/models/offline/tinyllama-1.1b-q4.gguf",
    contextSize: 2048,
    gpuLayers: 0,
  });
  const reply = await backend.chat([
    { role: "user", content: "Summarize the build steps in one sentence." },
  ]);
  console.log(reply);
  await backend.dispose();
}
```

When llama.cpp is available, set `BACKEND=llamacpp` to make it the default
chat backend. The router will load whichever GGUF file the request specifies
in `model` (matching the file stem under `data/models/offline/`).

## Creating bundles for distribution

For air-gapped sites, build a single tarball on a connected machine that
contains every model the target needs. Then sneakernet the tarball.

```sh
# 1. On a connected build host, download the models you want
siskelbot models download tinyllama-1.1b-q4
siskelbot models download nomic-embed-text-q4

# 2. Bundle them
siskelbot models bundle \
  --models tinyllama-1.1b-q4,nomic-embed-text-q4 \
  --output ./bundles/airgap-2026-04.tar.gz

# 3. On the target host, extract into the offline directory
mkdir -p data/models/offline
tar -xzf airgap-2026-04.tar.gz -C data/models/offline

# 4. Verify
siskelbot models list --downloaded
siskelbot models verify tinyllama-1.1b-q4
```

If the optional `tar` Node package is not installed, `models bundle` writes a
manifest JSON file alongside the requested output path so you can drive your
own archiver. Install `tar` to produce a real `.tar.gz` directly:

```sh
npm install tar
```

## Catalog customization

To add a new model to the catalog:

1. Edit `lib/offline-models.js` and append a new entry to `OFFLINE_MODELS`.
2. Provide `id`, `name`, `sizeBytes`, `parameters`, `quantization`,
   `capabilities`, `downloadUrl`, and `sha256`.
3. Set `minRamGB` and `minStorageGB` so device recommendations work.
4. (Optional) Run `siskelbot models verify <id>` after a test download to
   capture the canonical SHA-256, then commit the value.

The catalog is intentionally a static map (not a database) so it ships with
the source. This means upgrades are reproducible and there is nothing to
mutate at runtime.
