import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const execFileAsync = promisify(execFile);

const MOCK_MODE = process.env.DESKTOP_AGENT_ENABLED !== "1";

function storePath(workspaceId) {
  return join(getDataDir(), "desktop-agent", `${workspaceId}.json`);
}

async function loadSessions(workspaceId) {
  const data = await readJsonPath(storePath(workspaceId), { sessions: [] });
  return Array.isArray(data.sessions) ? data.sessions : [];
}

async function saveSessions(workspaceId, sessions) {
  await writeJsonPath(storePath(workspaceId), { sessions });
}

function findFreeDisplay(existing) {
  const used = new Set(existing.map((s) => s.display).filter(Boolean));
  for (let n = 1; n <= 99; n++) {
    const d = `:${n}`;
    if (!used.has(d)) return d;
  }
  return ":99";
}

function findFreePort(existing, base) {
  const used = new Set(existing.map((s) => s[base === "vncPort" ? "vncPort" : "noVncPort"]).filter(Boolean));
  let port = base === "vncPort" ? 5900 : 6080;
  while (used.has(port)) port++;
  return port;
}

export async function createDesktopSession(workspaceId, opts = {}) {
  const now = Date.now();
  let session;

  await withPathLock(storePath(workspaceId), async () => {
    const sessions = await loadSessions(workspaceId);
    const display = findFreeDisplay(sessions);
    const displayNum = display.slice(1);
    const vncPort = findFreePort(sessions, "vncPort") + parseInt(displayNum, 10) - 1;
    const noVncPort = 6080 + parseInt(displayNum, 10) - 1;
    const vncPassword = randomUUID().slice(0, 8);

    session = {
      sessionId: randomUUID(),
      workspaceId,
      sandboxId: opts.sandboxId ?? null,
      vncPort,
      vncPassword,
      noVncPort,
      display,
      status: MOCK_MODE ? "running" : "starting",
      createdAt: now,
      stoppedAt: null,
      screenshotPath: null,
    };
    sessions.push(session);
    await saveSessions(workspaceId, sessions);
  });

  if (!MOCK_MODE) {
    try {
      execFile("Xvfb", [
        session.display,
        "-screen", "0", "1920x1080x24",
      ], { detached: true, stdio: "ignore" });

      execFile("x11vnc", [
        "-display", session.display,
        "-rfbport", String(session.vncPort),
        "-passwd", session.vncPassword,
        "-forever", "-bg", "-quiet",
      ], { detached: true, stdio: "ignore" });

      execFile("websockify", [
        "--daemon",
        String(session.noVncPort),
        `localhost:${session.vncPort}`,
      ], { detached: true, stdio: "ignore" });

      await withPathLock(storePath(workspaceId), async () => {
        const sessions = await loadSessions(workspaceId);
        const idx = sessions.findIndex((s) => s.sessionId === session.sessionId);
        if (idx !== -1) {
          sessions[idx].status = "running";
          session = sessions[idx];
          await saveSessions(workspaceId, sessions);
        }
      });
    } catch {
      // processes may not be installed; still return session
    }
  }

  return session;
}

export async function stopDesktopSession(workspaceId, sessionId) {
  let stopped = null;
  await withPathLock(storePath(workspaceId), async () => {
    const sessions = await loadSessions(workspaceId);
    const idx = sessions.findIndex((s) => s.sessionId === sessionId);
    if (idx === -1) return;
    sessions[idx].status = "stopped";
    sessions[idx].stoppedAt = Date.now();
    stopped = sessions[idx];
    await saveSessions(workspaceId, sessions);
  });

  if (!MOCK_MODE && stopped) {
    try {
      await execFileAsync("pkill", ["-f", `Xvfb ${stopped.display}`]).catch(() => {});
      await execFileAsync("pkill", ["-f", `x11vnc.*${stopped.display}`]).catch(() => {});
    } catch {
      // ignore
    }
  }

  return stopped;
}

export async function getDesktopSession(workspaceId, sessionId) {
  const sessions = await loadSessions(workspaceId);
  return sessions.find((s) => s.sessionId === sessionId) ?? null;
}

export async function listDesktopSessions(workspaceId) {
  return loadSessions(workspaceId);
}

export async function takeScreenshot(workspaceId, sessionId) {
  const session = await getDesktopSession(workspaceId, sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);

  const tmpPath = join(getDataDir(), "desktop-agent", `screenshot-${sessionId}-${Date.now()}.png`);

  if (MOCK_MODE) {
    const mockBase64 = Buffer.from("mock-screenshot").toString("base64");
    return { screenshotPath: tmpPath, base64: mockBase64, at: Date.now() };
  }

  const env = { ...process.env, DISPLAY: session.display };

  try {
    await execFileAsync("scrot", [tmpPath], { env });
  } catch {
    try {
      await execFileAsync("import", ["-window", "root", tmpPath], { env });
    } catch (err) {
      throw new Error(`Screenshot failed: ${err?.message}`, { cause: err });
    }
  }

  const buf = await readFile(tmpPath);
  const base64 = buf.toString("base64");

  await withPathLock(storePath(workspaceId), async () => {
    const sessions = await loadSessions(workspaceId);
    const idx = sessions.findIndex((s) => s.sessionId === sessionId);
    if (idx !== -1) {
      sessions[idx].screenshotPath = tmpPath;
      await saveSessions(workspaceId, sessions);
    }
  });

  return { screenshotPath: tmpPath, base64, at: Date.now() };
}

export async function sendMouseClick(workspaceId, sessionId, x, y, button = 1) {
  const session = await getDesktopSession(workspaceId, sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  if (MOCK_MODE) return { ok: true, x, y, button };
  const env = { ...process.env, DISPLAY: session.display };
  await execFileAsync("xdotool", ["mousemove", String(x), String(y), "click", String(button)], { env });
  return { ok: true, x, y, button };
}

export async function sendKeypress(workspaceId, sessionId, keys) {
  const session = await getDesktopSession(workspaceId, sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  if (MOCK_MODE) return { ok: true, keys };
  const env = { ...process.env, DISPLAY: session.display };
  await execFileAsync("xdotool", ["key", String(keys)], { env });
  return { ok: true, keys };
}

export async function sendType(workspaceId, sessionId, text) {
  const session = await getDesktopSession(workspaceId, sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  if (MOCK_MODE) return { ok: true, text };
  const env = { ...process.env, DISPLAY: session.display };
  await execFileAsync("xdotool", ["type", "--clearmodifiers", "--", String(text)], { env });
  return { ok: true, text };
}

export async function openApplication(workspaceId, sessionId, appName) {
  const session = await getDesktopSession(workspaceId, sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  if (MOCK_MODE) return { ok: true, app: appName };
  const env = { ...process.env, DISPLAY: session.display };
  const child = execFile(appName, [], { env, detached: true, stdio: "ignore" });
  child.unref?.();
  return { ok: true, app: appName };
}
