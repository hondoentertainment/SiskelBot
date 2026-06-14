# GitHub branch protection (recommended for production)

Apply after CI is green on `main`. Requires repo admin.

```bash
gh api repos/hondoentertainment/SiskelBot/branches/main/protection \
  --method PUT \
  --input - <<'EOF'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "lint",
      "test",
      "Trivy filesystem scan",
      "smoke",
      "e2e"
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1
  },
  "restrictions": null
}
EOF
```

Adjust `contexts` to match exact check names in **Settings → Branches → main → Required checks** (names vary if workflows rename jobs).

Also set repository secrets:

| Secret | Purpose |
|--------|---------|
| `SMOKE_TEST_API_KEY` | Production smoke auth probe |
| `SMOKE_TEST_ADMIN_API_KEY` | Production smoke Phase 63 admin probe |
| `REPLAY_TOKEN_SECRET` | E2E replay tests (optional) |

See [docs/PRODUCTION.md](./PRODUCTION.md).
