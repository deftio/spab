# spab roadmap

Work that is known, scoped, and not done. Kept here so it is tracked rather than
remembered. Items are ordered roughly by how much they change the wire format —
decoder-only changes are cheap, frame changes are not.

Status legend: **open** (not started), **partial** (some of it shipped), **done**.

## Payload handling

### Typed payloads — **done** (wire format v2, 0.5.0)
The packet is now bit-level: `[version:3|type:5|comp:3|enc:3|cksum:3]`, extension
bytes for any escaped field, an optional varint length, the checksum, then the
content. Type covers string / json / bytes / ser8 / uuid / sha256 / program /
encrypted; unassigned codes are carried and reported by number so a newer writer and
an older reader can disagree without losing the payload. Inferred when the caller
does not say; explicit `params.type` wins. Normative spec: `dev/wire-format.md`.

Two notes for whoever revisits this. The original design argued for **flag-coded**
types (bits, not bytes) precisely because header bytes are expensive on short
passages, and that argument won: five fields fit in 17 bits where a byte each would
have taken 40. And the field went missing in the first place because nothing tested
it — the `algorithm.frame` descriptor described the code rather than the spec, so the
gap was invisible. The descriptor is now the contract, `tests/branches.test.js`
asserts against it, and `tests/wire.test.js` asserts the spec document against the
implementation.

### Compression — **done** (`comp` field, 0.5.0)
The packet carries a 3-bit compression field. The reference codec implements LZSS
(defined in the spec so it depends on no library, and identical in Node and the
browser); deflate-raw, gzip, brotli and zstd have registered code points for hosts
that have them. The encoder **tries and skips**: compression is attempted on every
payload and kept only if strictly smaller, because spab payloads are usually 8-200
bytes and every general-purpose compressor expands inputs that small.

### Compact JSON encoding — **open**
JSON payloads are stored as their literal text and then compressed, which helps on
repetitive metadata but does nothing about the representation itself:
`{"r":"j.smith","case":42}` is 25 bytes before either step. A CBOR-shaped encoding
plus a small dictionary for repeated keys should still beat LZSS on typical metadata.
Now cheap to add — it is a `type` code point, and the machinery to negotiate it is
already on the wire. Measure against `comp=lzss` before committing.

### Encryption / authenticated payloads — **done** (`enc` field, 0.5.0)
`params.encKey` (a 32-byte key, or 64 hex characters) encrypts the payload with
AES-256-GCM; the content becomes `nonce ‖ ciphertext ‖ tag`. Implemented in pure JS
rather than WebCrypto so `encode`/`decode` stay synchronous in every host — WebCrypto's
AEAD is async everywhere, which would have forced an async public API on a library
whose whole surface, including the browser demo, is synchronous. Verified against
Node's own AES-256-GCM byte-for-byte across fourteen lengths.

`params.key` remains a separate thing: it whitens and interleaves the symbol stream,
which is a cost multiplier, not confidentiality. The two compose.

Still open here:

* **`chacha20-poly1305`** has a code point and no implementation.
* **Constant-time AES.** The table-driven implementation is not constant-time. That
  is outside spab's threat model — marking happens locally and offline, and the
  attacker sees marked text rather than the machine — but a caller who needs it
  should encrypt with a platform AEAD and pass the ciphertext in as `bytes`.
* **Key derivation from a passphrase** is offered as `SPAB.deriveKey` (PBKDF2-HMAC-SHA256)
  and deliberately kept out of the packet, so no salt or iteration count has to
  travel in a header where every bit is contested. Callers manage their own salt.

### Payloads over 255 bytes — **done** (0.5.0)
The length is a varint: one byte to 127, two to 16 383, three beyond. The old 255-byte
ceiling and its silent truncation are gone. A 64 KB sanity bound remains — no cover
text can carry that — and truncating there is still better than emitting a packet
whose length field has wrapped.

## Robustness

### Redundancy sizing beyond auto-grow — **partial**
`redundancy` currently only shapes how far `autoGrow` inflates a passage. It does
not apply to substitution-only encoding, where redundancy is whatever capacity
happens to allow. A caller who wants "three copies or tell me it will not fit"
cannot ask for that today.

