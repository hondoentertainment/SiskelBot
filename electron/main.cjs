/**
 * Siskel Bot desktop shell (Electron).
 * Spawns the Node Express server, stores data under app.getPath("userData"), opens a window.
 *
 * Phases 97–106: native menu, system tray, auto-updater, IPC bridge,
 *   native notifications, deep linking, shortcuts, window state, model manager.
 */
const { app, BrowserWindow, shell, dialog } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const net = require("net");
const fs = require("fs");

const { buildMenu } = require("./menu.cjs");
const { createTray, setTrayBadge, destroyTray } = require("./tray.cjs");
const { initUpdater, checkForUpdates, destroyUpdater } = require("./updater.cjs");
const { registerIpcHandlers } = require("./ipc-handlers.cjs");
const { connectNotificationWs, disconnectNotificationWs } = require("./notifications.cjs");
const { registerProtocol, handleDeepLink, extractDeepLinkFromArgv } = require("./deep-link.cjs");
const { registerGlobalShortcuts, registerLocalShortcuts, unregisterAll: unregisterShortcuts } = require("./shortcuts.cjs");
const { loadWindowState, trackWindowState } = require("./window-state.cjs");

/** @type {import('child_process').ChildProcess | null} */
let serverProcess = null;
/** @type {BrowserWindow | null} */
let mainWindow = null;
let serverPort = null;
let serverBaseUrl = "http://127.0.0.1:38447";

const closeToTray = process.env.DESKTOP_CLOSE_TO_TRAY === "1";

// Phase 103: register protocol handler early (before app.whenReady)
registerProtocol();

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
    // Platform-specific bundled Node binary
    if (process.platform === "win32") {
      const bundled = path.join(process.resourcesPath, "node-win", "node.exe");
      if (fs.existsSync(bundled)) return bundled;
    } else if (process.platform === "darwin") {
      const bundled = path.join(process.resourcesPath, "node-mac", "node");
      if (fs.existsSync(bundled)) return bundled;
    } else {
      const bundled = path.join(process.resourcesPath, "node-linux", "node");
      if (fs.existsSync(bundled)) return bundled;
    }
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

  serverProcess.on("exit", (code, _signal) => {
    if (code && code !== 0 && !app.isQuitting) {
      console.error("[desktop] Server exited:", code, _signal);
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

function onNewChat() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(`${serverBaseUrl}/`);
    mainWindow.show();
    mainWindow.focus();
  }
}

function createWindow() {
  // Phase 105: load persisted window state
  const savedState = loadWindowState();

  const winOpts = {
    width: savedState.width,
    height: savedState.height,
    minWidth: 800,
    minHeight: 600,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  };

  // Only set position if we have saved coordinates
  if (savedState.x !== undefined && savedState.y !== undefined) {
    winOpts.x = savedState.x;
    winOpts.y = savedState.y;
  }

  mainWindow = new BrowserWindow(winOpts);

  // Phase 105: track state changes and restore maximized
  trackWindowState(mainWindow);
  if (savedState.isMaximized) {
    mainWindow.maximize();
  }

  mainWindow.once("ready-to-show", () => mainWindow?.show());

  mainWindow.loadURL(`${serverBaseUrl}/`);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Phase 98: minimize-to-tray on close
  if (closeToTray) {
    mainWindow.on("close", (e) => {
      if (!app.isQuitting) {
        e.preventDefault();
        mainWindow.hide();
      }
    });
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Phase 97: build native menu bar
  buildMenu({
    onNewChat,
    onCheckUpdates: checkForUpdates,
    serverBaseUrl,
  });

  // Phase 98: create system tray
  createTray(mainWindow, { onNewChat });

  // Phase 101: register IPC handlers
  registerIpcHandlers({
    onNewChat,
    onSetBadge: setTrayBadge,
    mainWindow,
  });

  // Phase 102: connect notification WebSocket
  connectNotificationWs(serverBaseUrl, mainWindow);

  // Phase 104: register keyboard shortcuts
  registerGlobalShortcuts(mainWindow);
  registerLocalShortcuts(mainWindow, { serverBaseUrl });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
    // Phase 103: forward deep-link URL from argv (Windows/Linux)
    const deepUrl = extractDeepLinkFromArgv(argv);
    if (deepUrl && mainWindow) {
      handleDeepLink(mainWindow, serverBaseUrl, deepUrl);
    }
  });

  // Phase 103: macOS open-url event
  app.on("open-url", (event, url) => {
    event.preventDefault();
    if (mainWindow) {
      handleDeepLink(mainWindow, serverBaseUrl, url);
    }
  });

  app.whenReady().then(async () => {
    try {
      await startServer();
      createWindow();

      // Phase 100: start auto-updater
      initUpdater();
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
    if (process.platform !== "darwin" && !closeToTray) {
      app.isQuitting = true;
      stopServer();
      app.quit();
    }
  });

  app.on("before-quit", () => {
    app.isQuitting = true;
    unregisterShortcuts();
    disconnectNotificationWs();
    destroyUpdater();
    destroyTray();
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
