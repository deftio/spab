# tests — CI/CD conformance

Fast, deterministic checks that run on every commit (not research — that's in `r_and_d/`).

```bash
node tests/roundtrip.test.js       # JS reference: round-trip, no false positives, exports
```

As language ports land, each gets a conformance runner here that validates against the shared
test vectors, so all implementations stay bit-for-bit compatible. The `r_and_d/harness.js`
robustness sweep can also be run in CI against a small corpus subset for regression tracking.
