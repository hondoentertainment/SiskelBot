# Karpathy 3-stage LLM training pipeline

SiskelBot ships an opinionated orchestrator for the canonical LLM training
pipeline popularized by Andrej Karpathy in his "State of GPT" keynote
(Microsoft Build 2023) and the "Let's build GPT" YouTube series. The code
lives in `lib/karpathy-pipeline.js`; the HTTP surface lives in
`routes/karpathy-pipeline.js`.

The pipeline has three stages. SiskelBot models each as a phase in a durable
pipeline record scoped to a workspace:

1. **Pretraining** -- raw text, next-token prediction, produces a base LLM
   that knows facts but is not helpful.
2. **Supervised Fine-Tuning (SFT)** -- curated `(prompt, ideal_response)`
   pairs, produces a helpful assistant.
3. **RLHF / DPO** -- preference data `(prompt, chosen, rejected)`, produces
   an aligned model. DPO is a single-step closed-form alternative to the
   reward-modeling + PPO pair used in classical RLHF.

SiskelBot does not perform gradient descent itself. It orchestrates the
lifecycle: creating pipelines, preparing datasets from existing SiskelBot
data (knowledge base, conversations, feedback), recording stage metrics,
and persisting the progression from base model to aligned model.

## References

- Karpathy, A. -- "State of GPT" (Microsoft Build 2023).
- Karpathy, A. -- "Let's build GPT: from scratch, in code, spelled out".
- Rafailov et al. -- "Direct Preference Optimization" (NeurIPS 2023).
- Ouyang et al. -- "Training language models to follow instructions with
  human feedback" (InstructGPT).

## Stage model

```
pretrain -> sft -> [reward_modeling ->] rlhf | dpo
```

Exported as `STAGES` from `lib/karpathy-pipeline.js`:

| Constant            | Value              |
| ------------------- | ------------------ |
| `STAGES.PRETRAIN`   | `pretrain`         |
| `STAGES.SFT`        | `sft`              |
| `STAGES.REWARD_MODELING` | `reward_modeling` |
| `STAGES.RLHF`       | `rlhf`             |
| `STAGES.DPO`        | `dpo`              |

The default pipeline if no stages are supplied is
`[pretrain, sft, dpo]` -- the "modern" path that avoids training a separate
reward model.

## Persistence

Pipelines are stored under
`$STORAGE_PATH/training-pipelines/{workspace}.json` (or
`$TRAINING_PIPELINE_DATA_DIR` if set). Writes go through
`lib/json-path-store.js` so the same record routes through PostgreSQL KV,
SQLite KV, or plain JSON files following the backend resolution rules in
`lib/storage.js`.

Each record has the shape:

```jsonc
{
  "id": "uuid",
  "name": "MyModel-v1",
  "workspace": "default",
  "baseModel": "llama3-8b",
  "stages": ["pretrain", "sft", "dpo"],
  "currentStage": "sft",
  "currentStageIndex": 1,
  "status": "running",
  "createdAt": "2026-04-11T...",
  "updatedAt": "2026-04-11T...",
  "history": [
    { "stage": "pretrain", "completedAt": "...", "outputModel": "base-v1", "metrics": { "loss": 2.3 } }
  ],
  "models": { "pretrain": "base-v1" },
  "metadata": {}
}
```

## Programmatic API

All exports are async unless noted. Example:

