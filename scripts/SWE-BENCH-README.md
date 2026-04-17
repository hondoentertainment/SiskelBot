# External Benchmark Harness

This directory contains `run-benchmark.js`, the CLI entry point for the
SWE-bench-shaped benchmark harness. The harness is designed so that the
**shape, runner, and scorer infrastructure** live in pure JavaScript and can
run today (with a small inline suite), and full SWE-bench can be plugged in
tomorrow once Docker is configured.

## Layout

```
lib/benchmark-harness.js         core runner: task → agentFn → code → score
lib/benchmark-scorer.js          subprocess-isolated code execution + scoring
lib/benchmark-suites/mini-tasks.js  10 inline JS tasks (no Docker needed)
scripts/run-benchmark.js         CLI entry point (mock agent or HTTP agent)
tests/benchmark-harness.test.js  unit tests for the harness
tests/benchmark-scorer.test.js   unit tests for the scorer
```

## Running the mini suite today

```bash
# Mock agent (returns hardcoded reference solutions, always passes):
node scripts/run-benchmark.js --suite mini

# Against a running SiskelBot instance:
node scripts/run-benchmark.js --suite mini \
  --url http://localhost:3000 --key $API_KEY --model gpt-4 \
  --concurrency 2 --output bench-report.json
```

Exit code is 0 iff every task passed, otherwise 1.

## BenchmarkTask shape

Every task in every suite (mini, SWE-bench, HumanEval, …) conforms to this
shape, documented in `lib/benchmark-harness.js`:

```js
{
  id: "mini-001",               // unique string
  title: "Sum of evens",
  prompt: "Write a function ...",
  language: "javascript",       // only "javascript" is executable today
  entry: "sumEvens",            // named export the scorer will call
  starterCode: "// optional starter",
  testCases: [
    { input: [[1, 2, 3]], expected: 6 },   // input is an array of args
    ...
  ],
  timeoutMs: 5000,              // hard cap, max 30000
}
```

### Scoring model

