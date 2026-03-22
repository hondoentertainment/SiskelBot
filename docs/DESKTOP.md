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

## Windows installer (x64, NSIS)

Configured for **Windows x64 only** (`electron-builder`).

1. On **Windows**, install dependencies: `npm install`
2. Build:

   ```bash
   npm run desktop:dist
   ```

3. **First run** downloads official **Node.js** `node.exe` (see `scripts/vendor-node-win.mjs`, default `NODE_VENDOR_VERSION=20.18.1`) into `vendor/node-win/` if missing, then produces:

   - `release/Siskel Bot-<version>-Windows-x64.exe` — NSIS setup (choose install dir, not one-click)
   - Installed app bundles **Electron** + app files + **`node.exe`** in `resources/node-win/` so end users **do not need Node on PATH**

4. Pre-download Node only (no full installer):

   ```bash
   npm run vendor:node-win
   ```

5. **Offline builds:** run `vendor:node-win` once on a machine with internet, keep `vendor/node-win/node.exe`, then run `electron-builder --win --x64` without `ensure-node-vendor` if you add a separate script.

**Notes**

- `npmRebuild` is **disabled** so native addons (e.g. optional `better-sqlite3`) stay built for **Node**, not Electron’s ABI (the API runs in a child `node` process).
- Build on **x64 Windows** for the Windows target. No macOS/Linux artifacts are configured.
- Optional: add a `.ico` under `build/icon.ico` and set `"icon": "build/icon.ico"` under `build.win` in `package.json`.

## Security notes

- The embedded server is **localhost-only** in desktop mode.
- External links open in the **default browser** (`setWindowOpenHandler`).
