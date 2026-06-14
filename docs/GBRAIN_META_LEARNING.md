# GBrain Meta-Learning

GBrain meta-learning is SiskelBot's "learning to learn" layer. It watches the
outcomes of every decision GBrain makes -- which strategy was chosen, which
model was routed to, which tools were invoked, which specialists were
assembled -- and feeds those outcomes back into future decisions.

The code lives in `lib/gbrain-meta-learning.js` with integration helpers in
`lib/gbrain-integration.js`. Persistent state is stored in
`data/gbrain/meta-learning.json`.

## What it learns

1. **Strategy weights.** For each task type (research, coding, planning,
   factcheck, etc.) GBrain tracks how often each strategy succeeds and builds
   a reinforcement-style weight table. Successes nudge weights up, failures
   nudge them down. High user ratings accelerate reinforcement.
2. **Model performance per task type.** Success rate, average duration,
   average cost, and average user rating are rolled into a composite score
   per `(model, task type)` pair. `getBestModelForTask` returns a ranked list.
3. **Tool success.** Per-tool success rates across contexts. Used to surface
   flaky tools and to seed the `tool_highlight` recommendation.
4. **Failure categories.** Errors are normalized into buckets: `timeout`,
   `tool_error`, `rate_limit`, `parse_error`, `auth_error`,
   `reasoning_error`, `network_error`, `other`. This makes systematic issues
   visible.
5. **Beliefs.** Named Beta-like beliefs (e.g. "strategy_success") can be
   updated with streaming observations via Bayesian updating.

## Data model

```text
decisions:          decisionId -> { decision, outcome }
strategyWeights:    taskType -> { strategy -> weight }   (clamped 0.01..100)
modelPerformance:   taskType -> { model -> stats }
toolPerformance:    tool -> { context -> stats }
outcomesLog:        rolling log of decisions with timestamps
beliefs:            key -> { mean, variance, count }
```

## Core API

| Function | Purpose |
|----------|---------|
| `recordDecisionOutcome(id, { decision, outcome })` | Log a decision outcome and fan out to sub-systems. |
| `updateStrategyWeights(taskType, strategy, outcome)` | Reinforcement update. |
| `getStrategyWeights(taskType)` | Read normalized weights for a task type. |
| `learnFromBatch(items)` | Batch update many outcomes at once. |
| `updateModelPerformance(model, taskType, outcome)` | Track per-task model stats. |
| `getBestModelForTask(taskType)` | Ranked models, best first. |
| `updateToolPerformance(tool, context, outcome)` | Track per-tool success. |
| `getToolRanking(taskType?)` | Rank tools by success rate. |
| `analyzeFailures(timeRange)` | Group failures by category/model/strategy. |
| `recommendImprovements(workspaceId)` | Actionable suggestions. |
| `bayesianUpdate(prior, obs)` | Stateless Normal-Normal conjugate update. |
| `updateBelief(key, obs)` / `getBelief(key)` | Keyed belief persistence. |
| `shouldExplore(task, best, alts, opts)` | Epsilon-greedy + UCB decision. |
| `getLearningCurve(metric, period)` | Time-series trend with slope. |
| `resetLearning(workspaceId?)` | Clear data (optionally scoped). |

## Integration helpers

`lib/gbrain-integration.js` exposes four non-invasive wrappers that add
meta-learning hooks around existing orchestrators:

```js
import * as agentLoop from "./agent-loop.js";
import { integrateWithAgentLoop } from "./gbrain-integration.js";

const wrappedLoop = integrateWithAgentLoop(agentLoop);
// Use `wrappedLoop` where you would normally use `agentLoop`.
```

The wrappers intercept the primary entry points and call
`recordDecisionOutcome` before/after the underlying function completes. Any
thrown error is recorded as a failure with a normalized `errorType`.

| Wrapper | Intercepts |
|---------|------------|
| `integrateWithAgentLoop(m)` | `runAgentLoop` / `runLoop` / `runAgent` / `run` |
| `integrateWithSwarm(m)` | `runSwarmDirect` / `runSwarm` / `run` |
| `integrateWithHierarchy(m)` | `executeHierarchy` / `runHierarchy` / `run` |
| `integrateWithConsensus(m)` | `executeConsensus` / `runConsensus` / `run` |

The wrappers are best-effort: failures inside the recording path are logged
and never block the underlying call.

