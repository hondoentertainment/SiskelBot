# LDAP / Active Directory Integration

SiskelBot supports authentication and group-based role mapping against any
LDAP v3 directory, including Microsoft Active Directory and OpenLDAP. This
guide describes how to configure the integration, map LDAP groups to
SiskelBot roles, and troubleshoot common problems.

## Status

LDAP support is provided by the optional `ldapjs` dependency, loaded
dynamically at runtime. The rest of the application works without it; LDAP
endpoints simply return `503 LDAPJS_NOT_INSTALLED` until the package is
installed.

```bash
npm install ldapjs
```

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LDAP_URL` | yes | LDAP/LDAPS URL, e.g. `ldap://ldap.example.com:389` or `ldaps://ad.example.com:636` |
| `LDAP_BIND_DN` | yes | Service account DN used for the initial bind (e.g. `cn=svc-siskelbot,ou=services,dc=example,dc=com`) |
| `LDAP_BIND_PASSWORD` | yes | Service account password |
| `LDAP_BASE_DN` | yes | Base DN for user/group searches (e.g. `dc=example,dc=com`) |
| `LDAP_USER_FILTER` | no | Filter template used during user lookup. Default: `(uid={username})`. For Active Directory use `(sAMAccountName={username})`. |
| `LDAP_GROUP_FILTER` | no | Filter template used during group lookup. Default: `(member={dn})`. |
| `LDAP_TLS_REJECT_UNAUTHORIZED` | no | Set to `0` to skip certificate validation. Disabling this is **not** recommended. |
| `LDAP_TIMEOUT_MS` | no | Operation timeout in milliseconds. Default: `10000`. |
| `LDAP_CONNECT_TIMEOUT_MS` | no | Connect timeout in milliseconds. Default: `10000`. |

The `{username}` and `{dn}` placeholders are substituted at request time and
properly escaped per RFC 4515.

## Active Directory specifics

Active Directory typically uses the `sAMAccountName` (pre-Windows 2000) or
`userPrincipalName` attribute as the login identifier and stores group
membership in the user's `memberOf` attribute. A typical configuration:

```env
LDAP_URL=ldaps://ad.example.com:636
LDAP_BIND_DN=cn=svc-siskelbot,ou=Service Accounts,dc=corp,dc=example,dc=com
LDAP_BIND_PASSWORD=********
LDAP_BASE_DN=dc=corp,dc=example,dc=com
LDAP_USER_FILTER=(sAMAccountName={username})
LDAP_GROUP_FILTER=(member={dn})
```

Notes:

- Active Directory rejects anonymous binds; the service account is
  required.
- The user search returns `memberOf`, which SiskelBot merges with the
  results of the LDAP_GROUP_FILTER search to form the user's full group
  list.
- Use the user's full DN to bind. SiskelBot resolves the DN automatically
  via the user search before attempting the credential bind.

## OpenLDAP

A typical OpenLDAP setup uses `uid` for the username and stores groups as
`groupOfNames` entries:

```env
LDAP_URL=ldap://ldap.example.com:389
LDAP_BIND_DN=cn=admin,dc=example,dc=com
LDAP_BIND_PASSWORD=********
LDAP_BASE_DN=dc=example,dc=com
LDAP_USER_FILTER=(uid={username})
LDAP_GROUP_FILTER=(member={dn})
```

If you use `posixGroup` (where membership lives in `memberUid`), set
`LDAP_GROUP_FILTER=(memberUid={username})`.

## Group-based role mapping

SiskelBot maps LDAP group DNs (or `cn` values) to its own RBAC roles:
`viewer`, `member`, `admin`, `owner`. When a user is in multiple mapped
groups, the highest-privilege role wins.

The default mapping is shipped in `lib/ldap-group-mapping.js`:

```js
{
  "cn=siskelbot-admins,ou=groups,dc=example,dc=com": "admin",
  "cn=siskelbot-members,ou=groups,dc=example,dc=com": "member",
  "cn=siskelbot-viewers,ou=groups,dc=example,dc=com": "viewer",
}
```

You can override this per workspace via the API:

