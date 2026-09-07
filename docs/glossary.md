# spab glossary

Shared vocabulary for the docs, the code and the API. Where a term here has a precise
meaning, it is used that way everywhere — identifiers, comments, metadata keys.

Current for **spab 0.5.1, wire format v2**. Terms that describe a *target* design
rather than shipping behaviour are marked **(planned)**, because the previous version
of this file quietly described a frame that had been retired two formats earlier.

---

## The idea in one picture

Ordinary text contains choices a reader never notices. spab spends them.

```
 visible text     T h e   b o a r d   m e t   o n   T u e s d a y
                        ^         ^       ^      ^
 carrier sites           |         |       |      |
                    each inter-word gap can be one of four
                    visually equivalent space characters:

                    U+0020  U+2006  U+2009  U+200A
                      00      01      10      11     -> 2 bits per gap
```

Nothing about the page changes. The character *count* does not change either — that
is what "length-preserving" means below.

---

## Text and payload

- **Cover text** — the visible text that carries the mark. The input to `encode`.
- **Marked text** — the output. With substitution carriers it has the same character
  count as the cover; with insert carriers it does not.
- **Payload** — the bytes being hidden. The generic thing spab transports.
- **Message** — a payload interpreted according to its type. `"3f2504e0-…"` is the
  message; the 16 raw bytes are the payload. `metadata.messageBytes` is the opened
  size, `metadata.payloadBytes` the size actually stored on the wire.
- **Type** — a **5-bit** field naming what the content is: `string`, `json`, `bytes`,
  `ser8`, `uuid`, `sha256`, `program`, `encrypted`. A *fixed* type implies its length
  and so carries no length field, and it **compacts**: a UUID travels as 16 bytes
  rather than 36 characters.
- **Packet** — the container written into the channel. Replaces the older word
  *frame*; see **wire format v2**.

## The channel

- **Carrier class** — one family of interchangeable characters: `ws`, `apos`,
  `hyphen`, `wsdense`, `zwsp`. Each is an **independent parallel channel carrying the
  whole payload**, so capacity across classes is *not* additive — what decides whether
  a payload fits is the largest single channel. The extra classes buy failure
  diversity, not room.
- **Site** — a position where a carrier can be read or written. For `ws`, an
  inter-word gap; for `apos`, an apostrophe.
- **Variant** — one of the interchangeable glyphs a site can take.
- **Radix** — how many variants a class has, hence bits per site: `ws` = 4 (2 bits),
  `wsdense` = 8 (3 bits), `apos`/`hyphen` = 2 (1 bit).
- **Substitution vs insert** — a substitution carrier swaps an existing character, so
  the text stays exactly as long. An insert carrier (`zwsp`) *adds* zero-width
  characters: far more capacity, but the document grows in bytes and the mark is
  obvious in a hex dump.
- **Length-preserving** — the property that marked and cover text have identical
  character counts. The main reason to prefer substitution carriers.
- **Confusable / homoglyph** — characters that render near-identically. The basis for
  visually safe variants.
- **Failure diversity** — the reason for running several classes. NFKC normalisation
  destroys the whitespace channel and leaves the confusables; smart-quote autocorrect
  does the reverse. They fail on *different* edits, which is the point.

## Wire format v2

The packet, bit by bit. There is deliberately **no magic number** — the header's own
plausibility plus the checksum is the discriminator.

```
 bits   0        3        8       11       14
        +--------+--------+--------+--------+
        | ver:3  | type:5 | comp:3 | enc:3  | cksum:3 |   17-bit fixed header
        +--------+--------+--------+--------+
        [ extension bytes, grouped, in field order ]      only for escaped fields
        [ len varint ]                                    only when not implied
        [ checksum, 8 << cksum bits ]                     BEFORE the content
        [ content ][ pad to a byte boundary ]
```

- **Fixed header** — the 17 bits above, always present, always this shape.
- **Escape** — the all-ones value of any enumerated field, meaning "8 more bits
  follow". Grouped after the fixed header, in field order.
- **varint** — 7 bits per byte, high bit set means another follows. One byte to 127.
- **Checksum exponent** — `cksum` is an exponent, not a size: `bits = 8 << n`, so
  0 → 8, 1 → 16, 2 → 32, up to 5 → 256. CRC below 64 bits, truncated SHA-256 at and
  above. There is **no "none"**: with no magic number, the checksum is what finds a
  packet at all.
- **Why the checksum precedes the content** — tail truncation and mid-excerpt are the
  commonest losses, and a trailing checksum dies with the data it protects. In front,
  a surviving header says what the missing bytes should have hashed to, which turns
  the checksum from a pass/fail gate into an oracle the erasure decoder can query.

## Transforms

Applied in this order, and undone in reverse:

```
  message ──▶ serialize ──▶ compress ──▶ encrypt ──▶ packet ──▶ ECC ──▶ carriers
              (type)        (comp)       (enc)
```

- **Compression** — attempted on every payload and **kept only if strictly smaller**.
  spab payloads are usually 8–200 bytes and every general-purpose compressor *expands*
  inputs that small, so unconditional compression would make the common case bigger.
  `lzss` is implemented; `deflate-raw`, `gzip`, `brotli`, `zstd` have code points.
- **Encryption** — AES-256-GCM under `params.encKey`. The content becomes
  `nonce ‖ ciphertext ‖ tag`, costing 28 bytes. An encrypted mark is still
  **findable without the key**, because the packet keeps a plaintext checksum.
- **Keyed scramble** (`params.key`) — a different thing from encryption. Whitens and
  interleaves the *symbol stream*, which raises the cost of stripping and hides
  structure. A cost multiplier, not confidentiality. The two compose.

## Error correction and synchronisation

