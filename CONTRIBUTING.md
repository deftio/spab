# Contributing to spab

Thanks for your interest. spab is a small, dependency-free text-watermarking library with a strong
emphasis on being explainable, portable, and measured. A few principles keep it that way — please
read these before opening a PR.

## Hard invariants (non-negotiable)

1. **Zero third-party dependencies in the shipped library.** The codec, GF/ECC math, PN/LFSR,
   hash/KDF, and (planned) cipher are all hand-implemented. `src/js/package.json` has empty
   `dependencies` **and** `devDependencies`, and it stays that way. Tooling (e.g. bitwrench for the
   GUI) is fetched on demand via `npx`, never added to the dependency list.
2. **Deterministic at runtime.** Same input + params → same output, on every platform and language
   port. No locale-, float-, or platform-dependent behavior in the codec path.
3. **Classic DSP, not gen-AI.** Modulation / demodulation / sync / FEC. ML may *tune parameters*
   offline (producing a fixed config); nothing learned runs at decode time.
4. **Portable wire format.** All language ports implement the same format and validate against the
   same shared conformance vectors (bit-for-bit interop).
5. **Honesty in docs.** Never claim adversarial robustness; spab targets *incidental* robustness.
   Report `not-detected` cleanly rather than inventing a payload.

## Repo layout

- `src/js/` — the reference implementation (what ships). `src/<lang>/` — other ports (skeletons).
- `cli/` — command-line tool. `tests/` — CI conformance tests. `pages/` — bitwrench GUI (also GitHub Pages).
- `r_and_d/` — research & iteration (harness, corpora, provenance, design docs). **Not shipped.**
- `docs/` — user-facing docs.

## Dev setup

No install needed — Node ≥ 18, zero deps.

```bash
npm run lint        # zero-dep lint gate — fails on ANY finding (tests/lint.js)
npm test            # conformance + branch tests (tests/roundtrip.test.js, tests/branches.test.js)
npm run fuzz        # property-based fuzzing (deterministic; tests/fuzz.test.js)
npm run coverage    # branch/function/line coverage of src/js/spab.js (zero-dep, V8)
npm run coverage:strict   # same, but exit 1 if below thresholds (branches 100%)
npm run ci          # what CI gates on today: lint + conformance + branch tests + smokes
npm run bench       # robustness benchmark
npm run survival    # raw per-carrier channel-survival experiment
npm run gui         # serve the GUI on http://localhost:1948/pages/index.html (fetches bwcli via npx)
```

### Linting

`tests/lint.js` is a **blocking gate** — any finding fails the build (warnings are
errors). Like the coverage tool, it's **zero-dependency** (no ESLint/Prettier): it
enforces the repo's `.editorconfig` across every source file (UTF-8/no BOM, LF endings,
final newline, no trailing whitespace, space indentation), parses every `.js` (and the
inline `<script>` in `pages/*.html`) with `node --check`, and holds the shipping library
(`src/js/spab.js`) to library rules (strict mode, no `console.*`, no leftover TODO/FIXME).
Port linters (`cargo clippy -D warnings`, `ruff`, `clang-tidy`) run with
warnings-as-errors **when their toolchain is installed and the port has real code** —
skipped, never failed, while a port is still a skeleton.

### Coverage & fuzzing

Coverage uses V8's built-in coverage (`NODE_V8_COVERAGE`) parsed by `tests/coverage.js`
— **no c8/istanbul**, in keeping with the zero-dep invariant. The shipping library
(`src/js/spab.js`) is held at **100% branch coverage**. A few genuinely-unreachable
defensive branches (browser-global path, the non-fatal-`TextDecoder` catch blocks, the
GF(256) rank-deficiency guards that distinct-ESI packets can't trigger) are annotated
inline with `// cov-ignore: <reason>`; the coverage tool excludes only those, and only
when they are actually uncovered, so a marker can never hide a branch that really runs.
New or changed codec branches must be covered (or, if provably dead, annotated with a
reason). Fuzzing is deterministic — a failure prints the exact `--seed`/`--iterations`
to replay. Both run in CI today as **report-only** steps and will flip to blocking once
stable (drop `continue-on-error` in `ci.yml`; use `coverage:strict`).

## Making changes

- **Tests are required.** Extend `tests/roundtrip.test.js` (or add a test) for any behavior change.
  CI must be green on Node 18/20/22.
- **Version bumps are paired.** If you change the codec, bump `SPAB.VERSION` in `src/js/spab.js`
  **and** `version` in `src/js/package.json` (and the root `package.json`). CI checks they match.
  Cutting a release is tag-driven — see [`RELEASING.md`](RELEASING.md) (and the branch-protection
  rules it documents).
- **Changelog.** Add an entry to `CHANGELOG.md` for any user-facing change (Keep a Changelog style).
- **Code style.** `src/js/spab.js` is written in browser-and-Node-compatible JS with no dependencies;
  favor defined-width integer / GF math over language-specific idioms so ports can mirror it.
  `.editorconfig` sets indentation (2 spaces JS, 4 Python) and LF endings.
- **Ports.** New language ports live under `src/<lang>/`, stay dependency-free, and must pass the
  shared conformance vectors. Mirror the frozen wire-format spec in `r_and_d/docs`.
- **Research vs. library.** Exploratory work (new carriers, ECC ideas, corpora) belongs in
  `r_and_d/`; only vetted, measured changes graduate into `src/`.

## Measure it

spab is a measured project. New carriers/ECC should come with harness numbers (strategy × channel
matrix) and, where relevant, symbol-survival data — not just intuition. The bar to beat is stated in
`r_and_d/docs/release-features.md` (must measurably beat StegCloak/Innamark on our channel models).

## License

By contributing you agree your contributions are licensed under **BSD-2-Clause** (see `LICENSE`).
Keep the tone plain-spoken — no marketing, just the numbers and how it works.
