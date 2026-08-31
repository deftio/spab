# spab — release / feature TODO

Execution list of things to build toward a useful release. Living checklist; not
committing to dates. "Not today" items are captured so they aren't lost.

## Multi-language library exports (not today, but the point of the project)

Ship the spab codec as a small, **dependency-free** library in each major language, so it
drops into anyone's stack. Same wire format across all of them, validated by shared test
vectors so implementations interoperate bit-for-bit.

- [ ] **JavaScript** (reference; exists as `src/js/spab.js`) — package for npm (ESM + CJS), no deps.
- [ ] **Rust** — crate, no deps; `no_std`-friendly if practical.
- [ ] **C / C++** — small C core with a clean header; the likely performance/embeddable base.
- [ ] **Python** — pure-Python package (no C-extension required), no deps.
- [ ] **Java / Kotlin** — JVM library (Kotlin Multiplatform is an option), no deps.

Cross-cutting requirements for every port:

- [ ] **No third-party dependencies** (bundle the GF/RS math; hand-roll the codec).
- [ ] **CI testing** per language (build + unit tests + the shared conformance vectors).
- [ ] **Shared test vectors** — a language-neutral fixture set (encode/decode + corruption
      cases) exported from the JS harness so every port validates against identical data.
- [ ] **Docs for every binary/CLI** — man-style usage, examples, and the format spec.
- [ ] **A frozen wire-format spec** (frame layout, symbol library, slot rules, PN/LFSR
      polynomial + seed, ECC parameters) that all ports implement. Prereq for interop.

## Codec / algorithm (see dev/spab-watermark-plan.md)

- [x] Baseline `0.1.0` — one **example** symbol set (not a requirement): each inter-word space
      picks among 4 whitespace variants (U+0020/2006/2009/200A) = 2 bits/space. The symbol
      library is pluggable — alphabet size, which variants, and which classes are all configurable;
      this is just the simplest starting choice. Plus repetition + majority-vote ECC and a magic+CRC frame.
- [ ] Fountain outer code: **RLNC over GF(256) first** (patent-free, small-K friendly, no-deps),
      **RaptorQ later** for large-K (check IPR). Packet = `[ESI | fragment | CRC]`; per-packet CRC
      turns swaps into erasures so the fountain can fill them. See proposal §9b (the six questions).
