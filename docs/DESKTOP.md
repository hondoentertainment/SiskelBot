# Desktop app (Electron)

Siskel Bot can run as a **native window** that embeds the same web UI and local Express API.

## Run from source

1. Install dependencies (includes Electron as a dev dependency):

   ```bash
   npm install
   ```

2. Start the desktop shell:

   ```bash
   npm run desktop
   ```

3. The app:
   - Spawns **Node** with `server.js` (not Electron’s runtime — `node` must be on `PATH`).
   - Binds the server to **127.0.0.1** only (`LISTEN_HOST`).
   - Stores data under the OS app user folder: `STORAGE_PATH` = `<userData>/data` (not the repo’s `./data`).

## Ports

- Default desktop port: **38447** (`http://127.0.0.1:38447/`).
- If that port is in use, a random free port is chosen (check the window URL or set `DESKTOP_PORT`).

Override:

```bash
set DESKTOP_PORT=3055
npm run desktop
```

## OAuth (GitHub / Google)

The desktop shell sets **`BASE_URL`** to `http://127.0.0.1:<port>` so callbacks match the window origin.

Register redirect URLs in the provider console, e.g.:

- `http://127.0.0.1:38447/auth/github/callback`
- `http://127.0.0.1:38447/auth/google/callback`

If you change **`DESKTOP_PORT`**, use that port in the provider settings. If the app falls back to a random port, either free `38447` or set `DESKTOP_PORT` explicitly before packaging.

## Debugging

- Server logs are hidden by default. To forward them to the terminal:

  ```bash
  set DESKTOP_DEBUG=1
  npm run desktop
  ```

- Custom Node binary:

  ```bash
  set NODE_BINARY=C:\Program Files\nodejs\node.exe
  npm run desktop
  ```

## Windows installers (NSIS) — x64 & ARM64

1. On **Windows**, install dependencies: `npm install`

2. Build **x64** (Intel/AMD):

   ```bash
   npm run desktop:dist
   ```

   → `release/Siskel Bot-<version>-Windows-x64.exe`

3. Build **ARM64** (Snapdragon / Windows on ARM):

   ```bash
   npm run desktop:dist:arm64
   ```

   → `release/Siskel Bot-<version>-Windows-arm64.exe`

4. Build **both** (downloads both Node zips if needed, then two installer passes):

   ```bash
   npm run desktop:dist:all
   ```

5. **Bundled Node:** each installer ships the matching **`node.exe`** under `resources/node-win/` (staged from `vendor/node-win-x64` or `vendor/node-win-arm64`). End users do **not** need Node on PATH.

6. Pre-download Node only:

   ```bash
   npm run vendor:node-win          # both arch
   npm run vendor:node-win:x64      # x64 only
   npm run vendor:node-win:arm64    # arm64 only
   ```

7. **Offline builds:** run the appropriate `vendor:node-win:*` on a machine with internet, keep `vendor/node-win-x64/` and/or `vendor/node-win-arm64/`, then run the `desktop:dist*` scripts (they skip download if `node.exe` exists).

**Notes**

- `npmRebuild` is **disabled** so native addons (e.g. optional `better-sqlite3`) stay built for **Node**, not Electron’s ABI (the API runs in a child `node` process). Run `npm install` on the **same architecture** you target when optional native modules matter.
- **ARM64 installer:** build with `desktop:dist:arm64` on an **ARM64 Windows** machine (or use cross-compilation if your toolchain supports it — untested here).
- Optional: add `build/icon.ico` and set `"icon": "build/icon.ico"` under `build.win` in `package.json`.

## macOS builds (Phase 99)

```bash
npm run desktop:dist:mac
```

Produces DMG and ZIP for both x64 and arm64. For code-signing and notarisation, set these environment variables:

