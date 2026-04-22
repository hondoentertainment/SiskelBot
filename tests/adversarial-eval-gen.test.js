import test from "node:test";
import assert from "node:assert/strict";

const {
  buildStaticAdversarialEvalSet,
  expandAdversarialWithLlm,
  runAdversarialSuite,
} = await import("../lib/adversarial-eval-gen.js");

test("buildStaticAdversarialEvalSet: returns cases of all categories", () => {
  const set = buildStaticAdversarialEvalSet();
  assert.equal(set.id, "adversarial");
  assert.ok(set.cases.length >= 10);
  const cats = new Set(set.cases.map((c) => c.category));
  assert.ok(cats.has("prompt_injection"));
  assert.ok(cats.has("goal_hijack"));
  assert.ok(cats.has("pii_exfil"));
  for (const c of set.cases) {
    assert.equal(c.expectSafetyBlock, true);
    assert.equal(c.target, "safety_probe");
  }
});

test("expandAdversarialWithLlm: returns static-only when no backend", async () => {
  const r = await expandAdversarialWithLlm({});
  assert.ok(r.length >= 10);
});

test("expandAdversarialWithLlm: adds variations when LLM responds", async () => {
  const backendFetch = async () => ({
    ok: true,
    async json() {
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                variations: ["var a", "var b", "var c"],
              }),
            },
          },
        ],
      };
    },
  });
  const r = await expandAdversarialWithLlm({
    backendFetch,
    url: "http://stub",
    model: "m",
    perTemplate: 2,
  });
  // Original count + 2 per template variations
  assert.ok(r.length > 15);
});

test("expandAdversarialWithLlm: tolerates non-ok response", async () => {
  const backendFetch = async () => ({ ok: false });
  const r = await expandAdversarialWithLlm({ backendFetch, url: "u", model: "m" });
  assert.ok(r.length >= 10);
});

test("runAdversarialSuite: skipped when gate disabled", async () => {
  const prev = process.env.SAFETY_PROBE_GATE;
  delete process.env.SAFETY_PROBE_GATE;
  try {
    const r = await runAdversarialSuite();
    assert.equal(r.skipped, true);
  } finally {
    if (prev !== undefined) process.env.SAFETY_PROBE_GATE = prev;
  }
});

test("runAdversarialSuite: runs when gate enabled", async () => {
  const prev = process.env.SAFETY_PROBE_GATE;
  process.env.SAFETY_PROBE_GATE = "1";
  try {
    const r = await runAdversarialSuite();
    assert.equal(r.skipped, false);
    assert.ok(r.total > 0);
    // At least some prompt-injection templates should be blocked by the gate.
    assert.ok(typeof r.passRate === "number");
  } finally {
    if (prev === undefined) delete process.env.SAFETY_PROBE_GATE;
    else process.env.SAFETY_PROBE_GATE = prev;
  }
});
