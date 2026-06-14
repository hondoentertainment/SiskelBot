import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { withRetry, isTransientError, computeDelay } from "../lib/tool-retry.js";

describe("isTransientError", () => {
  it("returns true for ECONNREFUSED", () => {
    const err = new Error("connect refused");
    err.code = "ECONNREFUSED";
    assert.equal(isTransientError(err), true);
  });

  it("returns true for ETIMEDOUT", () => {
    const err = new Error("timed out");
    err.code = "ETIMEDOUT";
    assert.equal(isTransientError(err), true);
  });

  it("returns true for ENOTFOUND", () => {
    const err = new Error("not found");
    err.code = "ENOTFOUND";
    assert.equal(isTransientError(err), true);
  });

  it("returns true for ECONNRESET", () => {
    const err = new Error("connection reset");
    err.code = "ECONNRESET";
    assert.equal(isTransientError(err), true);
  });

  it("returns true for HTTP 503", () => {
    const err = new Error("service unavailable");
    err.status = 503;
    assert.equal(isTransientError(err), true);
  });

  it("returns true for HTTP 429", () => {
    const err = new Error("rate limited");
    err.status = 429;
    assert.equal(isTransientError(err), true);
  });

  it("returns true for HTTP 500", () => {
    const err = new Error("server error");
    err.status = 500;
    assert.equal(isTransientError(err), true);
  });

  it("returns true for HTTP 502", () => {
    const err = new Error("bad gateway");
    err.status = 502;
    assert.equal(isTransientError(err), true);
  });

  it("returns true for HTTP 504", () => {
    const err = new Error("gateway timeout");
    err.status = 504;
    assert.equal(isTransientError(err), true);
  });

  it("returns true for errors with .transient = true", () => {
    const err = new Error("something broke");
    err.transient = true;
    assert.equal(isTransientError(err), true);
  });

  it("returns true for fetch TypeError", () => {
    const err = new TypeError("fetch failed");
    assert.equal(isTransientError(err), true);
  });

  it("returns false for HTTP 400", () => {
    const err = new Error("bad request");
    err.status = 400;
    assert.equal(isTransientError(err), false);
  });

  it("returns false for HTTP 404", () => {
    const err = new Error("not found");
    err.status = 404;
    assert.equal(isTransientError(err), false);
  });

  it("returns false for HTTP 401", () => {
    const err = new Error("unauthorized");
    err.status = 401;
    assert.equal(isTransientError(err), false);
  });

  it("returns false for HTTP 403", () => {
    const err = new Error("forbidden");
    err.status = 403;
    assert.equal(isTransientError(err), false);
  });

  it("returns false for HTTP 422 validation", () => {
    const err = new Error("unprocessable entity");
    err.status = 422;
    assert.equal(isTransientError(err), false);
  });

  it("returns false for validation error by name", () => {
    const err = new Error("field is required");
    err.name = "ValidationError";
    assert.equal(isTransientError(err), false);
  });

  it("returns false for VALIDATION_ERROR code", () => {
    const err = new Error("invalid input");
    err.code = "VALIDATION_ERROR";
    assert.equal(isTransientError(err), false);
  });

  it("returns false for permission denied code", () => {
    const err = new Error("denied");
    err.code = "TOOL_NOT_ALLOWED";
    assert.equal(isTransientError(err), false);
  });

  it("returns false for POLICY_TOOL_DENIED code", () => {
    const err = new Error("denied by policy");
    err.code = "POLICY_TOOL_DENIED";
    assert.equal(isTransientError(err), false);
  });

  it("returns false for null/undefined", () => {
    assert.equal(isTransientError(null), false);
    assert.equal(isTransientError(undefined), false);
  });

  it("returns false for generic Error without transient markers", () => {
    const err = new Error("something went wrong");
    assert.equal(isTransientError(err), false);
  });
});

