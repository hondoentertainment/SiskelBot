# Code Signing & Notarization

## macOS

### Prerequisites
1. **Apple Developer account** ($99/year)
2. **Developer ID Application** certificate from Apple Developer portal
3. **App-specific password** from appleid.apple.com (Account Security → App-Specific Passwords)

### Environment variables

| Variable | Description |
|----------|-------------|
| `CSC_LINK` | Path to `.p12` certificate file, or base64-encoded |
| `CSC_KEY_PASSWORD` | Password for the `.p12` certificate |
| `APPLE_ID` | Your Apple Developer email |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password (not your Apple ID password) |
| `APPLE_TEAM_ID` | Your Apple Developer Team ID |

### Local signing

```bash
export CSC_LINK=~/certs/DeveloperID.p12
export CSC_KEY_PASSWORD=your-cert-password
export APPLE_ID=you@example.com
export APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
export APPLE_TEAM_ID=XXXXXXXXXX

npm run desktop:dist:mac
```

### CI signing
Store certs as base64 GitHub secrets:
```bash
base64 -i DeveloperID.p12 | pbcopy
# Paste into GitHub → Settings → Secrets → MAC_CERT_P12
```

## Windows

### Prerequisites
1. **Code signing certificate** (EV recommended to avoid SmartScreen warnings)
2. OV certificates work but may show warnings for new publishers

### Environment variables

| Variable | Description |
|----------|-------------|
| `WIN_CSC_LINK` | Path to `.pfx` certificate, or base64-encoded |
| `WIN_CSC_KEY_PASSWORD` | Certificate password |

### Notes
- EV certificates require hardware tokens (USB) — not practical for CI without cloud HSM
- Consider services like DigiCert KeyLocker or SSL.com eSigner for cloud-based EV signing
- OV certs can be used in CI more easily

## Skipping signing

For local development/testing builds:
```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run desktop:dist:mac
```
