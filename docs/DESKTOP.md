# Desktop app (Electron)

Siskel Bot can run as a **native window** that embeds the same web UI and local Express API. The embedded server is the same `server.js` as the CLI and Docker image, so **feature parity** includes agent mode, swarm, knowledge/RAG, workspaces, OAuth, realtime notifications (WebSocket), admin/eval surfaces, optional Postgres/SQLite storage, metrics, and OpenTelemetry—subject to whatever you configure via environment variables.

## Launch sequence (what happens when you start the app)

Whether you run `npm run desktop` or a packaged `.exe`, the shell follows the same order:

1. **Single instance** — `requestSingleInstanceLock()`; a second launch focuses the existing window.
2. **Paths** — Dev: repo root + `server.js`. Packaged: `app.getAppPath()` + `server.js` inside the asar/resources layout.
3. **Port** — Prefer `DESKTOP_PORT` (default **38447**). If that TCP port is taken on `127.0.0.1`, a random free port is chosen (OAuth redirects should use the URL shown in the window if you rely on a fixed port).
4. **Environment** — `PORT`, `LISTEN_HOST=127.0.0.1`, `BASE_URL=http://127.0.0.1:<port>`, `ELECTRON_DESKTOP=1`, `STORAGE_PATH=<userData>/data`. Packaged: if `<STORAGE_PATH>/.env` exists, `DOTENV_CONFIG_PATH` is set so the child process loads secrets from there.
5. **Node process** — Spawns `node` (dev) or `resources/node-win/node.exe` (packaged Windows). `cwd` is the app root so `server.js` resolves modules correctly.
6. **Ready gate** — Polls `GET /health/live` until OK or timeout (default **30s**, override `DESKTOP_SERVER_TIMEOUT_MS`). Failures show a dialog with hints (antivirus, missing Node, slow disk).
7. **Window** — `BrowserWindow` loads `BASE_URL/` (same origin for WebSocket token and API).

**Troubleshooting startup**

| Symptom | Things to check |
|--------|------------------|
| “Server did not become ready…” | `DESKTOP_DEBUG=1` to see server logs; increase `DESKTOP_SERVER_TIMEOUT_MS`; ensure nothing else binds the chosen port. |
| “Could not start Node…” | Packaged: verify `node.exe` under app resources; Dev: install Node or set `NODE_BINARY`. |
| Blank page | Open DevTools from Electron if you add that in dev; confirm `BASE_URL` matches the address bar. |
| OAuth redirect mismatch | Provider must allow `http://127.0.0.1:<port>/auth/.../callback`. Set `DESKTOP_TITLE_PORT=1` to show the URL in the window title. |

Implementation reference: [`electron/main.cjs`](../electron/main.cjs).

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

   - Spawns **Node** with `server.js` (not Electron’s runtime — for dev, `node` must be on `PATH`).
   - Binds the server to **127.0.0.1** only (`LISTEN_HOST`).
   - Sets **`BASE_URL`** to `http://127.0.0.1:<port>` (OAuth callbacks and WebSocket token URLs stay consistent with the window origin).
   - Sets **`ELECTRON_DESKTOP=1`** so the API treats the session as a local HTTP app (e.g. OAuth cookies work even if `NODE_ENV=production` is set globally on the machine).
   - Stores user data under the OS app user folder: `STORAGE_PATH` = `<userData>/data` (not the repo’s `./data`).

## Ports

- Default desktop port: **38447** (`http://127.0.0.1:38447/`).
- If that port is in use, a random free port is chosen (check the window URL or set `DESKTOP_PORT`).

Override:

```bash
set DESKTOP_PORT=3055
npm run desktop
```

## OAuth (GitHub / Google)

The shell sets **`BASE_URL`** to `http://127.0.0.1:<port>` so provider redirect URIs match the embedded server.

Register redirect URLs in the provider console, for example:

- `http://127.0.0.1:38447/auth/github/callback`
- `http://127.0.0.1:38447/auth/google/callback`

If you change **`DESKTOP_PORT`**, use that port in the provider settings. If the app falls back to a random port, either free `38447` or set `DESKTOP_PORT` explicitly before packaging.

Set **`SESSION_SECRET`** (and client IDs/secrets) the same way as for the web server; see `.env.example`.

## Packaged install: configuration file

Windows installers run from a read-only install directory, so a repo-level `.env` is usually not present.

For **packaged** builds only, if a file exists at:

`<STORAGE_PATH>/.env` → on Windows typically:

`%APPDATA%\experimentagent\data\.env`

(`experimentagent` comes from the package `name` in `package.json`; the window title uses the `productName`.)

…the child Node process is started with **`DOTENV_CONFIG_PATH`** pointing at that file, so keys such as `OPENAI_API_KEY`, `GITHUB_CLIENT_ID`, `DATABASE_URL`, `STORAGE_BACKEND`, etc. load without editing Program Files.

Dev (`npm run desktop` from a clone) still uses the project’s `.env` in the repo via the default `dotenv` path; the packaged override applies only when that `data/.env` file exists.

