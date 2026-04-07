import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const notifPath = join(import.meta.dirname, "..", "electron", "notifications.cjs");
const deepLinkPath = join(import.meta.dirname, "..", "electron", "deep-link.cjs");
const shortcutsPath = join(import.meta.dirname, "..", "electron", "shortcuts.cjs");
const windowStatePath = join(import.meta.dirname, "..", "electron", "window-state.cjs");
const modelMgrPath = join(import.meta.dirname, "..", "electron", "model-manager.cjs");
const mainPath = join(import.meta.dirname, "..", "electron", "main.cjs");
const preloadPath = join(import.meta.dirname, "..", "electron", "preload.cjs");
const ipcPath = join(import.meta.dirname, "..", "electron", "ipc-handlers.cjs");

describe("Phase 102: Native notifications", () => {
  it("notifications.cjs exists and exports key functions", () => {
    const src = readFileSync(notifPath, "utf8");
    assert.ok(src.includes("function connectNotificationWs"), "should export connectNotificationWs");
    assert.ok(src.includes("function disconnectNotificationWs"), "should export disconnectNotificationWs");
    assert.ok(src.includes("function showEventNotification"), "should export showEventNotification");
    assert.ok(src.includes("function getPrefs"), "should export getPrefs");
    assert.ok(src.includes("function setPrefs"), "should export setPrefs");
  });

  it("supports per-event notification preferences", () => {
    const src = readFileSync(notifPath, "utf8");
    assert.ok(src.includes("new_message"), "should support new_message event");
    assert.ok(src.includes("agent_complete"), "should support agent_complete event");
    assert.ok(src.includes("swarm_complete"), "should support swarm_complete event");
    assert.ok(src.includes("schedule_fired"), "should support schedule_fired event");
  });

  it("connects to WebSocket for real-time events", () => {
    const src = readFileSync(notifPath, "utf8");
    assert.ok(src.includes("new WebSocket("), "should create WebSocket connection");
    assert.ok(src.includes("/ws"), "should connect to /ws endpoint");
    assert.ok(src.includes("subscribe"), "should subscribe to notification channels");
  });

  it("persists preferences to JSON file", () => {
    const src = readFileSync(notifPath, "utf8");
    assert.ok(src.includes("notification-prefs.json"), "should use prefs file");
    assert.ok(src.includes("writeFileSync"), "should persist to disk");
  });

  it("supports click-to-focus", () => {
    const src = readFileSync(notifPath, "utf8");
    assert.ok(src.includes('n.on("click"'), "should handle click event");
    assert.ok(src.includes("mainWindow.show()"), "should show window on click");
    assert.ok(src.includes("mainWindow.focus()"), "should focus window on click");
  });

  it("has reconnect logic", () => {
    const src = readFileSync(notifPath, "utf8");
    assert.ok(src.includes("scheduleReconnect"), "should have reconnect logic");
  });

  it("IPC handlers support notification prefs", () => {
    const src = readFileSync(ipcPath, "utf8");
    assert.ok(src.includes("desktop:get-notification-prefs"), "should handle get-notification-prefs");
    assert.ok(src.includes("desktop:set-notification-prefs"), "should handle set-notification-prefs");
  });

  it("preload exposes notification pref methods", () => {
    const src = readFileSync(preloadPath, "utf8");
    assert.ok(src.includes("getNotificationPrefs"), "should expose getNotificationPrefs");
    assert.ok(src.includes("setNotificationPrefs"), "should expose setNotificationPrefs");
  });
});

