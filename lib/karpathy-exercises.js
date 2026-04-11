/**
 * Interactive coding exercises for the Zero to Hero curriculum.
 * Exercises are graded by running user-submitted code against test cases
 * inside a sandboxed vm context with a strict execution budget.
 */
import vm from "vm";

export const MICROGRAD_VALUE_EXERCISE = {
  id: "value-class",
  title: "Micrograd: Value class",
  description:
    "Implement a minimal Value class with support for addition, multiplication, and a backward() method that populates .grad for all nodes via the chain rule.",
  hints: [
    "Each Value stores .data, .grad, ._prev (set of children), and a local _backward closure.",
    "In add: out._backward = () => { self.grad += out.grad; other.grad += out.grad; }",
    "In mul: out._backward = () => { self.grad += other.data * out.grad; other.grad += self.data * out.grad; }",
    "backward() should topologically sort nodes, set root grad to 1, then call each _backward in reverse order.",
  ],
  starterCode: `class Value {
  constructor(data, children = []) {
    this.data = data;
    this.grad = 0;
    this._prev = children;
    this._backward = () => {};
  }
  add(other) { /* TODO */ }
  mul(other) { /* TODO */ }
  backward() { /* TODO */ }
}
// Export for grading
globalThis.Value = Value;`,
  tests: [
    {
      name: "add forward pass",
      run: (ctx) => {
        const a = new ctx.Value(2);
        const b = new ctx.Value(3);
        const c = a.add(b);
        return c && c.data === 5;
      },
    },
    {
      name: "mul forward pass",
      run: (ctx) => {
        const a = new ctx.Value(2);
        const b = new ctx.Value(3);
        const c = a.mul(b);
        return c && c.data === 6;
      },
    },
    {
      name: "backward through add",
      run: (ctx) => {
        const a = new ctx.Value(2);
        const b = new ctx.Value(3);
        const c = a.add(b);
        c.backward();
        return a.grad === 1 && b.grad === 1;
      },
    },
    {
      name: "backward through mul",
      run: (ctx) => {
        const a = new ctx.Value(2);
        const b = new ctx.Value(3);
        const c = a.mul(b);
        c.backward();
        return a.grad === 3 && b.grad === 2;
      },
    },
  ],
};

export const MANUAL_BACKPROP_EXERCISE = {
  id: "manual-backprop",
  title: "Manual backprop: Chain rule",
  description:
    "Given the expression f = (a + b) * c, implement a function manualBackprop(a, b, c) that returns { f, dfa, dfb, dfc } — the forward value and partial derivatives.",
  hints: [
    "f = (a + b) * c",
    "df/da = c, df/db = c, df/dc = a + b",
  ],
  starterCode: `function manualBackprop(a, b, c) {
  // TODO: compute f and gradients
  return { f: 0, dfa: 0, dfb: 0, dfc: 0 };
}
globalThis.manualBackprop = manualBackprop;`,
  tests: [
    {
      name: "f = (2+3)*4 = 20",
      run: (ctx) => {
        const r = ctx.manualBackprop(2, 3, 4);
        return r.f === 20;
      },
    },
    {
      name: "df/da = c",
      run: (ctx) => ctx.manualBackprop(2, 3, 4).dfa === 4,
    },
    {
      name: "df/db = c",
      run: (ctx) => ctx.manualBackprop(2, 3, 4).dfb === 4,
    },
    {
      name: "df/dc = a+b",
      run: (ctx) => ctx.manualBackprop(2, 3, 4).dfc === 5,
    },
  ],
};

export const MLP_FROM_SCRATCH_EXERCISE = {
  id: "mlp-from-scratch",
  title: "MLP forward pass",
  description:
    "Implement a single-layer MLP forward pass. Given inputs x (array), weights w (array of same length), and bias b, return tanh(sum(x_i * w_i) + b).",
  hints: ["Math.tanh exists in JS.", "Sum the pairwise products and add the bias."],
  starterCode: `function mlpForward(x, w, b) {
  // TODO
  return 0;
}
globalThis.mlpForward = mlpForward;`,
  tests: [
    {
      name: "zero weights -> tanh(bias)",
      run: (ctx) => {
        const y = ctx.mlpForward([1, 2, 3], [0, 0, 0], 0.5);
        return Math.abs(y - Math.tanh(0.5)) < 1e-9;
      },
    },
    {
      name: "basic dot product + bias",
      run: (ctx) => {
        const y = ctx.mlpForward([1, 2], [0.5, 0.25], 0.1);
        const expected = Math.tanh(1 * 0.5 + 2 * 0.25 + 0.1);
        return Math.abs(y - expected) < 1e-9;
      },
    },
  ],
};

