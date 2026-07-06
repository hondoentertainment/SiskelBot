#!/usr/bin/env node
/**
 * Live probes for the commercial go-live checklist (docs/GO_LIVE.md).
 *
 * Usage:
 *   node scripts/go-live-verify.mjs [BASE_URL]
 *   BASE_URL=https://example.com npm run go-live:verify
 *
 * Exits 1 when any required probe fails.
 */
const BASE = (process.argv[2] || process.env.BASE_URL || "").replace(/\/$/, "");
const STRICT = process.argv.includes("--strict") || process.env.GO_LIVE_STRICT === "1";

/** Probes that must pass for any deployment. */
const CRITICAL = new Set(["health/live", "config", "billing/plans", "account.html", "pricing.html"]);
/** Probes that pass only after GO_LIVE flags (Stripe, enforcement, durable storage). */
const COMMERCIAL = new Set(["health/deep", "entitlements"]);

/** @param {string} path */
function url(path) {
  return `${BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

/** @param {string} name @param {() => Promise<{ ok: boolean, detail?: string }>} fn */
async function probe(name, fn) {
  try {
    const r = await fn();
    return { name, ok: r.ok, detail: r.detail ?? "" };
  } catch (e) {
    return { name, ok: false, detail: String(e?.message || e) };
  }
}

async function main() {
  if (!BASE) {
    console.error("Usage: node scripts/go-live-verify.mjs <BASE_URL>");
    process.exit(2);
  }

  const results = [];

  results.push(
    await probe("health/live", async () => {
      const r = await fetch(url("/health/live"));
      const j = await r.json().catch(() => ({}));
      return { ok: r.ok && j?.ok === true, detail: j?.status || String(r.status) };
    })
  );

  results.push(
    await probe("health/deep", async () => {
      const r = await fetch(url("/health/deep"));
      const j = await r.json().catch(() => ({}));
      const deps = j?.dependencies;
      const depOk =
        !deps ||
        typeof deps !== "object" ||
        Object.values(deps).every((d) => d?.ok !== false);
      return { ok: r.ok && j?.ok !== false && depOk, detail: j?.status || String(r.status) };
    })
  );

  results.push(
    await probe("config", async () => {
      const r = await fetch(url("/config"));
      const j = await r.json().catch(() => ({}));
      return { ok: r.ok && typeof j === "object", detail: `requiresApiKey=${j?.requiresApiKey}` };
    })
  );

  results.push(
    await probe("billing/plans", async () => {
      const r = await fetch(url("/api/v1/billing/plans"));
      const j = await r.json().catch(() => ({}));
      const count = Array.isArray(j?.plans) ? j.plans.length : 0;
      return { ok: r.ok && count >= 1, detail: `plans=${count}` };
    })
  );

  results.push(
    await probe("entitlements", async () => {
      const r = await fetch(url("/api/v1/entitlements?workspace=default"));
      const j = await r.json().catch(() => ({}));
      const plan = j?.plan;
      const planName =
        typeof plan === "string" ? plan : plan?.name || plan?.id || plan?.tier || "";
      const enforced = j?.enforced === true;
      const ok = r.ok && Boolean(planName) && (STRICT ? enforced : true);
      return {
        ok,
        detail: `plan=${planName || "?"} enforced=${enforced}`,
      };
    })
  );

  results.push(
    await probe("account.html", async () => {
      const r = await fetch(url("/account.html"), { redirect: "manual" });
      const ok = r.status === 200 || r.status === 302;
      return { ok, detail: String(r.status) };
    })
  );

  results.push(
    await probe("pricing.html", async () => {
      const r = await fetch(url("/pricing.html"));
      return { ok: r.ok, detail: String(r.status) };
    })
  );

  const failed = results.filter((x) => !x.ok);
  const criticalFailed = failed.filter((x) => CRITICAL.has(x.name));
  const commercialFailed = failed.filter((x) => COMMERCIAL.has(x.name));
  console.log(
    JSON.stringify(
      {
        baseUrl: BASE,
        strict: STRICT,
        results,
        passed: results.length - failed.length,
        failed: failed.length,
        criticalFailed: criticalFailed.map((x) => x.name),
        commercialFailed: commercialFailed.map((x) => x.name),
      },
      null,
      2
    )
  );
  if (criticalFailed.length > 0) process.exit(1);
  if (STRICT && commercialFailed.length > 0) process.exit(1);
}

main();
