import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const menuPath = join(import.meta.dirname, "..", "electron", "menu.cjs");
const trayPath = join(import.meta.dirname, "..", "electron", "tray.cjs");
const updaterPath = join(import.meta.dirname, "..", "electron", "updater.cjs");
const preloadPath = join(import.meta.dirname, "..", "electron", "preload.cjs");
const ipcPath = join(import.meta.dirname, "..", "electron", "ipc-handlers.cjs");
const mainPath = join(import.meta.dirname, "..", "electron", "main.cjs");

describe("Phase 97-101: Desktop modules exist and are syntactically valid", () => {
  it("electron/menu.cjs exists and exports buildMenu", () => {
    const src = readFileSync(menuPath, "utf8");
    assert.ok(src.includes("function buildMenu"), "should export buildMenu");
    assert.ok(src.includes("Menu.buildFromTemplate"), "should build menu template");
    assert.ok(src.includes('"File"'), "should have File menu");
    assert.ok(src.includes('"Edit"'), "should have Edit menu");
    assert.ok(src.includes('"View"'), "should have View menu");
    assert.ok(src.includes('"Help"'), "should have Help menu");
  });

  it("menu.cjs has macOS app menu handling", () => {
    const src = readFileSync(menuPath, "utf8");
    assert.ok(src.includes('process.platform === "darwin"'), "should detect macOS");
    assert.ok(src.includes("role: \"about\""), "should have About on macOS");
  });

  it("menu.cjs has New Chat, Open Data Folder, and Check for Updates", () => {
    const src = readFileSync(menuPath, "utf8");
    assert.ok(src.includes('"New Chat"'), "should have New Chat item");
    assert.ok(src.includes('"Open Data Folder"'), "should have Open Data Folder");
    assert.ok(src.includes('"Check for Updates'), "should have Check for Updates");
  });

  it("electron/tray.cjs exists and exports createTray / setTrayBadge", () => {
    const src = readFileSync(trayPath, "utf8");
    assert.ok(src.includes("function createTray"), "should export createTray");
    assert.ok(src.includes("function setTrayBadge"), "should export setTrayBadge");
    assert.ok(src.includes("new Tray("), "should create Tray instance");
  });

  it("tray.cjs has context menu with Show/Hide, New Chat, Quit", () => {
    const src = readFileSync(trayPath, "utf8");
    assert.ok(src.includes('"Hide"') || src.includes('"Show"'), "should have Show/Hide toggle");
    assert.ok(src.includes('"New Chat"'), "should have New Chat");
    assert.ok(src.includes('"Quit"'), "should have Quit");
  });

  it("tray.cjs handles badge on macOS dock", () => {
    const src = readFileSync(trayPath, "utf8");
    assert.ok(src.includes("dock?.setBadge"), "should set dock badge on macOS");
  });

  it("electron/updater.cjs exists and exports initUpdater / checkForUpdates", () => {
    const src = readFileSync(updaterPath, "utf8");
    assert.ok(src.includes("function initUpdater"), "should export initUpdater");
    assert.ok(src.includes("function checkForUpdates"), "should export checkForUpdates");
    assert.ok(src.includes("electron-updater"), "should reference electron-updater");
  });

  it("updater.cjs skips in dev mode", () => {
    const src = readFileSync(updaterPath, "utf8");
    assert.ok(src.includes("app.isPackaged"), "should check isPackaged");
    assert.ok(src.includes("Skipping updater in development"), "should log skip message");
  });

  it("updater.cjs supports configurable check interval", () => {
    const src = readFileSync(updaterPath, "utf8");
    assert.ok(src.includes("DESKTOP_UPDATE_INTERVAL_HOURS"), "should read interval env");
  });

  it("electron/preload.cjs exists and exposes siskelDesktop API", () => {
    const src = readFileSync(preloadPath, "utf8");
    assert.ok(src.includes("contextBridge.exposeInMainWorld"), "should use contextBridge");
    assert.ok(src.includes('"siskelDesktop"'), "should expose siskelDesktop");
    assert.ok(src.includes("getVersion"), "should expose getVersion");
    assert.ok(src.includes("getPlatform"), "should expose getPlatform");
    assert.ok(src.includes("showNativeNotification"), "should expose showNativeNotification");
    assert.ok(src.includes("setTrayBadge"), "should expose setTrayBadge");
    assert.ok(src.includes("getAutoLaunch"), "should expose getAutoLaunch");
    assert.ok(src.includes("setAutoLaunch"), "should expose setAutoLaunch");
    assert.ok(src.includes("onDeepLink"), "should expose onDeepLink");
    assert.ok(src.includes("onThemeChanged"), "should expose onThemeChanged");
  });

  it("electron/ipc-handlers.cjs exists and registers handlers", () => {
    const src = readFileSync(ipcPath, "utf8");
    assert.ok(src.includes("function registerIpcHandlers"), "should export registerIpcHandlers");
    assert.ok(src.includes('ipcMain.handle("desktop:get-version"'), "should handle get-version");
    assert.ok(src.includes('ipcMain.handle("desktop:get-platform"'), "should handle get-platform");
    assert.ok(src.includes('ipcMain.on("desktop:show-notification"'), "should handle notifications");
    assert.ok(src.includes('ipcMain.on("desktop:set-tray-badge"'), "should handle badge");
    assert.ok(src.includes("nativeTheme"), "should forward theme changes");
  });

  it("electron/main.cjs integrates menu, tray, updater, and preload", () => {
    const src = readFileSync(mainPath, "utf8");
    assert.ok(src.includes('require("./menu.cjs")'), "should require menu module");
    assert.ok(src.includes('require("./tray.cjs")'), "should require tray module");
    assert.ok(src.includes('require("./updater.cjs")'), "should require updater module");
    assert.ok(src.includes('require("./ipc-handlers.cjs")'), "should require ipc-handlers");
    assert.ok(src.includes("preload.cjs"), "should reference preload script");
    assert.ok(src.includes("sandbox: true"), "should enable sandbox");
  });

  it("main.cjs supports close-to-tray", () => {
    const src = readFileSync(mainPath, "utf8");
    assert.ok(src.includes("DESKTOP_CLOSE_TO_TRAY"), "should read close-to-tray env");
    assert.ok(src.includes("e.preventDefault()"), "should prevent close when tray mode");
    assert.ok(src.includes("mainWindow.hide()"), "should hide window instead of closing");
  });

  it("main.cjs resolves platform-specific node binary", () => {
    const src = readFileSync(mainPath, "utf8");
    assert.ok(src.includes('"win32"'), "should handle Windows");
    assert.ok(src.includes('"darwin"'), "should handle macOS");
    assert.ok(src.includes("node-mac"), "should look for node-mac");
    assert.ok(src.includes("node-linux"), "should look for node-linux");
  });
});