### Keyed marks cannot tolerate a change in carrier count — **open**
The keyed interleave permutation is derived from the digit count, so *any* change to
the number of carriers — including appending text at the end, which is otherwise
harmless — descrambles to noise. Resynchronisation is disabled when a key is set for
this reason. A key-derived permutation over fixed-size blocks rather than the whole
stream would make keyed marks resynchronisable. Caught by `tests/noise.test.js`.

### NFKC survival needs more confusable capacity — **open**
"How it works" says the payload survives normalization via the apostrophe and hyphen
channels. In practice those channels are tiny: carrying a 7-byte secret through NFKC
alone needs ~80 apostrophes and hyphens, and measured prose has 8–26 sites. It
survives only for very small payloads in long, punctuation-heavy text. Either find
more NFKC-durable carriers or state the limit more precisely than the current table
does.

### Whitespace variants are visible in proportional type — **open**
Thin, hair and six-per-em spaces are narrower than a plain space, so a marked
paragraph sets about 3% narrower than its source (measured: -3.26% system-ui,
-2.13% Georgia, 0.00% ui-monospace). Documented on the site. A carrier set chosen
for equal advance width would remove the tell at some cost in capacity.

## What the characterization run says

`npm run characterize` sweeps 10 fixed samples x 7 payload sizes x 4 carrier sets x
2 ECC modes x 23 corruption models (~3,465 rows, deterministic). Findings that
should shape the next round of design:

- **Redundancy is the variable, not text length.** Within the length-preserving
  carriers: 1 copy 29%, 2 copies 36%, 5-8 copies 57%. Length only matters because
  it buys copies, so any capacity work should be expressed as "how many copies does
  this passage hold" rather than "how long is it".
- **Repetition beats RLNC on equal terms.** The raw table says the opposite (rlnc
  80% vs repetition 70%) but that compares different populations: rlnc only encodes
  where there is room for K packets. Paired over the 900 cells both modes could
  encode, repetition wins 88% to 80%. RLNC's cross-channel pooling has not paid for
  itself yet — worth understanding before investing further in it.
- **The confusable channels never encode alone.** `classes: ['apos','hyphen']`
  failed to fit a payload in *every* combination in the sweep. They are ~1 bit per
  site and ordinary prose has single digits of them. The "survives NFKC via the
  confusables" story needs either denser NFKC-durable carriers or a much smaller
  payload than anything in this matrix.
- **Zero-width is far more robust, and that is a capacity effect.** Paired against
  the length-preserving carriers on the same cells: 97% vs 37%. It buys that with
  bytes and with a mark that is obvious in a hex dump.
- **The real-world channels split cleanly in two.** Anything that collapses
  whitespace — pasting into a plain text field, PDF extraction, tokenise-and-rejoin
  — takes the whitespace payload with it (69%, and the survivors are the zero-width
  runs). Everything that preserves characters survives at 100%: JSON round trip,
  trailing-space trim, email quoting, concatenation, markdown stripping,
  find-and-replace. Sentence reordering is 91%; per-word typos 75%.
- **Excerpting and word deletion are the weakest survivable cases** (cutPaste 40%,
  wordDelete 44%, truncate 52%) even after the resync work. This is where more
  redundancy or a resynchronisable keyed mode would pay.

## Research follow-ups

- **Enlarge the paired corpus.** The technique comparison pairs on cells every
  scheme can encode, which currently leaves only 6–20 cells — too few to quote.
  Mid-length samples that all schemes can carry would make it a measurement.
- **Re-verify the capability matrix** in `r_and_d/docs/prior-art-and-tradeoffs.md`
  against current releases; the entries come from project documentation and have not
  been re-checked.
- **Decide RLNC's future.** Repetition beats it paired (88% vs 80%). RLNC should win
  where damage is bursty and channels differ in survival; if a targeted test cannot
  show that, it is complexity without payment.
- **Position-independent framing.** Point insertion beats spreading on desync purely
  because a contiguous payload with a scan-anywhere decoder does not care about
  position. Sync markers or content-addressed packets would aim to have both.

## Tooling

### Recovery benchmark in CI — **open**
`r_and_d/harness.js` produces recovery-by-model numbers and is run as a smoke test
only. Tracking those numbers over time — even as a report, not a gate — would show
robustness regressions that the pass/fail suites cannot.

### Language ports — **open**
`src/python`, `src/rust`, `src/c_cpp`, `src/java`, `src/swift` are skeletons. The
conformance vectors that a port must satisfy live in `tests/`; the JS implementation
is the reference.
