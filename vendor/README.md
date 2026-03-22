# Vendor files (desktop build)

- **`node-win/node.exe`** — Official Node.js Windows x64 binary, copied here by:

  ```bash
  npm run vendor:node-win
  ```

  `npm run desktop:dist` runs `ensure-node-vendor` first and downloads this automatically if it is missing (requires internet once).

- These paths are **gitignored**; each machine / CI runner that builds the installer should generate them locally.