export const BIGRAM_COUNTS_EXERCISE = {
  id: "bigram-counts",
  title: "Bigram counts",
  description:
    "Given an array of words, return an object mapping every character bigram 'ab' to its count. Use '.' as start/end marker. Example: ['hi'] -> { '.h': 1, 'hi': 1, 'i.': 1 }.",
  hints: ["Pad each word with '.' at both ends before enumerating pairs."],
  starterCode: `function bigramCounts(words) {
  // TODO
  return {};
}
globalThis.bigramCounts = bigramCounts;`,
  tests: [
    {
      name: "single word hi",
      run: (ctx) => {
        const r = ctx.bigramCounts(["hi"]);
        return r[".h"] === 1 && r["hi"] === 1 && r["i."] === 1;
      },
    },
    {
      name: "repeated bigram",
      run: (ctx) => {
        const r = ctx.bigramCounts(["hi", "hi"]);
        return r["hi"] === 2;
      },
    },
  ],
};

export const BIGRAM_NN_EXERCISE = {
  id: "bigram-nn",
  title: "Bigram NLL loss",
  description:
    "Compute the average negative log-likelihood loss given an array of predicted probabilities for the correct next character. Return -mean(log(p_i)).",
  hints: ["Use Math.log; return Infinity-safe average."],
  starterCode: `function nllLoss(probs) {
  // TODO
  return 0;
}
globalThis.nllLoss = nllLoss;`,
  tests: [
    {
      name: "all prob 1 -> loss 0",
      run: (ctx) => Math.abs(ctx.nllLoss([1, 1, 1])) < 1e-9,
    },
    {
      name: "uniform prob 0.5 -> -log(0.5)",
      run: (ctx) => Math.abs(ctx.nllLoss([0.5, 0.5]) - -Math.log(0.5)) < 1e-9,
    },
  ],
};

export const MLP_LM_EXERCISE = {
  id: "mlp-lm",
  title: "Embedding lookup",
  description:
    "Implement embeddingLookup(E, idx) where E is a 2D array [vocabSize][d] and idx is a sequence of indices. Return a 2D array [len(idx)][d] of embeddings.",
  hints: ["Just map idx through E."],
  starterCode: `function embeddingLookup(E, idx) {
  // TODO
  return [];
}
globalThis.embeddingLookup = embeddingLookup;`,
  tests: [
    {
      name: "basic lookup",
      run: (ctx) => {
        const E = [
          [1, 2],
          [3, 4],
          [5, 6],
        ];
        const r = ctx.embeddingLookup(E, [0, 2]);
        return r.length === 2 && r[0][0] === 1 && r[1][1] === 6;
      },
    },
  ],
};

export const SELF_ATTENTION_EXERCISE = {
  id: "self-attention",
  title: "Scaled dot-product attention",
  description:
    "Implement softmaxRow(row) — numerically stable softmax of a 1D array. This is the core of attention.",
  hints: [
    "Subtract the max before exponentiating for numerical stability.",
    "Divide each exp by the sum of exps.",
  ],
  starterCode: `function softmaxRow(row) {
  // TODO
  return [];
}
globalThis.softmaxRow = softmaxRow;`,
  tests: [
    {
      name: "uniform input -> uniform output",
      run: (ctx) => {
        const r = ctx.softmaxRow([1, 1, 1]);
        return (
          r.length === 3 &&
          Math.abs(r[0] - 1 / 3) < 1e-9 &&
          Math.abs(r[1] - 1 / 3) < 1e-9 &&
          Math.abs(r[2] - 1 / 3) < 1e-9
        );
      },
    },
    {
      name: "sums to 1",
      run: (ctx) => {
        const r = ctx.softmaxRow([2, 0, -1]);
        const s = r.reduce((a, b) => a + b, 0);
        return Math.abs(s - 1) < 1e-9;
      },
    },
    {
      name: "numerically stable on large values",
      run: (ctx) => {
        const r = ctx.softmaxRow([1000, 1000, 1000]);
        return r.every((v) => Math.abs(v - 1 / 3) < 1e-9);
      },
    },
  ],
};

export const TRANSFORMER_BLOCK_EXERCISE = {
  id: "transformer-block",
  title: "Residual connection",
  description: "Implement residual(x, f) that returns x + f(x), element-wise, for a 1D array.",
  hints: ["Apply f to x, then add component-wise."],
  starterCode: `function residual(x, f) {
  // TODO
  return [];
}
globalThis.residual = residual;`,
  tests: [
    {
      name: "identity",
      run: (ctx) => {
        const r = ctx.residual([1, 2, 3], (x) => x.map(() => 0));
        return r[0] === 1 && r[1] === 2 && r[2] === 3;
      },
    },
    {
      name: "double",
      run: (ctx) => {
        const r = ctx.residual([1, 2, 3], (x) => x.map((v) => v));
        return r[0] === 2 && r[1] === 4 && r[2] === 6;
      },
    },
  ],
};

export const BPE_EXERCISE = {
  id: "bpe-encoder",
  title: "BPE: Most frequent pair",
  description:
    "Implement mostFrequentPair(tokens) that returns the [a, b] adjacent token pair with the highest count. Return null for sequences shorter than 2.",
  hints: ["Iterate adjacent pairs into a counts map, then pick the argmax."],
  starterCode: `function mostFrequentPair(tokens) {
  // TODO
  return null;
}
globalThis.mostFrequentPair = mostFrequentPair;`,
  tests: [
    {
      name: "short sequence",
      run: (ctx) => ctx.mostFrequentPair([1]) === null,
    },
    {
      name: "single pair",
      run: (ctx) => {
        const p = ctx.mostFrequentPair([1, 2]);
        return Array.isArray(p) && p[0] === 1 && p[1] === 2;
      },
    },
    {
      name: "most frequent wins",
      run: (ctx) => {
        const p = ctx.mostFrequentPair([1, 2, 1, 2, 3, 4]);
        return p[0] === 1 && p[1] === 2;
      },
    },
  ],
};