- `CSC_LINK` — path or base64 of your .p12 certificate
- `CSC_KEY_PASSWORD` — certificate password
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` — for notarisation

Unsigned builds work for local development without these variables.

## Linux builds (Phase 99)

```bash
npm run desktop:dist:linux
```

Produces AppImage (x64 + arm64), deb (x64), and rpm (x64) in `release/`.

## Native menu bar (Phase 97)

The app now has a full menu bar: **File** (New Chat, Open Data Folder), **Edit**, **View** (zoom, DevTools, fullscreen), **Help** (docs, report issue, about, check for updates). On macOS the standard app menu is included.

## System tray (Phase 98)

Set `DESKTOP_CLOSE_TO_TRAY=1` to minimise to tray on window close instead of quitting. The tray icon provides Show/Hide, New Chat, and Quit.

```bash
DESKTOP_CLOSE_TO_TRAY=1 npm run desktop
```

## Auto-updater (Phase 100)

Packaged builds check GitHub Releases for updates on startup and periodically. Configure the interval:

```bash
DESKTOP_UPDATE_INTERVAL_HOURS=12  # default: 6
```

The updater is a no-op in development (non-packaged) mode. Requires `electron-updater` (included as a dev dependency).

## IPC bridge (Phase 101)

The renderer has access to `window.siskelDesktop` (when running in Electron):

| Method | Description |
|--------|-------------|
| `getVersion()` | App version (async) |
| `getPlatform()` | `"win32"` / `"darwin"` / `"linux"` (async) |
| `getAutoLaunch()` | Whether the app starts on login (async) |
| `setAutoLaunch(bool)` | Enable/disable login launch |
| `showNativeNotification(title, body)` | Show OS notification |
| `setTrayBadge(count)` | Update tray badge / dock badge |
| `newChat()` | Open a new chat |
| `onDeepLink(callback)` | Listen for `siskelbot://` URLs (returns unsubscribe) |
| `onThemeChanged(callback)` | Listen for OS dark/light changes (returns unsubscribe) |
| `onUpdateAvailable(callback)` | Listen for update events (returns unsubscribe) |

| `getNotificationPrefs()` | Get per-event notification toggles (async) |
| `setNotificationPrefs(prefs)` | Update notification preferences |
| `onShortcut(callback)` | Listen for keyboard shortcuts (returns unsubscribe) |

The preload script uses `contextBridge` with `contextIsolation: true` and `sandbox: true` — no Node APIs leak to the page.

## Native notifications (Phase 102)

Desktop builds connect to the server's WebSocket and show native OS notifications for:
- **new_message** — new chat message received
- **agent_complete** — agent task finished
- **swarm_complete** — multi-agent swarm finished
- **schedule_fired** — scheduled recipe executed

Click any notification to focus the app window. Per-event toggles are persisted in `<userData>/notification-prefs.json` and can be managed via `window.siskelDesktop.getNotificationPrefs()` / `setNotificationPrefs()`.

## Deep linking (Phase 103)

The app registers the `siskelbot://` protocol. Supported URLs:

| URL | Action |
|-----|--------|
| `siskelbot://chat?prompt=hello` | Open chat with pre-filled prompt |
| `siskelbot://workspace/<id>` | Switch to workspace |
| `siskelbot://recipe/<name>` | Open a recipe |

Platform support: macOS `open-url` event, Windows registry via NSIS installer, Linux `.desktop` MimeType.

## Keyboard shortcuts (Phase 104)

**Global hotkey:** `Ctrl+Shift+S` (or `Cmd+Shift+S` on macOS) toggles the window. Override with:

```bash
DESKTOP_GLOBAL_HOTKEY="CmdOrCtrl+Shift+B" npm run desktop
```

**In-app shortcuts** (via `before-input-event`):

| Shortcut | Action |
|----------|--------|
| `Ctrl+N` | New chat |
| `Ctrl+L` | Clear / reload chat |
| `Ctrl+K` | Command palette |
| `Ctrl+,` | Open settings |
| `Ctrl+Tab` | Next conversation |
| `Ctrl+Shift+Tab` | Previous conversation |

## Window state persistence (Phase 105)

Window position, size, and maximized state are saved to `<userData>/window-state.json` and restored on next launch. Multi-monitor safe — if the saved position is off-screen, the window resets to the primary display.

## Local model manager (Phase 106)

Desktop builds expose API routes to manage Ollama models:

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/desktop/models` | List installed models (size, quantization, family) |
| POST | `/api/desktop/models/pull` | Pull a model (SSE progress stream) |
| DELETE | `/api/desktop/models/:name` | Delete a model |

These routes are only available when `ELECTRON_DESKTOP=1`. They proxy to the local Ollama API (`OLLAMA_URL`, default `http://localhost:11434`).

## Security notes

- The embedded server is **localhost-only** in desktop mode.
- External links open in the **default browser** (`setWindowOpenHandler`).
- Renderer sandbox is enabled; preload exposes only whitelisted IPC channels.
- No `nodeIntegration`; full `contextIsolation`.
