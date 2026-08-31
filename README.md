# spab

**spab** hides an arbitrary payload (a magic word, an ID/hash, JSON, even a small program) in
the *whitespace and punctuation choices* of ordinary text, protected by error correction so it
survives normal editing — copy/paste, reformatting, excerpting. The text reads identically; the
signal lives in equivalent choices a reader won't notice. It's information-entropy management: mine
the spare entropy in formatting/phrasing, spend some on signal, keep margin to survive the channel.

> Status: early development. The **JavaScript reference implementation** (`src/js`) ships a working
> baseline (`0.1.0`); other language ports are scaffolded but not yet written. Design and rationale
> live in `r_and_d/docs` (see the **encoder/decoder proposal v1**).

## Repository layout

```
src/            library implementations (one per language; JS is the reference)
  js/           reference implementation (spab.js) — no dependencies
  c_cpp/        C/C++ port (skeleton; C++17)
  rust/         Rust port (skeleton)
  python/       Python port (skeleton)
  java/         Java/Kotlin port (skeleton)
cli/            command-line tool (Node reference; optional compiled C++17 cli under cli/cpp)
tests/          CI/CD conformance tests (not research)
r_and_d/        research & iteration (the harness, not shipped)
  docs/         reasoning & algorithm-development notes (plan, proposal, catalog, glossary)
  reports/      version test data: run logs (JSONL) + derived SQLite index
corpuses/        test text to encode (generated + curated; gitignored, regenerable)
docs/           user-facing docs (how to use the library, capacity vs robustness)
pages/          GitHub Pages site — pure HTML/JS/CSS (bitwrench.js), same info as docs + live demo
```

## Design invariants

- **Zero third-party dependencies**, in every language.
- **Deterministic** at runtime (same input + params → same output, on every port).
- **Classic DSP, not gen-AI** — modulation / demodulation / sync / FEC; parameters may be tuned
  offline but nothing learned runs at decode time.
- **Portable wire format** validated by shared conformance test vectors across all ports.

## Quick start (JavaScript / CLI)

```bash
# hide and reveal a message with the built-in story
./cli/spabdemo.js encode --message "meet at dawn" --use-demo-story --out out.txt
./cli/spabdemo.js decode --in out.txt

# how much can a text hold?
./cli/spabdemo.js capacity --in yourtext.txt

# research harness (robustness benchmark)
./r_and_d/harness.js --gen 5000 --profile-bench
```

## Development & tests

Zero runtime dependencies — nothing to install. Node ≥ 18.

```bash
npm test                 # conformance tests (tests/roundtrip.test.js)
npm run ci               # tests + harness smoke + symbol-survival smoke (what CI runs)
npm run bench            # robustness benchmark (r_and_d/harness.js)
npm run survival         # raw per-carrier channel-survival experiment
```

CI (GitHub Actions, `.github/workflows/ci.yml`) runs on Node 18/20/22: syntax check, conformance
tests, a harness smoke, a symbol-survival smoke, and a version-consistency check (`spab.js` VERSION
== `package.json`). Research lives in `r_and_d/` and is not shipped.

## Docs

- `docs/capacity-vs-robustness.md` — choosing what to embed and how robustly.
- `r_and_d/docs/encoder-decoder-proposal-v1.md` — the full architecture proposal.
- `r_and_d/docs/symbol-catalog.md`, `spab-watermark-plan.md`, `glossary.md` — design notes.

## License

BSD 2-Clause — see [`LICENSE`](LICENSE). © 2026 M. A. Chatterjee (deftio).
