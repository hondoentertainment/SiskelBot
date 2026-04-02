# Release Process

## Automated Desktop Releases

Desktop installers are built automatically via GitHub Actions when a version tag is pushed.

### Trigger a release

```bash
# Update version in package.json first
npm version patch   # or minor / major
git push origin main --tags
```

The `desktop-release.yml` workflow will:
1. Build Windows installers (x64 + ARM64)
2. Build macOS installers (x64 + ARM64, signed if certs configured)
3. Build Linux packages (AppImage + .deb)
4. Create a **draft** GitHub Release with all artifacts

### Required Secrets

| Secret | Purpose |
|--------|---------|
| `GITHUB_TOKEN` | Auto-provided, used for release creation |
| `MAC_CERT_P12` | Base64-encoded macOS signing certificate |
| `MAC_CERT_PASSWORD` | Certificate password |
| `APPLE_ID` | Apple ID for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for notarization |
| `APPLE_TEAM_ID` | Apple Developer Team ID |
| `WIN_CSC_LINK` | Windows code-signing certificate (optional) |
| `WIN_CSC_KEY_PASSWORD` | Windows cert password (optional) |

### Manual release

```bash
# Build locally
npm run desktop:dist        # Windows x64
npm run desktop:dist:arm64  # Windows ARM64
npm run desktop:dist:mac    # macOS
npm run desktop:dist:linux  # Linux
```

Installers are output to `release/`.

### Release checklist

- [ ] Update version in `package.json`
- [ ] Update CHANGELOG if maintained
- [ ] Tag and push: `git tag v1.x.x && git push origin v1.x.x`
- [ ] Wait for CI to build all platforms
- [ ] Review draft release on GitHub
- [ ] Test installers on each platform
- [ ] Publish the release
