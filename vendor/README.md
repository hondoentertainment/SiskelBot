# Vendor files (desktop build)

Official **Node.js for Windows** binaries (no git; generated locally):

| Folder | Arch | Created by |
|--------|------|------------|
| `node-win-x64/` | x64 | `npm run vendor:node-win:x64` or `vendor:node-win` (all) |
| `node-win-arm64/` | ARM64 | `npm run vendor:node-win:arm64` or `vendor:node-win` (all) |
| `node-win/` | staging | `scripts/stage-node-vendor.mjs` — copy of one arch for `electron-builder` |

- **`npm run vendor:node-win`** downloads **both** (requires internet).
- **`ensure-node-vendor`** + **`stage-node-vendor`** run automatically from **`desktop:dist`** scripts.

Version: **`NODE_VENDOR_VERSION`** (default `20.18.1` in `scripts/vendor-node-win.mjs`).
