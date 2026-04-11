/**
 * MLflow-style experiment SDK (Phase 38.4).
 * Convenience wrapper around lib/experiments.js for training and evaluation scripts.
 */
import {
  createExperiment,
  listExperiments,
  startRun,
  logParam,
  logParams,
  logMetric,
  logMetrics,
  logArtifact,
  setRunStatus,
  getRun,
} from "./experiments.js";

/**
 * MLflow-style tracker that manages a single run lifecycle.
 *
 * Usage:
 *   const tracker = new ExperimentTracker("my-experiment", { workspaceId: "default" });
 *   await tracker.start();
 *   await tracker.logParam("learning_rate", 0.01);
 *   await tracker.logMetric("accuracy", 0.92, 1);
 *   await tracker.end("completed");
 */
export class ExperimentTracker {
  /**
   * @param {string} experimentName
   * @param {object} [options] - { workspaceId, runName, tags, baselineRunId, description }
   */
  constructor(experimentName, options = {}) {
    if (!experimentName || typeof experimentName !== "string") {
      throw new Error("experimentName is required");
    }
    this.experimentName = experimentName;
    this.workspaceId = options.workspaceId || "default";
    this.runName = options.runName || null;
    this.tags = Array.isArray(options.tags) ? options.tags : [];
    this.baselineRunId = options.baselineRunId || null;
    this.description = options.description || null;
    this.experimentId = null;
    this.runId = null;
    this.status = "pending";
    this._started = false;
    this._ended = false;
  }

  /**
   * Find or create the experiment, then start a new run.
   */
  async start() {
    if (this._started) return { runId: this.runId, experimentId: this.experimentId };

    const existing = await listExperiments(this.workspaceId);
    const match = existing.find((e) => e.name === this.experimentName);
    let experiment;
    if (match) {
      experiment = match;
    } else {
      experiment = await createExperiment(this.experimentName, this.workspaceId, {
        description: this.description,
        tags: this.tags,
      });
    }
    this.experimentId = experiment.id;

    const result = await startRun(this.experimentId, {
      workspaceId: this.workspaceId,
      name: this.runName,
      tags: this.tags,
      baselineRunId: this.baselineRunId,
    });
    this.runId = result.runId;
    this.status = "running";
    this._started = true;
    return { runId: this.runId, experimentId: this.experimentId };
  }

  _requireStarted() {
    if (!this._started || !this.runId) {
      throw new Error("tracker not started; call start() first");
    }
    if (this._ended) {
      throw new Error("tracker has already ended");
    }
  }

  async logParam(key, value) {
    this._requireStarted();
    return logParam(this.runId, key, value);
  }

  async logParams(params) {
    this._requireStarted();
    return logParams(this.runId, params);
  }

  async logMetric(key, value, step) {
    this._requireStarted();
    return logMetric(this.runId, key, value, step);
  }

  async logMetrics(metrics, step) {
    this._requireStarted();
    return logMetrics(this.runId, metrics, step);
  }

  /**
   * Register an artifact. If `content` is a string, it is stored inline in metadata.
   * For large files, provide `path` via metadata.
   */
  async logArtifact(name, content, metadata = {}) {
    this._requireStarted();
    let path = null;
    const meta = { ...metadata };
    if (typeof content === "string") {
      if (content.startsWith("/") || content.startsWith("./") || content.startsWith("../")) {
        path = content;
      } else {
        meta.inline = content.length > 10_000 ? content.slice(0, 10_000) + "..." : content;
      }
    } else if (content && typeof content === "object") {
      meta.inline = JSON.stringify(content).slice(0, 10_000);
    }
    return logArtifact(this.runId, name, path, meta);
  }

  async end(status = "completed") {
    if (!this._started || !this.runId) return;
    if (this._ended) return;
    await setRunStatus(this.runId, status);
    this.status = status;
    this._ended = true;
  }

  async getRun() {
    if (!this.runId) return null;
    return getRun(this.runId);
  }
}

/**
 * Context-manager-style wrapper: create a run, run the function, auto-end.
 * Sets status to "completed" on success, "failed" on thrown error.
 *
 * @param {string} experimentName
 * @param {(tracker: ExperimentTracker) => Promise<any>} fn
 * @param {object} [options] - passed through to ExperimentTracker constructor
 */
export async function withRun(experimentName, fn, options = {}) {
  const tracker = new ExperimentTracker(experimentName, options);
  await tracker.start();
  try {
    const result = await fn(tracker);
    await tracker.end("completed");
    return { result, runId: tracker.runId, experimentId: tracker.experimentId };
  } catch (err) {
    try {
      await tracker.end("failed");
    } catch {
      /* best effort */
    }
    throw err;
  }
}
