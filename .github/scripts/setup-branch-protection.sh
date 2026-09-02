#!/usr/bin/env bash
#
# setup-branch-protection.sh — apply spab's branch protection to `main` via the
# GitHub API. Branch protection is a repo SETTING (it can't live in the repo), so
# this script is the executable form of the rules documented in RELEASING.md.
#
# Requires the GitHub CLI (`gh`) authenticated with admin rights on the repo.
#
#   .github/scripts/setup-branch-protection.sh            # uses the current repo
#   .github/scripts/setup-branch-protection.sh owner/repo # explicit repo
#   BRANCH=main .github/scripts/setup-branch-protection.sh
#
# Solo vs. team (IMPORTANT):
#   GitHub does NOT let you approve your own PR, so a required-approval count of 1
#   would BLOCK a solo maintainer from ever merging. Default here is 0 approvals —
#   a PR and green status checks are still required, you just self-merge. When a
#   second maintainer joins, re-run with REQUIRED_APPROVALS=1.
#
#   REQUIRED_APPROVALS=0   # 0 = solo (self-merge on green CI); 1+ = team review
#   ENFORCE_ADMINS=true    # true = owner obeys the rules too (no bypass); false = escape hatch
#   REQUIRE_SIGNATURES=1   # 1 = require signed commits on the branch
#
set -euo pipefail

# Resolve owner/repo: explicit arg, else infer from the current repo's git remote.
REPO="${1:-}"
if [ -z "$REPO" ]; then
  REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
fi
BRANCH="${BRANCH:-main}"
REQUIRED_APPROVALS="${REQUIRED_APPROVALS:-0}"
ENFORCE_ADMINS="${ENFORCE_ADMINS:-true}"

# Fail early with guidance rather than firing a malformed request.
if ! printf '%s' "$REPO" | grep -Eq '^[^/[:space:]]+/[^/[:space:]]+$'; then
  echo "ERROR: could not determine the GitHub repo (got: '${REPO:-<empty>}')." >&2
  echo "Pass it explicitly, e.g.:  .github/scripts/setup-branch-protection.sh deftio/spab" >&2
  echo "And make sure: (1) you're authenticated  ->  gh auth status" >&2
  echo "               (2) the repo EXISTS on GitHub and 'main' is pushed  ->  gh repo view deftio/spab" >&2
  exit 1
fi

# Confirm the repo is reachable before attempting to set protection.
if ! gh repo view "$REPO" >/dev/null 2>&1; then
  echo "ERROR: '$REPO' not found or not accessible with your gh auth." >&2
  echo "Create/push it first (git push -u origin main), then re-run." >&2
  exit 1
fi

echo "Applying branch protection to ${REPO}@${BRANCH}"
echo "  approvals=${REQUIRED_APPROVALS}  enforce_admins=${ENFORCE_ADMINS}  (solo default: 0 approvals, self-merge on green CI)"

# Required status checks are the CI job names as they appear as checks:
#   ci.yml -> job `test`  name: "test (node <ver>)"  (one per matrix entry)
#   ci.yml -> job `version-consistency` name: "version consistency"
# (Lint/fuzz/coverage run inside the test job; keep this list to the top-level checks.)
set +e
gh api --method PUT "repos/${REPO}/branches/${BRANCH}/protection" \
  --header "Accept: application/vnd.github+json" \
  --input - <<JSON
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "test (node 18)",
      "test (node 20)",
      "test (node 22)",
      "version consistency"
    ]
  },
  "enforce_admins": ${ENFORCE_ADMINS},
  "required_pull_request_reviews": {
    "required_approving_review_count": ${REQUIRED_APPROVALS},
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false
  },
  "required_conversation_resolution": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "restrictions": null
}
JSON
STATUS=$?
set -e
if [ $STATUS -ne 0 ]; then
  echo "" >&2
  echo "Branch protection call failed. The most common cause of a 404 on a repo that DOES exist:" >&2
  echo "  • classic branch protection needs a paid plan for PRIVATE repos." >&2
  echo "    Fixes: make the repo public, OR use a repository RULESET (free on private too):" >&2
  echo "    gh api --method POST repos/${REPO}/rulesets --input - <<'RS'" >&2
  echo '    { "name":"main","target":"branch","enforcement":"active",' >&2
  echo '      "conditions":{"ref_name":{"include":["refs/heads/main"],"exclude":[]}},' >&2
  echo '      "rules":[{"type":"pull_request","parameters":{"required_approving_review_count":0,"dismiss_stale_reviews_on_push":true,"require_code_owner_review":false,"require_last_push_approval":false,"required_review_thread_resolution":true}},' >&2
  echo '               {"type":"non_fast_forward"},{"type":"deletion"},' >&2
  echo '               {"type":"required_status_checks","parameters":{"strict_required_status_checks_policy":true,"required_status_checks":[{"context":"test (node 18)"},{"context":"test (node 20)"},{"context":"test (node 22)"},{"context":"version consistency"}]}}] }' >&2
  echo "    RS" >&2
  echo "  • or the branch 'main' has not been pushed yet (push at least one commit first)." >&2
  exit $STATUS
fi

# Recommended (optional): require signed commits.
if [ "${REQUIRE_SIGNATURES:-1}" = "1" ]; then
  gh api --method POST "repos/${REPO}/branches/${BRANCH}/protection/required_signatures" \
    --header "Accept: application/vnd.github+json" >/dev/null && echo "  signed commits: required"
fi

echo "Done. Verify under Settings → Branches on ${REPO}."
echo "Notes:"
echo "  • A PR is still required — you just merge your own once CI is green (0 approvals)."
echo "  • release-on-bump.yml only creates tags/releases (never pushes to ${BRANCH}), so it isn't blocked."
echo "  • Protect release tags too — Settings → Tags → new rule, pattern 'v*'."
echo "  • Team later? re-run with REQUIRED_APPROVALS=1."
