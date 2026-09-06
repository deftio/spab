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

Ordered by *measured* cost, not by how interesting the fix is. Every figure below
comes from a run recorded in this file; where something is unmeasured it says so.

### Sliding histogram detector — **core architecture, not yet built**

This is the piece that makes spab robust to editing mayhem, and it belongs in the
core alongside the fountain layer. The two split the work cleanly: **the sliding
detector fixes phase, the fountain fixes erasure.**

#### It is a generalisation, not a new subsystem

`r_and_d/docs/encoder-decoder-proposal-v1.md` line 134 states the relationship
exactly:

> The baseline `0.1.0` is the degenerate case: block = 1 gap, 4-point constellation,
> hard decision.

The shipping modem *is* the histogram constellation receiver, at **n = 1**. With one
site there is nothing to integrate, no window to slide and no confidence to emit, so
"nearest constellation point" collapses to "read the digit". The work is to
generalise n = 1 to n > 1 with a sliding window and soft output — not to build a new
modem beside the existing one.

**Naming hazard for whoever picks this up.** The descriptor already says
`blocks: true` and `symbolLayer: 'mixed-radix (blocked)'`, and those are a *different*
mechanism: `symBlocks()` groups sites so bits pack across non-power-of-two radices
under a 2^32 product cap, bounding how far one damaged symbol propagates. It is not
histogram integration. Two meanings of "block" in one file. The only field that
honestly reports the gap is `softDecision: false`.

#### What it buys, measured on real spab output

A single block deletion is already survivable — the scan-anywhere packet finds an
intact copy in the still-aligned prefix, and recovery stays at 100% even with 89
carrier sites cut out of the middle. **The failure is fragmentation**: every cut adds
a phase discontinuity, and the decoder can only use whichever single region happens
to contain a whole packet.

Scattered 5-word cuts, recovery of the payload:

| cuts | sites lost | repetition | rlnc |
|--:|--:|--:|--:|
| 0 | 0 | 100% | 90% |
| 2 | 26 | 100% | 90% |
| 4 | 49 | 80% | 90% |
| 8 | 105 | **30%** | 70% |
| 16 | 178 | **10%** | 50% |

With k cuts the stream is k+1 regions at k+1 different phases. As the regions shrink,
the chance that any *one* of them holds a complete packet collapses — hence 10%.

Note that **RLNC degrades far more gracefully here (50% vs 10%)**, because a 32-bit
coded packet fits inside a fragment where a whole frame does not. This is the bursty,
fragmented channel where the fountain was supposed to earn its keep, and it does.
It is direct evidence for *Decide RLNC's future* below: the paired benchmark that has
repetition ahead 88% to 80% is not measuring this case.

#### The architecture to build

Run the sliding detector as an **acquisition layer**, not as the data modem:

```
carrier sites ─▶ sliding correlator ─▶ per-region phase + confidence
                                            │
                                            ▼
                              existing per-glyph demodulator
                                            │
                                            ▼
                                  packets ─▶ fountain / fold
```

Acquisition tracks the local phase **per region**, so every fragment is demodulated
at its own phase and contributes packets — instead of the whole decode hanging on one
lucky fragment. That is what turns the 10% row above into something much better, and
it composes with RLNC rather than competing: small packets fit fragments, and pooled
fragments reconstruct.

Keeping it as acquisition rather than modulation matters for a second reason: **it
costs no payload capacity.** A histogram-carried payload is inherently low rate; a
histogram-driven *synchroniser* is not, because the data still rides the per-glyph
modem at full rate.

#### Where the gain actually comes from — build the right part

Fair comparison, both schemes spending n = 16 sites per 2-bit symbol:

| site corruption | aligned: hard | aligned: histogram | desynced: hard | desynced: sliding |
|---|--:|--:|--:|--:|
| 0.0 | 100% | 100% | 89% | **100%** |
| 0.4 | 100% | 100% | 79% | **99%** |
| 0.6 | 95% | 95% | 68% | **89%** |

**Aligned, the two are identical** — with a one-hot constellation, maximum likelihood
over a block *is* majority voting. The entire win is the sliding window. So build the
window search and the soft output; do not over-invest in constellation geometry.
Shaping earns nothing against uniform randomisation, and nothing against a collapse
channel either, since NFKC folds every variant onto U+0020 and destroys all
constellation points equally.

Then feed confidences forward: a site read as 0.51/0.49 and one read as 0.999/0.001
currently become the same hard bit, and the fountain decoder never learns the
difference.

*Two negative results, recorded so they are not rebuilt:*

**Reliability-weighted voting does not work.** Per-site confidence from the soft
layer was used to down-weight blocks holding more ambiguous default glyphs in the
majority vote. It never helped and twice hurt — scattered folding at 5% went 56% ->
50%, at 20% went 6% -> 0%. The weight cannot distinguish a DAMAGED default glyph
from a legitimately sent one, since about 1/radix of sites carry the default value
in an intact stream, so it penalises good blocks for their content. The information
is not there at the site level. It may be there at the *window* level, which is what
the sliding detector is for.

