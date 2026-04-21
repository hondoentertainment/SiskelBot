/**
 * Chaos drill — fault injection runner with assertions.
 *
 * Drives a synthetic backend through enough failures to trip the circuit
 * breaker, then asserts:
 *   1. The breaker reports `open` for that backend.
 *   2. A subsequent execute() call short-circuits with breaker_open.
 *   3. After cooldown the breaker either half-opens or fully closes on
 *      the next success.
 *
 * Result is a structured report suitable for cron-driven runs (an
 * out-of-tree wrapper script — see scripts/run-chaos-drill.mjs). Production
 * use is gated on CHAOS_DRILL_ENABLE=1 to keep this strictly opt-in.
 *
 * This module deliberately does NOT touch real backends. The drill operates
 * against a synthetic backend name so a regression in the breaker shows
 * up in the drill before it shows up in production.
 */
import {
  recordFailure,
  recordSuccess,
  isOpen,
  getBreakerSnapshot,
  execute,
} from "./circuit-breaker.js";

const DEFAULT_BACKEND = "chaos-drill-synthetic";
const FAILURE_THRESHOLD = Number(process.env.CIRCUIT_BREAKER_FAILURES) || 5;

function nowIso() {
  return new Date().toISOString();
}

/**
 * @param {Object} [opts]
 * @param {string} [opts.backend] - Synthetic backend name (default: chaos-drill-synthetic)
 * @param {number} [opts.failures] - Number of failures to inject (default: threshold + 1)
 * @returns {Promise<{ ok: boolean, steps: object[], summary: object }>}
 */
export async function runChaosDrill(opts = {}) {
  if (process.env.CHAOS_DRILL_ENABLE !== "1") {
    return {
      ok: false,
      steps: [],
      summary: {
        skipped: true,
        reason: "CHAOS_DRILL_ENABLE != 1",
        runAt: nowIso(),
      },
    };
  }

  const backend = opts.backend || DEFAULT_BACKEND;
  const failures = Math.max(
    1,
    Number(opts.failures) || FAILURE_THRESHOLD + 1
  );
  const steps = [];
  const startedAt = Date.now();

  for (let i = 0; i < failures; i += 1) {
    recordFailure(backend);
  }
  const tripCheck = isOpen(backend);
  steps.push({
    step: "trip-breaker",
    failuresInjected: failures,
    open: !!tripCheck.open,
    detail: tripCheck,
  });

  let shortCircuited = false;
  try {
    await execute(backend, async () => {
      throw new Error("should not run — breaker should be open");
    });
  } catch (err) {
    shortCircuited =
      /breaker.*open/i.test(err?.message || "") || err?.code === "BREAKER_OPEN";
    steps.push({
      step: "execute-when-open",
      shortCircuited,
      errorMessage: err?.message || null,
      errorCode: err?.code || null,
    });
  }

  recordSuccess(backend);
  const recovered = isOpen(backend);
  steps.push({
    step: "recover-after-success",
    open: !!recovered.open,
    snapshot: getBreakerSnapshot(backend),
  });

  const ok =
    steps[0].open === true &&
    steps[1].shortCircuited === true &&
    steps[2].open === false;

  return {
    ok,
    steps,
    summary: {
      backend,
      failuresInjected: failures,
      durationMs: Date.now() - startedAt,
      runAt: nowIso(),
    },
  };
}