1. `runBenchmarkTask` calls `agentFn(prompt, { task })`.
2. Agent returns text; `extractCode` pulls the largest ```javascript fence.
3. `scoreTaskResult` writes the code to `mkdtemp`'d tmpfile, spawns
   `node --input-type=module --eval <runner>` with `env: { NODE_NO_WARNINGS: "1" }`
   (no inherited env), pipes JSON test cases via stdin, reads results via stdout,
   enforces timeout with a hard `SIGKILL`.
4. Pass/fail is `deepEqual(actual, expected)`.
5. Tmp directory is unconditionally deleted.

Generated code is **never** evaluated in-process. No `eval`, no `Function`,
no `require` or `import()` in the parent. The parent environment, network
credentials, working directory, and filesystem paths are all isolated from
the subprocess.

## Mini suite (10 tasks)

| id       | title                     | difficulty |
|----------|---------------------------|------------|
| mini-001 | Sum of evens              | easy       |
| mini-002 | FizzBuzz value            | easy       |
| mini-003 | Reverse string            | easy       |
| mini-004 | Is palindrome (alnum)     | tricky     |
| mini-005 | Two sum                   | medium     |
| mini-006 | Merge sorted arrays       | medium     |
| mini-007 | Deep clone                | tricky     |
| mini-008 | Binary search             | medium     |
| mini-009 | Count vowels              | easy       |
| mini-010 | Flatten one level         | medium     |

Each task ships with 4–7 test cases that cover happy paths and at least one
edge case (empty input, duplicates, boundary). `isPalindrome` and `deepClone`
in particular are chosen because they're easy to get subtly wrong.

## Plugging in the real SWE-bench

SWE-bench tasks aren't runnable with the JS-subprocess scorer — they require
a Python environment with the target repo + pytest inside Docker. The harness
is designed so that only the **scorer** needs to be swapped; the runner and
report structure stay the same.

### Steps

1. **Load the dataset.** SWE-bench ships as JSONL (`SWE-bench-lite` has ~300
   tasks; full has 2,294). Each row has `instance_id`, `problem_statement`,
   `patch`, `test_patch`, `repo`, `base_commit`, `FAIL_TO_PASS`, `PASS_TO_PASS`.

2. **Map to `BenchmarkTask`.** Add a new suite module,
   `lib/benchmark-suites/swe-bench.js`, that reads the JSONL and returns:

   ```js
   {
     id: row.instance_id,
     title: row.instance_id,
     prompt: row.problem_statement,
     language: "python-swebench",        // new sentinel, NOT "javascript"
     repo: row.repo,
     baseCommit: row.base_commit,
     testPatch: row.test_patch,
     failToPass: row.FAIL_TO_PASS,       // tests that must flip to pass
     passToPass: row.PASS_TO_PASS,       // tests that must stay passing
     timeoutMs: 900_000,                 // 15 minutes per SWE-bench spec
   }
   ```

3. **Write a Docker-backed scorer.** Create `lib/benchmark-scorer-docker.js`
   that exports the same `scoreTaskResult(task, generatedPatch, testCases)`
   signature. Inside, it should:

   ```
   a. Pull/reuse the official SWE-bench base image for row.repo.
   b. Start a container, checkout row.baseCommit.
   c. Apply row.test_patch (the ground-truth test update).
   d. Apply the agent-generated patch.
   e. Run pytest over FAIL_TO_PASS and PASS_TO_PASS lists with a strict timeout.
   f. Return { passed, passedTests, totalTests, details, error? }.
   g. `docker rm -f` the container in finally.
   ```

4. **Teach the harness to pick the scorer.** In `lib/benchmark-harness.js`,
   replace the direct import of `scoreTaskResult` with a dispatch:

   ```js
   const scorer = task.language === "javascript"
     ? jsScorer
     : task.language === "python-swebench"
       ? dockerScorer
       : null;
   if (!scorer) return { ..., error: "no-scorer" };
   ```

5. **Teach the CLI.** Add `--suite swe-bench-lite` to `scripts/run-benchmark.js`.
   The runner and report format stay identical.

### Why this split is worth it

The harness's interesting logic — task iteration, concurrency, agent retries,
code extraction, timeout, aggregation, p50/p95 reporting, JSON+table output —
is already written and tested. Adding SWE-bench means writing **only** the
container-scoped scorer, not re-plumbing the pipeline.

## Example: real Anthropic agent

To run the mini suite against the real Anthropic API (outside SiskelBot),
the agentFn is one line:

```js
import Anthropic from "@anthropic-ai/sdk";
import { runBenchmarkSuite } from "../lib/benchmark-harness.js";
import { getSuite } from "../lib/benchmark-suites/mini-tasks.js";

const client = new Anthropic();

async function anthropicAgent(prompt) {
  const resp = await client.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });
  return resp.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

const { taskResults, aggregate } = await runBenchmarkSuite(
  getSuite("mini"),
  anthropicAgent,
  { concurrency: 3 }
);
console.log(aggregate);
```

## Security notes

- The scorer uses `child_process.spawn` with `env: { NODE_NO_WARNINGS: "1" }`
  only — the subprocess does **not** inherit `PATH`, `HOME`, or any secrets
  from the parent.
- `cwd` is `os.tmpdir()`; the subprocess cannot read the SiskelBot source
  tree or `data/` directory by relative path.
- Subprocess code path is never eval'd or `Function`'d in the parent.
- Hard timeout is 5 s default, 30 s max; enforced via `setTimeout` + `SIGKILL`.
- Tmp files are written under `mkdtempSync(os.tmpdir(), "bench-")` and deleted
  in a `finally` block regardless of outcome.
- `language` is whitelist-checked before any execution.

## Adding a new inline task

Edit `lib/benchmark-suites/mini-tasks.js` and append to `MINI_TASKS`. The
`entry` field must match a named export in what the agent returns. Tests in
`tests/benchmark-harness.test.js` run a reference solution for every task, so
add a matching solution to that file's `MOCK_SOLUTIONS` map (or the test will
fail for the new task because the mock agent has no solution for it).
