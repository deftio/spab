# Changelog

All notable changes to spab. Format follows [Keep a Changelog](https://keepachangelog.com/),
versions follow [SemVer](https://semver.org/). **Pre-release / not yet published** — versions below
are development milestones of the JavaScript reference implementation (`src/js/spab.js`).

## [Unreleased]

### Added
- **Lint gate (`tests/lint.js`).** Zero-dependency, blocking — **any finding fails the build**
  (warnings are errors). Enforces `.editorconfig` across all source (UTF-8/no BOM, LF, final
  newline, no trailing whitespace, space indent), `node --check` on every `.js` and on the inline
  `<script>` in `pages/*.html`, and library rules for `src/js/spab.js` (strict, no `console.*`, no
  TODO/FIXME). Native port linters (clippy/ruff/clang-tidy, warnings-as-errors) run when their
  toolchain is present. New script: `npm run lint`; added first in `npm run ci` and CI.
  - Caught and fixed a real bug: a literal `</script>` inside an inline JS string in
    `pages/index.html` (would prematurely close the tag in a browser) — now escaped `<\/script>`.
- **Test hygiene.** Deterministic property-based **fuzzing** (`tests/fuzz.test.js`) checking
  round-trip, no-false-positive, and never-throws invariants; a **zero-dependency coverage tool**
  (`tests/coverage.js`) built on V8's `NODE_V8_COVERAGE` (no c8/istanbul), and targeted branch
  tests (`tests/branches.test.js`) bringing `src/js/spab.js` to **100% branch coverage**. Genuinely
  unreachable defensive branches are annotated `// cov-ignore: <reason>`. New scripts: `npm run
  fuzz`, `npm run coverage`, `npm run coverage:strict`.
- **Release/publish workflows.** Tag-driven GitHub releases (`release.yml`, verifies tag == version
  + tests) and inert-until-credentialed npm/PyPI publish stubs (`publish.yml`, gated on
  `NPM_TOKEN`/`PYPI_TOKEN`). Branch-protection rules documented in `RELEASING.md`.
- **Pages: per-language integration page** — sticky TOC + anchored install/usage sections for
  JavaScript, CLI, Rust, C/C++, Python, Java/Kotlin, Swift, with a shared-API sidebar.

### Changed
- CI runs fuzz + coverage as report-only steps (measure now, gate later); adds the branch-test suite
  to the blocking run; adds the lint gate as the first blocking step.
- Small behavior-preserving simplifications in `spab.js` (removed provably-dead capacity guards).
- **Dependency review is now quarterly.** Replaced the Dependabot config (whose minimum cadence is
  monthly) with `deps-quarterly.yml` + a zero-dep checker (`.github/scripts/check-action-versions.mjs`)
  that runs on the 1st of each quarter, compares pinned GitHub Actions against their latest releases,
  and opens a tracking issue only when something is behind. spab has zero package dependencies, so
  action pins are the only thing that drifts.

### Removed
- `.github/dependabot.yml` (superseded by the quarterly workflow above).

## [0.4.0] — 2026-08

### Added
- **RLNC fountain ECC** (`ecc: 'rlnc'`): a from-scratch, dependency-free GF(256) systematic
  random-linear fountain. Payload is carried as self-checking (CRC) and self-locating (ESI) 32-bit
  packets that **pool across all carrier channels**, so surviving carriers reconstruct any K —
  e.g. NFKC kills whitespace but the confusable-channel packets rebuild the payload.
- **bitwrench GUI** (`pages/index.html`): runs the library in the browser — encode, pick carrier
  classes and ECC, apply channel attacks with sliders, and watch it decode live. Also the GitHub
  Pages target. `npm run gui` serves it on **port 1948** (year of Shannon's *A Mathematical Theory
  of Communication*).
- Harness `--ecc rlnc` flag (logged in run provenance); Swift port skeleton (`src/swift/`);
  Dependabot config (github-actions only, monthly/grouped); `CONTRIBUTING.md`; this changelog.

### Notes
- Honest finding: RLNC matches repetition on channel-kill attacks (NFKC/strip) and is slightly
  behind on dense bit-noise, where repetition's bit-majority wins — the CRC-per-packet-vs-FEC
  tradeoff. Repetition remains the default.

## [0.3.0] — 2026-08

### Changed
- **Carrier default is now whitespace + confusables, co-equal** (parallel channels), decided from
  data: NFKC normalization collapses *every* whitespace variant to a plain space, while the
  confusables (`'`↔`'`, `-`↔`‐`) survive NFKC. Orthogonal failure modes.

### Added
- Harness channels **`nfkc`** and **`smartQuotes`** — the transforms that separate the carriers.
- **Symbol-survival experiment** (`r_and_d/symbol-survival.js`): raw per-carrier channel
  characterization (random symbols, no ECC).
- Library hygiene: GitHub Actions CI (Node 18/20/22), root `package.json` scripts, `.editorconfig`,
  version-consistency check; `LICENSE` (BSD-2-Clause); npm package scoped as `@deftio/spab` with a
  `spab` bin (bare `spab` is a reserved/unpublished name on npm).

### Removed
- Ellipsis and non-breaking-hyphen carriers (NFKC-fragile).

## [0.2.0] — 2026-08

### Added
- **Pluggable symbol library** with **confusables** (apostrophe, hyphen) as independent parallel
  per-class channels: each class carries the whole payload; decode returns the best-surviving
  channel, so a whitespace-only strip no longer defeats the mark.

## [0.1.0] — 2026-08

### Added
- Baseline codec: 2 bits per inter-word space over 4 whitespace variants, repetition + majority-vote
  ECC, `[magic 0xA5][len][content][crc8]` frame; `encode`/`decode` with confidence metadata.
- Research/tooling: robustness harness with a channel-noise model (normalize, blockErasure,
  cutPaste, truncate, word delete/insert, reflow, regexAttack, fullStrip); corpora (deterministic
  generator, directory loader, license-free curated downloader); run provenance (JSONL + SQLite);
  payload profiles (`--profile-bench`, `--by-size`); CLI (`cli/spabdemo.js`); first visualizer.
