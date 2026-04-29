# SSO Operational Runbook

Configure single sign-on (SSO) for SiskelBot. Covers OAuth 2.0 / OIDC, SAML, and provider-specific setup steps.

## 1. Overview

| Protocol | Status | Reference |
|---|---|---|
| OAuth 2.0 (GitHub) | implemented | this doc, §3 |
| OAuth 2.0 (Google) | implemented | this doc, §3 |
| OIDC (generic) | implemented | this doc, §4–§7 |
| SAML 2.0 | implemented | this doc, §8 |
| LDAP | implemented | [docs/LDAP.md](./LDAP.md) |
| SCIM provisioning | implemented | [docs/SCIM_SETUP.md](./SCIM_SETUP.md) |

## 2. Configuration env vars

All env vars are loaded at process start. Restart pods after changing.

### OIDC

| Variable | Required | Description |
|---|---|---|
| `OIDC_ISSUER` | yes | Issuer URL (e.g. `https://yourorg.okta.com/oauth2/default`) |
| `OIDC_CLIENT_ID` | yes | OAuth client ID from IdP |
| `OIDC_CLIENT_SECRET` | yes | OAuth client secret |
| `OIDC_REDIRECT_URI` | yes | Public callback URL (e.g. `https://siskelbot.example.com/auth/oidc/callback`) |
| `OIDC_SCOPES` | no | Default: `openid profile email` |

### SAML

| Variable | Required | Description |
|---|---|---|
| `SAML_ENTRY_POINT` | yes | IdP SSO URL (e.g. `https://yourorg.okta.com/app/.../sso/saml`) |
| `SAML_ISSUER` | yes | SP entity ID (must match what IdP expects) |
| `SAML_CERT` | yes | IdP signing cert (PEM, multi-line via env-file syntax) |
| `SAML_CALLBACK_URL` | yes | ACS URL (e.g. `https://siskelbot.example.com/auth/saml/callback`) |

### Built-in OAuth providers (GitHub, Google)

These are passport-style integrations. Set:
```
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

Callback URLs (registered in the provider):
- GitHub: `https://siskelbot.example.com/auth/github/callback`
- Google: `https://siskelbot.example.com/auth/google/callback`

## 3. GitHub & Google OAuth setup

These work out of the box. To enable:

1. Create an OAuth app in GitHub Settings → Developer settings → OAuth Apps (or Google Cloud Console → OAuth client ID)
2. Set the callback URL exactly as above
3. Set `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` (or Google equivalents) in the SiskelBot environment
4. Restart pods: `kubectl rollout restart deployment/siskelbot`
5. Test: navigate to `/auth/github` (or `/auth/google`); confirm OAuth flow + redirect back to app

## 4. Okta (OIDC)

1. Okta Admin Console → **Applications** → **Create App Integration**
2. Sign-in method: **OIDC – OpenID Connect**
3. Application type: **Web Application**
4. Name: `SiskelBot`
5. Sign-in redirect URIs: `https://siskelbot.example.com/auth/oidc/callback`
6. Sign-out redirect URIs: `https://siskelbot.example.com/`
7. Assignments: select groups that should have access
8. Note the **Client ID** and **Client secret** from the General tab
9. Set in SiskelBot env:
   ```
   OIDC_ISSUER=https://yourorg.okta.com/oauth2/default
   OIDC_CLIENT_ID=<from Okta>
   OIDC_CLIENT_SECRET=<from Okta>
   OIDC_REDIRECT_URI=https://siskelbot.example.com/auth/oidc/callback
   ```
10. Restart pods
11. Test: navigate to `/auth/oidc`; confirm redirect to Okta and back

### Attribute mapping

Okta sends `email`, `name`, `groups` claims with `openid profile email` scope. To include `groups`, add a custom claim in Okta: **Security → API → Authorization Servers → default → Claims → Add Claim** with `groups` as the name and `Matches regex .*` as the filter.

## 5. Microsoft Entra ID (Azure AD)

