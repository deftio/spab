# tests — CI/CD conformance

Fast, deterministic checks that run on every commit. Research and measurement live in
`r_and_d/`; nothing here samples a corpus or reports a percentage that moves.

```bash
npm test              # roundtrip + branches + wire + noise
npm run lint          # zero-dependency lint gate (warnings are errors)
npm run fuzz          # 2000 random permutations; --iterations N for more
npm run coverage      # V8 block coverage over src/js/spab.js
npm run coverage:strict   # same, but fails below the thresholds
npm run ci            # everything above except fuzz, plus the r_and_d smoke sweeps
```

| file | what it holds the code to |
|---|---|
| `roundtrip.test.js` | the conformance spine: round-trip, no false positives on clean text, orthogonal carrier failure, RLNC cross-channel recovery, exported surface |
| `branches.test.js` | the awkward paths — empty and degenerate inputs, capacity warnings, auto-grow, keyed marks, resync after edits, carrier boundary conditions, and the `algorithm` descriptor as a contract |
| `wire.test.js` | the v2 packet format on its own (`SPAB.wire`): primitives against published vectors, every payload type, every length, every compression and encryption code point, every checksum width, and the spec document itself |
| `noise.test.js` | a deterministic recovery matrix — payload sizes x cover sizes x carriers x ECC x damage models — asserting behaviour, not pinned percentages |
| `fuzz.test.js` | random permutations of cover, payload and params, checking invariants rather than outputs; failures print a reproducing seed |
| `lint.js` | editorconfig hygiene, parse checks (including inline `<script>` in `pages/*.html`), and the shipping library's own rules — strict mode, no `console.*`, no TODOs |
| `coverage.js` | merges per-process V8 coverage and reports functions/lines/branches, excluding blocks explicitly annotated `cov-ignore` with a reason |

## Two conventions worth knowing

**The descriptor is the contract.** `SPAB.algorithm` describes the format, and the tests
assert the implementation matches *it* — not the other way around. A type field specified
in the original design was missing from the first working commit through 0.4.x and nothing
noticed, because the descriptor documented whatever the code happened to do.

**A wrong answer costs more than a missed one.** Several assertions permit "did not
recover" but forbid "recovered something that was never written". Where the two trade off,
the tests take that side, and `noise.test.js` measures the price.

## Ports

As language ports land, each gets a conformance runner here that validates against the
shared test vectors, so all implementations stay bit-for-bit compatible. `dev/wire-format.md`
is the normative specification a port implements; `wire.test.js` is the check it must pass.