```http
PUT /api/v1/auth/ldap/group-mapping
Authorization: Bearer <ADMIN_API_KEY>
Content-Type: application/json

{
  "workspaceId": "team-acme",
  "mapping": {
    "cn=acme-admins,ou=Groups,dc=acme,dc=com": "admin",
    "cn=acme-engineering,ou=Groups,dc=acme,dc=com": "member"
  }
}
```

Reading the current mapping:

```http
GET /api/v1/auth/ldap/group-mapping?workspace=team-acme
```

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/v1/auth/ldap/login` | none | Username/password login. Returns `userId`, `groups`, and resolved `role`. |
| `POST` | `/api/v1/auth/ldap/test` | admin | Bind to the configured server and return success/failure. |
| `GET`  | `/api/v1/auth/ldap/groups` | admin | List groups visible under the base DN. |
| `GET`  | `/api/v1/auth/ldap/group-mapping` | none | Read the role mapping for a workspace (defaults to the global mapping). |
| `PUT`  | `/api/v1/auth/ldap/group-mapping` | admin | Update the role mapping for a workspace. |
| `POST` | `/api/v1/auth/ldap/sync` | admin | Trigger a one-shot sync of all matching users and groups. |

All endpoints return JSON with `error`/`code` fields on failure, matching
the rest of the SiskelBot API.

### Login example

```bash
curl -X POST http://localhost:3000/api/v1/auth/ldap/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"hunter2"}'
```

Response:

```json
{
  "ok": true,
  "userId": "ldap-alice",
  "email": "alice@example.com",
  "displayName": "Alice Smith",
  "dn": "uid=alice,ou=people,dc=example,dc=com",
  "groups": [
    { "dn": "cn=siskelbot-members,ou=groups,dc=example,dc=com", "name": "siskelbot-members" }
  ],
  "role": "member"
}
```

## Testing with `ldapsearch`

Before configuring SiskelBot, verify the directory works from the host:

```bash
# Test the service bind
ldapsearch -x -H ldaps://ad.example.com:636 \
  -D 'cn=svc-siskelbot,ou=Service Accounts,dc=corp,dc=example,dc=com' \
  -w '********' \
  -b 'dc=corp,dc=example,dc=com' \
  '(sAMAccountName=alice)'

# Test that you can bind as the user
ldapsearch -x -H ldaps://ad.example.com:636 \
  -D 'cn=Alice Smith,ou=People,dc=corp,dc=example,dc=com' \
  -w 'alice-password' \
  -b 'dc=corp,dc=example,dc=com' \
  '(objectClass=*)' dn
```

If `ldapsearch` succeeds with the same credentials, SiskelBot will too.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `503 LDAPJS_NOT_INSTALLED` | The `ldapjs` package is not installed | `npm install ldapjs` and restart |
| `503 LDAP_NOT_CONFIGURED` | `LDAP_URL` is not set | Set the env vars in this guide |
| `502 LDAP_TEST_FAILED: connect ECONNREFUSED` | Wrong host/port or firewall | Confirm network reachability with `nc -vz host port` |
| `502 LDAP_TEST_FAILED: self signed certificate` | LDAPS cert not trusted | Add the CA to the system trust store, or set `LDAP_TLS_REJECT_UNAUTHORIZED=0` (not recommended) |
| `401 AUTH_FAILED: user not found` | `LDAP_USER_FILTER` does not match | Verify with `ldapsearch -b $LDAP_BASE_DN '(uid=alice)'` |
| `401 AUTH_FAILED: bind as user failed: InvalidCredentialsError` | Wrong password supplied | Re-test the password with `ldapsearch` |
| User logs in but role is `null` | LDAP groups do not match the configured mapping | Update the mapping via `PUT /auth/ldap/group-mapping` |
| Group lookup empty even though user has groups | Server uses a different group attribute (e.g. `memberUid`) | Set `LDAP_GROUP_FILTER=(memberUid={username})` |

For deeper debugging, set `DEBUG=ldapjs:*` to see the protocol-level
messages from `ldapjs`.

## Storage

LDAP-synced users are persisted at `data/ldap-users.json`, the group
snapshot at `data/ldap-groups.json`, and the per-workspace mapping at
`data/ldap-group-mapping.json`. When `STORAGE_BACKEND=postgres` or
`STORAGE_BACKEND=sqlite` is enabled, the json-path-store routes these
records into the configured backend automatically.
