#!/usr/bin/env node
/**
 * Apply recommended branch protection to main (requires repo admin + gh auth).
 * See docs/BRANCH_PROTECTION.md.
 *
 * Usage: node scripts/apply-branch-protection.mjs [owner/repo]
 */
import { spawnSync } from "node:child_process";

const repo = process.argv[2] || process.env.GITHUB_REPOSITORY || "hondoentertainment/SiskelBot";

const payload = {
  required_status_checks: {
    strict: true,
    contexts: [
      "lint",
      "test",
      "Trivy filesystem scan",
      "smoke",
      "e2e",
      "regression",
      "agent-regression",
    ],
  },
  enforce_admins: false,
  required_pull_request_reviews: {
    required_approving_review_count: 1,
  },
  restrictions: null,
};

console.log(`Applying branch protection to ${repo}@main …`);
console.log(JSON.stringify(payload, null, 2));

const r = spawnSync(
  "gh",
  ["api", `repos/${repo}/branches/main/protection`, "--method", "PUT", "--input", "-"],
  { input: JSON.stringify(payload), encoding: "utf8" }
);

if (r.status !== 0) {
  console.error(r.stderr || r.stdout);
  console.error("\nIf gh lacks admin rights, apply manually via GitHub Settings → Branches.");
  process.exit(r.status || 1);
}

console.log("Branch protection applied.");