describe("Phase 103: Deep linking & protocol handler", () => {
  it("deep-link.cjs exists and exports key functions", () => {
    const src = readFileSync(deepLinkPath, "utf8");
    assert.ok(src.includes("function registerProtocol"), "should export registerProtocol");
    assert.ok(src.includes("function parseDeepLink"), "should export parseDeepLink");
    assert.ok(src.includes("function handleDeepLink"), "should export handleDeepLink");
    assert.ok(src.includes("function extractDeepLinkFromArgv"), "should export extractDeepLinkFromArgv");
  });

  it("registers siskelbot:// protocol", () => {
    const src = readFileSync(deepLinkPath, "utf8");
    assert.ok(src.includes('"siskelbot"'), "should define siskelbot protocol");
    assert.ok(src.includes("setAsDefaultProtocolClient"), "should register with OS");
  });

  it("parses supported deep link routes", () => {
    const src = readFileSync(deepLinkPath, "utf8");
    assert.ok(src.includes('"chat"'), "should handle chat route");
    assert.ok(src.includes('"workspace"'), "should handle workspace route");
    assert.ok(src.includes('"recipe"'), "should handle recipe route");
  });

  it("handles macOS open-url in main.cjs", () => {
    const src = readFileSync(mainPath, "utf8");
    assert.ok(src.includes('"open-url"'), "should listen for macOS open-url event");
    assert.ok(src.includes("handleDeepLink"), "should call handleDeepLink");
  });

  it("forwards deep-link via argv on second-instance", () => {
    const src = readFileSync(mainPath, "utf8");
    assert.ok(src.includes("extractDeepLinkFromArgv(argv)"), "should extract URL from argv");
  });

  it("package.json has protocol config for macOS and Windows", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
    assert.ok(pkg.build.mac.protocols, "mac should have protocols config");
    assert.ok(pkg.build.mac.protocols[0].schemes.includes("siskelbot"), "mac should register siskelbot scheme");
    assert.ok(pkg.build.win.protocols, "win should have protocols config");
    assert.ok(pkg.build.win.protocols[0].schemes.includes("siskelbot"), "win should register siskelbot scheme");
  });

  it("Linux .desktop file has MimeType for protocol", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
    assert.ok(pkg.build.linux.desktop.MimeType.includes("siskelbot"), "linux should have siskelbot MimeType");
  });
});

describe("Phase 104: Keyboard shortcuts", () => {
  it("shortcuts.cjs exists and exports key functions", () => {
    const src = readFileSync(shortcutsPath, "utf8");
    assert.ok(src.includes("function registerGlobalShortcuts"), "should export registerGlobalShortcuts");
    assert.ok(src.includes("function registerLocalShortcuts"), "should export registerLocalShortcuts");
    assert.ok(src.includes("function unregisterGlobalShortcuts"), "should export unregisterGlobalShortcuts");
  });

  it("has configurable global hotkey with default", () => {
    const src = readFileSync(shortcutsPath, "utf8");
    assert.ok(src.includes("CmdOrCtrl+Shift+S"), "should have default hotkey");
    assert.ok(src.includes("DESKTOP_GLOBAL_HOTKEY"), "should support env var override");
  });

  it("global hotkey toggles window visibility", () => {
    const src = readFileSync(shortcutsPath, "utf8");
    assert.ok(src.includes("mainWindow.hide()"), "should hide when visible+focused");
    assert.ok(src.includes("mainWindow.show()"), "should show when hidden");
  });

  it("registers local shortcuts via before-input-event", () => {
    const src = readFileSync(shortcutsPath, "utf8");
    assert.ok(src.includes("before-input-event"), "should use before-input-event");
  });

  it("supports Ctrl+L clear, Ctrl+K palette, Ctrl+, settings, Ctrl+Tab cycle", () => {
    const src = readFileSync(shortcutsPath, "utf8");
    assert.ok(src.includes('"l"'), "should handle Ctrl+L");
    assert.ok(src.includes('"k"'), "should handle Ctrl+K");
    assert.ok(src.includes('","'), "should handle Ctrl+,");
    assert.ok(src.includes('"Tab"'), "should handle Ctrl+Tab");
    assert.ok(src.includes("command-palette"), "should send command-palette");
    assert.ok(src.includes('"settings"'), "should send settings");
    assert.ok(src.includes("cycle-"), "should send cycle direction");
  });

  it("preload exposes shortcut listener", () => {
    const src = readFileSync(preloadPath, "utf8");
    assert.ok(src.includes("onShortcut"), "should expose onShortcut");
    assert.ok(src.includes("desktop:shortcut"), "should use desktop:shortcut channel");
  });

  it("main.cjs integrates shortcuts", () => {
    const src = readFileSync(mainPath, "utf8");
    assert.ok(src.includes("registerGlobalShortcuts"), "should call registerGlobalShortcuts");
    assert.ok(src.includes("registerLocalShortcuts"), "should call registerLocalShortcuts");
    assert.ok(src.includes("unregisterShortcuts"), "should unregister on quit");
  });
});