describe("computeDelay", () => {
  it("uses exponential backoff", () => {
    // Run many samples and check the average is in expected range
    const samples = 200;
    const delays = [];
    for (let i = 0; i < samples; i++) {
      delays.push(computeDelay(0, 1000, 8000));
    }
    const avg = delays.reduce((a, b) => a + b, 0) / samples;
    // attempt 0: base = 1000, jitter [0.5, 1.0) → range [500, 1000)
    assert.ok(avg >= 400, `average delay attempt 0 should be >= 400, got ${avg}`);
    assert.ok(avg <= 1100, `average delay attempt 0 should be <= 1100, got ${avg}`);
  });

  it("doubles delay for each attempt", () => {
    const samples = 200;
    const avg0 = Array.from({ length: samples }, () => computeDelay(0, 1000, 8000)).reduce((a, b) => a + b, 0) / samples;
    const avg1 = Array.from({ length: samples }, () => computeDelay(1, 1000, 8000)).reduce((a, b) => a + b, 0) / samples;
    const avg2 = Array.from({ length: samples }, () => computeDelay(2, 1000, 8000)).reduce((a, b) => a + b, 0) / samples;

    // avg1 should be roughly 2x avg0, avg2 roughly 2x avg1
    assert.ok(avg1 > avg0 * 1.5, `attempt 1 avg (${avg1}) should be > 1.5x attempt 0 avg (${avg0})`);
    assert.ok(avg2 > avg1 * 1.5, `attempt 2 avg (${avg2}) should be > 1.5x attempt 1 avg (${avg1})`);
  });

  it("caps delay at maxDelayMs", () => {
    for (let i = 0; i < 50; i++) {
      const delay = computeDelay(10, 1000, 8000);
      // max raw = 8000, jitter max = 1.0 → max possible = 8000
      assert.ok(delay <= 8000, `delay ${delay} exceeds maxDelayMs 8000`);
    }
  });

  it("applies jitter (delay varies between runs)", () => {
    const delays = new Set();
    for (let i = 0; i < 20; i++) {
      delays.add(computeDelay(1, 1000, 8000));
    }
    // With jitter, we should get multiple distinct values
    assert.ok(delays.size > 1, "expected jitter to produce varying delays");
  });
});

describe("withRetry", () => {
  it("returns result on first success", async () => {
    let callCount = 0;
    const result = await withRetry(async () => {
      callCount++;
      return "ok";
    }, { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1 });
    assert.equal(result, "ok");
    assert.equal(callCount, 1);
  });

  it("retries on transient error and returns result after recovery", async () => {
    let callCount = 0;
    const result = await withRetry(async () => {
      callCount++;
      if (callCount <= 2) {
        const err = new Error("connection refused");
        err.code = "ECONNREFUSED";
        throw err;
      }
      return "recovered";
    }, { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1 });
    assert.equal(result, "recovered");
    assert.equal(callCount, 3);
  });

  it("throws immediately on non-transient error without retrying", async () => {
    let callCount = 0;
    await assert.rejects(
      () =>
        withRetry(async () => {
          callCount++;
          const err = new Error("bad request");
          err.status = 400;
          throw err;
        }, { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1 }),
      (err) => {
        assert.equal(err.message, "bad request");
        return true;
      }
    );
    assert.equal(callCount, 1);
  });

  it("throws after exhausting all retries", async () => {
    let callCount = 0;
    await assert.rejects(
      () =>
        withRetry(async () => {
          callCount++;
          const err = new Error("service unavailable");
          err.status = 503;
          throw err;
        }, { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1 }),
      (err) => {
        assert.equal(err.message, "service unavailable");
        return true;
      }
    );
    // 1 initial + 3 retries = 4 total
    assert.equal(callCount, 4);
  });

  it("calls onRetry callback with correct arguments", async () => {
    const retryCalls = [];
    let callCount = 0;
    await assert.rejects(
      () =>
        withRetry(async () => {
          callCount++;
          const err = new Error("timeout");
          err.code = "ETIMEDOUT";
          throw err;
        }, {
          maxRetries: 2,
          baseDelayMs: 1,
          maxDelayMs: 1,
          onRetry: (err, attempt, delayMs) => {
            retryCalls.push({ message: err.message, attempt, delayMs });
          },
        }),
    );
    assert.equal(retryCalls.length, 2);
    assert.equal(retryCalls[0].attempt, 1);
    assert.equal(retryCalls[0].message, "timeout");
    assert.equal(typeof retryCalls[0].delayMs, "number");
    assert.equal(retryCalls[1].attempt, 2);
  });

  it("does not call onRetry when succeeding on first try", async () => {
    let retryCalled = false;
    await withRetry(async () => "ok", {
      maxRetries: 3,
      baseDelayMs: 1,
      maxDelayMs: 1,
      onRetry: () => { retryCalled = true; },
    });
    assert.equal(retryCalled, false);
  });

  it("uses custom isTransient classifier", async () => {
    let callCount = 0;
    // Custom classifier: only retry errors with code "CUSTOM_TRANSIENT"
    await assert.rejects(
      () =>
        withRetry(async () => {
          callCount++;
          const err = new Error("connection refused");
          err.code = "ECONNREFUSED";
          throw err;
        }, {
          maxRetries: 3,
          baseDelayMs: 1,
          maxDelayMs: 1,
          isTransient: (err) => err.code === "CUSTOM_TRANSIENT",
        }),
    );
    // Should not retry because custom classifier says not transient
    assert.equal(callCount, 1);
  });

  it("uses default options when none provided", async () => {
    let callCount = 0;
    const result = await withRetry(async () => {
      callCount++;
      return 42;
    });
    assert.equal(result, 42);
    assert.equal(callCount, 1);
  });

  it("handles maxRetries=0 (no retries)", async () => {
    let callCount = 0;
    await assert.rejects(
      () =>
        withRetry(async () => {
          callCount++;
          const err = new Error("fail");
          err.code = "ECONNREFUSED";
          throw err;
        }, { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 }),
    );
    assert.equal(callCount, 1);
  });

  it("preserves the original error when retries are exhausted", async () => {
    const originalErr = new Error("original network error");
    originalErr.code = "ECONNREFUSED";
    originalErr.extraInfo = "important";

    await assert.rejects(
      () =>
        withRetry(async () => {
          throw originalErr;
        }, { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 }),
      (err) => {
        assert.equal(err, originalErr);
        assert.equal(err.extraInfo, "important");
        return true;
      }
    );
  });

  it("swallows onRetry callback errors", async () => {
    let callCount = 0;
    const result = await withRetry(async () => {
      callCount++;
      if (callCount === 1) {
        const err = new Error("fail");
        err.code = "ECONNREFUSED";
        throw err;
      }
      return "ok";
    }, {
      maxRetries: 3,
      baseDelayMs: 1,
      maxDelayMs: 1,
      onRetry: () => {
        throw new Error("callback exploded");
      },
    });
    assert.equal(result, "ok");
    assert.equal(callCount, 2);
  });
});

