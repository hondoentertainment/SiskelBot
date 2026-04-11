/**
 * Long-running missions unit tests.
 * Tests cover the full mission lifecycle, checkpoints, constraints,
 * progress tracking, completion detection, and the worker loop.
 *
 * Uses a temp directory via STORAGE_PATH so the tests don't pollute data/.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "siskelbot-missions-"));
process.env.STORAGE_PATH = tempDir;

const {
  createMission,
  startMission,
  pauseMission,
  resumeMission,
  abortMission,
  createCheckpoint,
  listCheckpoints,
  restoreFromCheckpoint,
  getMissionStatus,
  getMission,
  listMissions,
  getMissionHistory,
  updateProgress,
  reportMilestone,
  incrementCounters,
  appendConversationMessage,
  checkConstraints,
  deleteMission,
} = await import("../lib/long-running-missions.js");

const {
  runMission,
  startMissionWorker,
  stopMissionWorker,
  tickAllMissions,
} = await import("../lib/mission-runner.js");

test.after(() => {
  stopMissionWorker();
  try {
    rmSync(tempDir, { recursive: true });
  } catch (_) {}
});

// --- Lifecycle ---

test("createMission creates a pending mission with defaults", async () => {
  const result = await createMission({
    workspaceId: "lifecycle",
    name: "Test mission",
    goal: "Investigate the issue",
  });
  assert.ok(result.missionId, "missionId returned");
  assert.equal(result.status, "pending");

  const mission = await getMission(result.missionId);
  assert.equal(mission.name, "Test mission");
  assert.equal(mission.goal, "Investigate the issue");
  assert.equal(mission.status, "pending");
  assert.equal(mission.progress, 0);
  assert.ok(mission.constraints);
  assert.ok(mission.maxDurationHours > 0);
});

test("createMission rejects missing name and goal", async () => {
  await assert.rejects(() => createMission({ workspaceId: "lifecycle", goal: "x" }), /name is required/);
  await assert.rejects(() => createMission({ workspaceId: "lifecycle", name: "x" }), /goal is required/);
});

test("startMission transitions pending → running and creates a checkpoint", async () => {
  const { missionId } = await createMission({ workspaceId: "lifecycle", name: "M2", goal: "G2" });
  const result = await startMission(missionId);
  assert.equal(result.started, true);
  assert.ok(result.firstCheckpoint?.checkpointId);

  const mission = await getMission(missionId);
  assert.equal(mission.status, "running");
  assert.ok(mission.startedAt);
  assert.equal(mission.checkpoints.length, 1);
});

test("pauseMission and resumeMission cycle", async () => {
  const { missionId } = await createMission({ workspaceId: "lifecycle", name: "P", goal: "G" });
  await startMission(missionId);
  await pauseMission(missionId, "user");
  let m = await getMission(missionId);
  assert.equal(m.status, "paused");
  assert.ok(m.pausedAt);

  await resumeMission(missionId);
  m = await getMission(missionId);
  assert.equal(m.status, "running");
  assert.equal(m.pausedAt, null);
});

test("pauseMission fails when not running", async () => {
  const { missionId } = await createMission({ workspaceId: "lifecycle", name: "x", goal: "y" });
  await assert.rejects(() => pauseMission(missionId), /Cannot pause/);
});

test("abortMission terminates the mission", async () => {
  const { missionId } = await createMission({ workspaceId: "lifecycle", name: "A", goal: "G" });
  await startMission(missionId);
  const result = await abortMission(missionId, "user requested");
  assert.equal(result.aborted, true);
  const m = await getMission(missionId);
  assert.equal(m.status, "aborted");
  assert.equal(m.abortReason, "user requested");
});

test("abortMission on already-terminal mission is a no-op", async () => {
  const { missionId } = await createMission({ workspaceId: "lifecycle", name: "A2", goal: "G" });
  await startMission(missionId);
  await abortMission(missionId, "first");
  const second = await abortMission(missionId, "second");
  assert.equal(second.aborted, false);
  assert.equal(second.alreadyTerminal, true);
});

// --- Checkpointing ---

test("createCheckpoint snapshots state", async () => {
  const { missionId } = await createMission({ workspaceId: "checkpoints", name: "CP", goal: "G" });
  await startMission(missionId);
  await updateProgress(missionId, 0.25);
  await incrementCounters(missionId, { iterations: 3, toolCalls: 7, costUsd: 0.42 });

  const cp = await createCheckpoint(missionId);
  assert.ok(cp.checkpointId);
  assert.ok(cp.savedAt);

  const checkpoints = await listCheckpoints(missionId);
  assert.ok(checkpoints.length >= 2); // start + manual
});

test("restoreFromCheckpoint restores prior state", async () => {
  const { missionId } = await createMission({ workspaceId: "checkpoints", name: "RST", goal: "G" });
  await startMission(missionId);
  await updateProgress(missionId, 0.3);
  await incrementCounters(missionId, { iterations: 2, toolCalls: 5, costUsd: 1.2 });
  await appendConversationMessage(missionId, { role: "assistant", content: "early state" });
  const early = await createCheckpoint(missionId);

  // Advance further
  await updateProgress(missionId, 0.8);
  await incrementCounters(missionId, { iterations: 5, toolCalls: 20, costUsd: 5.0 });
  await appendConversationMessage(missionId, { role: "assistant", content: "later state" });

  let m = await getMission(missionId);
  assert.equal(m.progress, 0.8);
  assert.equal(m.toolCallsCount, 25);

  const r = await restoreFromCheckpoint(missionId, early.checkpointId);
  assert.equal(r.restored, true);
  m = await getMission(missionId);
  assert.equal(m.progress, 0.3);
  assert.equal(m.toolCallsCount, 5);
  assert.equal(m.iterationsCount, 2);
  assert.equal(m.status, "paused", "restored mission should be paused");
  assert.equal(m.conversationHistory.length, 1);
});

test("restoreFromCheckpoint fails for unknown checkpoint id", async () => {
  const { missionId } = await createMission({ workspaceId: "checkpoints", name: "X", goal: "G" });
  await startMission(missionId);
  await assert.rejects(() => restoreFromCheckpoint(missionId, "nonexistent"), /not found|Invalid/);
});

// --- Constraints ---

test("checkConstraints reports time-limit violation", () => {
  const startedAt = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
  const mission = {
    startedAt,
    maxDurationHours: 5,
    constraints: { maxToolCalls: 1000, maxCostUsd: 100 },
    toolCallsCount: 1,
    costUsd: 0,
  };
  const result = checkConstraints(mission);
  assert.equal(result.withinLimits, false);
  assert.ok(result.violations.some((v) => v.includes("time limit")));
});

test("checkConstraints reports tool call violation", () => {
  const mission = {
    startedAt: new Date().toISOString(),
    maxDurationHours: 100,
    constraints: { maxToolCalls: 10, maxCostUsd: 100 },
    toolCallsCount: 50,
    costUsd: 0,
  };
  const result = checkConstraints(mission);
  assert.equal(result.withinLimits, false);
  assert.ok(result.violations.some((v) => v.includes("tool call")));
});

test("checkConstraints reports cost violation", () => {
  const mission = {
    startedAt: new Date().toISOString(),
    maxDurationHours: 100,
    constraints: { maxToolCalls: 1000, maxCostUsd: 5 },
    toolCallsCount: 1,
    costUsd: 25,
  };
  const result = checkConstraints(mission);
  assert.equal(result.withinLimits, false);
  assert.ok(result.violations.some((v) => v.includes("cost limit")));
});

test("checkConstraints passes when all within limits", () => {
  const mission = {
    startedAt: new Date().toISOString(),
    maxDurationHours: 100,
    constraints: { maxToolCalls: 1000, maxCostUsd: 100 },
    toolCallsCount: 1,
    costUsd: 0.5,
  };
  const result = checkConstraints(mission);
  assert.equal(result.withinLimits, true);
  assert.equal(result.violations.length, 0);
});

// --- Progress tracking ---

test("updateProgress accepts numbers and step objects", async () => {
  const { missionId } = await createMission({ workspaceId: "progress", name: "P1", goal: "G" });
  await startMission(missionId);
  await updateProgress(missionId, 0.5);
  let m = await getMission(missionId);
  assert.equal(m.progress, 0.5);

  await updateProgress(missionId, { step: 3, totalSteps: 4, currentStep: "Phase 3 of 4" });
  m = await getMission(missionId);
  assert.equal(m.progress, 0.75);
  assert.equal(m.currentStep, "Phase 3 of 4");
});

test("updateProgress clamps values to [0, 1]", async () => {
  const { missionId } = await createMission({ workspaceId: "progress", name: "P2", goal: "G" });
  await startMission(missionId);
  await updateProgress(missionId, 1.5);
  let m = await getMission(missionId);
  assert.equal(m.progress, 1);
  await updateProgress(missionId, -0.5);
  m = await getMission(missionId);
  assert.equal(m.progress, 0);
});

test("reportMilestone records a milestone", async () => {
  const { missionId } = await createMission({ workspaceId: "progress", name: "MS", goal: "G" });
  await startMission(missionId);
  const m = await reportMilestone(missionId, "Phase 1 complete");
  assert.ok(m.id);
  assert.equal(m.label, "Phase 1 complete");
  const mission = await getMission(missionId);
  assert.equal(mission.milestones.length, 1);
});

// --- Status / listing / history ---

test("getMissionStatus returns elapsed and progress fields", async () => {
  const { missionId } = await createMission({ workspaceId: "status", name: "S", goal: "G" });
  await startMission(missionId);
  await updateProgress(missionId, 0.4);
  const s = await getMissionStatus(missionId);
  assert.ok(s);
  assert.equal(s.status, "running");
  assert.equal(s.progress, 0.4);
  assert.ok(s.elapsedTime >= 0);
  assert.ok(s.checkpoints.length >= 1);
});

test("listMissions returns missions filtered by status", async () => {
  await createMission({ workspaceId: "list-test", name: "A", goal: "g" });
  const startedRes = await createMission({ workspaceId: "list-test", name: "B", goal: "g" });
  await startMission(startedRes.missionId);

  const all = await listMissions("list-test");
  assert.ok(all.length >= 2);

  const running = await listMissions("list-test", "running");
  assert.ok(running.every((m) => m.status === "running"));
  assert.ok(running.length >= 1);

  const pending = await listMissions("list-test", "pending");
  assert.ok(pending.every((m) => m.status === "pending"));
});

test("getMissionHistory returns events newest-first", async () => {
  const { missionId } = await createMission({ workspaceId: "history", name: "H", goal: "G" });
  await startMission(missionId);
  await pauseMission(missionId, "test");
  const events = await getMissionHistory(missionId);
  assert.ok(events.length >= 3); // created, started, checkpoint, paused
  const types = events.map((e) => e.type);
  assert.ok(types.includes("created"));
  assert.ok(types.includes("started"));
  assert.ok(types.includes("paused"));
});

// --- Completion detection (via runner) ---

test("runMission completes when iterate returns done=true", async () => {
  const { missionId } = await createMission({ workspaceId: "runner", name: "Done", goal: "Finish" });
  await startMission(missionId);

  let calls = 0;
  const result = await runMission(missionId, {
    maxIterations: 5,
    iterate: async () => {
      calls += 1;
      return {
        progress: calls / 3,
        currentStep: "step " + calls,
        toolCalls: 1,
        costUsd: 0.01,
        done: calls >= 3,
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.completed, true);
  const m = await getMission(missionId);
  assert.equal(m.status, "completed");
  assert.equal(m.progress, 1);
  assert.equal(m.toolCallsCount, 3);
});

test("runMission fails when iterate throws", async () => {
  const { missionId } = await createMission({ workspaceId: "runner", name: "Fail", goal: "G" });
  await startMission(missionId);
  const result = await runMission(missionId, {
    maxIterations: 3,
    iterate: async () => {
      throw new Error("backend down");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.failed, true);
  const m = await getMission(missionId);
  assert.equal(m.status, "failed");
  assert.match(m.failureReason, /backend down/);
});

test("runMission aborts when constraints are exceeded", async () => {
  const { missionId } = await createMission({
    workspaceId: "runner",
    name: "Limit",
    goal: "G",
    constraints: { maxToolCalls: 2, maxCostUsd: 100 },
  });
  await startMission(missionId);
  // Pre-bump tool calls past the limit
  await incrementCounters(missionId, { toolCalls: 10 });

  const result = await runMission(missionId, {
    maxIterations: 3,
    iterate: async () => ({ progress: 0.1, toolCalls: 0, costUsd: 0 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.aborted, true);
  assert.ok(result.violations.some((v) => v.includes("tool call")));
  const m = await getMission(missionId);
  assert.equal(m.status, "aborted");
});

test("runMission stops when mission is paused externally", async () => {
  const { missionId } = await createMission({ workspaceId: "runner", name: "Pausing", goal: "G" });
  await startMission(missionId);
  await pauseMission(missionId, "ext");

  const result = await runMission(missionId, {
    maxIterations: 3,
    iterate: async () => ({ progress: 0.5 }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.paused, true);
});

// --- Worker loop ---

test("startMissionWorker schedules a tick interval and stops", async () => {
  const start = startMissionWorker({ intervalMs: 60_000, workspaces: ["worker-test"] });
  assert.equal(start.started, true);
  // Starting twice is a no-op
  const start2 = startMissionWorker({});
  assert.equal(start2.started, false);
  const stop = stopMissionWorker();
  assert.equal(stop.stopped, true);
});

test("tickAllMissions advances running missions for a workspace", async () => {
  const { missionId } = await createMission({ workspaceId: "tick-ws", name: "T", goal: "G" });
  await startMission(missionId);

  let calls = 0;
  const results = await tickAllMissions({
    workspaces: ["tick-ws"],
    maxIterations: 2,
    iterate: async () => {
      calls += 1;
      return { progress: calls * 0.5, done: calls >= 2 };
    },
  });
  assert.ok(results.length >= 1);
  assert.ok(calls >= 1);
  const m = await getMission(missionId);
  assert.ok(["running", "completed"].includes(m.status));
});

// --- Cleanup ---

test("deleteMission removes mission and checkpoints", async () => {
  const { missionId } = await createMission({ workspaceId: "delete-test", name: "Del", goal: "G" });
  await startMission(missionId);
  await createCheckpoint(missionId);
  const deleted = await deleteMission("delete-test", missionId);
  assert.equal(deleted, true);
  const m = await getMission(missionId);
  assert.equal(m, null);
  const all = await listMissions("delete-test");
  assert.equal(all.find((x) => x.missionId === missionId), undefined);
});
