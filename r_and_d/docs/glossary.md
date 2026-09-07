# spab research glossary

**Shipping vocabulary lives in [`docs/glossary.md`](../../docs/glossary.md)** — carrier
classes, the wire format, transforms, status words, and everything the API exposes.
That file is checked against the implementation by `tests/wire.test.js`.

This file is the **design and research** vocabulary: terms for schemes that are
proposed, exploratory, or deliberately not built. It is not checked against anything,
because most of it describes things that do not exist yet.

That distinction is why this file was split. It previously carried both, and the
shipping half rotted: it documented a `[magic][len][content][crc]` frame two formats
after that frame was retired, called the type field "2–3 bits" when it is 5, named
Reed–Solomon as the baseline code when the codec has never used one, and listed a
`tampered` status that was never implemented. A glossary nobody tests is a glossary
that lies eventually.

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
  reader cannot tell hidden symbols from incidental ones. spab addresses it with the slot
  model plus encode-time **normalization**. A live instance: U+200D is both a zero-width
  carrier variant and the emoji joiner, so a family emoji's own joiners were read as
  payload until the extractor learned to skip joiners between pictographs.
- **Normalization (encode-time)** — resetting carrier positions to a canonical base before
  writing, so every read slot value is one spab placed.
- **Desync** — an insertion/deletion that shifts the slot/symbol stream out of alignment.
  Distinct from a substitution; the hardest error class here.

## Coding & ECC

- **ECC** — error-correcting code applied to the symbol stream so corruption can be healed.
- **RS** — Reed–Solomon. A candidate inner code, **not** what spab uses: the shipping
  codec offers repetition and a GF(256) RLNC fountain. Listed because it keeps coming
  up as an option for the inner-code slot (see `dev/roadmap.md`).
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
- **Transposition dictionary** — a user-supplied set of permitted equivalent swaps (synonyms,
  spelling/punctuation variants) whose probabilistic choice carries signal; a word-level carrier
  class, akin to LLM-output-bias watermarking done as post-processing. Exploratory/deferred.
- **Payload profile** — a named test payload spanning the capacity spectrum: `magic` (4B),
  `magic8` (8B), `sha1` (20B), `sha256` (32B), `json` (~67B), `program` (130B+).
- **regexAttack** — corruption model for an informed adversary stripping a fraction of the
  carrier variants (1.0 = full strip). Always defeats the whitespace channel; an honesty check.
- **Adversary cost / cost-escalation** — the posture of making removal *expensive, lossy, and
  visible* rather than impossible: carrier–content overlap (collateral), defense-in-depth across
  channels, key-gated carriers over a large pool. Ceiling: a rewriter always wins.
- **Tamper-evidence** — detecting that a watermark *was present and stripped* (vs. never present)
  even when the payload can't be recovered; surfaced as a `tampered` decode status. Denies clean,
  deniable removal.

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
- **Reacquisition** — continuously re-locking the signal while stepping through the text
  (alignment, boundaries, and noise floor drift; cut/paste jumps them). Acquisition is ongoing,
  not one-shot.
- **M-ary alphabet** — a symbol set of M distinguishable histogram shapes, carrying log₂(M) bits
  each; M need not be a power of two. Pairs naturally with non-binary ECC (RS over GF(M)) or
  range-coded bit packing.
- **Pilot / sync symbol** — a reserved histogram class used for framing/reacquisition instead of
  data (shrinks the data alphabet to M−1); the M-ary analogue of a pilot tone.
- **Correlation score / divergence** — the distance (chi-square, KL, L1, correlation) between an
  observed window histogram and a target symbol histogram; doubles as a soft likelihood.

## Metrics & testing (harness)

- **Capacity** — how many payload bits a passage can hold (bits/slot × slots).
- **Serial regime** — tiny payloads (≤ ~8 B) where whole-message repetition + majority vote
  is the main tool; short passages suffice.
- **Hash regime** — 160–256+ bit payloads (SHA-1/SHA-256) where repetition fails; needs real
  coding (fountain/soft) over the whole payload plus higher bits/slot to keep text reasonable.
- **Excerpt locality / locality of recoverability** — the property that a fully-decodable unit
  sits within any retained span, so lifting a section out still yields the mark. Repetition has
  it; globally-spread FEC does not.
- **Tile / independently-decodable unit** — a small self-contained FEC-coded unit (payload +
  parity + integrity) tiled across the text so any large-enough excerpt contains ≥1 whole unit.
  Efficient internally, local by tiling — the synthesis of FEC and repetition.
- **Flag/continuation coding (type)** — encoding the type as a 1-bit flag + 7-bit value
  (varint-style) inside the ECC-protected stream, so typeless payloads cost nothing and typed
  ones cost ~one unit, rather than a mandatory header byte.
- **Recovery** — exact-payload match rate under a corruption model.
- **Detection rate** — fraction of trials where `decode` reports a (non-failed) frame.
- **False positive** — a CRC-valid payload claimed from un-watermarked text. Target ~0%.
- **Confidence** — `decode`'s self-reported success probability.
- **Agreement** — mean per-bit agreement across redundant copies.
- **Robustness curve** — recovery vs. corruption intensity, per model.
- **Corruption model / channel** — a deterministic damage function `(text, intensity, rng)`.
- **R&D corpus** — the large (25k–100k) deterministic generated set for tuning/statistics.
- **CI subset** — the small fixed prefix of the same generator, run on every commit.