- [ ] `0.2.x` — real ECC behind a swappable interface, prioritizing codes that **survive block /
      burst disturbances** (cut/paste, retyped paragraphs), since that's this project's hardest
      channel. Lead with **erasure-aware rateless/fountain** (LT/Raptor) and soft-decision codes;
      RS is a poor fit as the destination (it assumes alignment we don't have) — at most an interim
      erasure baseline, not the goal.
- [ ] Block-histogram coding + A/B framing (the current lean; measure vs. baseline).
- [ ] Interleaving + PN placement; position-tagged vs. self-identifying symbols.
- [ ] Sliding-window / matched-filter acquisition decoder.
- [ ] Richer M-ary symbol library (more whitespace variants; punctuation/confusables).
- [ ] Independently-decodable tiles (excerpt/cut-paste survival).
- [ ] Transposition-dictionary channel (probabilistic word/symbol swaps — see plan).
- [ ] Payload transforms in frame flags: **compression** (capacity) and **encryption**
      (privacy + whiter carrier stats) — transform stack, not new types (see plan).
      - [ ] Encryption: ChaCha20(-Poly1305), user key → 256-bit via KDF (default) /
            PN-continuation / repeat (stretch ≠ entropy); nonce stored-or-derived. No-deps.
      - [ ] Key-strength warnings in encode `metadata.issues` (length, diversity, common-password
            check, entropy estimate → ~bits of security). Advisory, non-blocking; key never logged.
      - [ ] Compression: 3-bit codec-id enum (up to 8 lossless), `0=none`; `auto` mode
            (default) tries all implemented codecs, keeps smallest, stores winner id.
            Implement a simple few first (none/RLE/LZW/LZ77); reserve the rest.
- [ ] API evolution to target form: `encode(baseText, message, key?, options?)` /
      `decode(markedText, key?, options?)`; `options.compression='auto'`; metadata reports
      chosen codec + ratio, encryption applied, key/codec warnings.
- [x] Confusables carrier class (apos U+0027/U+2019, hyphen U+002D/U+2010) — implemented as
      independent parallel per-class channels; survives whitespace-only strips (CI-tested).
      Note: confusables are sparse, so they carry only small payloads or need long/punct-rich text.
- [x] **Carrier set locked from data (0.3.0):** NFKC collapses all whitespace variants → the
      confusables (U+0027/U+2019, U+002D/U+2010) survive NFKC. Default now enables whitespace +
      confusables **co-equal** (parallel channels); dropped ellipsis/NBSP/U+2011 (NFKC-fragile).
- [x] Harness: added `nfkc` and `smartQuotes` corruption channels (the transforms that separate
      the carriers — whitespace dies to NFKC, apostrophes die to smart-quote autocorrect).
- [ ] Confusables: add double-quote group (open/close handling); measure co-equal set on real
      punct-rich corpora (curated books) — synthetic short docs are too punct-sparse to show it.

## Polish bar (fr_math / bitwrench level)

Target the polish of deftio's other libraries (github.com/deftio/fr_math, bitwrench): thorough
**docs**, real **tests**, **CI/CD**, and **plain-spoken explanations** — not just working code.
Already scaffolded (tests/, per-port skeletons, docs/, plain READMEs); hold every increment to that
bar as ports and features land.
- [ ] Adversary-cost measures (make removal expensive/lossy, not impossible): carrier–content
      overlap, defense-in-depth across channels, key-gated carriers over a large pool.
- [ ] Tamper-evidence: `tampered` decode status — detect "watermark stripped" vs. "never
      watermarked" (decoy/tripwire layer + normalization fingerprints).

## Library hygiene / CI

- [x] CI/CD: GitHub Actions (`.github/workflows/ci.yml`) on Node 18/20/22 — syntax check,
      conformance tests, harness smoke, symbol-survival smoke, version-consistency check.
- [x] Root `package.json` scripts (`test`/`ci`/`bench`/`survival`); `.editorconfig`; zero deps.
- [x] Raw channel-characterization experiment (`r_and_d/symbol-survival.js`): stamp random symbols,
      apply every attack, measure per-carrier survival — decouples carrier robustness from ECC.
- [ ] Finding to act on: the `smartQuotes` attack only curls *single* quotes; real autocorrect also
      curls double quotes, so the `dquote` carrier looks more robust than it is. Extend the model.
- [ ] Per-port CI as the ports land; publish coverage/badges (fr_math/bitwrench polish bar).

## Tooling / product

- [x] Benchmark harness with corruption models, provenance (JSONL + SQLite), corpora.
- [x] Payload profiles (magic / sha1 / sha256 / json / program) + `--profile-bench`, `--by-size`.
- [x] Directory corpus loader + generator + curated (license-free) downloader.
- [x] `spabdemo.js` CLI (hide/reveal/capacity) + web visualizer.
- [ ] `plan()` advisory / dry-run: returns a **list of dual-readable options** — programmatic
      (payload size, class set, redundancy, per-channel recovery probs) + human (recommendation +
      why) — so a caller branches in code or shows a person a rationale (proposal §13a).
- [ ] Re-encoding policy: run the presence detector on the cover; report pre-existing marks with a
      `present`/`readable`/`opaque` state (opaque = encrypted/unknown mark) and `onExisting` =
      report | reject | overwrite | preserve-regions | layer. Handle the derivative-work / quotation
      case (add our mark in the remaining space or an orthogonal carrier class). Never silently
      destroy a third-party mark. Scope now because it biases carrier/region choice (proposal §13b).
- [ ] Confidence-calibration report (does reported confidence match actual success?).
- [ ] Executable-payload runner (sandboxed, opt-in) for the `program` type.

## Value bar — comparative benchmarks (must beat the incumbents)

Internal bar, not a marketing claim: spab must **measurably** beat the popular prior tools on our
own channel models, or it isn't worth shipping. Plain-spoken, numbers only.

- [ ] **StegCloak** (github.com/kurolabs/stegcloak) — JS, zero-width + homoglyph + encryption, no
      ECC/robustness study. Wrap as a strategy row in the harness (r_and_d may use it as a dev-only
      dep) and run our corruption channels against it. Expected spab edge: robustness (ECC,
      multi-carrier) and honest tamper reporting.
- [ ] **Innamark** (github.com/FraunhoferISST/Innamark) — Kotlin/JVM, Unicode-whitespace + RS.
      Compare via its CLI (shell out) or a faithful re-impl as a strategy row. Expected spab edge:
      portability (no-deps, 5 languages), multi-carrier strip-resistance, richer channel eval.
- [ ] Publish a plain comparison table (recovery vs. channel, capacity, portability) once real —
      no boasting, just the matrix.

## Docs

- [x] `docs/capacity-vs-robustness.md` — user guide (magazine vs. novel framing).
- [ ] Format spec document (normative; the interop contract for all ports).
- [ ] Per-language API docs + CLI man pages.
- [ ] Threat-model / "what spab is not" page (incidental vs. adversarial robustness).
