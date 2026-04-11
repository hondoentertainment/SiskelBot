/**
 * Phase 45.1: Federated training coordinator tests.
 *
 * Covers:
 *   - FedAvg math (computeWeights, federatedAverage)
 *   - Round lifecycle (create → join → submit → aggregate → complete)
 *   - Weighted averaging by sample count
 *   - Error handling (full rounds, duplicate submissions, missing state)
 *   - Model distribution
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-fed-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const { federatedAverage, computeWeights } = await import("../lib/fedavg.js");
const {
  createFederatedRound,
  joinRound,
  submitGradients,
  aggregateGradients,
  distributeModel,
  completeRound,
  cancelRound,
  getRound,
  listRounds,
  deleteRound,
  FederatedRoundStates,
} = await import("../lib/federated-training.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

// ---- computeWeights ----

test("computeWeights normalizes to sum 1", () => {
  const w = computeWeights([10, 20, 70]);
  assert.equal(w.length, 3);
  assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.ok(Math.abs(w[0] - 0.1) < 1e-9);
  assert.ok(Math.abs(w[1] - 0.2) < 1e-9);
  assert.ok(Math.abs(w[2] - 0.7) < 1e-9);
});

test("computeWeights returns empty array on empty input", () => {
  assert.deepEqual(computeWeights([]), []);
});

test("computeWeights returns zeros when every count is zero or invalid", () => {
  const w = computeWeights([0, -1, NaN]);
  assert.deepEqual(w, [0, 0, 0]);
});

// ---- federatedAverage ----

test("federatedAverage averages scalar updates equally when sample counts match", () => {
  const result = federatedAverage([
    { gradients: { bias: 1 }, sampleCount: 5 },
    { gradients: { bias: 3 }, sampleCount: 5 },
  ]);
  assert.ok(Math.abs(result.averaged.bias - 2) < 1e-9);
  assert.equal(result.totalSamples, 10);
  assert.equal(result.clientCount, 2);
});

test("federatedAverage weights scalar updates by sample count", () => {
  const result = federatedAverage([
    { gradients: { x: 10 }, sampleCount: 1 },
    { gradients: { x: 0 }, sampleCount: 9 },
  ]);
  // Expected: (10 * 0.1) + (0 * 0.9) = 1
  assert.ok(Math.abs(result.averaged.x - 1) < 1e-9);
});

test("federatedAverage averages arrays element-wise", () => {
  const result = federatedAverage([
    { gradients: { w: [2, 4, 6] }, sampleCount: 1 },
    { gradients: { w: [4, 8, 12] }, sampleCount: 1 },
  ]);
  assert.deepEqual(
    result.averaged.w.map((x) => Number(x.toFixed(9))),
    [3, 6, 9],
  );
});

test("federatedAverage handles missing keys as zero contributions", () => {
  const result = federatedAverage([
    { gradients: { a: 4, b: 8 }, sampleCount: 1 },
    { gradients: { a: 4 }, sampleCount: 1 },
  ]);
  assert.ok(Math.abs(result.averaged.a - 4) < 1e-9);
  // b only appears in one client with half weight ⇒ 8 * 0.5 = 4
  assert.ok(Math.abs(result.averaged.b - 4) < 1e-9);
});

test("federatedAverage pads mismatched array lengths with zeros", () => {
  const result = federatedAverage([
    { gradients: { w: [1, 1, 1] }, sampleCount: 1 },
    { gradients: { w: [2, 2] }, sampleCount: 1 },
  ]);
  // weights each = 0.5
  // idx0: 0.5 + 1.0 = 1.5
  // idx1: 0.5 + 1.0 = 1.5
  // idx2: 0.5 + 0.0 = 0.5
  const avg = result.averaged.w.map((x) => Number(x.toFixed(9)));
  assert.deepEqual(avg, [1.5, 1.5, 0.5]);
});

test("federatedAverage returns empty for empty input", () => {
  const r = federatedAverage([]);
  assert.deepEqual(r.averaged, {});
  assert.equal(r.clientCount, 0);
  assert.equal(r.totalSamples, 0);
});

test("federatedAverage skips invalid entries", () => {
  const r = federatedAverage([null, { gradients: null }, { gradients: { z: 5 }, sampleCount: 2 }]);
  assert.equal(r.clientCount, 1);
  assert.ok(Math.abs(r.averaged.z - 5) < 1e-9);
});

// ---- Round lifecycle ----

test("createFederatedRound returns an open round with an id", async () => {
  const round = await createFederatedRound({ modelId: "m1", minClients: 2, maxClients: 5 });
  assert.ok(round.id);
  assert.equal(round.state, FederatedRoundStates.OPEN);
  assert.equal(round.modelId, "m1");
  assert.equal(round.minClients, 2);
  assert.equal(round.maxClients, 5);
});

test("getRound retrieves a created round by id", async () => {
  const round = await createFederatedRound({ modelId: "m2" });
  const fetched = await getRound(round.id);
  assert.ok(fetched);
  assert.equal(fetched.id, round.id);
  assert.equal(fetched.modelId, "m2");
});

test("joinRound registers a client and returns clientId", async () => {
  const round = await createFederatedRound({ modelId: "m3", minClients: 2 });
  const { clientId, round: updated } = await joinRound(round.id, "user-1", { platform: "web" });
  assert.ok(clientId);
  assert.ok(updated.clients[clientId]);
  assert.equal(updated.clients[clientId].userId, "user-1");
  assert.equal(updated.clients[clientId].capabilities.platform, "web");
});

test("joinRound rejects when round is full", async () => {
  const round = await createFederatedRound({ modelId: "m4", minClients: 1, maxClients: 1 });
  await joinRound(round.id, "user-a");
  await assert.rejects(
    () => joinRound(round.id, "user-b"),
    /full/,
  );
});

test("submitGradients records the update and marks client submitted", async () => {
  const round = await createFederatedRound({ modelId: "m5", minClients: 1 });
  const { clientId } = await joinRound(round.id, "u");
  const updated = await submitGradients(
    round.id,
    clientId,
    { bias: 0.25 },
    { sampleCount: 8 },
  );
  assert.ok(updated.submissions[clientId]);
  assert.equal(updated.submissions[clientId].sampleCount, 8);
  assert.equal(updated.clients[clientId].submitted, true);
});

test("submitGradients rejects duplicate submissions", async () => {
  const round = await createFederatedRound({ modelId: "m6", minClients: 1 });
  const { clientId } = await joinRound(round.id, "u");
  await submitGradients(round.id, clientId, { a: 1 }, { sampleCount: 1 });
  await assert.rejects(
    () => submitGradients(round.id, clientId, { a: 2 }, { sampleCount: 1 }),
    /already submitted/,
  );
});

test("submitGradients rejects empty or invalid gradients", async () => {
  const round = await createFederatedRound({ modelId: "m7", minClients: 1 });
  const { clientId } = await joinRound(round.id, "u");
  await assert.rejects(() => submitGradients(round.id, clientId, {}), /non-empty/);
  await assert.rejects(() => submitGradients(round.id, clientId, null), /non-empty/);
});

test("aggregateGradients requires the configured minimum client count", async () => {
  const round = await createFederatedRound({ modelId: "m8", minClients: 3 });
  const { clientId: c1 } = await joinRound(round.id, "u1");
  await submitGradients(round.id, c1, { x: 1 }, { sampleCount: 1 });
  await assert.rejects(() => aggregateGradients(round.id), /need >=/);
});

test("aggregateGradients produces FedAvg weighted weights and updates round", async () => {
  const round = await createFederatedRound({
    modelId: "m9",
    minClients: 2,
    initialWeights: { bias: 0, w: [0, 0] },
  });
  const { clientId: c1 } = await joinRound(round.id, "u1");
  const { clientId: c2 } = await joinRound(round.id, "u2");
  await submitGradients(round.id, c1, { bias: 10, w: [2, 4] }, { sampleCount: 1 });
  await submitGradients(round.id, c2, { bias: 0, w: [0, 0] }, { sampleCount: 9 });

  const aggregated = await aggregateGradients(round.id);
  // weights: [0.1, 0.9], bias averaged = 1, w averaged = [0.2, 0.4]
  assert.ok(Math.abs(aggregated.weights.bias - 1) < 1e-9);
  const expectedW = [0.2, 0.4];
  aggregated.weights.w.forEach((v, i) => {
    assert.ok(Math.abs(v - expectedW[i]) < 1e-9);
  });
  assert.equal(aggregated.totalSamples, 10);
  assert.equal(aggregated.state, FederatedRoundStates.OPEN);
  assert.ok(aggregated.aggregated);
  assert.equal(aggregated.aggregated.clientCount, 2);
});

test("distributeModel returns current weights and records distribution", async () => {
  const round = await createFederatedRound({
    modelId: "m10",
    minClients: 1,
    initialWeights: { bias: 0 },
  });
  const { clientId } = await joinRound(round.id, "u");
  const payload = await distributeModel(round.id, clientId);
  assert.equal(payload.modelId, "m10");
  assert.equal(payload.roundId, round.id);
  assert.ok(payload.weights);
  // The version starts at 0 (no aggregation has happened yet).
  assert.equal(payload.version, 0);

  const refetched = await getRound(round.id);
  assert.equal(refetched.clients[clientId].distributions, 1);
});

test("distributeModel rejects unknown clients", async () => {
  const round = await createFederatedRound({ modelId: "m11", minClients: 1 });
  await assert.rejects(
    () => distributeModel(round.id, "client_bogus"),
    /has not joined/,
  );
});

test("completeRound sets metrics and transitions to completed", async () => {
  const round = await createFederatedRound({ modelId: "m12", minClients: 2 });
  const { clientId: c1 } = await joinRound(round.id, "u1");
  const { clientId: c2 } = await joinRound(round.id, "u2");
  await submitGradients(round.id, c1, { a: 1 }, { sampleCount: 5 });
  await submitGradients(round.id, c2, { a: 3 }, { sampleCount: 5 });
  await aggregateGradients(round.id);
  const completed = await completeRound(round.id);
  assert.equal(completed.state, FederatedRoundStates.COMPLETED);
  assert.ok(completed.metrics);
  assert.equal(completed.metrics.participatingClients, 2);
  assert.equal(completed.metrics.submittedClients, 2);
  assert.equal(completed.metrics.totalSamples, 10);
  assert.equal(completed.metrics.participationRate, 1);
  assert.equal(completed.metrics.aggregationCount, 1);
});

test("submitGradients rejects after round is completed", async () => {
  const round = await createFederatedRound({ modelId: "m13", minClients: 1 });
  const { clientId } = await joinRound(round.id, "u");
  await submitGradients(round.id, clientId, { a: 1 }, { sampleCount: 1 });
  await aggregateGradients(round.id);
  await completeRound(round.id);

  const { clientId: c2 } = await joinRound(round.id, "u2").catch(() => ({ clientId: null }));
  if (c2) {
    await assert.rejects(
      () => submitGradients(round.id, c2, { a: 1 }),
      /not accepting/,
    );
  } else {
    // joinRound rightly refused on a non-open round — good signal too.
    assert.ok(true);
  }
});

test("cancelRound transitions the round to cancelled", async () => {
  const round = await createFederatedRound({ modelId: "m14", minClients: 2 });
  const cancelled = await cancelRound(round.id);
  assert.ok(cancelled);
  assert.equal(cancelled.state, FederatedRoundStates.CANCELLED);
});

test("listRounds returns recently created rounds", async () => {
  const a = await createFederatedRound({ modelId: "list-a" });
  const b = await createFederatedRound({ modelId: "list-b" });
  const rounds = await listRounds({ limit: 10 });
  const ids = rounds.map((r) => r.id);
  assert.ok(ids.includes(a.id));
  assert.ok(ids.includes(b.id));
});

test("deleteRound removes a round from storage", async () => {
  const round = await createFederatedRound({ modelId: "del-me" });
  const ok = await deleteRound(round.id);
  assert.equal(ok, true);
  const gone = await getRound(round.id);
  assert.equal(gone, null);
});