```js
import {
  STAGES,
  createTrainingPipeline,
  advanceStage,
  getPipelineStatus,
  listPipelines,
  preparePretrainingData,
  prepareSFTData,
  preparePreferenceData,
  evaluatePretraining,
  evaluateSFT,
  evaluatePreferenceAlignment,
  computeLossGradient,
  recommendLearningRate,
} from "../lib/karpathy-pipeline.js";

// 1. Create a pipeline
const p = await createTrainingPipeline({
  name: "AssistantV1",
  baseModel: "llama3-8b",
  stages: [STAGES.PRETRAIN, STAGES.SFT, STAGES.DPO],
  workspaceId: "research",
});

// 2. Prepare pretraining data from raw knowledge-base documents
const pre = await preparePretrainingData(documents, { minChars: 64, dedupe: true });
// pre.tokens, pre.stats.{keptDocs, approxBpeTokens, uniqueTokens, ...}

// 3. Advance after pretraining completes in your external trainer
await advanceStage(p.id, {
  outputModel: "base-v1",
  metrics: { loss: 2.4, perplexity: 11.0 },
}, "research");

// 4. SFT: extract (prompt, response) pairs from highly rated conversations
const sft = await prepareSFTData(conversations, {
  minRating: 4,
  template: "### Instruction:\n{prompt}\n### Response:\n{response}",
});
// sft.jsonl is ready for an SFT trainer (OpenAI fine-tune, llama-factory, etc.)

await advanceStage(p.id, { outputModel: "sft-v1" }, "research");

// 5. DPO: build (prompt, chosen, rejected) triples from user feedback
const pref = await preparePreferenceData(conversations, { minRatingGap: 2 });
// pref.jsonl is ready for a DPO trainer

// 6. Evaluate the aligned model
const metrics = await evaluatePreferenceAlignment(model, pref.triples);
// { preferenceAccuracy, klDivergence, sampleCount }

await advanceStage(p.id, { outputModel: "dpo-v1", metrics }, "research");
// p.status === "completed"
```

### Data preparation helpers

| Function                    | Input                                  | Output                              |
| --------------------------- | -------------------------------------- | ----------------------------------- |
| `preparePretrainingData`    | `[{ text }, ...]`                      | `{ tokens, stats }`                 |
| `prepareSFTData`            | `[{ messages: [{role, content, rating}] }]` | `{ pairs, jsonl, stats }`     |
| `preparePreferenceData`     | conversations + `preferencePairs` or sibling ratings | `{ triples, jsonl, stats }` |

`prepareSFTData` options:

- `minRating` -- drop conversations/messages below this rating
- `minResponseChars` -- drop short assistant responses
- `template` -- instruction template with `{prompt}` and `{response}` slots

`preparePreferenceData` options:

- `minRatingGap` -- required difference between chosen and rejected ratings
  (siblings-by-rating heuristic)
- `minResponseChars` -- drop short responses

## Quality metrics per stage

| Stage     | Function                         | Returns                                                  |
| --------- | -------------------------------- | -------------------------------------------------------- |
| Pretrain  | `evaluatePretraining`            | `{ perplexity, loss, accuracy, sampleCount }`            |
| SFT       | `evaluateSFT`                    | `{ avgHelpfulness, toxicity, coherence, sampleCount }`   |
| DPO/RLHF  | `evaluatePreferenceAlignment`    | `{ preferenceAccuracy, klDivergence, sampleCount }`      |

All three accept an optional `model` object. If present, SiskelBot will call:

- `model.scoreBatch(prompts)` for pretraining, returning
  `[{ logLoss, correct }, ...]`
- `model.judge(item)` for SFT, returning
  `{ helpfulness, coherence, toxic }`
- `model.preference(prompt, chosen, rejected)` or
  `model.logProb(prompt, response)` for preference alignment

If `model` is omitted, the functions operate on pre-labeled test set items
(`item.loss`, `item.helpfulness`, `pair.modelPreferred`, etc.) so the same
code can back both real evaluation and reproducible unit tests.

## Training diagnostics ("fundamental theorem" utilities)

- `computeLossGradient(lossHistory)` -- inspects a loss curve and returns
  `{ trend, avgDelta, maxSpike, spikeIndices, unstable }`. Karpathy's rule
  of thumb: if the curve has frequent spikes, lower the learning rate, add
  gradient clipping, or check your data shard for junk.