describe("Phase 99: Cross-platform build config", () => {
  let pkg;
  beforeEach(() => {
    pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")
    );
  });

  it("package.json has mac build targets", () => {
    assert.ok(pkg.build.mac, "should have mac config");
    assert.ok(pkg.build.mac.target.length >= 2, "should have dmg + zip targets");
    const targets = pkg.build.mac.target.map((t) => t.target);
    assert.ok(targets.includes("dmg"), "should build DMG");
    assert.ok(targets.includes("zip"), "should build ZIP");
  });

  it("package.json has linux build targets", () => {
    assert.ok(pkg.build.linux, "should have linux config");
    const targets = pkg.build.linux.target.map((t) => t.target);
    assert.ok(targets.includes("AppImage"), "should build AppImage");
    assert.ok(targets.includes("deb"), "should build deb");
    assert.ok(targets.includes("rpm"), "should build rpm");
  });

  it("package.json has desktop:dist:mac and desktop:dist:linux scripts", () => {
    assert.ok(pkg.scripts["desktop:dist:mac"], "should have mac dist script");
    assert.ok(pkg.scripts["desktop:dist:linux"], "should have linux dist script");
  });

  it("package.json has publish config for auto-updater", () => {
    assert.ok(pkg.build.publish, "should have publish config");
    assert.equal(pkg.build.publish.provider, "github", "should use github provider");
    assert.equal(pkg.build.publish.owner, "hondoentertainment");
    assert.equal(pkg.build.publish.repo, "SiskelBot");
  });

  it("package.json includes electron-updater in devDependencies", () => {
    assert.ok(pkg.devDependencies["electron-updater"], "should have electron-updater");
  });

  it("macOS entitlements file exists", () => {
    const plist = readFileSync(
      join(import.meta.dirname, "..", "build", "entitlements.mac.plist"),
      "utf8"
    );
    assert.ok(plist.includes("com.apple.security"), "should contain entitlements");
    assert.ok(plist.includes("network.client"), "should allow network client");
    assert.ok(plist.includes("network.server"), "should allow network server");
  });
});
