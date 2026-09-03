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

Two npm commands. The first opens a release cycle, the second runs every gate and opens the PR;
CI and branch protection do the rest.

```bash
npm run start-release -- minor      # bump 0.4.0 -> 0.5.0, promote CHANGELOG, branch release/v0.5.0
# review the CHANGELOG section — it becomes the GitHub Release notes verbatim
npm run release                     # all gates, push, open PR, arm auto-merge
```

That is the whole release. Auto-merge lands the PR the moment the four required checks go green,
`release-on-bump.yml` then tags `v0.5.0` at the merged commit and cuts the Release from the
CHANGELOG section, and `publish.yml` packages (and publishes, once tokens are set).

**`npm run start-release -- <patch|minor|major>`** — you pick the level; the script never chooses a
version. It refuses unless you are on a clean `main` in sync with `origin`, then writes the new
version to all three surfaces, rewrites `## [Unreleased]` as `## [x.y.z] — <today>` with a fresh
empty Unreleased above it, and commits that on `release/vX.Y.Z`. Nothing is pushed.

**`npm run release`** — runs, in order: the identity check, preflight (not on `main`, clean tree,
version surfaces agree), the release-only gates when the branch bumps the version (CHANGELOG section
exists and is non-empty, tag free, version not already on npm), then **every** gate — `npm run ci`
(lint, conformance + branch tests, smokes), `npm run fuzz`, and `npm run coverage:strict`. Only then
does it push the branch, open the PR, and enable auto-merge.

Fuzz and coverage are **blocking here but report-only in `ci.yml`**. Locally they are fast and
deterministic, so there is no reason to let a regression through; in CI they stay advisory until
they have proven stable across the matrix.

The script **cannot** push to `main` or merge anything — branch protection forbids both, admins
included. It front-loads the failures; GitHub remains the authority.

```bash
npm run release:dry             # every gate, zero mutations — rehearse anything
npm run release -- --no-auto    # open the PR but leave the merge to you
npm run release -- --help       # full flag reference
```

### Ordinary changes vs releases

A version bump *is* the release trigger, so it gets its own branch and PR:

| branch | contains | merging it |
|---|---|---|
| `feat/…` `fix/…` `ci/…` `docs/…` | ordinary work, **never** a version change | changes nothing about releases |
| `release/vX.Y.Z` | the bump + CHANGELOG promotion, nothing else | ships that version |

`npm run release` works on both. It detects whether the branch changes the version relative to
`origin/main` and only applies the release-only gates when it does.

### Identity check

More than one GitHub account can be authenticated on a dev machine, and `gh` has a single *active*
one that is easy to leave switched after working elsewhere. Every mutating step — push, PR, merge —
inherits it silently, so the failure is not an error but a PR opened under the wrong name.

Both release scripts therefore start by asserting that all three identities resolve to the
maintainer, and bail with the exact fix command if any has drifted:

| identity | why it matters | probe |
|---|---|---|
| `gh` active account | who opens the PR and drives the merge | `gh api user` |
| git `user.name` / `user.email` | who the commits are attributed to | `git config --get` |
| SSH key GitHub sees | who the push authenticates as | `ssh -T git@github.com` |

These drift independently: `gh auth switch` does not touch git config, and neither touches which key
ssh-agent offers. Check any time with `npm run whoami`. The maintainer is named once, in
`tools/gh-identity.js`. `SPAB_SKIP_IDENTITY=1` bypasses it (loudly).

### Manual fallback

Release an arbitrary commit by hand-pushing a tag:

```bash
git tag -a v0.4.0 -m "spab 0.4.0" && git push origin v0.4.0   # triggers release.yml
```

Tags are the record of what shipped; the version bump is the *only* thing a release changes in
source, so a release PR is small and easy to review.

## Branch protection (applied)

CI can *prove* a commit is good, but only branch protection can *require* that proof before merge.
**This is live on `main` as of 2026-09-02** — applied with the script below, with signed commits off
and `enforce_admins` on:

| rule | setting |
|---|---|
| Pull request required | yes — **0 approvals** (GitHub forbids self-approval, so a solo maintainer self-merges) |
| Required checks | `test (node 18)`, `test (node 20)`, `test (node 22)`, `version consistency` |
| Branch up to date before merge | yes (`strict`) |
| Conversation resolution | required |
| Force pushes / deletions | blocked |
| Applies to admins | **yes** — the owner obeys the same rules |
| Merge methods | **squash only** (rebase and merge-commit disabled repo-wide) |
| Auto-merge | enabled — `npm run release` arms it |
| Signed commits | off |

Because `enforce_admins` is on, `git push origin main` is rejected for the maintainer too. That is
the point: the escape hatch is flipping the setting in Settings -> Branches, which is deliberate and
visible rather than accidental. `release-on-bump.yml` is unaffected — it pushes a *tag*, never a
commit to `main`.

**Re-apply or change it with the script** (needs `gh` authenticated with admin on the repo):

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