## Realtime (WebSocket) and same-origin UI

The chat shell loads from `http://127.0.0.1:<port>/`. Notifications use **`/api/ws-token`** and a **`ws://`** connection to the same host, so no extra desktop configuration is required.

## Bundled eval examples (installers)

Shipped **`data/eval-sets/*.json`** examples are included in the Windows installer. When `STORAGE_PATH` points at per-user data (desktop), the server **merges** those bundled sets with any sets under `<STORAGE_PATH>/eval-sets`; user copies win on duplicate ids.

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

   If NSIS installer creation fails on your machine (for example `spawn UNKNOWN` in OneDrive-managed paths), build a **portable** x64 executable instead:

   ```bash
   npm run desktop:dist:portable
   ```

   → `release/Siskel Bot-<version>-Windows-x64.exe` (portable, no installer wizard)

3. Build **ARM64** (Snapdragon / Windows on ARM):

   ```bash
   npm run desktop:dist:arm64
   ```

   → `release/Siskel Bot-<version>-Windows-arm64.exe`

   Portable ARM64 alternative:

   ```bash
   npm run desktop:dist:portable:arm64
   ```

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

## Recommended release commands (immediate)

Use the release scripts when you want one command that attempts NSIS first and falls back to portable automatically.

```bash
npm run desktop:release          # x64
npm run desktop:release:arm64    # arm64
```

Each run writes:

- `release/Siskel Bot-<version>-Windows-<arch>.exe`
- `release/Siskel Bot-<version>-Windows-<arch>.exe.sha256`

The `.sha256` file contains a standard `sha256sum` line for distribution verification.

Quick verify on Windows PowerShell:

```powershell
Get-FileHash -Algorithm SHA256 "release\Siskel Bot-<version>-Windows-x64.exe"
```

**Notes**

- `npmRebuild` is **disabled** so native addons (e.g. optional `better-sqlite3`) stay built for **Node**, not Electron’s ABI (the API runs in a child `node` process). Run `npm install` on the **same architecture** you target when optional native modules matter.
- **ARM64 installer:** build with `desktop:dist:arm64` on an **ARM64 Windows** machine (or use cross-compilation if your toolchain supports it — untested here).
- Optional: add `build/icon.ico` and set `"icon": "build/icon.ico"` under `build.win` in `package.json`.
- Portable builds do not create Add/Remove Programs entries; distribute the `.exe` directly.

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

- The embedded server is **localhost-only** in desktop mode (`LISTEN_HOST=127.0.0.1`).
- External links open in the **default browser** (`setWindowOpenHandler`).
- Renderer sandbox is enabled; preload exposes only whitelisted IPC channels.
- No `nodeIntegration`; full `contextIsolation`.
- Treat `%APPDATA%\experimentagent\data\.env` like any secret store; restrict file permissions if the machine is shared.

### SmartScreen (“Windows protected your PC”)

Unsigned builds (or builds from a certificate with no reputation yet) are often blocked or warned by **Microsoft Defender SmartScreen**. The app cannot disable that from inside the binary; Windows treats it as a security feature.

**Production fix:** sign the Windows artifacts with a **trusted Authenticode** code-signing certificate (from a CA Microsoft trusts). [electron-builder](https://www.electron.build/code-signing) signs automatically when you set environment variables on the machine that runs the build:

1. Obtain a **Standard** or **EV** code-signing certificate and export a **`.pfx`** (keep the password secret).
2. Before `npm run desktop:release` (or any `electron-builder` command), set:
   - **`CSC_LINK`** — absolute path to the `.pfx`, **or** a `base64:`-prefixed string of the PFX bytes.
   - **`CSC_KEY_PASSWORD`** — the PFX password.

Example (PowerShell, current session only):

```powershell
$env:CSC_LINK = "C:\certs\your-company-signing.pfx"
$env:CSC_KEY_PASSWORD = "your-pfx-password"
npm run desktop:release
```

EV certificates often get **faster** SmartScreen trust than standard certs; either type may still need **reputation** (install volume / time) before every user sees a clean prompt. For enterprise rollout, use Intune or publisher-based allow rules.

**Local testing only (not a distribution fix):** right-click the `.exe` → **Properties** → if present, check **Unblock** → **Apply**. Or on the SmartScreen page choose **More info** → **Run anyway** once. Turning off SmartScreen globally is not recommended.

## Release smoke checklist

1. Launch the packaged app and confirm no startup error dialog (if startup fails, retry once with `DESKTOP_SERVER_TIMEOUT_MS=60000` in the packaged `data/.env` to rule out slow AV scanning).
2. Open `http://127.0.0.1:<port>/health/live` and verify `{ ok: true }`.
3. Send one normal chat message and one agent-mode prompt; confirm responses render.
4. Create/switch workspace, restart app, and confirm workspace + conversation persist.
5. Open `/eval` and `/admin` in the app session and confirm pages load.
6. For packaged app env config, validate `%APPDATA%\experimentagent\data\.env` values are honored after restart.
