# Changelog

All notable changes to spab. Format follows [Keep a Changelog](https://keepachangelog.com/),
versions follow [SemVer](https://semver.org/). The JavaScript reference implementation
(`src/js/spab.js`) is published on npm as [`@deftio/spab`](https://www.npmjs.com/package/@deftio/spab);
the wire format is still settling, so minor versions may change it.

## [0.5.1] — 2026-09-06

Robustness release, on top of the v2 wire format shipped in 0.5.0.

### Fixed

- **Keyed marks now survive editing.** The keyed interleave built one Fisher-Yates
  permutation over all `n` digits, so any change to the carrier count invalidated it
  globally — and resynchronisation was switched off for keyed marks as a result.
  Measured cost: **97% -> 27%** recovery under structural damage, with an exact
  correlation — every damage model that preserved the carrier count recovered, every
  model that changed it scored **zero**. Appending one sentence destroyed a keyed
  mark completely.

  The permutation is now over fixed-size 32-digit blocks derived from `(key, id)`
  alone, never from `n`, and the whitening PN is block-local for the same reason
  (keying it to absolute index left excerpting broken — dropping 125 sites off the
  front is a shift no 32-phase sweep can undo). Keyed structural recovery is
  **27% -> 98%**, level with unkeyed. **This changes how keyed marks are written:**
  a keyed mark from 0.5.0 does not decode here.
- **Emoji joiners are no longer read as payload.** U+200D is both a `zwsp` carrier
  variant and the emoji ZERO WIDTH JOINER, so a family emoji's own joiners came back
  as carrier digits — two spurious digits extracted from an *unmarked* cover, which
  shifts every real digit after them. A joiner between two pictographic characters is
  now skipped. Found by the new corpus on its first run.

### Added

- **`SPAB.detect(text, params)` — the sliding histogram detector.** Reports, per
  carrier class, a *likelihood field*: a window slid over the carrier sites with the
  histogram and a marked-ness score at each position, plus per-site posteriors and a
  channel estimate. Output is a field over position, not a symbol stream.
  - **Channel estimation with no pilots.** The carrier histogram *is* the pilot: an
    intact marked stream is near-uniform over the radix, so excess mass on the
    default glyph measures how much normalization collapse the text has been
    through. Unmarked prose estimates 0.99, a marked passage 0.41, and the same
    passage after NFKC returns to 0.99.
  - **The soft model is asymmetric, because the channel is.** Nothing turns a plain
    space into a thin space, so observing a variant is near-certain while observing
    the default glyph is ambiguous in proportion to the estimated collapse.
  - Doubles as the steganalysis statistic an adversary would run, which is the point
    of exposing it rather than hiding it.
- **`tests/corpus.js` — 73 structurally diverse documents** (8 short public-domain
  excerpts, 65 written for the suite), chosen so each stresses a different carrier
  property: scripts with no inter-word spaces (Chinese, Japanese, Thai), right-to-left
  text, emoji ZWJ and tag sequences, combining marks, code and markup in seven
  languages, covers that already contain unicode spaces and curly quotes, and lengths
  from empty to twelve paragraphs.
- **`tests/corpus.test.js`** runs the whole codec across that corpus — 73 documents x
  11 parameter sets x 6 payload shapes — asserting behaviour rather than percentages:
  4,818 encode/decode/detect calls without a throw, every failure to round-trip
  carrying a capacity warning, no payload ever reported from unmarked text, carrier
  length and visible-text invariants on every document, and **2,352 damage trials
  with zero wrong payloads**.
- **Fuzz and 100% coverage are now CI gates**, not report-only. The wire format is
  being frozen for language ports, and a port is written against what the reference
  implementation actually does; a regression that lands silently becomes a
  conformance vector that enshrines it.

### Documentation

- **The source header described the 0.1.x codec** — "magic 0xA5", a one-byte length,
  whitespace-only defaults — none of which had been true for two wire formats. A
  porting agent reading it would have faithfully implemented the wrong thing. It now
  describes v2, and `tests/wire.test.js` **asserts the header against the descriptor**
  so it cannot drift again.
- **"any K packets" corrected to "any K linearly independent packets"** in the RLNC
  comments and the algorithm descriptor. Systematic ESIs are independent by
  construction; random repair rows are independent with overwhelming probability but
  not by guarantee, and the solver already detects an under-rank system.
- **The determinism claim now states its exception**: identical output for identical
  *explicit* params, except that encryption draws a fresh nonce when `params.nonce`
  is absent.
- **`r_and_d/docs/prior-art-and-tradeoffs.md` was stale** — it still listed typed
  payloads and encryption as spab's two gaps, both closed in 0.5.0. Corrected and
  version-stamped, since an unstamped capability table goes stale silently.

### Measured and rejected

Recorded because a negative result that is not written down gets rebuilt:

- **Reliability-weighted voting.** Per-site confidence was used to down-weight blocks
  holding more ambiguous glyphs in the majority vote. It never helped and twice hurt
  (5% scattered folding 56% -> 50%; 20% folding 6% -> 0%). The weight cannot tell a
  damaged default glyph from a legitimately sent one, so it penalises good blocks for
  their content. Removed; the soft layer stays exposed for uses where the information
  is actually present.
- **Wider packet checksums for RLNC admission.** Zero chance-valid packets were
  admitted across nine unmarked passages swept at every phase and offset, so this is
  overhead without payment today.

## [0.5.0] — 2026-09-05

### Changed — wire format v2 (breaking)

The packet format is redesigned and specified in [`dev/wire-format.md`](dev/wire-format.md).
**Marks written by 0.4.x do not decode here.** Accepting both layouts was tried and reverted: a
CRC-8 validates by chance about once in 256, so parsing two doubles the ways a random window looks
like a packet, and a UUID payload came back as a "legacy string" within the hour. The version field
exists to make the break explicit rather than a guess.

```
[version:3 | type:5 | comp:3 | enc:3 | cksum:3]   17-bit fixed header
[extension bytes, grouped, in field order    ]   only for escaped fields
[len varint                                  ]   only when the type does not imply it
[checksum, 8 << cksum bits                   ]   before the content
[content][pad to a byte boundary             ]
```

- **Bit-level, not byte-aligned.** Five header fields in 17 bits where a byte each would have taken
  40. The modem is bit-oriented, so rounding to bytes bought nothing.
- **The checksum precedes the content.** Tail truncation and mid-excerpt are spab's commonest
  losses, and a trailing checksum dies with the data it protects. In front, a surviving header says
  what type it is, how many bytes to expect, and what they must hash to — which turns the checksum
  from a pass/fail gate into an oracle the erasure decoder can query while it is still working.
- **No magic number.** The header's own plausibility plus the checksum is the discriminator, and
  unlike a constant it also tells the decoder something. Measured on random streams: 1 false packet
  per 133 000 windows, and none at all across 199 400 windows of page-sized streams — better than
  the ~1 in 65 000 the old magic-plus-CRC gave, while saving 8 bits on every packet.
- **Every enumerated field has an escape.** All-ones means 8 more bits follow, grouped after the
  fixed header in field order, `0xFF` continuing into another byte. Ranges continue with no gap.
- **Unassigned `type` codes are carried and reported by number**, so a newer writer and an older
  reader can disagree without losing the payload. `comp` and `enc` are not relaxed the same way: an
  unknown algorithm yields nothing usable, so accepting one buys no capability and costs sweep
  margin.

### Added

- **Compression (`comp` field).** LZSS, defined in the spec so it depends on no library and behaves
  identically in Node and the browser. The encoder **tries and skips**: compression is attempted on
  every payload and kept only if strictly smaller, because spab payloads are usually 8-200 bytes and
  every general-purpose compressor expands inputs that small. `deflate-raw`, `gzip`, `brotli` and
  `zstd` have registered code points; a packet using one is reported `unsupported`, not dropped.
- **Encryption (`enc` field).** `params.encKey` encrypts with **AES-256-GCM**; the content becomes
  `nonce ‖ ciphertext ‖ tag`. Pure JS so `encode`/`decode` stay synchronous in every host — WebCrypto's
  AEAD is async everywhere and would have forced an async public API on a synchronous library.
  Verified against Node's own AES-256-GCM byte-for-byte across fourteen lengths, and against
  FIPS-197 for the block cipher. An encrypted mark is **findable without the key** (the packet keeps
  a plaintext checksum) and reports `status: 'encrypted'`; a wrong key reports `auth-failed`.
- **`SPAB.deriveKey(password, salt, iterations, length)`** — PBKDF2-HMAC-SHA256, verified against
  Node. Deliberately kept *out* of the packet so no salt or iteration count travels in a header
  where every bit is contested.
- **Selectable checksum width.** `params.cksum` is a 3-bit exponent, `bits = 8 << n`: crc8, crc16,
  crc32, then SHA-256 truncated to 64, 128 and 256 bits. Defaults by stored size. There is
  deliberately no "none" — with no magic number, the checksum is what finds a packet at all.
- **`SPAB.version()`** — what this build is and what it can actually do: library version, wire format,
  carriers, ECC modes, payload types, and the **implemented** compression, encryption and checksum
  code points. `SPAB.algorithm.frame` lists every *registered* code point; `version()` lists the
  subset this build honours, and the difference is exactly what predicts an `unsupported` decode.
  `SPAB.VERSION` remains the bare string. The suite asserts these lists against what the codec
  actually does, not against another table that could drift the same way.
- **`spab version`** (and `spab --version`, `spab version --json`) — the CLI had no way to report its
  own version at all.
- **`SPAB.wire`** — the packet layer on its own (build/parse/size/checksums/LZSS/AES-GCM/varint),
  exposed so conformance tests drive it directly rather than inferring it through the carrier and
  ECC layers.
- **`tests/wire.test.js`** — 288 assertions across thirteen sections: primitives against published
  vectors (FIPS-180, RFC 4231, FIPS-197, the CRC check values, and Node itself), bit I/O and varint
  boundaries, the escape mechanism across type codes 31 to 541, packet geometry per size class,
  every payload type, **every length from 1 to 300 bytes plus both varint boundaries**, compression
  across five compressible and four incompressible shapes plus 510 LZSS round-trips, encryption
  across thirteen lengths and four key forms, every checksum width with **exhaustive single-bit
  corruption detection**, the truncation property, a measured false-accept rate, end-to-end through
  every carrier and both ECC modes, and a check that the spec document matches the implementation.
- **`npm run wire:tables`** regenerates the worked-example and overhead tables in the spec from the
  implementation, so its numbers are measured rather than asserted. `--check` gates CI on drift.
- **CLI options** `--enc-key`, `--cksum`, `--no-compress`, `--ecc`, and a decode report that names
  every header field: wire version, type, compression, encryption, checksum width, stored and
  opened sizes.

- **11 real-world corruption models** in `r_and_d/corruptions.js`: pasting into a plain text field,
  PDF/rendered-page extraction, tokenise-and-rejoin, email quoting, editor trailing-space trim,
  per-word typos, terminology find-and-replace, JSON round trip (a control that must always
  survive), sentence reordering, markdown stripping, and concatenation into a larger document.
  These are what a mark actually meets; the existing models are synthetic damage.
- **`r_and_d/samples.js`** — ten fixed text samples chosen so each stresses something different:
  punctuation-rich and punctuation-poor prose, chat-style short lines, markdown, code with
  structural indentation, a long passage, a passage too small to encode, text with no inter-word
  spaces at all (CJK-like), and text that already contains unicode spaces and curly quotes.
- **`npm run characterize`** — a deterministic sweep (10 samples x 7 payload sizes x 4 carrier sets
  x 2 ECC modes x 23 models, ~3,465 rows) reporting recovery grouped the way design has to reason
  about it. It reports **paired** comparisons alongside the raw ones, because the raw tables are
  confounded: an arm with more capacity encodes in a different population than one without. On this
  data the paired view reverses the ECC conclusion — raw says RLNC 80% vs repetition 70%, paired
  over the 900 cells both could encode says repetition 88% vs RLNC 80%.
- **The deterministic suite now covers the real-world channels** as a classification rather than a
  pass mark: lossless channels must keep the mark, destructive ones may lose it but must never
  return a wrong payload.
- **`npm run compare` — spab against reference models of the other approaches.** `r_and_d/baselines.js`
  reimplements each *technique* (point insertion as StegCloak shapes it, spread insertion as 330k
  does, naive whitespace substitution as the snow family does) so the comparison isolates two design
  decisions — where the payload sits and whether there is error correction — rather than benchmarking
  anyone's library. Paired, like the characterization sweep.
- **`r_and_d/reports/findings.md`** — a running log of what the harnesses actually show, with the
  command to reproduce each number and superseded findings struck rather than deleted.
- **A capability matrix in `r_and_d/docs/prior-art-and-tradeoffs.md`** across placement, ECC/erasure,
  integrity, compactness, typed payloads and encryption, marked clearly as sourced from project
  documentation rather than measured. It puts spab's two gaps in writing: no type field and no real
  encryption, both of which StegCloak has had for years.
- **Two measurement biases found and fixed.** The corruption suite only ever attacked the whitespace
  channel, so zero-width schemes sailed through a suite that never touched them (`stripZw`, `zwNoise`
  added); and `truncate` kept the head, which silently favours any scheme anchored at the start
  (`truncTail`, `midExcerpt` added — point insertion's excerpt score fell from 83% to 36% once the
  mirror cases existed). A robustness suite written around one design will flatter that design.
- **Findings recorded in `dev/roadmap.md`** — redundancy (not length) is the variable that moves
  recovery; the confusable channels never fit a payload alone in the whole sweep; excerpting and
  word deletion remain the weakest survivable cases.

### Documentation

- **`tests/README.md` listed only `roundtrip.test.js`** — it predated `branches`, `wire`, `noise`,
  `fuzz` and the coverage gate. Now describes what each file holds the code to, and the two
  conventions behind them: the descriptor is the contract, and a wrong answer costs more than a
  missed one.
- **The capacity rule of thumb was wrong.** `docs/capacity-vs-robustness.md` said a passage of *W*
  words holds ~`W/4 − 3` payload bytes per copy; the −3 was the old 3-byte frame. Measured against
  the implementation at W = 50…1600, it is **`W/4 − 7`** (a 17-bit header, a varint length, a 16-bit
  checksum and the pad come to 41 bits), with the caveats that it assumes an incompressible payload
  and that a fixed type carries no length field.
- **The npm README linked out of the published package.** `src/js/README.md` pointed at
  `../../dev/wire-format.md`, which resolves in the repo and 404s on npmjs.com — the package ships
  only `spab.js`, `cli.js`, `README.md` and `LICENSE`. Now an absolute GitHub link.
- **Documented the exports nothing mentioned**: `CLASS_DEFS`, `SPACE_MAP`, `SPACE_NAMES`,
  `readClassBits`, and `params.profile` (a legacy shorthand for `classes`).

### Fixed

- **`payloadBytes` was the only size reported**, which became ambiguous once payloads could be
  compressed. `payloadBytes` is now the stored size and `messageBytes` the opened size.
- **The capacity warning quoted the wrong requirement in RLNC mode.** RLNC spends a 32-bit packet
  per source byte, so a 52-byte packet needs 1664 bits where repetition needs 416 — the message
  quoted the repetition figure in both modes, producing warnings that contradicted themselves
  ("needs 416 bits, best channel has 1314").
- **`algorithm.ecc` was defined twice** in the descriptor object, so the second definition silently
  overwrote the first and the RLNC description never appeared.
- **A wrong payload could be returned from a damaged mark.** The new noise matrix caught it: when a
  mark is thin enough that only one copy fits, folding cannot vote and the blind resync sweep
  decides — and the sweep accepted a chance window as a 32-byte `sha256` packet, a fixed type with
  no length field to constrain it and 8 bits of CRC as the only obstacle. Two changes:
  - the **default checksum floor is now crc16**, not crc8. The capacity argument for crc8 was weak
    (an 8-byte serial is 89 bits with crc8, 97 with crc16, against a memo that holds 64 either way)
    and it cost a factor of 256 in false accepts. crc8 remains available as `cksum: 0`.
  - a packet found by **blind sweep** must carry at least a 16-bit checksum *or* have been seen more
    than once. Measured over 1539 thin damaged marks: without the rule, 2 wrong payloads and 885
    recoveries; with it, 0 wrong and 864. It costs 2.4% of recoveries to remove a 0.13% chance of
    confidently returning something that was never written.

  Worth recording that the original §7 of the wire-format spec justified dropping the magic byte on
  **random-stream** measurements alone. Real streams are structured — they contain shifted, damaged
  copies of a real packet, which produce header-shaped patterns far more often than noise — and that
  gap is what let the false positive through. The spec now carries both numbers.
- **The release script spliced the PR title into a shell command.** `release.js` built
  `gh pr create --title <title>` as one string and handed it to `/bin/sh`, with `JSON.stringify` as
  the only quoting — and inside double quotes the shell still expands backticks and `$(…)`. A v0.5.0
  title derived from a CHANGELOG line containing `` `dev/wire-format.md` `` was truncated mid-token,
  left an unbalanced backtick, and the shell tried to execute what followed. A CHANGELOG containing
  `$(…)` would have run it. Fixed with `runArgs()` (`execFileSync`, argument list, no shell); the
  derived subject now strips markdown and trims at a word boundary. The body was already passed by
  file "because it contains backticks" — the title had the same property and was missed.
- **The RLNC/NFKC round-trip test was on a capacity knife edge** (240 surviving bits against the 256
  an 8-byte packet needs), so a one-byte growth in the packet broke it. Given the cover it needs.

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
