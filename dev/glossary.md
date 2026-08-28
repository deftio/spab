# spab glossary

Shared vocabulary so the docs, code, and API stay consistent. When a term here has a
precise meaning, use it that way everywhere (identifiers, comments, metadata keys).

## Text & payload

- **Cover text** — the visible text that carries the mark. Never altered visibly (beyond
  carrier substitution).
- **Payload** — the bytes being hidden. The generic thing spab transports.
- **Message** — a payload interpreted as a value per its type (string, uuid, json…).
  "Message" is the user-facing form; "payload" is the byte form.
- **Type** — a small tag (2–3 bits) saying how to interpret the payload bytes
  (`bytes` / `string` / `json` / `uuid` / `program` / …).
- **Frame** — the serialized container written into the channel:
  `[magic][len][content][crc]` in the baseline. Adds sync + integrity to the payload.
- **Magic** — a fixed sync/sanity byte (0xA5 in the baseline) that lets `decode` reject
  un-watermarked or stripped text instead of inventing a payload.

## Channel & symbols

- **Carrier** — a character position used to hold hidden bits (an inter-word space, and
  later punctuation/confusables).
- **Variant** — one of the visually-interchangeable glyphs a carrier can take
  (e.g. U+0020 / U+2006 / U+2009 / U+200A). The chosen variant encodes the bits.
- **Symbol** — the unit of information at a given layer: in the baseline, the 2 bits held
  by one carrier; in block-histogram coding, the value carried by a whole block.
- **Slot** — a *structural position* where a carrier is read/written (a gap between two
  word chars). The slot model makes the channel positional so pre-existing carriers
  elsewhere are ignored. See **in-band problem**.
- **Symbol library** — the set of carrier classes + their variant maps that are enabled.
- **Homoglyph / confusable** — characters that render (near-)identically; the basis for
  visually-safe variants.

## In-band problem

- **In-band problem** — carrier glyphs can occur naturally in the cover text, so a naive
  reader can't tell hidden symbols from incidental ones. spab addresses it with the slot
  model + encode-time **normalization**.
- **Normalization (encode-time)** — resetting carrier positions to a canonical base before
  writing, so every read slot value is one spab placed.
- **Desync** — an insertion/deletion that shifts the slot/symbol stream out of alignment.
  Distinct from a substitution; the hardest error class here.

## Coding & ECC

- **ECC** — error-correcting code applied to the symbol stream so corruption can be healed.
- **RS** — Reed–Solomon; the baseline/erasure-friendly code. Corrects up to `n/2` byte
  errors for `n` parity bytes (≈2× as many erasures).
- **Erasure vs. error** — an *erasure* is a lost symbol at a *known* position (cheaper to
  fix); an *error* is a wrong symbol at an unknown position.
- **Fountain / rateless code** — (LT, Raptor) emits as many coded symbols as capacity
  allows; the decoder recovers once it has collected *enough*. Fits unknown text length.
- **Repetition + majority** — the baseline "ECC": write the frame many times, majority-vote
  per bit on decode. `reps` = how many copies fit.
- **Redundancy / reps** — number of payload copies spread across the text.
- **Interleaving** — scattering each logical block's carriers across the text (chunk size
  `k` < block size `n`) so a burst erasure becomes spread erasures. **Depth** = `n / k`.
- **PN sequence / spreading code** — a pseudo-random but *reproducible* sequence (from an
  **LFSR** / primitive generator polynomial over GF(2⁸)/GF(2⁹)) used to choose scattered
  slot positions for a block. Encoder and decoder share the seed/polynomial.
- **LFSR / primitive polynomial** — linear-feedback shift register whose primitive
  polynomial yields a full-period (m-sequence) permutation; the placement/keying primitive.
- **PN placement / spread-spectrum placement** — gathering a block's subblocks from
  PN-selected positions across the whole passage (vs. contiguous or fixed-stride
  interleaving). Maximizes burst tolerance; placement is key-dependent.
- **Position-tagged symbol** — a symbol that spends some of its bits on its own stream
  position/sequence index (e.g. 4 data + 4 position), so decode can resync after cut/paste
  and hand ECC correct erasure positions. Alternative: self-identifying **fountain** symbols.
- **CDMA overlay** — using orthogonal PN codes to embed multiple independent payloads in the
  same text (open question).

## Block-histogram coding

- **Block** — a window of `n` carriers whose *distribution* of variants encodes a symbol.
- **Block-histogram coding** — reading the aggregate variant histogram over a block as one
  soft symbol (spread-spectrum flavor), rather than one glyph = one symbol.
- **Hist-encoding-1** — the sequential (non-interleaved) version: contiguous blocks. Simple
  but burst-fragile; motivates interleaving.
- **A/B framing** — alternating two carrier sets block-to-block as a self-clocking signal so
  the decoder can find block boundaries under length drift.
- **Soft-decision / likelihood** — decoding that carries per-symbol probabilities rather than
  hard bits, feeding ECC confidence/erasure information.
- **Detection gate** — a histogram/density test answering "is this text encoded at all?",
  producing the reported confidence and the `not-detected` status.
- **Sliding-window / correlation decoding** — advancing one char at a time and comparing each
  window's carrier distribution against the known target histograms (a matched-filter /
  broadcast-receiver approach). The correct alignment "correlates"; sync and detection fall
  out for free. Windows update incrementally (O(1)/step) and the sweep is SIMD/GPU-friendly.
- **Matched filter / acquisition** — the correlation step that locks onto the correct block
  alignment amid many non-matching offsets.
- **Correlation score / divergence** — the distance (chi-square, KL, L1, correlation) between an
  observed window histogram and a target symbol histogram; doubles as a soft likelihood.

## Metrics & testing (harness)

- **Capacity** — how many payload bits a passage can hold (bits/slot × slots).
- **Recovery** — exact-payload match rate under a corruption model.
- **Detection rate** — fraction of trials where `decode` reports a (non-failed) frame.
- **False positive** — a CRC-valid payload claimed from un-watermarked text. Target ~0%.
- **Confidence** — `decode`'s self-reported success probability.
- **Agreement** — mean per-bit agreement across redundant copies.
- **Robustness curve** — recovery vs. corruption intensity, per model.
- **Corruption model / channel** — a deterministic damage function `(text, intensity, rng)`.
- **R&D corpus** — the large (25k–100k) deterministic generated set for tuning/statistics.
- **CI subset** — the small fixed prefix of the same generator, run on every commit.

## Status words (decode `metadata.status`)

- **`perfect`** — recovered with full bit agreement and valid integrity check.
- **`corrected`** — recovered via ECC after some corruption; integrity check passed.
- **`failed`** — a frame was detected (magic seen) but the payload didn't validate.
- **`not-detected`** — no spab frame found (clean text, or fully stripped).