export const EXERCISES = {
  [MICROGRAD_VALUE_EXERCISE.id]: MICROGRAD_VALUE_EXERCISE,
  [MANUAL_BACKPROP_EXERCISE.id]: MANUAL_BACKPROP_EXERCISE,
  [MLP_FROM_SCRATCH_EXERCISE.id]: MLP_FROM_SCRATCH_EXERCISE,
  [BIGRAM_COUNTS_EXERCISE.id]: BIGRAM_COUNTS_EXERCISE,
  [BIGRAM_NN_EXERCISE.id]: BIGRAM_NN_EXERCISE,
  [MLP_LM_EXERCISE.id]: MLP_LM_EXERCISE,
  [SELF_ATTENTION_EXERCISE.id]: SELF_ATTENTION_EXERCISE,
  [TRANSFORMER_BLOCK_EXERCISE.id]: TRANSFORMER_BLOCK_EXERCISE,
  [BPE_EXERCISE.id]: BPE_EXERCISE,
};

// Legacy aliases (for backward compat with earlier names in task spec)
export const MICROGRAD_EXERCISE = MICROGRAD_VALUE_EXERCISE;
export const BIGRAM_EXERCISE = BIGRAM_COUNTS_EXERCISE;

const MAX_CODE_LENGTH = 20_000;
const EXEC_TIMEOUT_MS = 1500;

/**
 * Run a user-submitted exercise solution in a sandboxed vm context against
 * the exercise's test cases. Returns a grade report.
 */
export function runExercise(exerciseId, userCode) {
  const exercise = EXERCISES[exerciseId];
  if (!exercise) {
    return {
      passed: false,
      score: 0,
      total: 0,
      feedback: `Unknown exercise: ${exerciseId}`,
      errors: [`Unknown exercise: ${exerciseId}`],
    };
  }

  if (typeof userCode !== "string" || userCode.length === 0) {
    return {
      passed: false,
      score: 0,
      total: exercise.tests.length,
      feedback: "Empty solution",
      errors: ["userCode must be a non-empty string"],
    };
  }
  if (userCode.length > MAX_CODE_LENGTH) {
    return {
      passed: false,
      score: 0,
      total: exercise.tests.length,
      feedback: "Solution too large",
      errors: [`Solution exceeds ${MAX_CODE_LENGTH} characters`],
    };
  }

  // Reject obviously dangerous constructs early. This is defence in depth —
  // the vm sandbox itself runs without require/process/global.
  const banned = [
    /\brequire\s*\(/,
    /\bprocess\b/,
    /\bchild_process\b/,
    /\bimport\s*\(/,
    /\beval\s*\(/,
    /\bFunction\s*\(/,
  ];
  for (const re of banned) {
    if (re.test(userCode)) {
      return {
        passed: false,
        score: 0,
        total: exercise.tests.length,
        feedback: "Disallowed construct in solution",
        errors: [`Solution contains disallowed construct matching ${re}`],
      };
    }
  }

  const sandbox = { Math, Array, Object, JSON, Number, String, Boolean, globalThis: {} };
  const context = vm.createContext(sandbox);

  // Bind globalThis inside the sandbox back to sandbox so user code can set
  // globalThis.X = ... and we can read it afterwards.
  try {
    vm.runInContext("var globalThis = this;", context);
  } catch {
    // ignore
  }

  try {
    vm.runInContext(userCode, context, { timeout: EXEC_TIMEOUT_MS });
  } catch (err) {
    return {
      passed: false,
      score: 0,
      total: exercise.tests.length,
      feedback: `Execution error: ${err.message}`,
      errors: [err.message],
    };
  }

  const results = [];
  const errors = [];
  let passedCount = 0;
  for (const t of exercise.tests) {
    try {
      let ok = false;
      vm.runInContext("", context); // ensure context is still valid
      // Execute the test by invoking it with a reference to the sandbox
      // (tests read exported globals from the sandbox).
      const testFn = t.run;
      const passed = testFn(sandbox);
      ok = Boolean(passed);
      if (ok) passedCount++;
      results.push({ name: t.name, passed: ok });
      if (!ok) errors.push(`Test failed: ${t.name}`);
    } catch (err) {
      results.push({ name: t.name, passed: false, error: err.message });
      errors.push(`Test "${t.name}" threw: ${err.message}`);
    }
  }

  const total = exercise.tests.length;
  const score = total > 0 ? Math.round((passedCount / total) * 100) : 0;
  const passed = passedCount === total && total > 0;
  return {
    passed,
    score,
    total,
    passedCount,
    results,
    feedback: passed
      ? `All ${total} tests passed. Nice work!`
      : `${passedCount}/${total} tests passed.`,
    errors,
  };
}
