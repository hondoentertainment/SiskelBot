# SCIM 2.0 Setup Guide

SiskelBot exposes a [SCIM 2.0](https://datatracker.ietf.org/doc/html/rfc7644)
provisioning endpoint at `/scim/v2/*`. Identity providers (Okta, Azure AD,
OneLogin, Google Workspace, JumpCloud, etc.) can use this endpoint to
automatically create, update, and deactivate users and groups in SiskelBot
when they are added to or removed from upstream IdP groups.

## Overview

| Item              | Value                                              |
|-------------------|----------------------------------------------------|
| Base URL          | `https://<your-siskelbot-host>/scim/v2`            |
| Auth              | OAuth Bearer Token (long-lived, shared with IdP)   |
| Content-Type      | `application/scim+json`                            |
| User endpoint     | `/scim/v2/Users`                                   |
| Group endpoint    | `/scim/v2/Groups`                                  |
| Discovery         | `/scim/v2/ServiceProviderConfig`, `/ResourceTypes`, `/Schemas` |
| PATCH supported   | Yes                                                |
| Filter supported  | Yes (`eq`, `ne`, `co`, `sw`, `ew`, `pr`, `gt/ge/lt/le`) |
| Bulk supported    | No                                                 |

## 1. Configure SiskelBot

Generate a long bearer token (32+ random bytes recommended) and set it as an
environment variable on your SiskelBot deployment:

```bash
export SCIM_BEARER_TOKEN=$(openssl rand -hex 32)
```

For zero-downtime token rotation, also set `SCIM_BEARER_TOKEN_PREVIOUS` to the
old token while you roll the new one out to your IdP:

```bash
export SCIM_BEARER_TOKEN=new_token_here
export SCIM_BEARER_TOKEN_PREVIOUS=old_token_here
```

Both tokens are accepted, but requests authenticated with the previous token
get the response header `X-SCIM-Token-Deprecated: true` and a warning is
logged. Remove `SCIM_BEARER_TOKEN_PREVIOUS` once your IdP has been updated.

If neither variable is set, all `/scim/v2/*` endpoints respond with HTTP 503
`SCIM_NOT_CONFIGURED` so the endpoint cannot be accessed anonymously.

Restart SiskelBot to apply the change.

## 2. Verify the SCIM endpoint

Quick smoke test from a shell:

```bash
curl -sS -H "Authorization: Bearer $SCIM_BEARER_TOKEN" \
  https://your-siskelbot-host/scim/v2/ServiceProviderConfig | jq .
```

You should get a SCIM `ServiceProviderConfig` response describing supported
features (patch, filter, etc.).

## 3. Identity provider setup

### Okta

1. Open the Okta Admin Console.
2. **Applications** → **Browse App Catalog** and select **SCIM 2.0 Test App
   (OAuth Bearer Token)** (or your existing SiskelBot app).
3. **General** tab → set **App label** to "SiskelBot".
4. **Provisioning** tab → click **Configure API Integration** and check
   **Enable API integration**.
5. Set:
   - **SCIM connector base URL**: `https://your-siskelbot-host/scim/v2`
   - **Unique identifier field for users**: `userName`
   - **Supported provisioning actions**: Push New Users, Push Profile Updates,
     Push Groups, Reactivate Users
   - **Authorization mode**: HTTP Header
   - **HTTP Header** → **Authorization**: `Bearer <SCIM_BEARER_TOKEN>`
6. Click **Test API Credentials** — you should see a green check.
7. Under **To App** → **Edit**, enable **Create Users**, **Update User
   Attributes**, and **Deactivate Users**, then **Save**.
8. **Assignments** tab → assign users or groups to provision them.

#### Okta attribute mapping

| Okta attribute      | SCIM attribute                |
|---------------------|-------------------------------|
| `userName`          | `userName`                    |
| `email`             | `emails[type eq "work"].value`|
| `firstName`         | `name.givenName`              |
| `lastName`          | `name.familyName`             |
| `displayName`       | `displayName`                 |
| `(active)`          | `active`                      |

### Azure AD (Microsoft Entra ID)

1. Sign in to the [Azure portal](https://portal.azure.com) and open **Microsoft
   Entra ID** → **Enterprise applications**.
2. **+ New application** → **+ Create your own application**, enter "SiskelBot",
   pick **Integrate any other application you don't find in the gallery
   (Non-gallery)**, then **Create**.
3. Open the new app → **Provisioning** → **Get started**.
4. Set **Provisioning Mode** to **Automatic**.
5. Under **Admin Credentials**:
   - **Tenant URL**: `https://your-siskelbot-host/scim/v2`
   - **Secret Token**: `<SCIM_BEARER_TOKEN>`
6. Click **Test Connection** — Azure performs a `GET
   /scim/v2/Users?filter=...` and a `GET /ServiceProviderConfig`.
7. Save, then under **Mappings** review **Provision Microsoft Entra ID Users**
   and **Provision Microsoft Entra ID Groups**. The defaults work; remove or
   adapt unsupported attributes (e.g., `urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:manager`).
8. Set **Provisioning Status** to **On** and **Save**.
9. **Users and groups** → assign users or groups.

#### Azure AD attribute mapping

| Source (Entra ID)             | Target (SCIM)                       |
|-------------------------------|-------------------------------------|
| `userPrincipalName`           | `userName`                          |
| `mail`                        | `emails[type eq "work"].value`      |
| `givenName`                   | `name.givenName`                    |
| `surname`                     | `name.familyName`                   |
| `displayName`                 | `displayName`                       |
| `Switch([IsSoftDeleted], …)` | `active`                            |
| `objectId`                    | `externalId`                        |

### OneLogin

1. Sign in to the OneLogin admin portal.
2. **Applications** → **Add App** → search for **SCIM Provisioner with SAML
   (SCIM v2 Enterprise, Bearer)**. Add it and rename to "SiskelBot".
3. **Configuration** tab:
   - **SCIM Base URL**: `https://your-siskelbot-host/scim/v2`
   - **SCIM Bearer Token**: `<SCIM_BEARER_TOKEN>`
   - **SCIM JSON Template**: leave as default.
4. Click **Enable**.
5. **Provisioning** tab → check **Enable provisioning**, set **When users are
   deleted in OneLogin** and **When user accounts are suspended** to **Delete**
   or **Suspend**.
6. **Save**.
7. **Users** tab → assign users; OneLogin will start provisioning.

#### OneLogin attribute mapping

| OneLogin field   | SCIM attribute                   |
|------------------|----------------------------------|
| `username`       | `userName`                       |
| `email`          | `emails[type eq "work"].value`   |
| `firstname`      | `name.givenName`                 |
| `lastname`       | `name.familyName`                |
| `displayname`    | `displayName`                    |
| `userPrincipalName` | `externalId`                  |

### Google Workspace

Google Workspace uses the [Automatic Provisioning](https://support.google.com/a/answer/7681608)
feature, which supports SCIM 2.0.

1. In the [Google Admin console](https://admin.google.com), go to **Apps** →
   **Web and mobile apps**.
2. **Add app** → **Add custom SAML app** (or pick the SiskelBot SAML app if
   already configured).
3. After creating the SAML config, open the app → **Auto-provisioning**.
4. **Set up auto-provisioning** → **Get started**.
5. Enter:
   - **Endpoint URL**: `https://your-siskelbot-host/scim/v2`
   - **Access token**: `<SCIM_BEARER_TOKEN>`
6. Click **Continue**, then map attributes:
   - `Primary email` → `userName`
   - `Primary email` → `emails[type eq "work"].value`
   - `First name` → `name.givenName`
   - `Last name` → `name.familyName`
7. Choose **Deprovisioning** behaviour (suspend / delete) and **Finish**.
8. Toggle **Auto-provisioning** to **On**.

## 4. Group provisioning

SCIM groups are stored under `/scim/v2/Groups`. Adding members to a group from
your IdP issues a `PATCH /scim/v2/Groups/:id` with operations like:

```json
{
  "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
  "Operations": [
    {
      "op": "add",
      "path": "members",
      "value": [{ "value": "user-id-123", "display": "alice@example.com" }]
    }
  ]
}
```

Removing members uses:

```json
{
  "Operations": [
    { "op": "remove", "path": "members[value eq \"user-id-123\"]" }
  ]
}
```

## 5. Common operations

| Action                  | Method  | Endpoint                                       |
|-------------------------|---------|------------------------------------------------|
| List users              | GET     | `/scim/v2/Users?startIndex=1&count=100`        |
| Filter by username      | GET     | `/scim/v2/Users?filter=userName eq "alice"`    |
| Get user                | GET     | `/scim/v2/Users/:id`                           |
| Create user             | POST    | `/scim/v2/Users`                               |
| Replace user            | PUT     | `/scim/v2/Users/:id`                           |
| Patch user              | PATCH   | `/scim/v2/Users/:id`                           |
| Delete user             | DELETE  | `/scim/v2/Users/:id`                           |
| Deactivate user (PATCH) | PATCH   | `/scim/v2/Users/:id` with `active: false`      |

## 6. Troubleshooting

| Symptom                                  | Cause                                          | Fix                                                       |
|------------------------------------------|------------------------------------------------|-----------------------------------------------------------|
| `503 SCIM_NOT_CONFIGURED`                | `SCIM_BEARER_TOKEN` not set                    | Set the env var and restart SiskelBot                     |
| `401 INVALID_TOKEN`                      | IdP token does not match server token          | Re-paste the bearer token in the IdP admin UI             |
| `409 uniqueness`                         | A user with the same `userName` already exists | Resolve the duplicate or change the IdP unique identifier |
| `400 invalidSyntax`                      | PATCH body missing `Operations` array          | Check IdP attribute mapping for unsupported transforms    |
| Provisioning succeeds but users inactive | IdP sends `active: false`                      | Reactivate the user in the IdP                            |
| `X-SCIM-Token-Deprecated: true`          | IdP still uses the previous token              | Update the IdP to the new bearer token                    |

## 7. Security notes

- The bearer token is **highly sensitive**. Treat it like a password and rotate
  regularly using `SCIM_BEARER_TOKEN_PREVIOUS`.
- All `/scim/v2/*` endpoints should be served over HTTPS only.
- Restrict outbound network access from your IdP if possible (most IdPs publish
  fixed egress IPs).
- Audit `data/scim/users.json` and `data/scim/groups.json` periodically.

## 8. Reference

- [RFC 7643 — SCIM Core Schema](https://datatracker.ietf.org/doc/html/rfc7643)
- [RFC 7644 — SCIM Protocol](https://datatracker.ietf.org/doc/html/rfc7644)
- [Okta SCIM provisioning](https://developer.okta.com/docs/concepts/scim/)
- [Azure AD SCIM provisioning](https://learn.microsoft.com/en-us/entra/identity/app-provisioning/use-scim-to-provision-users-and-groups)
- [OneLogin SCIM provisioning](https://developers.onelogin.com/scim)
- [Google Workspace auto-provisioning](https://support.google.com/a/answer/7681608)