1. Azure Portal → **Microsoft Entra ID** → **App registrations** → **New registration**
2. Name: `SiskelBot`
3. Supported account types: **Single tenant** (typical) or **Multitenant** (for SaaS)
4. Redirect URI: **Web** → `https://siskelbot.example.com/auth/oidc/callback`
5. After creation, note **Application (client) ID** and **Directory (tenant) ID**
6. **Certificates & secrets** → **New client secret** → copy the value
7. **API permissions** → Add `openid`, `profile`, `email`, optionally `User.Read`
8. **Token configuration** → **Add groups claim** (select "Security groups" or "All groups")
9. Set env:
   ```
   OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
   OIDC_CLIENT_ID=<application-id>
   OIDC_CLIENT_SECRET=<secret-value>
   OIDC_REDIRECT_URI=https://siskelbot.example.com/auth/oidc/callback
   ```
10. Restart pods, test login

## 6. Google Workspace (OIDC)

For most setups, use the built-in `GOOGLE_*` env vars (§3). Use OIDC mode only if you need group claims from Workspace directory.

1. Google Cloud Console → **APIs & Services** → **Credentials** → **Create Credentials** → **OAuth client ID**
2. Application type: **Web application**
3. Authorized redirect URIs: `https://siskelbot.example.com/auth/oidc/callback`
4. Note Client ID and Client Secret
5. Set:
   ```
   OIDC_ISSUER=https://accounts.google.com
   OIDC_CLIENT_ID=<client-id>.apps.googleusercontent.com
   OIDC_CLIENT_SECRET=<client-secret>
   OIDC_REDIRECT_URI=https://siskelbot.example.com/auth/oidc/callback
   ```
6. Restart pods, test login

## 7. Auth0 (OIDC)

1. Auth0 Dashboard → **Applications** → **Create Application**
2. Type: **Regular Web Application**
3. **Settings** tab:
   - Allowed Callback URLs: `https://siskelbot.example.com/auth/oidc/callback`
   - Allowed Logout URLs: `https://siskelbot.example.com/`
   - Note Domain (e.g. `your-tenant.auth0.com`), Client ID, Client Secret
4. Set env:
   ```
   OIDC_ISSUER=https://your-tenant.auth0.com/
   OIDC_CLIENT_ID=<client-id>
   OIDC_CLIENT_SECRET=<client-secret>
   OIDC_REDIRECT_URI=https://siskelbot.example.com/auth/oidc/callback
   ```
   Note the trailing slash on `OIDC_ISSUER` for Auth0 — required.
5. Restart pods, test login

## 8. SAML 2.0

1. In your IdP (Okta, Azure AD, ADFS, Keycloak, etc.), create a new SAML 2.0 application
2. Configure:
   - **SP Entity ID**: pick a stable URN, e.g. `urn:siskelbot:prod`
   - **ACS URL**: `https://siskelbot.example.com/auth/saml/callback`
   - **NameID format**: `EmailAddress`
   - **Required attribute statements**: `email`, `firstName`, `lastName`, `groups` (optional)
3. Download the IdP signing certificate (X.509 PEM)
4. Note the IdP SSO URL (entry point)
5. Set env:
   ```
   SAML_ENTRY_POINT=https://yourorg.okta.com/app/.../sso/saml
   SAML_ISSUER=urn:siskelbot:prod
   SAML_CALLBACK_URL=https://siskelbot.example.com/auth/saml/callback
   SAML_CERT="-----BEGIN CERTIFICATE-----\nMIIDpDCCAoyg...\n-----END CERTIFICATE-----"
   ```
   For multi-line certs, use a Kubernetes Secret with `\n` literals or mount a file and reference it.
6. Restart pods, test login at `/auth/saml`

### Common SAML attribute names