- `recommendLearningRate(model, dataSize)` -- suggests a starting LR using
  Karpathy's "rules of thumb":
  - Pretraining base LR ~ `6e-4` (nanoGPT default for small GPTs)
  - SFT base LR ~ `6e-5` (~10x smaller than pretraining)
  - RLHF/DPO base LR ~ `6e-6` (~10x smaller than SFT)
  - Scaled by `1/sqrt(params / 1M)` for parameter-count stability
  - Reduced for datasets below 10k tokens, boosted above 1B tokens
  - Returns a warmup step count ~1% of total steps (floor 100)

## HTTP API

All routes are mounted under `/api/v1/training/pipelines` (with legacy
`/api/training/pipelines` kept for backwards compatibility via the standard
`dualRegister`/`apiRoute` pattern). Requests honor `req.query.workspace`
and body `workspaceId` to scope storage.

| Method | Path                                   | Purpose                                           |
| ------ | -------------------------------------- | ------------------------------------------------- |
| GET    | `/training/pipelines`                  | List pipelines in a workspace                     |
| POST   | `/training/pipelines`                  | Create a pipeline                                 |
| GET    | `/training/pipelines/:id`              | Fetch a pipeline's status + history               |
| POST   | `/training/pipelines/:id/advance`      | Record the current stage's output and move on    |
| POST   | `/training/pipelines/:id/prepare-data` | Prepare SFT/DPO/pretrain dataset from request body|
| POST   | `/training/pipelines/:id/evaluate`     | Run stage-appropriate evaluation and return metrics|

### Example: create and advance a pipeline

```bash
curl -sX POST http://localhost:3000/api/v1/training/pipelines \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "AssistantV1",
    "baseModel": "llama3-8b",
    "stages": ["pretrain", "sft", "dpo"],
    "workspaceId": "research"
  }'

# Use the returned `id` in follow-up calls.
curl -sX POST http://localhost:3000/api/v1/training/pipelines/$ID/advance \
  -H 'Content-Type: application/json' \
  -d '{
    "outputModel": "base-v1",
    "metrics": { "loss": 2.4, "perplexity": 11.0 }
  }'
```

### Example: prepare SFT data from conversations

```bash
curl -sX POST "http://localhost:3000/api/v1/training/pipelines/$ID/prepare-data?stage=sft" \
  -H 'Content-Type: application/json' \
  -d '{
    "workspaceId": "research",
    "options": { "minRating": 4, "template": "### Instruction:\n{prompt}\n### Response:\n{response}" },
    "conversations": [
      {
        "id": "c1",
        "messages": [
          { "role": "user", "content": "What is DPO?" },
          { "role": "assistant", "content": "Direct Preference Optimization...", "rating": 5 }
        ]
      }
    ]
  }'
```

The response includes `pairs`, `jsonl` (ready for an SFT trainer), and
`stats` describing how many pairs were kept/filtered.

### Example: evaluate preference alignment

```bash
curl -sX POST "http://localhost:3000/api/v1/training/pipelines/$ID/evaluate?stage=dpo" \
  -H 'Content-Type: application/json' \
  -d '{
    "workspaceId": "research",
    "preferencePairs": [
      { "prompt": "p", "chosen": "good", "rejected": "bad", "modelPreferred": "chosen" },
      { "prompt": "p", "chosen": "good", "rejected": "bad", "modelPreferred": "rejected" }
    ]
  }'
```

## Environment variables

| Variable                   | Purpose                                            |
| -------------------------- | -------------------------------------------------- |
| `TRAINING_PIPELINE_DATA_DIR` | Override storage directory for pipeline records (defaults to `$STORAGE_PATH/training-pipelines`) |
| `STORAGE_PATH`             | Root data directory (inherited from `lib/storage.js`) |
| `STORAGE_BACKEND`          | Same resolution as other storage modules (`json`, `sqlite`, `postgres`) |

## Testing

Unit tests live in `tests/karpathy-pipeline.test.js`. They cover pipeline
creation and stage advancement, all three data-preparation functions, all
three evaluators, loss-gradient diagnostics, and learning-rate recommendations.

```bash
node --test tests/karpathy-pipeline.test.js
```