- **Repetition** — the default. Write the packet as many times as capacity allows,
  majority-vote per bit on decode. `metadata.reps` is how many copies fit.
- **Redundancy** — how many copies fit. **The variable that moves recovery**, far more
  than the channel does: measured recovery for length-preserving carriers is about 29%
  at one copy against 57% at five to eight. Any table that averages across cover
  lengths describes neither case.
- **RLNC** (`ecc: 'rlnc'`) — a GF(256) systematic random-linear fountain. Each packet
  is `[esi][data][crc]`, self-checking and self-locating, and packets pool across
  carrier channels. Needs **K linearly independent** packets, not merely K.
- **Geometry** — how a fountain packet divides its bits. `params.rlncGeom` selects one
  of `v1` (16/8/8), `default` (8/16/8), `wide` (16/32/16) or `widest`. Only the data
  field is byte-aligned; the index and check are bit fields and never enter GF(256).
  **Packet width is not free**: the modem groups sites into 32-bit blocks, so a packet
  wider than a block cannot be realigned by the resync sweep — desync recovery falls
  from 20% at 32 bits to 1% at 40.
- **ESI** — encoding symbol id. `esi < K` is *systematic* (the data is source symbol
  `esi` verbatim); `esi ≥ K` is a *repair* equation, a random GF(256) combination.
  The coefficients are a pure function of `esi`, so the same id always encodes the
  same equation — which is why the id may **wrap** once the space is exhausted: a
  wrapped packet is a duplicate copy, not a conflicting equation.
- **Erasure vs error** — an *erasure* is a lost symbol at a known position; an *error*
  is a wrong symbol at an unknown one. Erasures are much cheaper to repair.
- **Desync** — an insertion or deletion that shifts every symbol after it. The hardest
  error class here, because redundancy does not help: every copy shifts together.
- **Phase sweep** — the answer to desync. The decoder re-cuts the block grid at each
  of 32 offsets, so a shift becomes "try phase *p*".
- **Scan-anywhere** — packets are self-contained and checksummed, so one intact copy
  can be found at any offset without agreement from its neighbours.
- **Mixed-radix block** — bits are packed across sites of differing radix in bounded
  blocks, recovering the fractional bits of a non-power-of-two radix. Consequence
  worth knowing: **every site in a block affects every bit of that block**, so one
  damaged carrier costs up to 32 bits. Not the same "block" as below.

## The soft layer

- **Likelihood field** — the output of `SPAB.detect()`: a window slid over the carrier
  sites reporting, at each position, the histogram and how close it sits to what an
  encoded stream produces. A field over position, not a verdict.
- **Collapse estimate** — how much of the carrier alphabet has been folded back to its
  default glyph, measured from the histogram alone. **The carrier histogram is the
  pilot**: an intact marked stream is near-uniform over the radix, so excess mass on
  the plain space measures normalisation the text has been through. Unmarked prose
  estimates ~0.99, a freshly marked passage ~0.41, and the same passage after NFKC
  returns to ~0.99.
- **Posterior / site confidence** — `P(sent | observed)` per site. Deliberately
  **asymmetric, because the channel is**: nothing turns a plain space into a thin
  space, so observing a variant is near-certain, while observing the default glyph is
  ambiguous in proportion to the collapse estimate.
- **Sliding histogram detector (planned as a modem)** — today `detect()` reports the
  field; using it to acquire per-region phase and feed likelihoods to the fountain
  decoder is the target design. The shipping demodulator is the degenerate `n = 1`
  case of it: one site, one hard digit.

## Status words (`decode().metadata.status`)

Ordered as the decoder ranks them. **A recovered payload always outranks one that was
merely located** — an unranked status once caused a channel holding an unopenable
packet to mask a channel that had the payload.

| status | meaning |
|---|---|
| `perfect` | recovered, full bit agreement, checksum valid |
| `corrected` | recovered after ECC repaired corruption |
| `encrypted` | packet located and verified; needs a key |
| `auth-failed` | packet located and verified; the key was wrong |
| `unsupported` | packet located and verified; this build cannot open it |
| `corrupt` | packet located and verified; the content would not open |
| `failed` | something was there; the checksum did not hold |
| `not-detected` | no packet found — clean text, or fully stripped |

The four middle statuses all mean **a real packet was found and its checksum
verified**, which is a different fact from "nothing is here" and callers can act on
the difference.

## Measurement

- **Channel model** — a deterministic damage function `(text, intensity, rng)`.
  Catalogued in `r_and_d/attacks.js`, split into `control` (must always survive),
  `channel` (ordinary handling) and `attack` (deliberate removal).
- **Recovery** — exact-payload match rate under a model. Always reported alongside the
  redundancy it was measured at, for the reason under **redundancy**.
- **False positive** — a payload claimed from unmarked text. Must be zero.
- **Wrong payload** — a *damaged* mark decoding to something other than what was
  written. Must be zero, and is a stronger requirement than recovery: losing a mark is
  a non-answer, returning a different one is a false provenance claim.
- **Agreement** — mean per-bit agreement across redundant copies.
- **Distortion** — the share of eligible sites the encoder actually changed. The
  steganalysis-relevant figure, since an untouched site looks like any other.

## What spab does not claim

- **Not resistant to deliberate removal.** Anyone who knows the carrier set can strip
  it, and rewriting the text removes it entirely. The design raises the cost and makes
  stripping detectable; it never claims to be unbreakable.
- **Encryption protects contents, not survival.** An encrypted payload is confidential;
  it is no more likely to survive a normaliser than a plaintext one.
- **Capacity is not robustness.** A payload that fits once is fragile. Reading a
  capacity table as "how much fits" rather than "how much fits several times over"
  produces brittle marks.
