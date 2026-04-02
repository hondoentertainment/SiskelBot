# Desktop Packaging Guide

## Reducing installer size

### Automatic pruning

Before building installers, run the prune script to remove unnecessary files from `node_modules`:

```bash
npm run desktop:prune
npm run desktop:dist
```

This removes test files, documentation, source maps, and other files unnecessary at runtime from dependencies.

### What gets included

The `build.files` config in `package.json` controls which project files are included. Currently excluded:
- Test files and test config
- Documentation (`docs/`, `*.md`)
- Build/CI config (Dockerfile, docker-compose, Makefile, vercel.json, etc.)
- Development artifacts (data/, backups/, release/, vendor/)
- Source maps (`*.map`)
- Environment files (`.env*`)

### ASAR packaging

Currently `asar` is disabled (`"asar": false`) because the Express server runs as a child Node.js process and needs direct filesystem access to `server.js` and its dependencies.

If you want to enable asar in the future:
1. Set `"asar": true` in package.json `build` section
2. Mark server files as unpacked: `"asarUnpack": ["server.js", "lib/**", "client/**"]`
3. Update `electron/main.cjs` `getProjectPaths()` to handle asar paths
4. Test thoroughly — native modules and dynamic requires may break

### Build size targets

| Platform | Target size |
|----------|------------|
| Windows (NSIS) | < 120 MB |
| macOS (DMG) | < 110 MB |
| Linux (AppImage) | < 100 MB |

Most of the size comes from:
- Electron runtime (~85 MB)
- Vendored Node.js binary (~25 MB)
- node_modules (~20-40 MB depending on optional deps)
- Application code (~2 MB)