## Exploration vs. exploitation

`shouldExplore(taskType, currentBest, alternatives, opts)` picks between
exploiting the current best and exploring an alternative. Two strategies are
supported:

- **Epsilon-greedy (default).** With probability `epsilon` (default 0.1)
  GBrain picks a random alternative; otherwise it picks the current best.
- **UCB1 (when `opts.totalPulls` is provided).** GBrain computes the upper
  confidence bound
  `score + sqrt(2 * ln(totalPulls) / sampleCount)` for every arm and prefers
  an alternative if its UCB exceeds the current best's. This naturally
  favours under-explored arms.

**Why explore at all?** A model or strategy that is "best" today may only be
best because GBrain never tried the alternatives. Reinforcement without
exploration converges to local optima. Epsilon-greedy exploration guarantees
that every strategy keeps collecting a small amount of data, while UCB gives
optimism-under-uncertainty so promising under-tried arms get pulled earlier.

Tuning:

- Set `epsilon` high (0.2–0.3) early in a workspace's life, and anneal it
  down as the weight table stabilises.
- Prefer UCB when total pulls is available; it is parameter-free and more
  sample-efficient than pure epsilon-greedy.
- Reset learning after major model or prompt changes — past outcomes may no
  longer be representative.

## Learning curves

`getLearningCurve(metric, period)` buckets the outcomes log into fixed-size
time slots and returns

```js
{
  dataPoints: [{ ts, value, count }, ...],  // one per bucket
  trend: "up" | "down" | "flat",            // sign of linear-regression slope
  improvementRate: number                   // (last - first) / |first|
}
```

Metrics supported:

- `success_rate` — fraction of outcomes with `success: true` in the bucket.
- `avg_duration` — mean wall-clock duration of outcomes in the bucket.
- `avg_cost` — mean cost per outcome.

### Interpretation

- **Up trend.** GBrain is getting better at this metric over time. If the
  metric is success rate, you're on the right track.
- **Flat trend with healthy counts.** GBrain has converged; additional
  learning on the current distribution won't help much. Consider
  introducing new strategies/models or increasing exploration.
- **Down trend.** Something regressed. Check `analyzeFailures` for the same
  period — a particular model, strategy, or failure category will usually
  stand out.
- **Flat trend with very low counts.** Not enough data; re-check after more
  traffic.

The `improvementRate` is a coarse "percent change" from the first to the
last non-empty bucket; use `dataPoints` plus a chart for the real story.

## Recommendations

`recommendImprovements(workspaceId)` stitches the above signals together and
returns a list of actionable items. Each entry has:

```js
{
  type: "strategy_change" | "model_upgrade" | "tool_highlight" |
        "failure_category" | "system_prompt" | "insufficient_data",
  severity: "info" | "low" | "medium" | "high",
  message: "…human-readable summary…",
  // optional fields per type
}
```

Typical outputs:

- *"For 'coding', prefer strategy 'strong' over 'weak' (1.80 vs 0.23)"*
- *"Model 'tiny' accounts for 12 failures; consider routing away"*
- *"14 reasoning errors observed — consider tightening system prompt or
  enabling reflection"*

Recommendations are suggestions, not automated changes. Surface them in the
admin dashboard and let an operator (or a scheduled job) act on them.

## Storage and lifecycle

- In-memory store backed by periodic JSON flush (`data/gbrain/meta-learning.json`).
- Flush interval: 30 s after any mutation, debounced.
- Rolling caps: `MAX_DECISIONS = 5,000`, `outcomesLog` trimmed to ~4,000
  entries.
- Call `flush()` on graceful shutdown to persist pending mutations.
- Call `loadFromDisk()` at startup (it is also called lazily by every
  public function).

## Testing

Unit tests live in `tests/gbrain-meta-learning.test.js`. They cover:

- Decision outcome recording and validation
- Reinforcement-style weight updates
- Batch learning
- Per-task model ranking
- Tool ranking
- Failure analysis grouping and recommendations
- Bayesian updating (including edge cases)
- Epsilon-greedy and UCB exploration decisions
- Learning curve computation over seeded history
- Recommendation generation end-to-end
- Reset (full and workspace-scoped)
- Integration wrappers for agent-loop, swarm, hierarchy, consensus

Run them with:

```bash
node --test tests/gbrain-meta-learning.test.js
```
