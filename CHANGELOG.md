# Changelog

All notable changes to spab. Format follows [Keep a Changelog](https://keepachangelog.com/),
versions follow [SemVer](https://semver.org/). The JavaScript reference implementation
(`src/js/spab.js`) is published on npm as [`@deftio/spab`](https://www.npmjs.com/package/@deftio/spab);
the wire format is still settling, so minor versions may change it.

## [Unreleased]

### Fixed
- **`publish.yml` never ran.** It triggered on `release: published`, but `release-on-bump.yml`
  creates the Release with the default `GITHUB_TOKEN`, and GitHub does not fire workflows from
  events raised by that token — so no release from v0.4.0 to v0.4.2 ever reached npm automatically.
  It now also triggers on the release workflow completing, guarded so a failed release cannot
  publish.

## [0.4.2] — 2026-09-04

### Added
- **`tests/noise.test.js` — a deterministic recovery matrix.** Payload sizes (1 to 59 bytes) x cover
  sizes (90 to 1800 chars) x carriers (default, ws-only, keyed, zero-width) x ECC modes x 14 damage
  models, asserting behaviour rather than pinned percentages: every combination round-trips or
  reports honestly that it did not fit, carrier-preserving damage is always recovered (176 checks),
  structural damage degrades rather than cliff-edging and improves with redundancy (50% -> 80% from
  1 to 8 copies), and no combination ever reports a payload from unmarked text (80 checks). Also
  pins the payload shapes that are supported: identifiers, JSON, Unicode, emoji, base64, text with
  spaces. Wired into `npm test`, `npm run ci`, coverage and the CI workflow.
- **The decoder reports how it read a mark.** `spab decode` prints the payload on stdout and a
  report on stderr (status, confidence, surviving channel, ECC mode, copies/packets, payload bytes,
  CRC), so piping stays clean; `--json` emits the full metadata, and a new `spab inspect` reports
  capacity, carrier sites, zero-width count and the decode result together. It states explicitly
  that the frame carries no type or encryption field rather than letting the absence read as
  "not encrypted".
- **`dev/roadmap.md`** tracking the work this release does not do: typed payloads, compact binary
  JSON (JSON -> binary -> compress -> ECC -> carriers), authenticated encryption, payloads over 255
  bytes, redundancy sizing for substitution-only encoding, keyed marks tolerating a change in
  carrier count, NFKC capacity, the whitespace width tell, and a recovery benchmark in CI.

### Found
- **Keyed marks break when text is appended.** The interleave permutation is derived from the digit
  count, so adding carriers anywhere — including a sentence at the end, which is otherwise harmless
  — descrambles to noise. Surfaced by the new matrix, documented, and tracked in the roadmap; it is
  also why resynchronisation is disabled when a key is set.

### Added
- **`autoGrow` (opt-in) and `redundancy`, for payloads a passage cannot hold.** Substitution carriers
  are bounded by the text, so a long secret in a short passage used to encode one truncated copy that
  decoded to nothing. `autoGrow: true` enables the zero-width carrier and raises its density until the
  payload fits, aiming for `redundancy` copies (default 3 — growing to a single copy would trade a
  broken mark for a fragile one). Decoding needs no flag: zero-width characters are self-evident, so
  `decode()` reads that channel whenever the text contains them.

  It is opt-in at the API, on by default in the front-page demo (so it just works whatever a visitor
  types, with the growth reported in the result), and exposed as a toggle in the Playground. Stuffing
  a large payload into a small passage is allowed — the same trade StegCloak makes — but a short
  paragraph carrying hundreds of zero-width characters is trivially visible in a hex dump, so the
  docs say plainly that it is allowed and not recommended.
- **`tests/fuzz.test.js` asserted the wrong contract.** It inferred length preservation from the
  requested `params.classes`, but that is a property of what the encoder *did*, not what was asked
  for — so any encode that legitimately added an insert carrier was reported as a failure. The
  invariants are now: visible length is never changed (universal), the visible text is identical
  when only insert carriers ran, and byte length is preserved only when `metadata.classes` shows no
  insert carrier was used. `autoGrow` and `redundancy` joined the permutation space.
- **Word-boundary detection now skips zero-width characters.** Inserting a zero-width carrier after a
  space stopped that space being seen as an inter-word gap, silently destroying the whitespace
  channel underneath it (measured: 10 sites before, 0 after). Invisible characters must not change
  what counts as a word boundary; the two carriers now coexist.

### Fixed
- **`zwsp.embed` recomputed its anchors instead of using the ones encode planned against** — a
  latent bug, present before this release. Substitution carriers run first, and `wsdense` swaps
  spaces for variants outside the whitespace class's own set, so the anchors found afterwards were
  fewer than the digit stream had been sized for. The stream was silently truncated: unkeyed
  decoding partly tolerated it, keyed decoding could not, because the descramble permutation depends
  on the digit count. `classes: ['wsdense','zwsp']` with a key never round-tripped. Substitution is
  one-for-one, so the cover's positions stay valid and are now passed through.
- **The decoder now resynchronises after an edit that adds or removes a carrier site.** Deleting a
  word usually collapses two gaps into one, removing a site and shifting the whole symbol stream;
  blocks are cut from that stream by index, so every block after the edit decoded to noise. Adding
  redundancy never helped because every copy shifted together — measured identically broken at 1x,
  2x, 4x and 11x. The packets were never destroyed, only mislocated: `parsePackets` read fixed
  32-bit slots from offset 0 and `foldParse` assumed the frame began at bit 0.

  Decoding now re-cuts the block grid at each phase (up to 32, the largest block spab produces).
  RLNC pools packets from every phase, and repetition falls back to scanning for one intact
  self-contained frame when majority folding fails — folding otherwise averages intact copies
  together with shifted noise. Phase 0 is tried first, so undamaged input decodes exactly as
  before. Windows stay 32-bit aligned: scanning every bit offset instead surfaced ~8 chance CRC8
  hits per document, and one false packet poisons the RLNC solve. Unmarked text still yields
  nothing. Resync is disabled when `params.key` is set, since the keyed interleave spans the whole
  stream and cannot be undone on a shifted one.

  Measured on the research harness (same seeded corpus, 600 docs): cut/paste at 75% kept 2% -> 17%,
  at 50% kept 0% -> 6%; word deletion at p=0.05 3% -> 6%; word insertion 3% -> 7%. Recovery still
  requires spare capacity — a passage holding exactly one copy has nothing to fall back on, which
  is why the front-page demo sample is now long enough for three.
- **`tests/coverage.js` reported covered code as uncovered.** V8 emits a coarse zero-count range in
  a process where a region was skipped and finer nested ranges where parts of it ran, so the same
  code produced different `[start,end)` keys per test file and the two could never cancel. A coarse
  zero-range from one file therefore outvoted another file that executed every statement inside it.
  Coverage is now resolved per source offset across processes. This was blocking a legitimate 100%.

### Changed
- **npm publishing uses OIDC trusted publishing — no token, no secret.** `publish.yml` declares
  `id-token: write`, and npm verifies that identity against the trusted publisher registered on the
  package, so releases upload with a provenance attestation tying the tarball to the commit and run
  that produced it. The old `NPM_TOKEN` guard (which made the job a silent no-op) is gone, and the
  job now skips cleanly when the version is already published instead of failing a re-run.

## [0.4.1] — 2026-09-04

### Added
- **Keyed scramble (opt-in): interleave + whitening.** With `params.key`, the symbol stream is
  whitened (key-derived PN added mod radix — flattens carrier statistics, hides structure) and
  interleaved by a key-derived permutation (spreads burst damage across mixed-radix blocks, obscures
  order). Right key recovers; wrong/no key fail. Both are key-derived (cryptography-flavored, not
  hidden-constant obscurity) and are a **cost multiplier, not confidentiality** — that awaits the
  planned AEAD. Identity when no key, so keyless behavior/vectors are unchanged. Wired into the
  playground as an optional "Scramble key" field.
- **Tunable block size.** `params.block` caps mixed-radix block length in sites (0 = product-cap
  only); block size and its bit width need not be powers of two, and it's an empirical knob to tune
  later. Encoder/decoder must use the same value.
- **Mixed-radix symbol layer (all carriers).** The ECC bit stream is now mapped to carrier symbols
  through one uniform modulation layer that packs bits by **blocked mixed-radix (base) conversion**,
  recovering the fractional bits a power-of-two, per-site packer discards (a radix-3 carrier now gets
  ~1.5 bits/site instead of 1.0). Packing is done in bounded blocks (radix-product ≤ 2³²) so a damaged
  symbol corrupts only its block (≤32 bits) — locality preserved, ECC unchanged. Power-of-two carriers
  are bit-identical in density but now share the one code path (no special-casing). Exposed as
  `SPAB.symbols` for introspection/conformance. *(Pre-release wire-format change.)*
- **Dense carriers.** Two new, opt-in carrier classes: **`zwsp`** (zero-width insertion — a 4-symbol
  zero-width alphabet, 2 bits/char, StegCloak/330k-style; high capacity but adds length and is
  hex-visible) and **`wsdense`** (8 whitespace variants, 3 bits/gap; length-preserving). encode/decode
  now support insert-kind carriers. Still 100% branch coverage; fuzz covers both.
- **Playground rework.** Carrier highlighting now defaults **off**; the watermarked text is an
  **editable** textarea (edit it and watch decode survive), an **encoding-method selector** (sparse /
  dense-whitespace / dense-zero-width), and an expandable **Stats & capacity** panel (cover chars,
  watermarked chars + Δ, payload/frame, capacity, bits-per-char, copies/packets, per-channel sites).
- **Base-N packer prototype** (`r_and_d/basen.js`, `npm run basen`) — zero-dep mixed-radix packing
  over heterogeneous carrier radices, recovering the fractional bits a power-of-two per-site packer
  discards (measured: +29% for a 6-symbol zero-width alphabet, +58% for 3 whitespace variants; 0% for
  pure powers of two). Round-trips 4000/4000. R&D, not yet in the shipping codec.
- **Detectability metric** in the playground Stats panel — a proxy learned from the references: for
  substitution methods, the share of spaces that are non-standard variants (a whitespace-histogram
  tell); for `zwsp`, the invisible-character ratio (found instantly in a hex view). Shown with a
  LOW/MEDIUM/HIGH badge that updates live as you edit.
- **Prior-art doc** (`r_and_d/docs/prior-art-and-tradeoffs.md`) — shout-outs to related tools
  (StegCloak, 330k, stegtext, markovTextStego, Tomato, Priyansh-15, Agarwal 2013), an
  approaches/tradeoffs map, and a discussion of open-source vs. security-by-obscurity (Kerckhoffs;
  keyed confidentiality; obscurity only as a documented cost-multiplier).
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
  JavaScript, CLI, Rust, C/C++, Python, Java/Kotlin, Swift, with a shared-API sidebar. Added a
  **GitHub** link to the site nav, a root `index.html` that redirects to `pages/`, and README
  status badges (CI, version, npm, branch coverage, license, GitHub).
- **Release on version bump** (`release-on-bump.yml`) — a push to `main` that bumps the version
  auto-tags `vX.Y.Z` and cuts the Release once CI passes; `release.yml` remains the manual-tag
  fallback. **Branch-protection setup script** (`.github/scripts/setup-branch-protection.sh`)
  applies the `main` protection documented in `RELEASING.md` via `gh`.

### Changed
- **Analytics on every page, including hash routes.** The site is a hash-routed single page, so the
  stock GoatCounter snippet only ever counted the entry URL — every visit looked like one hit on
  `/pages/`. `site.js` now counts each route change as its own view, guarded so a blocked or absent
  analytics script can never break the page.
- **Light counts under each demo box** — chars, words, non-space characters, and the carrier-site
  count on the input side. The two sides showing identical chars/words is the length-preservation
  claim demonstrated rather than asserted.
- **Corrected a false claim in the demo.** The hint read "the mark survives ordinary editing". It
  does not: deleting or inserting a word shifts every carrier position after the edit and recovery
  fails at every redundancy level measured (1x, 2x, 4x, 11x). Rewording in place does survive. The
  hint now says which is which and links to `How it works`.
- **Recover sits above the recovered secret**, between the text it reads and the value it produces.
- **Front page copy and demo reworked.** Headline is now "Mark a document without changing how it
  reads" — the previous one said "Invisibly", and the tagline claimed *robust* text watermarking,
  which the measurements do not yet establish; the site now says "watermark plain text". Second
  person is gone from the headline, section copy and field labels. The version beside the wordmark
  is read from `SPAB.VERSION` at runtime, so it cannot drift from the package. Nav type enlarged.
- **Home page loses two sections of filler.** "Robustness by construction" (a feature grid whose
  copy restated the hero) and "The idea / In one line" are replaced by one prose section, *About Text
  Watermarks*: what a watermark answers, why plain text is hard to mark, what it is
  actually useful for, and an explicit statement that it is not encryption. It ends with links to
  How it works, the Playground, and Libraries rather than another call to action.
- **Contrast raised** across secondary text and box edges — several muted values were dialled far
  enough down that labels and body copy read as disabled rather than secondary, and cards and form
  fields sat on a near-white surface with a near-white border.
- **The two demo panels mirror each other** — title, text box, single-value box, actions, note — so
  they are the same size by default (cards 590/590, text boxes 231/231, secret and recovered both
  41px). Equal card height is safe here precisely because the contents are mirrored; the earlier
  pair held very different amounts and had to size to content to avoid a void.
- **The try-it demo is two stages instead of two separate tools:** original + secret on the left,
  watermarked + recovered on the right. The watermarked box is editable and is the same field
  recovery reads from, so the text can be mangled in place and recovered again — surviving ordinary
  editing is the claim, and nothing previously invited anyone to test it. This also removes the
  copy-from-one-card-into-another step that existed only to serve the old layout.
- **Both demo panes are monospace, and the whitespace tell is now documented.** The whitespace
  carrier substitutes narrower variants (thin, hair, six-per-em), so in a proportional face a marked
  paragraph sets ~3% narrower than its source (measured: -3.26% system-ui, -2.13% Georgia, 0.00%
  ui-monospace). Displayed side by side in a proportional font, the demo visibly contradicted the
  claim next to it. Monospace normalizes the advances, and `How it works` now states the caveat
  outright rather than leaving a reader to notice it.
- **npm package is ready to publish as `@deftio/spab`.** `spab` itself is permanently unavailable on
  npm — it was unpublished in 2021 and npm retires unpublished names — so the scope is the way to
  keep one name across registries (`spab` is still free on PyPI and crates.io, and the `bin` stays
  `spab` either way). Packaging fixes: ship `LICENSE` (the tarball previously claimed BSD-2-Clause
  with no license text), replace the 672-byte contributor note that npm would have rendered as the
  package page with a real README, and add `repository`/`homepage`/`bugs` (the package had no links
  at all) plus `publishConfig.access: public` so a scoped `npm publish` works without a flag.
- **CLI help advertised a carrier class that does not exist.** Usage showed `--classes ws,punct`;
  the real ids are `ws`, `apos`, `hyphen`, `wsdense`, `zwsp`. Corrected, and the full set is now
  listed. Note that unknown class names are still accepted and silently ignored rather than
  rejected — worth tightening separately.
- **Home page fold tightened, hero gradient back to the brand pair.** The hero ramped through a
  single hue and read as a flat band; it now runs ink blue to the warm accent. Hero height went
  403px to 292px (padding, headline scale, section rhythm), so the try-it panel and both its cards
  are above the fold at 1320x860. Hero buttons are pinned light-on-dark in the theme-independent
  rules — the hero is a dark gradient in both themes, but the button variants flipped with the
  theme, leaving near-black text on the gradient in dark mode.
- **Site chrome is shared, and the site is themed rather than hand-styled.** `pages/site.js` now owns
  the design tokens, header/nav, theme toggle, footer, and router for every page; a page supplies only
  its routes and views, so no page can drift from the others. The look is derived by `bw.loadStyles()`
  from one token object (seed colors, radius, elevation, spacing, type scale) instead of a hand-written
  stylesheet, and light/dark comes from the generated alternate palette via `bw.setThemeMode()` — the
  shell CSS is emitted twice, once per palette, so the page furniture themes with the components.
  Navigation uses `bw.router()` + `bw.link()` (real history, deep links, working middle-click) in place
  of a `hashchange` listener and an if/else chain, and the nav tracks its own active state by
  subscribing to `bw:route`. Views are built from real components — `makeHero`, `makeFeatureGrid`,
  `makeStatCard`, `makeCTA`, `makeAccordion`, `makeCard`, `makeFormGroup`, `makeInput`/`makeSelect`/
  `makeTextarea` — rather than hand-assembled `div` trees, plus a gradient hero and an install strip
  in the style of the bitwrench sites.
- **Fixed: every form control on the playground was unstyled.** The page hardcoded 1.x-era class
  names (`bw_form_control`, `bw_badge`) while loading `bitwrench@2` from the CDN. Those classes are
  BCCL-prefixed in 2.x and have no rules at all, so the inputs, selects and badges had been rendering
  as bare browser defaults — the labels sat on top of their own fields and the metadata lines ran
  together as one string. Building them with the `make*()` factories fixes it and keeps it fixed.
- **Branching & merging etiquette** documented in `CONTRIBUTING.md` (trunk-based, `type/desc`
  branches, Conventional Commits, squash-merge to linear history, PR + green CI), with a
  `.github/pull_request_template.md`. Releases are a version-bump PR to `main` (auto-cut), not manual
  tags.
- **Branch-protection script is solo-safe:** defaults to **0 required approvals** (GitHub blocks
  self-approval, so a solo maintainer self-merges on green CI) with `REQUIRED_APPROVALS`/
  `ENFORCE_ADMINS` overrides for teams; documented in `RELEASING.md`.
- CI runs fuzz + coverage as report-only steps (measure now, gate later); adds the branch-test suite
  to the blocking run; adds the lint gate as the first blocking step.
- Small behavior-preserving simplifications in `spab.js` (removed provably-dead capacity guards).
- **Dependency review is now quarterly.** Replaced the Dependabot config (whose minimum cadence is
  monthly) with `deps-quarterly.yml` + a zero-dep checker (`.github/scripts/check-action-versions.mjs`)
  that runs on the 1st of each quarter, compares pinned GitHub Actions against their latest releases,
  and opens a tracking issue only when something is behind. spab has zero package dependencies, so
  action pins are the only thing that drifts.
- **GitHub Actions pins bumped to v7** across all five workflows: `actions/checkout@v4`→`@v7`,
  `actions/setup-node@v4`→`@v7`, `actions/setup-python@v5`→`@v7` (final Dependabot PR, merged; the
  quarterly checker now reports all pins current).
- **Scripted release pipeline (`npm run release`).** `tools/start-release.js` opens a release cycle
  (bump all three version surfaces, promote `[Unreleased]` to a dated section, branch
  `release/vX.Y.Z`); `tools/release.js` runs every gate — lint, conformance + branch tests, smokes,
  fuzz, and strict coverage, the last two blocking locally though still report-only in CI — then
  pushes the branch, opens the PR, and arms auto-merge. It never pushes to `main` and never merges:
  branch protection and CI stay the authority, and the script only front-loads the failures.
  `npm run release:dry` rehearses the whole thing with zero mutations.
- **Identity gate before anything mutates (`npm run whoami`).** More than one GitHub account can be
  authenticated at once and `gh` has a single active one, so a stale switch silently opens PRs under
  the wrong name. `tools/gh-identity.js` asserts the `gh` account, the git commit identity, and the
  SSH key GitHub sees all resolve to the maintainer, and bails with the exact fix command otherwise.
- **Branch protection applied to `main`** (it was documented but never enabled): PR required with 0
  approvals, the four CI checks required and branches kept up to date, force-pushes and deletions
  blocked, admins included, squash-only merging, auto-merge on. See `RELEASING.md`.
- **CI version check now covers all three version surfaces.** `ci.yml` compared only `spab.js` to
  `src/js/package.json`, so a PR that missed the root `package.json` passed every required check and
  failed later at release time with `main` already inconsistent.
- **`.nojekyll`** at the repo root — Pages serves from `main` with the legacy Jekyll build, which
  silently drops underscore-prefixed paths (`src/python/spab/__init__.py`).
- **`npm run release` rescues commits stranded on `main`.** Committing on `main` is an easy mistake
  and, with branch protection on, a dead end — the push is rejected and the work sits there. The
  script now detects commits on `main` that are not on `origin/main`, offers to move them to a branch
  named from the newest commit's subject, and carries on into the normal PR flow. The branch is
  created before `main` is reset, so an interruption cannot lose the commits, and `--dry-run`
  describes the move without performing it.
- **Commit-message hygiene gate.** A conversation/session identifier in a commit message is
  permanent once pushed — the object stays fetchable by SHA, the PR timeline keeps the record, and a
  revert adds a commit rather than removing one. `tools/release.js` now refuses to push when the
  branch's commits contain one (the last moment `--amend` still works), and a `commit hygiene` CI job
  backstops commits that arrive any other way.

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
