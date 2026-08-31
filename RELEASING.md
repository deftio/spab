# Releasing spab

spab uses **tag-driven releases** with **protected branches**. CI proves a build is good on
every push; a semver tag turns a proven commit into a published GitHub Release. The two workflows:

- **`.github/workflows/ci.yml`** — runs on every push and PR (Node 18/20/22): syntax check,
  conformance tests, harness + symbol-survival smokes, and a **version-consistency** check
  (`spab.js` `VERSION` == `src/js/package.json` == root `package.json`).
- **`.github/workflows/release.yml`** — runs only on a pushed `v*` tag. It re-verifies the tag
  matches all three source versions and that tests pass, then creates the GitHub Release with the
  matching `CHANGELOG.md` section as its notes.
- **`.github/workflows/publish.yml`** — runs when a Release is published. **Inert until credentials
  are added:** each ecosystem job does a credential-free package check (proving publishability) and
  publishes for real only when its token secret is set. Add `NPM_TOKEN` (npm, `@deftio/spab`) and
  `PYPI_TOKEN` (PyPI) as repo secrets to go live; crates.io / Maven follow when those ports land.

## Cutting a release

1. **Bump the version in all three places** (CI enforces they agree):
   - `src/js/spab.js` → `VERSION`
   - `src/js/package.json` → `version`
   - `package.json` (root) → `version`
2. **Add a `CHANGELOG.md` section** — `## [x.y.z] — YYYY-MM` (the release workflow extracts this
   block verbatim for the release notes).
3. **Open a PR, get CI green, merge to `main`.** Direct pushes to `main` are blocked (below).
4. **Tag the merge commit and push the tag:**
   ```bash
   git checkout main && git pull
   git tag -a v0.4.0 -m "spab 0.4.0"
   git push origin v0.4.0
   ```
5. The **Release** workflow verifies `tag == version`, runs tests, and publishes the GitHub Release.
   A tag whose number doesn't match the source, or whose tests fail, **does not** produce a release.

Tags are the record of what shipped; the version bump is the *only* thing a release changes in
source, so a release PR is small and easy to review.

## Branch protection (set once, in repo Settings → Branches)

CI can *prove* a commit is good, but only branch protection can *require* that proof before merge.
Configure a protection rule on **`main`** (GitHub → Settings → Branches → Add rule), matching what
the workflows above assume:

- **Require a pull request before merging** (no direct pushes to `main`) — at least **1 approval**,
  and **dismiss stale approvals** on new commits.
- **Require status checks to pass before merging**, and **require branches to be up to date**.
  Select these checks (the job names from `ci.yml`):
  - `test (node 18)`, `test (node 20)`, `test (node 22)`
  - `version consistency`
- **Require conversation resolution before merging.**
- **Require signed commits** (recommended).
- **Do not allow force pushes** and **do not allow deletions** on `main`.
- Apply the rule to administrators too (**Include administrators**), so releases always go through CI.

Optionally protect tags as well (Settings → Tags → protected tag pattern `v*`) so only maintainers
can create release tags.

> Branch/tag protection is a repository *setting*, not code — it can't live in the repo. This file
> is the source of truth for how it should be configured; keep it in sync if the CI job names change.