**Composition (multiset) coding**,
where the histogram itself is the codeword, is a different scheme and a bad one. A
block of n sites over r variants has `C(n+r-1, r-1)` distinct histograms, so capacity
grows only logarithmically in n — 32 bits positional versus 9.9 at n=16, r=4, and 24x
worse by n=256. Robustness to a lost symbol *is* low information per symbol; they are
the same property. The sliding detector above is not this: the payload keeps riding
the per-glyph modem, and the histogram is used to find the phase.

### Keyed marks cannot tolerate a change in carrier count — **done** (0.5.1)

The keyed permutation was built by Fisher-Yates over all `n` digits, so any change to
the carrier count invalidated it globally and resynchronisation had to be switched
off for keyed marks. Measured cost was **97% -> 27%** under structural damage, with
an exact correlation: every model that preserved the carrier count recovered, every
model that changed it scored zero.

Fixed by deriving the permutation over fixed-size blocks of `KEY_BLOCK = 32` digits
from `(key, id)` alone, never from `n`, and making the whitening PN block-local for
the same reason — keying it to absolute index left excerpting broken, because
dropping 125 sites off the front is a shift no 32-phase sweep can undo. The
`key ? 1` special case in `phaseCount()` is gone, so keyed marks sweep phases like
any other.

| damage model | sites | before | after |
|---|---|--:|--:|
| append a sentence | +7 | 0% | **100%** |
| prepend a sentence | +4 | 0% | **100%** |
| delete a word | -1 | 33% | **100%** |
| delete two words | -2 | 0% | **100%** |
| delete a sentence | unchanged | 80% | **100%** |
| excerpt first half | -188 | 0% | **87%** |
| excerpt last two thirds | -125 | 0% | **93%** |

Overall keyed structural recovery **27% -> 98%**, level with unkeyed's 97%. The cost
is a permutation repeating every 32 digits, which is weaker than a global one; `key`
is documented as a cost multiplier rather than confidentiality and `encKey`
(AES-256-GCM) is the real confidentiality mechanism, so this is the right trade.

### Block size is a robustness knob nobody is turning — **open**

Mixed-radix conversion mixes every site in a block into every bit of that block, so
one folded carrier corrupts up to 32 bits. That makes PARTIAL normalization — a tool
that flattens some whitespace variants but not all — far more destructive than its
rate suggests. `params.block` already caps block size in sites, and it matters:

| variants folded | default | block=2 | block=3 | block=4 | block=6 |
|--:|--:|--:|--:|--:|--:|
| 5% | 60% | 70% | 60% | **80%** | **80%** |
| 10% | 20% | 40% | 40% | **60%** | 30% |
| 15% | 0% | **50%** | 40% | 20% | 10% |
| 20% | 0% | 0% | **20%** | 10% | **20%** |

Ten trials per cell, so the cells are noisy, but the trend is not: the default (up to
32 sites per block) is the worst column at every damage level above zero. The default
is tuned for capacity, and capacity is not what is scarce in a long document. Worth a
proper sweep and probably a smaller default, or an adaptive one chosen from the
cover's size.

### RLNC symbol geometry — **open**

A coded packet is `[esiHi][esiLo][val][crc8]` — 32 bits to carry **one** source byte,
against repetition's 8. That is a 4x capacity requirement, and it is a robustness
problem rather than an efficiency one, because it decides whether RLNC can be used at
all:

```
37-byte packet, 750 bits of cover capacity:
  repetition  needs  296 bits ->  2 copies     decodes
  rlnc        needs 1184 bits -> 23 packets    cannot reach K = 37
```

This is very likely why the paired comparison has repetition beating RLNC 88% to 80%:
RLNC is being measured where it cannot afford to compete. The fragmentation table
under *Sliding histogram detector* shows the other half of the picture — on a stream
cut into many pieces, RLNC recovers 50% where repetition manages 10%, because a
32-bit coded packet fits inside a fragment that cannot hold a whole frame. Vector symbols — one ESI
and one checksum amortised over 4, 8 or 16 coded bytes — would change the comparison,
and the comparison should be re-run before drawing any conclusion about which code is
better. Ties into **Decide RLNC's future** below.

### Packet admission hardening — **measured as a non-issue, do not spend on it yet**

A reasonable concern is that the packet CRC8 lets chance-valid packets into the RLNC
solve. Measured across nine unmarked passages swept at every phase and offset:
**zero** chance packets admitted, zero false payloads. The lazy phase pooling (phase 0
first, widen only on failure) already keeps them out. Revisit if a measurement shows
otherwise; until then a wider packet checksum is overhead without payment.

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
- **Decide RLNC's future.** Repetition beats it paired (88% vs 80%) — but see
  *RLNC symbol geometry* above: scalar packets spend 32 bits per source byte, so the
  comparison is being run where RLNC cannot afford to compete. Fix the geometry
  first, then re-run. RLNC should win where damage is bursty and channels differ in
  survival; if a targeted test still cannot show that, it is complexity without
  payment.
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
