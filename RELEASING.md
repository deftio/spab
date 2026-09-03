# Releasing spab

spab uses **release-on-version-bump** with **protected branches**. CI proves a build is good on
every push; when a push to `main` bumps the version and CI passes, the release is cut automatically.
You control the version number — the workflow never invents one. The workflows:

- **`.github/workflows/ci.yml`** — runs on every push and PR (Node 18/20/22): lint gate, conformance
  + branch tests, harness + symbol-survival smokes, report-only fuzz + coverage, and a
  **version-consistency** check (`spab.js` `VERSION` == `src/js/package.json` == root `package.json`).
- **`.github/workflows/release-on-bump.yml`** — the primary path. Runs after **CI succeeds on
  `main`**; if `package.json`'s version has no matching tag yet, it creates `vX.Y.Z` at the tested
  commit and cuts the GitHub Release from the matching `CHANGELOG.md` section. Ordinary pushes that
  don't change the version do nothing.
- **`.github/workflows/release.yml`** — the manual fallback. Runs only on a hand-pushed `v*` tag,
  re-verifies tag == version + tests, then creates the Release. Use it to release from a specific
  commit. (The two never collide: bump-releases tag via the Actions token, which by design does not
  re-trigger the tag workflow.)
- **`.github/workflows/publish.yml`** — runs when a Release is published. **Inert until credentials
  are added:** each ecosystem job does a credential-free package check (proving publishability) and
  publishes for real only when its token secret is set. Add `NPM_TOKEN` (npm, `@deftio/spab`) and
  `PYPI_TOKEN` (PyPI) as repo secrets to go live; crates.io / Maven follow when those ports land.

## Cutting a release (normal path)

1. **Bump the version in all three places** (CI enforces they agree):
   - `src/js/spab.js` → `VERSION`
   - `src/js/package.json` → `version`
   - `package.json` (root) → `version`
2. **Add a `CHANGELOG.md` section** — `## [x.y.z] — YYYY-MM` (extracted verbatim for the release
   notes; a matching section is how the notes get populated).
3. **Open a PR, get CI green, merge to `main`.** Direct pushes to `main` are blocked (below).
4. **That's it.** When CI passes on `main` and the version is new, `release-on-bump` tags `vX.Y.Z`
   at the merged commit and publishes the GitHub Release. No new version ⇒ no release.

Manual fallback (release an arbitrary commit):

```bash
git tag -a v0.4.0 -m "spab 0.4.0" && git push origin v0.4.0   # triggers release.yml
```

Tags are the record of what shipped; the version bump is the *only* thing a release changes in
source, so a release PR is small and easy to review.

## Branch protection (set once)

CI can *prove* a commit is good, but only branch protection can *require* that proof before merge.
**Apply it with the script** (needs `gh` authenticated with admin on the repo):

```bash
.github/scripts/setup-branch-protection.sh              # current repo, main — SOLO default (0 approvals)
REQUIRED_APPROVALS=1 .github/scripts/setup-branch-protection.sh   # team: require 1 review
ENFORCE_ADMINS=false .github/scripts/setup-branch-protection.sh   # keep an owner escape hatch
```

**Solo maintainer (current):** GitHub does **not** let you approve your own PR, so a required-approval
count of 1 would lock you out of merging your own work. The script therefore defaults to **0 required
approvals** — a PR and green status checks are still required, you just self-merge once CI is green.
Re-run with `REQUIRED_APPROVALS=1` when a second maintainer joins.

It sets exactly the rule below. To configure by hand instead (GitHub → Settings → Branches → Add
rule on **`main`**):

- **Require a pull request before merging** (no direct pushes to `main`). Required approvals: **0**
  for a solo maintainer (self-merge), **1+** for a team; **dismiss stale approvals** on new commits.
- **Require status checks to pass before merging**, and **require branches to be up to date**.
  Select these checks (the job names from `ci.yml`):
  - `test (node 18)`, `test (node 20)`, `test (node 22)`
  - `version consistency`
- **Require conversation resolution before merging.**
- **Require signed commits** (recommended).
- **Do not allow force pushes** and **do not allow deletions** on `main`.
- **Include administrators** so the owner obeys the same rules (max discipline). Flip it off only if
  you want an emergency bypass. This does **not** affect releases: `release-on-bump.yml` creates a
  tag + Release and never pushes a commit to `main`, so branch protection doesn't block it.

Optionally protect tags as well (Settings → Tags → protected tag pattern `v*`) so only maintainers
can create release tags.

> Branch/tag protection is a repository *setting*, not code — it can't live in the repo. This file
> is the source of truth for how it should be configured; keep it in sync if the CI job names change.