| Attribute | Standard URI / common name |
|---|---|
| Email | `email` or `urn:oid:0.9.2342.19200300.100.1.3` |
| First name | `firstName` or `urn:oid:2.5.4.42` |
| Last name | `lastName` or `urn:oid:2.5.4.4` |
| Groups | `groups` or `http://schemas.xmlsoap.org/claims/Group` |

## 9. JIT provisioning

When a user logs in via SSO for the first time, SiskelBot creates the user record automatically. Default behavior:

- New user joins a default workspace (or the workspace specified by IdP claim, if mapped)
- Default role: `member`
- An audit log entry is recorded with `event="login"` and `metadata.first_login=true`

To pre-provision users instead (recommended for tighter access control), use SCIM — see [docs/SCIM_SETUP.md](./SCIM_SETUP.md).

## 10. Group-to-role mapping

SSO group claims map to SiskelBot roles via convention. Default mapping:

| IdP group claim value | SiskelBot role |
|---|---|
| `siskelbot-admins` | `admin` |
| `siskelbot-members` | `member` |
| (no matching group) | `member` (JIT default) |

Customize via your IdP's group/claim configuration. There is no env-driven mapping override at this time — file an issue if needed.

## 11. Testing the integration

```bash
# Verify the OIDC discovery doc is reachable from the pod
kubectl exec deploy/siskelbot -- curl -fsS \
  "${OIDC_ISSUER}/.well-known/openid-configuration" | jq .issuer

# Tail server logs while attempting login
kubectl logs -f -l app.kubernetes.io/name=siskelbot -n siskelbot \
  | grep -iE 'oidc|saml|sso|auth'

# Verify a successful login created a session and audit entry
psql "${DATABASE_URL}" -c \
  "SELECT user_id, event, created_at FROM audit_log WHERE event='login' ORDER BY created_at DESC LIMIT 5;"
```

## 12. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Redirect loop after login | Cookie not set, or `Secure` flag conflicts with proxy | Set `SESSION_COOKIE_SECURE=1` and `TRUST_PROXY=1` |
| 400 `invalid_redirect_uri` | Callback URL mismatch | Ensure exact match between IdP config and `OIDC_REDIRECT_URI` (incl. trailing slash, scheme) |
| User logged in but no permissions | Role mapping failed | Confirm IdP is sending the `groups` claim; check group names match the convention in §10 |
| SAML signature validation failed | IdP cert rotated or stale | Re-fetch IdP metadata, update `SAML_CERT` |
| `state` mismatch error | Multi-replica session loss | Ensure session store is shared (Postgres or Redis), not in-memory |
| Group claim missing | IdP not configured to send | Add a custom claim/attribute statement in the IdP |

## 13. Emergency: SSO IdP down

There is **no built-in fallback to local auth** when the configured SSO IdP is unreachable. If your IdP goes down, users cannot log in via SSO until it recovers.

Mitigations:
- Keep `ADMIN_API_KEY` available out-of-band — admin API endpoints accept it independently of SSO
- For multi-IdP redundancy, configure both OIDC and SAML pointing at different IdPs and document which to use during an outage

## 14. Audit considerations

Every successful and failed login is recorded in the audit log (see [docs/COMPLIANCE.md](./COMPLIANCE.md)):
- `event="login"` — successful authentication
- `event="login_failed"` — auth failure with reason in metadata
- `event="logout"` — explicit logout

Default audit retention is `AUDIT_RETENTION_DAYS=90`. For SOC2 / GDPR compliance, override to `AUDIT_RETENTION_DAYS=2555` (7 years).

For external audit, query the audit log:
```sql
SELECT user_id, event, ip_address, user_agent, metadata, created_at
FROM audit_log
WHERE event LIKE 'login%'
  AND created_at > NOW() - INTERVAL '30 days'
ORDER BY created_at DESC;
```

---

See also: [RUNBOOK.md](./RUNBOOK.md) (Secret Rotation section), [LDAP.md](./LDAP.md), [SCIM_SETUP.md](./SCIM_SETUP.md), [COMPLIANCE.md](./COMPLIANCE.md).