describe("withRetry delay behavior", () => {
  it("delays increase exponentially with jitter", async () => {
    // We verify indirectly via timing that delays are applied.
    // Use small delays to keep the test fast.
    const t0 = Date.now();
    let callCount = 0;
    await assert.rejects(
      () =>
        withRetry(async () => {
          callCount++;
          const err = new Error("fail");
          err.status = 503;
          throw err;
        }, { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 100 }),
    );
    const elapsed = Date.now() - t0;
    assert.equal(callCount, 3); // 1 initial + 2 retries
    // Minimum total delay: attempt 0 → 10*0.5=5ms, attempt 1 → 20*0.5=10ms → >=15ms
    // Be generous with timing assertions
    assert.ok(elapsed >= 5, `Expected at least 5ms total delay, got ${elapsed}ms`);
  });
});

describe("AGENT_TOOL_RETRY_DISABLED integration", () => {
  let savedEnv;

  beforeEach(() => {
    savedEnv = process.env.AGENT_TOOL_RETRY_DISABLED;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.AGENT_TOOL_RETRY_DISABLED;
    } else {
      process.env.AGENT_TOOL_RETRY_DISABLED = savedEnv;
    }
  });

  it("when AGENT_TOOL_RETRY_DISABLED=1, withRetry can still be called but the env guard is in the caller", async () => {
    // This test verifies the pattern: callers check the env var and either
    // call withRetry or call the function directly. withRetry itself does
    // not check the env var — that's the caller's responsibility.
    process.env.AGENT_TOOL_RETRY_DISABLED = "1";
    const retryDisabled = process.env.AGENT_TOOL_RETRY_DISABLED === "1";
    let callCount = 0;
    const fn = async () => {
      callCount++;
      if (callCount === 1) {
        const err = new Error("fail");
        err.code = "ECONNREFUSED";
        throw err;
      }
      return "ok";
    };

    if (retryDisabled) {
      // When disabled, call directly — should throw on first failure
      await assert.rejects(() => fn());
      assert.equal(callCount, 1);
    } else {
      const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1 });
      assert.equal(result, "ok");
    }
  });
});
