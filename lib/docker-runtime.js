import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
import { registerRuntime } from "./agent-sandbox.js";

const execFile = promisify(_execFile);

function dockerError(message, cause) {
  const err = new Error(message);
  err.code = "DOCKER_ERROR";
  if (cause) err.cause = cause;
  return err;
}

async function docker(...args) {
  try {
    const { stdout, stderr } = await execFile("docker", args, { maxBuffer: 10 * 1024 * 1024 });
    return { stdout: stdout || "", stderr: stderr || "" };
  } catch (e) {
    throw dockerError(`docker ${args[0]} failed: ${e?.stderr || e?.message || e}`, e);
  }
}

async function pull(image) {
  if (!image || typeof image !== "string") throw dockerError("image is required");
  const { stdout } = await docker("pull", image);
  const digestMatch = stdout.match(/Digest:\s*(sha256:[a-f0-9]+)/);
  return { image, pulled: true, digest: digestMatch ? digestMatch[1] : null };
}

async function run(config) {
  if (!config?.image) throw dockerError("config.image is required");
  const args = ["run", "-d"];

  if (config.limits?.memoryMB) args.push(`--memory=${config.limits.memoryMB}m`);
  if (config.limits?.cpuShares) args.push(`--cpu-shares=${config.limits.cpuShares}`);
  if (config.limits?.network) args.push(`--network=${config.limits.network}`);

  const env = config.env && typeof config.env === "object" ? config.env : {};
  for (const [k, v] of Object.entries(env)) {
    args.push("-e", `${k}=${v}`);
  }

  const mounts = Array.isArray(config.mounts) ? config.mounts : [];
  for (const m of mounts) {
    if (m && typeof m === "string") args.push("-v", m);
    else if (m?.host && m?.container) args.push("-v", `${m.host}:${m.container}${m.readonly ? ":ro" : ""}`);
  }

  if (config.workdir) args.push("-w", config.workdir);

  args.push(config.image);

  if (config.command) {
    if (Array.isArray(config.command)) args.push(...config.command);
    else args.push("sh", "-c", config.command);
  }

  const { stdout } = await docker(...args);
  const id = stdout.trim();
  if (!id) throw dockerError("docker run returned no container id");
  return { id, image: config.image, state: "running", startedAt: Date.now() };
}

async function exec(containerId, command, options = {}) {
  if (!containerId) throw dockerError("containerId is required");
  if (!command) throw dockerError("command is required");
  const timeoutMs = (Number(options.timeoutSec) || 60) * 1000;
  const args = ["exec", containerId, "sh", "-c", command];
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  let timedOut = false;
  try {
    const result = await Promise.race([
      execFile("docker", args, { maxBuffer: 10 * 1024 * 1024 }),
      new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("timeout"), { timedOut: true })), timeoutMs)),
    ]);
    stdout = result.stdout || "";
    stderr = result.stderr || "";
  } catch (e) {
    if (e?.timedOut) {
      timedOut = true;
      exitCode = 124;
    } else {
      stdout = e?.stdout || "";
      stderr = e?.stderr || "";
      exitCode = typeof e?.code === "number" ? e.code : 1;
    }
  }
  return { command, stdout, stderr, exitCode, timedOut, at: Date.now() };
}

async function stop(containerId) {
  if (!containerId) throw dockerError("containerId is required");
  await docker("stop", containerId);
  return { id: containerId, state: "stopped", stoppedAt: Date.now() };
}

async function remove(containerId) {
  if (!containerId) throw dockerError("containerId is required");
  await docker("rm", "-f", containerId);
  return { removed: true };
}

async function logs(containerId, options = {}) {
  if (!containerId) throw dockerError("containerId is required");
  const args = ["logs"];
  const tail = Number(options.tail);
  if (Number.isFinite(tail) && tail > 0) args.push("--tail", String(tail));
  args.push(containerId);
  const { stdout, stderr } = await docker(...args);
  const combined = [stdout, stderr].filter(Boolean).join("\n");
  return combined.split(/\r?\n/).filter((l) => l.length > 0);
}

async function list() {
  const { stdout } = await docker("ps", "--format", "{{json .}}");
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  return lines.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { raw: line };
    }
  });
}

export const dockerRuntime = { pull, run, exec, stop, remove, logs, list };

export function registerDockerRuntime() {
  registerRuntime("docker", dockerRuntime);
}

if (process.env.CONTAINER_RUNTIME === "docker" || process.env.CONTAINER_RUNTIME === "podman") {
  registerDockerRuntime();
}
