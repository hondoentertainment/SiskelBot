#!/usr/bin/env node
/**
 * Short-lived boot probe: import the app with VERCEL=1 (no long-lived listener from server.js),
 * spin up an ephemeral HTTP server, hit /health/live, exit 0.
 * Use in CI or local checks without holding `node server.js` open.
 */
import http from "node:http";

process.env.VERCEL = "1";
const { default: app } = await import(`../server.js?t=${Date.now()}`);

const server = http.createServer(app);
await new Promise((resolve, reject) => {
  server.listen(0, "127.0.0.1", (err) => (err ? reject(err) : resolve()));
});
const { port } = server.address();

try {
  const res = await fetch(`http://127.0.0.1:${port}/health/live`, { redirect: "follow" });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    console.error(JSON.stringify({ ok: false, status: res.status, body }));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ ok: true, status: res.status }));
  }
} finally {
  await new Promise((r) => server.close(r));
}