describe("Phase 105: Window state persistence", () => {
  it("window-state.cjs exists and exports key functions", () => {
    const src = readFileSync(windowStatePath, "utf8");
    assert.ok(src.includes("function loadWindowState"), "should export loadWindowState");
    assert.ok(src.includes("function saveWindowState"), "should export saveWindowState");
    assert.ok(src.includes("function trackWindowState"), "should export trackWindowState");
  });

  it("persists x, y, width, height, isMaximized", () => {
    const src = readFileSync(windowStatePath, "utf8");
    assert.ok(src.includes("width"), "should persist width");
    assert.ok(src.includes("height"), "should persist height");
    assert.ok(src.includes("isMaximized"), "should persist maximized state");
  });

  it("clamps to visible screen on restore (multi-monitor safe)", () => {
    const src = readFileSync(windowStatePath, "utf8");
    assert.ok(src.includes("getAllDisplays"), "should check all displays");
    assert.ok(src.includes("workArea"), "should use workArea for bounds check");
    assert.ok(src.includes("visible"), "should verify window is on a visible display");
  });

  it("saves state to JSON in userData", () => {
    const src = readFileSync(windowStatePath, "utf8");
    assert.ok(src.includes("window-state.json"), "should use window-state.json");
    assert.ok(src.includes("writeFileSync"), "should write to disk");
  });

  it("main.cjs uses window state for creation and tracking", () => {
    const src = readFileSync(mainPath, "utf8");
    assert.ok(src.includes("loadWindowState"), "should load state on create");
    assert.ok(src.includes("trackWindowState"), "should track state changes");
    assert.ok(src.includes("savedState.isMaximized"), "should restore maximized state");
  });
});

describe("Phase 106: Local model manager", () => {
  it("model-manager.cjs exists and exports registerModelRoutes", () => {
    const src = readFileSync(modelMgrPath, "utf8");
    assert.ok(src.includes("function registerModelRoutes"), "should export registerModelRoutes");
  });

  it("has GET /api/desktop/models route", () => {
    const src = readFileSync(modelMgrPath, "utf8");
    assert.ok(src.includes('"/api/desktop/models"'), "should have models list route");
    assert.ok(src.includes("/api/tags"), "should proxy ollama /api/tags");
  });

  it("returns model details (size, quantization, family)", () => {
    const src = readFileSync(modelMgrPath, "utf8");
    assert.ok(src.includes("size"), "should include size");
    assert.ok(src.includes("quantization"), "should include quantization");
    assert.ok(src.includes("family"), "should include family");
    assert.ok(src.includes("parameter_size"), "should include parameter_size");
    assert.ok(src.includes("modified_at"), "should include modified_at");
  });

  it("has POST /api/desktop/models/pull with SSE streaming", () => {
    const src = readFileSync(modelMgrPath, "utf8");
    assert.ok(src.includes('"/api/desktop/models/pull"'), "should have pull route");
    assert.ok(src.includes("text/event-stream"), "should use SSE content type");
    assert.ok(src.includes("/api/pull"), "should proxy ollama /api/pull");
    assert.ok(src.includes("stream: true"), "should request streaming from Ollama");
  });

  it("validates and sanitizes model name on pull", () => {
    const src = readFileSync(modelMgrPath, "utf8");
    assert.ok(src.includes("Missing model name"), "should validate name presence");
    assert.ok(src.includes("Invalid model name"), "should validate name format");
    assert.ok(src.includes(".test(name)"), "should have sanitization regex");
  });

  it("has DELETE /api/desktop/models/:name route", () => {
    const src = readFileSync(modelMgrPath, "utf8");
    assert.ok(src.includes('"/api/desktop/models/:name"'), "should have delete route");
    assert.ok(src.includes("/api/delete"), "should proxy ollama /api/delete");
  });

  it("guards routes behind ELECTRON_DESKTOP check", () => {
    const src = readFileSync(modelMgrPath, "utf8");
    assert.ok(src.includes('ELECTRON_DESKTOP'), "should check ELECTRON_DESKTOP env");
  });

  it("server.js registers model routes in desktop mode", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "server.js"), "utf8");
    assert.ok(src.includes("model-manager.cjs"), "should import model-manager");
    assert.ok(src.includes("registerModelRoutes"), "should call registerModelRoutes");
  });
});
