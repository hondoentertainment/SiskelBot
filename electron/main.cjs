/**
 * Siskel Bot desktop shell (Electron).
 * Spawns the Node Express server, stores data under app.getPath("userData"), opens a window.
 */
const { app, BrowserWindow, shell, dialog } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const net = require("net");
const fs = require("fs");

/** @type {import('child_process').ChildProcess | null} */
let serverProcess = null;
/** @type {BrowserWindow | null} */
let mainWindow = null;
let serverPort = null;
let serverBaseUrl = "http://127.0.0.1:38447";

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : null;
      s.close(() => (port ? resolve(port) : reject(new Error("No port"))));
    });
  });
}

/** Prefer stable port (OAuth redirect URLs); fall back if busy. */
function isPortFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => {
      s.close(() => resolve(true));
    });
  });
}

async function pickServerPort() {
  const preferred = parseInt(process.env.DESKTOP_PORT || "38447", 10);
  if (!Number.isFinite(preferred) || preferred < 1 || preferred > 65535) {
    return getFreePort();
  }
  if (await isPortFree(preferred)) return preferred;
  return getFreePort();
}

function dataDir() {
  return path.join(app.getPath("userData"), "data");
}

function getProjectPaths() {
  if (app.isPackaged) {
    const root = app.getAppPath();
    return { projectRoot: root, serverScript: path.join(root, "server.js") };
  }
  return {
    projectRoot: path.join(__dirname, ".."),
    serverScript: path.join(__dirname, "..", "server.js"),
  };
}

function resolveNodeBinary() {
  if (process.env.NODE_BINARY) return process.env.NODE_BINARY;
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, "node-win", "node.exe");
    if (fs.existsSync(bundled)) return bundled;
  }
  return "node";
}

async function waitForServer(port, maxMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health/live`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch (_) {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("Server did not become ready in time");
}

async function startServer() {
  const { projectRoot, serverScript } = getProjectPaths();
  if (!fs.existsSync(serverScript)) {
    throw new Error(`Server script missing: ${serverScript}`);
  }

  serverPort = await pickServerPort();
  const storagePath = dataDir();

  serverBaseUrl = `http://127.0.0.1:${serverPort}`;
  const env = {
    ...process.env,
    PORT: String(serverPort),
    LISTEN_HOST: "127.0.0.1",
    BASE_URL: serverBaseUrl,
    ELECTRON_DESKTOP: "1",
    STORAGE_PATH: storagePath,
    VERCEL: "",
  };

  const nodeBin = resolveNodeBinary();
  serverProcess = spawn(nodeBin, [serverScript], {
    cwd: projectRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  serverProcess.stdout?.on("data", (buf) => {
    if (process.env.DESKTOP_DEBUG) process.stdout.write(buf);
  });
  serverProcess.stderr?.on("data", (buf) => {
    if (process.env.DESKTOP_DEBUG) process.stderr.write(buf);
  });

  serverProcess.on("error", (err) => {
    console.error("[desktop] Failed to spawn server:", err.message);
  });

  serverProcess.on("exit", (code, signal) => {
    if (code && code !== 0 && !app.isQuitting) {
      console.error("[desktop] Server exited:", code, signal);
    }
    serverProcess = null;
  });

  await waitForServer(serverPort);
}

function stopServer() {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
    serverProcess = null;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 800,
    minHeight: 600,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());

  mainWindow.loadURL(`${serverBaseUrl}/`);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      await startServer();
      createWindow();
    } catch (e) {
      console.error("[desktop] Startup failed:", e.message);
      dialog.showErrorBox(
        "Siskel Bot — server failed to start",
        `${e.message}\n\nIf you installed from the Setup wizard, reinstall or ensure antivirus did not remove files.\n\nDev: run with DESKTOP_DEBUG=1 or install Node.js on PATH.`
      );
      app.quit();
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.isQuitting = true;
      stopServer();
      app.quit();
    }
  });

  app.on("before-quit", () => {
    app.isQuitting = true;
    stopServer();
  });

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      try {
        if (!serverProcess || !serverPort) await startServer();
        createWindow();
      } catch (e) {
        console.error("[desktop] Re-activate failed:", e.message);
      }
    }
  });
}
