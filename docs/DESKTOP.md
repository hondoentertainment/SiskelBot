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

## Security notes

- The embedded server is **localhost-only** in desktop mode.
- External links open in the **default browser** (`setWindowOpenHandler`).
