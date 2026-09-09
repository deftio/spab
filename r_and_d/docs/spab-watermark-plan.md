# spab — Watermark Plan

Design and implementation plan for spab: a JavaScript library that embeds a hidden payload into text using a library of visually subtle symbol substitutions, protected by error correction so it survives ordinary editing. See `text-watermark-research.md` for background and attributions.

This is an idea Manu has had for a long time. Fraunhofer ISST's Innamark covers the same territory, but it is Kotlin/JVM-centric and not a drop-in for JS — and spab intends to push further on the encoding/decoding model: a richer symbol library, variable bits per symbol, graceful behavior on short passages, and a typed payload container (watermark / UUID / raw bytes / even an executable program).

> **North star: information-entropy management.** Every carrier class is a place where text holds *spare entropy* — equivalent choices a reader won't notice (which space, which dash, straight vs. curly quote, one synonym vs. another). spab measures that latent capacity, spends some of it on signal, and keeps enough margin (redundancy + ECC) to survive the channel. It's rate–distortion at heart: capacity vs. robustness vs. how much the text may change. Confusables and the transposition dictionary matter because they are simply *more sources of the same free entropy*.

> **Status: exploratory design notes.** These are working ideas, not a locked spec. Several sections (soft-decision decoding, block-histogram coding, context conditioning, executable payloads) are directions to prototype and prove out, not committed decisions. Expect them to change as we experiment.

## Framing: this is classic DSP, not ML

The spab data path is **classic signal processing applied to text**: modulation (bias whitespace variants / shape a block histogram), demodulation (matched-filter correlation, soft symbol estimates), synchronization/acquisition, and forward error correction. The codec itself is deterministic — the same input always encodes/decodes the same way.

**Where ML may legitimately appear: choosing parameters, not generating bits.** Selecting detector thresholds, window/block sizes, symbol-shape sets, or interleave depth is an optimization problem, and it's fair game to use ML/optimization to fit those against corpus statistics (learn a threshold, search a window size, tune a symbol dictionary). That's parameter selection / calibration — a knob-fitting step whose *output is a fixed configuration* the deterministic codec then runs. It is emphatically **not a gen-AI / large-model situation**: no learned end-to-end demodulator, no generative model in the pipeline, nothing that makes decoding non-deterministic or unexplainable. So: DSP core, optionally ML-assisted tuning of its parameters, deterministic at runtime.

Terminology, to keep it honest: the big corpus is the **development / tuning corpus** (for measurement and parameter fitting), and the small fixed slice is the **CI corpus** (for regression) — earlier drafts called these "training/R&D," which over-implied a learned model. Some tuning may be ML; the codec is not.

## Two approaches (and why we currently lean histogram)

The design has evolved between two ways to put bits into text, and it's worth recording both.

- **Approach A — direct per-symbol coding (the original idea).** Embed simple symbols (spaces, tabs, whitespace variants); some combination of them *is* the symbol. The document becomes a linear stream of these symbols, and ECC pulls the message back. This is intuitive and is exactly what the **baseline `0.1.0`** implements (2 bits per space, repetition ECC).
- **Approach B — histogram / block coding (current lean).** Don't read individual glyphs; read the **statistical distribution of carriers over a block/window** as one (soft, M-ary) symbol, recovered by continuous matched-filter reacquisition, then hand the symbol stream to ECC.

**Why the lean toward histogram** — intuition, to be validated by measurement: the per-symbol stream is positional and brittle, so a single insertion/deletion desyncs it, and the harness already shows exactly this (cutPaste / wordDelete collapse to ~0). A histogram is an *aggregate*, so it is inherently soft, tolerant of per-position noise, and far less disturbed by a stray inserted/deleted character or a lifted excerpt — it degrades gracefully where the per-symbol stream falls off a cliff.

This is a hypothesis, not a verdict. Approach A stays in the repo as the documented baseline and the number to beat; both live behind the same `encode`/`decode` interface and the same benchmark harness, so when the histogram path is built (as `0.2.x`) we compare them head-to-head on identical corruption models rather than arguing from intuition.

## Goal

Embed a hidden payload (copyright mark, UUID, raw bytes, or a small program) into plain text such that the output looks identical to a human, the payload survives realistic tampering (copy/paste, reformatting, partial deletion), and recovery reports a confidence estimate rather than a bare pass/fail. Robust, not the fragile trailing-space (SNOW) approach.

Core design tensions to solve:

- **Passage size vs. capacity.** A short passage has few embedding slots, so any mark is small and brittle. A long passage has many slots, enough to carry a real message *and* heavy redundancy. spab should scale gracefully across this range and be honest about what a given passage can hold.
- **Error correction is the linchpin.** The whole scheme only works because ECC + redundancy can rebuild the payload after words, sentences, or whole sections are edited away.
- **Symbol richness vs. safety.** The more symbol variants we use — and the more bits some symbols carry — the higher the capacity, but the greater the risk of visible artifacts or fragility. The symbol library must be tunable and self-describing.

## Public API

Two functions. The baseline `0.1.0` ships the minimal `(text, message, params)` form; the
target form surfaces the common transform options (key, compression) as first-class arguments
while keeping `params`/`options` for the rest:

```js
// baseline (implemented)
encode(text, message, params) → { text, metadata }
decode(text, params)          → { message, metadata }

// target form
encode(baseText, message, key, options) → { text, metadata }   // options.compression = 'auto' | id | 'none'
decode(markedText, key, options)        → { message, metadata }
```

### encode(baseText, message, key?, options?)

- `baseText` — visible cover text to carry the mark.
- `message` — payload: a string, bytes, or a typed object (see Payload framing).
- `key` — optional encryption key/passphrase. Absent → payload is not encrypted. Present →
  ChaCha20-Poly1305 with the key stretched deterministically (KDF/PN/repeat); the encoder also
  emits key-strength warnings (advisory).
- `options` — configuration, including **`compression`** (`'auto'` default = try all implemented
  codecs and keep the smallest; or a codec id; or `'none'`), symbol-library profile, ECC settings,
  header mode, redundancy strategy, and payload `type`.
- Returns watermarked `text` + `metadata`: raw capacity of the passage (bits/symbols available),
  capacity used, redundancy/repetition achieved, payload `type`, **chosen compression codec + ratio**
  (which one `auto` picked and how much it saved), whether encryption was applied, warnings/issues
  (passage too short → brittle; weak key; codec unavailable), and the effective options used.
- If the passage cannot hold the payload at the requested ECC level, that is surfaced as an issue
  (and/or a thrown error) — never a silent truncation. Marginal passages still encode but flag low redundancy.

### decode(markedText, key?, options?)

- `markedText` — possibly-tampered watermarked text.
- `key` — the same key, required only if the payload was encrypted (decode learns *whether* it was
  from the frame flags; a missing/wrong key on an encrypted payload is reported, not guessed).
- `options` — must be compatible with the encode configuration, or (self-describing mode) decode reads
  type / compression id / flags from the frame and configures itself.
- Returns recovered `message` + `metadata`: `status` (`not-detected` / `perfect` / `corrected` / `failed`),
  payload type, compression codec used, symbols corrected, max correctable capacity, a success/confidence
  probability (detection gate + ECC margin), and a corruption / channel-health indicator.
- On unrecoverable corruption, `message` is null and metadata explains why (including "encrypted — key
  required/incorrect" and "compressed with codec N not available in this build").

## Symbol library (the channel)

The channel is a **library of subtle symbol substitutions**, not just whitespace. Each substitution class is a set of glyphs that render (near-)identically in normal contexts, where the chosen variant carries bits. The library is extensible and each class is used only where it naturally occurs in the text.

- **Inter-word whitespace** (primary, always available where there are spaces). Baseline 2 bits/space:

  | Bits | Char | Name |
  |------|------|------|
  | 00 | U+0020 | Space |
  | 01 | U+2006 | Six-per-em space |
  | 10 | U+2009 | Thin space |
  | 11 | U+200A | Hair space |

  More whitespace variants (U+2004, U+2005, U+202F, U+205F, U+2008…) can extend this to 3–4 bits/space where safe.

- **Punctuation & format confusables** (opportunistic — only when present):
  - periods / full stops and their homoglyphs,
  - bullet characters (•, ·, ‣, and confusables) in lists,
  - hyphen / minus / dashes (-, ‐, ‑, –),
  - quotes / apostrophes (straight vs. curly),
  - other Unicode confusables of common punctuation.

  These are lower-frequency than spaces but let some *symbols carry more bits*, and add capacity to text that is space-poor but punctuation-rich.

- **End-of-line trailing whitespace** (optional, parameterized — the classic SNOW channel). Appends tab/space combinations before newlines. Unlike the inline classes this is *detectable* and *fragile* (trailing-space strippers, linters, and git hooks remove it). spab treats it as an opt-in extra-capacity layer, off by default.

  **Decoy / honeypot use.** Because trailing whitespace is the obvious, well-known channel, it can double as a decoy: carry extra redundancy (or a plausible-but-lower-value copy) in the trailing-space layer while the real, hard-to-detect payload lives in the inline whitespace/punctuation classes. An attacker who strips trailing whitespace sees the visible channel disappear and may conclude they've defeated the watermark — when in fact they've only deleted redundant copies and the subtle inline mark survives intact. This is a parameter (`trailingLine: off | capacity | decoy`), because it's a genuine design choice: capacity vs. an intentional false sense of defeat.

Design rule: every symbol class must be (a) visually safe in normal rendering (trailing-line excepted — it's invisible but strippable), (b) strictly detectable on decode via a fixed character class, and (c) individually toggleable in `params` so a user can trade capacity/stealth/robustness — including deliberately sacrificial (decoy) layers.

### Transposition dictionary (probabilistic word/symbol swaps) — exploratory, later

A user-supplied **transposition dictionary** would let spab swap certain words or symbols for equivalents *probabilistically*, and read those choices back as signal. The dictionary grants permission ("you may replace X with {X, X′, X″}"), and the encoder biases which variant appears to shape a probability distribution — adding a whole new carrier class on top of whitespace/punctuation. Examples: synonym sets ("big/large"), spelling variants ("color/colour"), optional punctuation (Oxford comma on/off), contraction vs. expansion ("it's/it is"), or symbol equivalents. Each swap point carries a fraction of a bit via which choice was made; over a document these biases accumulate into a recoverable mark.

This is, in miniature, what LLM-output watermarking (e.g. Google's approach) does by biasing token-selection probabilities and recovering the bias statistically — here done as a **post-processing** step over existing text using a permitted-swap dictionary, rather than at generation time. Properties:

- **Higher capacity and more robustness to whitespace attacks** — the mark lives in word/punctuation *choices*, which survive whitespace normalization and reflow that destroy the whitespace channel. It composes with the histogram model as extra symbols.
- **The cost is visible edits** — unlike whitespace, this changes the actual words, so the dictionary must be constrained to swaps the author accepts as meaning-preserving and in-voice. It's opt-in and author-supervised by nature.
- **Fits the same pipeline** — swap choices are just more soft symbols feeding ECC; the transposition dictionary is another entry in the symbol library, weighted by how often each swap point occurs in the text.

Deferred (the user flagged "more on that later"); captured here so the channel model has room for it. Needs its own capacity/quality study — how many safe swap points real text affords, and how much bias is recoverable without harming readability.

## Variable bits per symbol

Not every slot has to carry the same number of bits. Where the text is long and a slot's symbol class supports many safe variants, that slot can carry more bits (a higher-alphabet symbol); where only a plain space fits, it carries fewer. The bit allocation is deterministic given the passage + params, so encode and decode agree on the per-slot capacity map.

This variable-rate stream is what feeds ECC: more total information slots means the ECC layer has more room for parity/redundancy, or a larger payload, at the encoder's choice. (Analogy: adaptive-rate modulation over a channel whose per-symbol capacity varies with what glyphs the text makes available.)

## The in-band problem: carrier characters that aren't ours

The carrier glyphs are ordinary characters — a thin space, a curly quote, an en-dash — and the cover text may already contain them for legitimate reasons. The decoder must not mistake a pre-existing carrier-class character for part of the encoded stream, or the whole bit alignment shifts. This is the central correctness issue, because inserting or dropping one symbol is a *desync* (insertion/deletion), and Reed-Solomon corrects substitutions, not desyncs.

spab's answer is to make the channel **positional, not global** — read symbols at defined *slots*, and normalize those slots at encode time:

- **Slot model.** Bits live only at structural positions the encoder and decoder both derive from the visible text the same way: inter-word gaps, the position after sentence punctuation, list-bullet positions, line ends (if enabled). The decoder reads exactly one symbol per slot. A thin space that happens to sit *inside* a word is not a slot and is simply ignored — it's out of band by position even though it's the same glyph.

- **Normalize-at-encode.** Before embedding, the encoder normalizes every carrier class *at slot positions* to a canonical base (all gap whitespace → U+0020, quotes → straight, dashes → hyphen, etc.), then writes its chosen variants. So every slot's value is one spab placed, never a leftover. Whitespace normalization is invisible; visible-ish normalizations (curly→straight quotes) are only applied when that class is enabled, and this is called out to the user.

- **Decode transparency.** The decoder applies the same slot derivation and the same canonicalization map, so it reads back exactly the variants written. Characters outside the enabled classes, or outside slot positions, pass through untouched and are never part of the stream.

- **Residual desync defense.** Real-world edits still insert/delete words (hence slots). Framing helps here: a short **sync/preamble** pattern lets the decoder find stream start, `length` bounds the payload, and the spreading/repetition layer means a localized desync corrupts some copies, not all. Where a slot is provably gone, mark it an **erasure** (cheaper for RS than an error).

Open design point: how much visible normalization is acceptable by default. The safe default is whitespace-only (fully invisible); punctuation/confusable classes ship off until we're happy they don't perceptibly alter the text.

## Probabilistic / soft-decision decoding

Because carrier glyphs can occur naturally, a hard "this symbol = these bits" read is fragile. spab should treat demodulation as a **statistical inference** problem: each observed symbol contributes a *probability* over what was intended, and the decoder recovers the most likely symbol stream, then hands that (with confidence) to ECC. This is soft-decision demodulation, and it turns the in-band noise from a correctness bug into just another source of uncertainty the math already handles.

Several layers to this:

- **Context-conditioned symbols.** A symbol's meaning can depend on its **preceding non-symbol character**. Schematically `x[s]` — the interpretation of `s` is conditioned on `x` (letter vs. digit vs. punctuation vs. end-of-sentence). Conditioning on context lets the same glyph mean different things in different places, which raises capacity and stealth, and lets the decoder down-weight symbols in contexts where that class is unreliable. (Cost: encoder and decoder must derive context identically — same rule as the slot model.)

- **Chains and deltas.** Meaning need not live in a single symbol. A run `[s1][s2]…` can encode information in the **sequence or the delta** between successive symbols (differential encoding), which is naturally robust to constant offsets and to some normalization that shifts all symbols the same way.

- **Noise tolerance by design.** The decoder must expect *extra* symbols that were never part of the payload (pre-existing carriers, editor artifacts). Rather than assuming every carrier is signal, it scores each against the model and lets low-probability observations fall out — as low-weight contributions or erasures — instead of derailing alignment.

- **Histogram / density detection gate.** Before trying to decode, ask: *is this text encoded at all?* Build a histogram of the target symbols over the passage (or per block) and compare its probability density against (a) what an unencoded natural text looks like and (b) what a spab-encoded passage should look like. A distribution that matches the "no watermark" profile short-circuits to `status: not-detected` with a probability, rather than emitting garbage. This same detector produces the confidence number reported in `decode` metadata.

- **Block-histogram → one soft symbol (spread-spectrum flavor).** Instead of one glyph = one symbol, a *block* of text can carry a symbol in the **aggregate distribution** of its carriers — the histogram over a block collapses to a single decoded symbol (with a likelihood). This spreads each payload symbol across many positions, so no single insertion/deletion is fatal and the decode is inherently soft. It trades raw capacity for robustness. Developed further below.

**Pipeline.** Decode becomes: derive slots + context → observe carrier symbols → soft-demodulate to a probability-weighted symbol stream (optionally via block histograms) → detection gate (encoded at all? confidence?) → resolve to hard symbols + erasures/likelihoods → **ECC** → parse frame. The ECC stage runs on the recovered symbol stream, exactly as before; everything above just makes that stream cleaner and annotated with confidence.

**ECC implication.** Hard-decision RS can consume this by taking the argmax symbols plus erasure flags for low-confidence positions (RS corrects ~2× as many erasures as errors, so soft info is valuable even without a soft decoder). If we want to exploit the likelihoods fully, a soft-decision code (e.g. an LDPC/convolutional/soft-RS variant) is the longer-term option — noted, not committed.

## Block-histogram coding (exploratory — the most promising direction)

*Not fully baked, but the most interesting thread.* The idea: stop reading individual glyphs and instead read the **statistical distribution of carriers over a block of text**.

- **Block = a window of text, size selectable** (e.g. 64 characters). Within that window there are many carrier opportunities — several kinds of spaces and several kinds of punctuation. Each carrier kind is a roughly **orthogonal variant** we can bias.
- **Encode by shaping the distribution.** To write a value into a block, the encoder nudges the *proportions* of the carrier variants in that window toward a target histogram. Many orthogonal variants → a rich histogram → enough distinguishable states to carry, say, an **8-bit symbol per block**.
- **Decode by measuring the histogram.** Read the carrier distribution over the block and match it to the nearest target histogram → one recovered symbol, plus a likelihood. Because it's an aggregate over many positions, a stray natural symbol or a single insertion/deletion barely moves the histogram — inherently soft and robust.
- **Detection with authority.** The same histogram gives a strong "is this encoded at all?" test: an encoded block has a deliberately shaped distribution that natural text almost never produces by chance, so the detector can report presence/absence with real confidence.

**Framing via alternating symbol sets (A/B windows).** A hard part of block coding is knowing where each block starts. Approach: define **two carrier sets, A and B**, and alternate which set a block draws from — block 0 uses set A, block 1 uses set B, block 2 uses A, and so on. The alternation is a self-clocking signal: the decoder locks onto block boundaries by finding the A/B/A/B rhythm (like alternating pilot/training symbols), so blocks stay framed even as text length drifts. It also gives a second, independent presence check.

**Then: stream of blocks → stream of symbols → heavy-spreading ECC.** Each block yields one soft symbol; the sequence of blocks is the symbol stream fed to error correction. For this regime, prefer codes that **spread the signal hard and degrade gracefully**:

- **Fountain / rateless codes (LT, Raptor).** Especially apt: capacity depends on passage length, and rateless codes let the encoder emit *as many* coded symbols as there are blocks, while the decoder recovers once it has collected *enough* — any enough. Natural fit for "we don't know how long the text is" and for surviving arbitrary chunk loss.
- **Turbo / LDPC codes.** Strong soft-decision performance near the channel limit, consuming the per-block likelihoods directly.

This whole path trades raw capacity for robustness and detectability, which is exactly the trade we want on short or hostile passages. It needs prototyping to find real numbers: how many orthogonal carrier states a 64-char block actually affords, how cleanly encoded vs. natural histograms separate, and how well A/B framing survives edits.

### Hist-encoding-1: sequential blocks (and why burst noise breaks it)

The straightforward version — call it **hist-encoding-1**: chop the text into contiguous blocks of `n` chars; in block *i*, shape the space/punct n-gram distribution to one of the symbol histograms; the decoder slides across the char stream, reads each block's characteristic histogram, and emits a **symbol stream** which then goes to ECC.

The weakness is **burst noise**. Because each block owns a contiguous run of text, any localized damage — a deleted sentence, a retyped paragraph, a cut-and-paste excerpt — wipes out *whole* blocks (whole symbols) at once. That is a burst-erasure channel, the hardest kind for most codes, and it's exactly what the baseline harness already shows killing recovery (`blockErasure`, `cutPaste`, `wordDelete`).

### Interleaving: spread each block across the whole text

Fix the burst problem the classic way — **interleaving**. Keep `n` chars of carrier per logical block, but don't lay a block down contiguously. Chop the text into small chunks of `k` chars (`k < n`) and assign consecutive chunks to *different* logical blocks, round-robin:

```
chars [0..k)    → block i
chars [k..2k)   → block i+1
chars [2k..3k)  → block i+2
...
(wrap back to block i after the last block, and continue)
```

With `n = 128` and `k = 32`, each logical block's contribution is scattered in 32-char chunks spaced far apart. Now a contiguous burst of length up to the interleaver stride only removes **one chunk from each of several blocks** instead of destroying any single block — it converts a *burst* erasure into *spread* erasures, which the per-symbol ECC handles far better. The knobs:

- **`n`** — carriers per logical block (histogram richness / bits per symbol).
- **`k`** — interleave chunk size; smaller `k` → deeper spreading → more burst tolerance, at the cost of more bookkeeping and sensitivity to fine desync.
- **interleaver depth** = number of blocks in flight = `n / k` (× however many blocks span the text).

This composes with everything above: interleaved histogram blocks → soft symbol stream → fountain/soft ECC, with A/B framing to keep block boundaries. It's the concrete path to prototype and measure against the burst-noise rows in the harness.

### PN spreading: pseudo-random placement (spread-spectrum)

Interleaving with a fixed stride is the regular case; the general case is **pseudo-random placement**. Rather than consecutive or evenly-interleaved chunks, gather each logical block's `k`-char subblocks from **PN-selected positions** scattered across the whole passage:

```
block n  =  slots [0..4)  ∪  [32..35)  ∪  [64..67)  ∪  ...   (positions from a PN sequence)
block n == one symbol;  ECC still runs over the concatenated symbol stream.
```

Generate the hop positions deterministically with a **primitive generator polynomial / LFSR** over a smallish modulus (GF(2⁸) or GF(2⁹) — 256/512), producing a full-period pseudo-random permutation of slot indices that encoder and decoder both reproduce from a shared seed. Properties:

- **Maximal burst tolerance.** Any contiguous cut removes a near-uniform random subset of *every* block instead of concentrating damage — the best case for per-symbol ECC. It's direct-sequence spread spectrum applied to text position.
- **Key-dependent placement.** Without the PN seed/polynomial you can't even locate the blocks, which adds stealth and a mild keying property (and, with orthogonal PN codes, a path to overlaying *multiple* independent payloads CDMA-style — see open questions).
- **Reuses one primitive.** The same LFSR/GF machinery can drive placement, the A/B set choice, and a fountain code's symbol selection.

The catch is indexing: PN placement is defined over **slot indices**, but cut/paste and desync renumber slots. So the decoder needs a way to recover *absolute* position before it can invert the permutation — which motivates the next idea.

### Position-tagged symbols (resync against cut/paste)

Let each symbol carry **both data and its own stream position**, so recovered symbols can be placed back on the timeline even after a cut/paste scrambles indexing — and so ECC gets *correct erasure positions* for what's missing. Concretely, an 8-bit symbol might split as **4 bits data + 4 bits (coarse/relative) position**, or a block might spend one whole symbol on a sequence counter.

The tradeoff to measure:

- **Spend bits on position** — robust resync against excerpting/reordering, at a direct capacity cost (halving payload in the 4+4 case).
- **Spend nothing, lean on ECC** — recover whatever symbols you can and let a strong code sort it out. **Fountain codes fit this beautifully**: each coded symbol already carries its own selector/seed as an identity, so "the symbol encodes its position" falls out for free, and the decoder just needs *enough* distinct symbols regardless of which survived. This may make explicit position bits unnecessary — the choice is really *position bits vs. a fountain-style self-identifying symbol*.

Prototype both and let the `cutPaste` / `blockErasure` rows in the harness decide.

### Sliding-window correlation decoding (matched-filter / broadcast-receiver model)

Decoding doesn't need to know block boundaries in advance. Regardless of block strategy (sequential, interleaved, or PN), the decoder can **slide one character at a time** and, at each position, gather the window's carriers under a candidate schema (next `n` chars / the interleaved set / the PN-selected set) and compare their **probability distribution** against the known target distributions. Either the observed histogram matches a known symbol's distribution or it doesn't. It is essentially a **matched-filter / broadcast-signal receiver**: most alignments are noise and won't correlate; the correct alignment lights up.

Why this is attractive:

- **Sync falls out for free.** No need to locate block starts — the correct offset is the one where correlation spikes. This directly attacks the desync problem that kills the baseline; cut/paste just means acquisition re-locks at a new offset.
- **Detection for free.** If *nothing* correlates above threshold across the whole passage, the text isn't encoded → clean `not-detected`. Same computation yields the confidence.
- **Naturally soft.** The distance between observed and target histograms (chi-square, KL divergence, L1, or a correlation score) is a per-symbol likelihood, feeding soft ECC.
- **Cheap and parallel.** Histogram comparisons are tiny; a sliding window updates incrementally (add the entering char, drop the leaving char) for O(1) per step, and the whole "try every offset × schema × symbol" sweep is embarrassingly parallel — a clear later win for **DSP/SIMD/GPU** once a scheme is settled. *(Not to be optimized now — just noting the headroom is obviously there for good encode/decode rates.)*

The cost shape is many cheap comparisons — O(positions × schemas × candidate-symbols) — which is exactly the kind of workload that vectorizes. This is the decoder-side counterpart to the block-histogram encoder and the most promising way to get robust, sync-free acquisition.

### Channel realities: a messy, low-SNR, M-ary channel

The channel — histogram statistics riding on natural text — is **inherently messy**. Natural whitespace/punctuation distributions are noisy, vary by document, and drift; the "signal" is a small bias on top of that. Consequences that shape the whole design:

- **Reacquisition is continuous, not one-shot.** The step-through decoder isn't "sync once, then read" — it is constantly re-locking as it slides, because alignment, block boundaries, and even the local noise floor shift through the passage (and jump at any cut/paste). Acquisition is an ongoing background process, like a radio receiver holding lock on a fading signal.
- **All authoritative information lives at the ECC layer.** The channel/acquisition layer only ever produces *soft proposals* — "this window looks like symbol s, with likelihood L". Nothing is trusted until ECC decodes. This is why type and payload are defined post-ECC: the channel is too messy to carry reliable bits on its own.

- **The symbol alphabet can be rich (M-ary), and need not be a power of two.** If we define M distinguishable histogram shapes, each symbol carries log₂(M) bits — e.g. 8 shapes → 3 bits. But M is free: nothing forces M = 2ᵏ. Handling non-power-of-two M:
  - **Non-binary ECC** fits naturally — **Reed–Solomon is already defined over GF(M)** (symbols, not bits), and fountain/soft codes can operate on symbols too. Working at symbol granularity avoids the bit-packing mismatch entirely.
  - **If we must map to bits**, pack base-M symbols with range/arithmetic coding to avoid wasting the fractional bit per symbol (a plain floor(log₂M) throws capacity away).
  - Choosing M a power of two is the simple case (clean bit packing) but is a *convenience*, not a requirement.

- **A symbol value can be spent on framing/sync (a pilot).** Optionally reserve one (or more) of the M histogram classes as a **pilot/sync symbol** rather than data — an in-band marker the matched filter can correlate against to hold lock or delimit blocks. Cost: the data alphabet shrinks to M−1 (or M−p) and a fraction of positions carry no payload; benefit: cheaper, more reliable reacquisition on a messy channel. It's the M-ary analogue of a comma/pilot tone, and complements (or could replace) A/B framing. Whether a dedicated pilot beats spending those symbols on more ECC is a measurement question.

## Error correction — family evaluation

The spab channel is unusual, so the "obvious" ECC choices aren't obvious here. What our channel actually looks like:

- **Soft, not hard** — the demodulator produces per-symbol *likelihoods* (histograms), so codes that consume soft input have a real edge.
- **Insertion/deletion prone (desync)** — edits add/remove words → add/remove slots. This is the hardest property: most classic codes assume symbols stay aligned and only get *substituted*. Sync errors break them.
- **Erasure-rich** — we often *know* a region was destroyed (normalized/stripped), which is cheaper to correct than an unknown error.
- **Unknown / variable length** — capacity depends on the passage, so rateless behavior is a natural fit.
- **Often short** — small payloads over few slots; some families have too much overhead to be worth it at small sizes.

### Comparison

| Family | Corrects | Soft input | Erasures | Sync (ins/del) | Rateless / var-len | Short-block fit | JS effort | Fit for spab |
|--------|----------|:----------:|:--------:|:--------------:|:------------------:|:---------------:|-----------|--------------|
| **Repetition + majority** | subst/erasure | ~ | yes | no | trivially | excellent | trivial | Good floor for tiny payloads; combine with detection. |
| **CRC (detect only)** | nothing (detects) | no | n/a | no | n/a | good | trivial | Use as the integrity/detection hash, not correction. |
| **Hamming / Reed–Muller** | 1–few subst | ~ (RM soft) | limited | no | no | ok | low | RM has nice soft decoding at short lengths; niche. |
| **BCH** | t substitutions | no | some | no | no | good | medium | Solid for fixed small binary blocks; hard-decision only. |
| **Reed–Solomon** | burst/erasure (bytes) | no (hard) | excellent (2×) | no | no | ok | low (have it) | Great on *erasures* once we know where; poor on desync/soft. Baseline, not first pick. |
| **Convolutional + Viterbi** | subst (soft) | yes | yes | no | streaming | good | medium | Strong soft inner code; pairs well as inner layer. |
| **Turbo** | subst (soft, near-limit) | yes | yes | rate-matched | ~ | poor at short len | high | Excellent BER but heavy; overkill for short passages. |
| **LDPC** | subst (soft, near-limit) | yes | yes | rate-matched | ~ | poor at short len | high | Best-in-class soft; JS impl + short-length design is a lot. |
| **Polar** | subst (soft) | yes | yes | no | no | medium | high | Modern, capacity-achieving; complex, less payoff here. |
| **Fountain — LT** | erasures (rateless) | ~ | excellent | via chunking | **yes** | needs many symbols | medium | Rateless matches unknown length; weak at very short. |
| **Fountain — Raptor/RaptorQ** | erasures (rateless) | ~ | excellent | via chunking | **yes** | better than LT | high | Best rateless option; standardized; heavier to implement. |
| **VT / Levenshtein codes** | **insertions/deletions** | no | some | **yes** | no | good (small) | medium | Directly targets our hardest error type; limited correction power. |
| **Marker / watermark codes (Davey–MacKay)** | **ins/del + subst** | yes | yes | **yes** | ~ | good | high | Purpose-built for sync channels; the "right" theory fit, most novel to build. |
| **Concatenated (outer + inner)** | depends | yes | yes | inner handles | outer can be rateless | tunable | medium–high | Likely the real architecture: sync-aware inner + erasure/rateless outer. |

### Reading of the table

- **Synchronization is the differentiator.** The families that actually address ins/del — **VT/Levenshtein**, **marker/watermark (Davey–MacKay)**, or a **sync layer** (markers/pilots, the A/B framing) feeding a conventional code — matter more here than raw BER performance. This is why RS alone underwhelms: it assumes alignment we don't have.
- **Likely architecture is concatenated.** An **inner** code/layer that restores synchronization and consumes soft likelihoods (markers + convolutional/soft, or a watermark code), wrapped by an **outer** erasure/rateless code (**fountain**) that mops up whole-block losses and handles unknown length. Detection/integrity via **CRC/hash**.
- **Ship-first vs. aim-for.** Simplest working baseline: **repetition + majority + CRC**, or RS-over-erasures once slot loss is detectable — enough to validate the pipeline. Aim-for: **markers/A-B sync → soft inner → fountain outer**.
- **Short passages** push toward repetition/VT/RM and away from turbo/LDPC/polar, whose gains need length spab often won't have.

### Redundancy & degradation (unchanged principles)

- **Spreading + interleaving** across slots so a contiguous deletion removes copies, not the whole message; de-interleave + combine on decode.
- **Erasure awareness** — mark provably-destroyed slots as erasures (cheaper than errors for every family above).
- **Graceful degradation** — on scarce slots, prefer a smaller payload with more redundancy over a full message with none; report the tradeoff in metadata.

## Payload-size regimes (serial → hash)

How much text a payload needs is the whole game, and it splits into two regimes. At the baseline's **2 bits/slot** (≈ 1 slot per inter-word gap ≈ 1 slot/word), with the `[magic][len][content][crc]` frame:

| Payload | Frame | Slots (words) for 1 copy | for 5 copies |
|---------|------:|-------------------------:|-------------:|
| serial 4 B | 7 B | 29 | 141 |
| 8 B | 11 B | 45 | 221 |
| **SHA-1 20 B (160 bit)** | 23 B | 93 | 461 |
| **SHA-256 32 B (256 bit)** | 35 B | 141 | 701 |
| 64 B | 67 B | 269 | 1341 |

- **Serial / tiny regime (≤ ~8 B).** Repetition dominates: a short passage holds several whole copies, majority vote does the work, and the harness shows real recovery. This is the sweet spot for IDs/serials/short tags — worth a dedicated tuned path where "multiple copies" is the main knob.
- **Hash regime (160–256+ bits).** Repetition stops being the answer. One bare SHA-256 copy already needs ~140 words, and you often can't fit even *two* whole copies — so majority-of-whole-copies degrades to no redundancy exactly when you need it. Here the design must shift to **real coding over the whole payload** (fountain/RS/soft) that heals from *partial* recovery, plus levers that raise capacity so the text stays reasonable.

**The capacity lever is bits/slot.** Doubling effective bits per slot halves the text a hash needs. Routes: a richer symbol library (3–4 whitespace variants, plus punctuation/confusable carriers where present) and block-histogram coding (many orthogonal states per block). Combined with fountain-style ECC, this is what makes 256-bit payloads practical in ordinary-length documents rather than requiring an essay.

**Consequence for the exact-match bar.** A 256-bit payload is unforgiving — one wrong bit fails an equality check — so at hash sizes recovery *must* come through ECC that reconstructs the whole value from surviving symbols, never from hoping every bit of one copy survived. (An integrity hash in the frame then confirms the reconstruction.)

## Repetition vs. FEC vs. excerpt locality

Plain repetition (copying the whole message) is *poor bit allocation for FEC* — a code spends parity far more efficiently than duplicating data. But repetition buys something a globally-spread code doesn't: **locality of recoverability**. If someone lifts a section out of the document (cut/paste, quoting a paragraph), a self-contained copy that happens to fall inside that section survives, whereas a payload spread thinly across the whole document is destroyed — you kept a fragment, but every symbol only appeared once, far apart.

So the real axis isn't "repetition vs. FEC", it's **how local a fully-decodable unit is**:

- **Global FEC (fountain/RS over the whole text)** — best efficiency and best burst tolerance *when the whole document is retained*. Loses to excerpting.
- **Repetition** — wasteful, but any surviving copy is self-sufficient; robust to excerpting.
- **The synthesis — independently-decodable tiles.** FEC-code a *small self-contained unit* (payload + its own parity + integrity), then **tile** that unit across the document so that any retained span above some length contains at least one whole unit. Each tile is efficient internally (real FEC, not dumb copies); tiling provides the locality. Unit size is chosen ≈ the smallest excerpt we want to survive.

This also exposes a genuine tension with **interleaving / PN spreading**: spreading maximizes burst tolerance *within a retained whole*, but excerpting wants the opposite — locality. A hierarchical layout resolves it: interleave/PN *within* a tile for burst tolerance, and keep tiles local for excerpt survival. The tile size is the knob between the two. Measure it against `cutPaste` (excerpt) vs. `blockErasure`/`saltPepper` (in-place damage) in the harness — they pull in different directions.

## Payload framing & message types

### Canonical pipeline (type is post-ECC)

The type indicator is **always inside the ECC-protected message** — it is the head of what ECC hands back, never a fragile pre-ECC header. The full pipeline, both directions:

```
encode:  [type + payload] → ECC → symbol stream → blocks (any block strategy)
                                              → histogram/signal shaping → text
decode:  text → histogram/signals → blocks (any strategy) → symbol stream
                                              → ECC → [type + payload]
```

So decode's job is to recover the symbol stream (via whatever demodulation/acquisition the block strategy uses), run ECC over it, and only *then* read the message — whose leading element is the type. Everything about placement, blocks, and sync lives below ECC; type and payload live above it, protected. Any sync/mode marker the block layer needs (A/B framing, a correlation preamble, or the baseline's magic byte) is a property of the *channel/acquisition* layer, not of the message — it is not the type.

**"Head of the message" is logical, not physical.** Where the type *bits* actually sit in the coded symbol stream depends on the ECC:

- **Systematic codes** (e.g. systematic RS, repetition) keep the message bytes verbatim in the output, so type could in principle be read early, before full correction — but only opportunistically, and it's still unreliable until ECC confirms it.
- **Non-systematic / diffusing codes** (fountain/LT/Raptor, turbo, LDPC) mix every input bit across many or all coded symbols, so the type is **spread across the whole ECC output** and only exists once decoding completes. There is no early peek.

Consequence: treat type as available *only after* ECC decode in the general case. Don't design a decoder that depends on reading type from a fixed early position unless the chosen code is systematic and that shortcut has been deliberately opted into. This also reinforces the flag/continuation encoding for type: it's a property of the decoded message stream, agnostic to how the code physically scattered it.

The decoded message is fundamentally a pair:

```
[ type, content ]
```

- **type is optional.** A payload may carry a leading type symbol, or not (a "typeless" raw payload — decode just returns the bytes). Whether a type symbol is present is itself a mode set at encode time and, ideally, signaled by the frame so decode isn't guessing.
- **the type symbol is tiny.** Cap the type space at ~4–8 kinds, so the type is only **2–3 bits** — cheap even on short passages. The set is fixed-but-extensible (reserve a value for "extended type" if we ever outgrow it).
- **richer type ⇒ richer content.** The type tells decode how to interpret `content`; a richer type implies a richer/structured content format. The content layout per type is defined separately and extensibly, so adding a type doesn't disturb the transport.

The **type is really a content-interpretation tag**: it tells decode how to turn the recovered bytes back into a value. Sketch (fits in 3 bits):

| # | type | content interpretation |
|---|------|------------------------|
| 0 | `bytes` | arbitrary byte array, returned as-is (generic) |
| 1 | `string` | UTF-8 text, decoded to a string |
| 2 | `json` | UTF-8 → `JSON.parse` to a structured value |
| 3 | `uuid` | fixed 16-byte identifier, formatted canonically |
| 4 | `program` | executable payload (see below) |
| 5–6 | reserved | future rich types |
| 7 | `extended` | escape hatch: next symbol(s) select an extended type |

Semantic roles like "watermark" are just conventions over these encodings (a watermark is usually a `string` or `uuid`); the transport only needs to know how to reconstruct the value, not what it means.

### Where the type lives, and how few bits it costs

A full **type byte** is expensive here — it's precious channel spent on metadata, and if it sits in a fragile header, losing it loses the whole decode. Two refinements:

- **Type belongs inside the ECC-protected stream, not a raw header.** Put type after coding so it's healed like everything else, rather than a naked prefix that a single corruption kills. (The one thing that may need to precede ECC is a tiny sync/mode marker — see the header ladder.)
- **Spend a bit, not a byte — a flag/continuation code.** Instead of a fixed byte, use a **1-bit flag + 7-bit value** scheme (varint / high-bit-continuation, like UTF-8): the flag says "this is a control/type symbol" vs "this is data", or "more type bits follow". Typeless payloads spend *nothing*; typed ones spend one flagged unit; rare rich types chain via the continuation bit. This makes type-cost proportional to how much typing you actually use, which matters most in the short/serial regime where every bit counts.

So the type is best thought of as an **optional, flag-coded, ECC-protected** element of the stream — not a mandatory header byte. Whether the flag convention or a fixed tiny field wins is a measurement question (overhead vs. decode complexity vs. robustness).

### Header — what actually goes in it

Beyond the type, the header is what makes decode self-configuring instead of relying on out-of-band params. Candidate fields, each individually optional so short passages pay only for what they use:

- **magic / version** — a few bits so the format can evolve and decode can reject noise that isn't a spab frame.
- **type** — the content-interpretation tag above (absent in typeless mode).
- **length** — payload size, so decode knows where content ends. More robust than a terminator symbol, which is vulnerable to trailing corruption.
- **flags** — which optional layers are on: ECC scheme/strength, compression, encryption, and the **symbol-library profile** (which carrier classes, how many bits each) so decode reads the stream exactly as it was written.
- **content** — the payload bytes.
- **integrity hash** — a short checksum/hash so decode can separate verified success (hash matches) from "recovered but unverified," and feed the confidence metric.

```
[ (magic/version) | (type) | length | (flags) | content | (integrity hash) ]
```

Because every header bit is stolen from a small, noisy budget, the header should be a **ladder of modes**, not one fixed layout:

- **bare** — no header; fixed params agreed out of band; just ECC-protected content. For the smallest passages.
- **typed** — type + length only.
- **self-describing** — full magic/version/flags/hash so decode needs no shared params.

### Payload transforms: compression & encryption (flags, not types)

StegCloak (and most serious payload steganography) applies **compression** and **encryption** to the payload. These are the right features, but they are **transforms/modifiers, not content types** — keep them out of the `type` enum (which stays "how to interpret the bytes": bytes/string/json/uuid/program) and put them in **flags** as a small transform stack. Clean separation: `type` says *what the content is*; `flags` say *what was done to it on the way in*.

The transform stack, applied in order on encode and reversed on decode:

```
encode:  payload → compress? → encrypt? → [type + content] frame → ECC → symbols → text
decode:  text → symbols → ECC → frame → decrypt? → decompress? → payload
```

- **Compression** (e.g. deflate/gzip, or a tiny domain coder) — pure capacity win: a JSON or program payload shrinks, so it fits in shorter text or leaves more room for redundancy. Directly moves the capacity-vs-robustness trade in the user's favor. Flag bit + codec id.
- **Encryption** (e.g. a stream/AEAD cipher with a user key) — confidentiality (only key-holders read the mark) *and* a second benefit for this channel: ciphertext is high-entropy/uniform, so the embedded bit stream looks random, which keeps the carrier-symbol histogram flat and less distinguishable. AEAD also gives integrity for free (can subsume the frame's hash). Flag bit + cipher id + nonce.

Both are optional, independently togglable, and cost only a flag when off — so the tiny "magic word" case pays nothing, while the "JSON/program in a novel" case gets compression for capacity and (optionally) encryption for privacy. This mirrors StegCloak's feature set but as first-class frame flags over spab's multi-carrier, ECC-protected transport.

**How the transform indicator is encoded — two options.**

- **Transform bits alongside the type** (leaning): the type is only 3 bits, so a couple of transform bits (`compressed?`, `encrypted?`, plus a small codec id) fit in the *same* header byte as the type. Orthogonal and cheap — "bits in the type byte," as you put it.
- **Enum-doubled types**: define encrypted/plain (and compressed/plain) variants of each core type. Simpler to switch on, but it multiplies the type table (4 combos × N types) and muddies the clean "type = interpretation" split. Prefer the transform bits unless header space is so scarce that folding everything into one enum wins.

**The real challenge is *which* algorithms.** The indicator is trivial; the choice is the substance, and it's constrained by the no-deps multi-language goal (must be hand-portable to JS/Rust/C/Python/Java without pulling a library).

- **Encryption — one cipher, decided: ChaCha20-Poly1305 (RFC 8439).** Assuming a good key, we commit to a **single** AEAD and support no others — no cipher-agility beyond a format-version bump. It is the right and only choice for this project's constraints:
  - **Dep-free portable by construction** — ChaCha20 is pure ARX (add-rotate-xor on 32-bit words): no S-boxes, no lookup tables, constant-time in plain software, ~200–300 lines to reimplement identically in JS/Rust/C/Python/Java. AES is the wrong pick here — safe, fast AES needs hardware or table tricks (naive table AES leaks timing), which fights the no-deps, five-language goal.
  - **AEAD** — Poly1305 authenticates, so decryption verifies integrity for free (subsumes the frame hash) and rejects tampered/garbage input cleanly.
  - **Standardized + verifiable** — RFC 8439 has official **test vectors**; every language port validates against the same vectors bit-for-bit. This is how we make "no third-party crypto lib" safe: implement one well-specified standard exactly, don't invent anything, and conform to the published vectors (and keep the ARX core constant-time).
  - **One choice = smaller surface** — less code to port and audit, fewer interop combinations, no downgrade/agility pitfalls. If it ever must change, that's a new format version, not a runtime menu.
  - Nonce: 96-bit (RFC 8439) stored or deterministically derived per the determinism rule above; if random nonces are wanted, the **XChaCha20-Poly1305** extension (192-bit nonce) is the only sanctioned variant.
  - **Key handling — stretch a user key to 256 bits, three options (security differs).** All three are deterministic; the distinction is that *stretching does not add entropy* — effective strength is capped by the original key's entropy regardless of method.
    - **KDF / hash (recommended)** — SHA-256 / HKDF of the passphrase to 256 bits. Adds diffusion (every key bit affects the whole key), hides the original key, and is still no-dep-portable. Best default, especially for human passphrases.
    - **PN / LFSR key continuation** — seed a PRNG (the same LFSR/GF primitive used for placement) with the key and run it out to length. Avoids the obvious periodicity of plain repetition; a reasonable stretch when the supplied key is already high-entropy, but it's a PRNG expansion, not a KDF.
    - **Repeat-to-length** — tile the key until it reaches 256 bits. Simplest, but periodic and weakest (structure in the key); acceptable only for an already-strong key, and mainly as a fallback.
    Guidance: default to the KDF; offer PN-continuation/repeat as explicit low-overhead modes for callers who supply full-entropy keys. Never present any of them as *increasing* security over the user's key.
  - **Determinism requirement — derivation must be repeatable.** Decode has to reproduce the exact key from the same passphrase, so key derivation must be a **pure, deterministic function** of its inputs — same passphrase (+ any *stored* public parameters) → same 256-bit key, every time, on every platform and language port. Precise, portable primitives only (defined-width integer/GF math, a fixed hash) — no locale-, float-, or platform-dependent behavior. This is also why "adding entropy" is the wrong mental model: a deterministic function can't manufacture entropy; the KDF adds **diffusion** and stretches to length, but repeatably.
  - **Corollary — any randomness must be stored or derived, never ephemeral.** If we introduce a **KDF salt** (to defeat precomputation) or a cipher **nonce**, it must be either (a) written into the frame as a public parameter so decode can reproduce the derivation/decryption, or (b) derived deterministically from key+content (SIV-style). An ephemeral random salt/nonce that isn't recorded makes the payload unrecoverable — the same rule as the placement PN seed and every other parameter: reproducible by construction, stored when not.
  - **Key-strength warnings (encoder-side, advisory).** Since stretching can't fix a weak key, the encoder should *estimate key strength and warn* — surfaced as non-fatal `metadata.issues` (the same channel that already warns "passage too short / low redundancy"), never blocking. Cheap, portable heuristics: minimum length, character-class diversity, a small built-in common-password/dictionary check, repeated/sequential patterns, and a rough Shannon-entropy estimate → an estimated-bits-of-security number. Message should be honest ("this key ≈ N bits; KDF stretching does not increase that; consider a longer passphrase"). Advisory only — respect the caller's choice, but make a poor key visible. (Purely local; never log or transmit the key.)
  - **Nonce.** A cipher needs a nonce. Either store a small random nonce in the frame (costs header bits) or derive it deterministically (SIV/nonce-misuse-resistant construction from key+content) so identical input reproduces identical output without a stored nonce. Tradeoff to settle; XChaCha20's large nonce eases the random-nonce path.
- **Compression — an 8-slot enum with an `auto` best-of mode.** A **3-bit codec id** (up to 8 lossless codecs) lives in the flags; the chosen codec's id is stored so decode reverses the right one. Codec `0 = none`. Modes:
  - **explicit** — caller picks a codec by id.
  - **`auto` (default)** — encode runs every *implemented* codec on the payload, keeps the **smallest result** (payload + its own overhead; ties → simpler codec), and records the winner's id. Encode is offline, so paying to try them all is fine; `none` is always in the race, so tiny payloads that don't compress just stay raw.
  Candidate codecs, ordered by port simplicity (all lossless, all hand-portable, no deps):
  `none`, **RLE**, **LZW** (dictionary; compact, public-domain), **LZ77/LZSS** (sliding window), **Huffman** (order-0), and **DEFLATE** (LZ77+Huffman; best ratio, but heavy to hand-roll in Rust/C — offer where a stdlib exists). A couple of the 8 slots stay **reserved** for future coders.
  - **Caveat — 8 codecs × 5 languages is real work** and cuts against the no-deps invariant. So: *reserve* 8 slots in the format, but only *implement a small simple set* first (none/RLE/LZW/LZ77); `auto` picks the best among whatever is implemented, and a payload compressed with a codec a given port lacks simply can't be decoded there (report it). Grow the set as ports warrant. Decide which few ship first by measuring ratio vs. port cost on the corpus.

**Ordering caveat.** Always compress *then* encrypt (encrypting first makes ciphertext incompressible). Note the standard compress-then-encrypt side-channel caveat (compressed-then-encrypted length can leak information about plaintext, CRIME-style) — for offline, whole-payload watermarks with no adaptive oracle it's an acceptable risk, but document it.

The active mode is the one thing that must be knowable up front (a couple of magic bits, or a param).

## Executable payloads (`program`) — exploratory

A stretch goal: a payload can be a small program, and spab can optionally "run" it. To keep this safe and generic:

- Define a tiny, well-specified bytecode / mini-language rather than executing host JS.
- Execution is opt-in, sandboxed, and off by default; decode never auto-runs a payload.
- Treat this as a v2+ exploration layered on top of the `raw` transport — the transport shouldn't care what the bytes mean.

(Security note: an executable payload embedded in copyable text is a natural injection vector. Any "run" capability must be explicit, sandboxed, and resource-limited.)

### Showcase use case — "the story that carries a secret"

A concrete, delightful demo (and a good design anchor for the *friendly* end of the channel): write a long story, hide a message — or a small program — inside its whitespace, then a spab decoder reveals it straight from the plain text. This is the ideal case for the current baseline: a long passage has thousands of inter-word slots, so capacity is ample (a paragraph-length secret or a SHA-sized token fits with redundancy to spare), and a demo has no adversary and no reformatting, so incidental robustness suffices. The message-reveal version works with `0.1.0` today; the program-reveal version is the `program` type above — the transport already carries the bytes; only the opt-in sandboxed runner is the stretch. It doubles as documentation of the design's friendly extreme (long text, no attack), the mirror of the short/hostile cases the harness stresses.

## Configuration (`params`)

- `eccBytes` / ECC scheme and strength.
- symbol library profile — which classes are enabled (whitespace-only, +punctuation, etc.) and max bits per class.
- variable-rate on/off (uniform vs. adaptive per-slot bits).
- redundancy strategy — target repetition count / interleaving depth, or "auto-fill available capacity."
- payload type + optional compression / encryption.
- encode and decode params must be compatible — or carried in the payload frame so decode can self-configure.

## Robustness targets

Must survive and report health under: copy/paste; reflow preserving word boundaries; deletion/replacement of words, sentences, or a paragraph; partial normalization of whitespace/punctuation.

Acceptable (and honestly reported) failure: all whitespace + punctuation normalized to ASCII defaults; full retype; dedicated invisible-char / confusable cleaners; passage shorter than minimum capacity for the chosen payload + ECC.

**Adversarial note — a good regex still wins.** Any party who knows (or guesses) the carrier set can destroy the mark with a one-line substitution, e.g. collapse `[    …]` to ` `. spab is designed for *incidental* robustness and does **not** promise to defeat a determined, informed adversary — the honest ceiling is that a patient rewriter (paraphrase/retype) always wins. But that ceiling is **not** a reason to punt: the goal is to make the adversary *work for their meal* — push reliable removal from a one-liner toward rewriting the document with quality loss, and make removal *detectable*. Levers (see the proposal's "Adversary cost & tamper-evidence" section): (1) prefer carriers that overlap legitimate text so stripping causes visible collateral — confusables, and especially word-choice carriers with no character class; (2) defense-in-depth across orthogonal channels so one regex can't cover all, and the union of required attacks approaches "rewrite the text"; (3) key-gated carriers over a large pool, forcing the attacker to normalize a broad superset; (4) **tamper-evidence** — a `tampered` decode status that flags "watermark was here and stripped" vs. "never watermarked," denying clean/deniable removal. Design consequences: never *claim* adversarial robustness, but *do* engineer against it; and `decode` reports `not-detected` (or `tampered`) cleanly rather than emitting a false payload.

**Carrier visibility is viewer-dependent (stealth ≠ universal).** "Looks identical" holds in the rendering contexts that matter for a watermark — browsers, word processors, chat, PDFs — which display the exotic-whitespace variants as ordinary spaces. But **code editors that flag unusual codepoints reveal them**: Sublime Text (and VS Code with whitespace rendering on) draw U+2006/U+2009/U+200A as little hex boxes like `<2006>`. This is display only — the bytes and the payload are intact — but it means stealth is not universal. There is no fully invisible carrier: any non-U+0020 substitute can be surfaced by a strict editor, and zero-width characters are flagged (and often auto-stripped) too. Practical stance: (1) the target surfaces (web/doc/chat) render clean, so the demo's claim holds there; (2) treat "invisible in a code editor" as a non-goal; (3) the symbol-library profile is the knob — whitespace variants hide in prose viewers, punctuation/confusables hide in more editors but alter glyphs — pick per use case; (4) an editor that *shows* carriers is also one that lets a user delete/normalize them, so visibility and the regex-stripping risk are two sides of one coin.

**Empirical nuance — visibility is per-codepoint-class, not "exotic vs. not."** Observed: Sublime Text flags unusual *visible-width* whitespace (U+2006/2009/200A → `<2006>` hex boxes) but does **not** flag zero-width / invisible-operator characters (ZWSP/ZWNJ/ZWJ, U+2061–2064) — those paste in invisibly even there. So StegCloak's zero-width carriers are *stealthier in Sublime* than spab's whitespace variants, yet more likely to be auto-stripped by sanitizers/plain-text fields — the usual stealth↔fragility trade. Lesson: don't assume "code editors reveal exotic carriers"; each carrier class's visibility in each editor is an **empirical** question to test (build a small "how does editor/renderer X show carrier class Y" matrix), not a generalization.

## Implementation plan

Phased so the **benchmark harness exists early** and every later idea is measured, not asserted.

1. **Symbol library module** — pluggable symbol classes, each with encode map, strict decode character class, and a capacity descriptor; toggleable via params. Priority order: **whitespace variants first, then punctuation/format confusables** (dash/quote/ellipsis/bullet) as a near-term second class — it's the highest-value addition because it survives the whitespace-normalization / reflow channels that kill class 1 (see `symbol-catalog.md`).
2. **Slot model + in-band handling** — deterministic slot derivation shared by encode/decode; encode-time normalization of carrier classes at slots.
3. **Baseline codec + ECC** — simplest end-to-end path: bit codec + repetition/RS baseline + payload framing. Gets a working `encode`/`decode` to test against.
4. **Benchmark harness + corpora** — corruption models, metrics, config matrix, CSV/JSON output. Stand this up early against the baseline.
5. **Standalone visualizer** — self-contained HTML page: highlight carriers, block histograms, live corruption sliders, live decode/confidence.
6. **Soft demodulation + detection gate** — probability-weighted symbol stream; histogram-based "encoded at all?" detector feeding confidence.
7. **Block-histogram coding + A/B framing** — the exploratory core; measure real per-block capacity and framing robustness in the harness.
8. **ECC Stack A** — markers/A-B sync + soft inner + fountain outer, behind the ECC interface.
9. **ECC Stack B** — marker/watermark (Davey–MacKay-style) sync code, same interface; benchmark A vs. B head-to-head.
10. **Variable-rate bit codec** — deterministic per-slot capacity map; variable-alphabet pack/unpack; measure the capacity gain vs. desync risk.
11. **Packaging** — self-contained ES module with `encode` / `decode` exports; Node + browser; harness runnable in CI.
12. **(v2+) Executable payload** — mini-language spec + opt-in sandboxed runner.

## Deliverables & repo layout

Three artifacts, one repo:

1. **Core JS library** (`src/`) — the encode/decode engine. Pluggable ECC so we can implement **both** candidate stacks behind one interface and compare them head-to-head:
   - **Stack A** — markers / A-B sync + soft inner (convolutional or repetition) + fountain outer.
   - **Stack B** — a marker/watermark (Davey–MacKay-style) sync code.
   - A simple **RS/repetition baseline** to validate the harness before the fancy stacks exist.
   The ECC layer is an interface (`encodeECC` / `decodeECC` returning soft/erasure info) so stacks are swappable by config.

2. **Standalone visualizer** (`web/`) — a single self-contained HTML page (no server) to *see* the scheme work:
   - paste cover text → watermarked output with carriers highlighted (and a "looks identical" toggle),
   - per-block histograms and the A/B framing rhythm,
   - live **corruption sliders** (normalize %, delete %, paraphrase, etc.) applied before decode,
   - decode result: recovered payload, status, confidence, bit/symbol error rate — updating live.
   Doubles as the demo and the debugging tool.

3. **Benchmark suite + harness** (`bench/`) — corpora plus an automated runner (see below). Reports error rates per ECC stack × corpus × corruption type.

## Benchmark & evaluation harness

The core experiment: take clean text, encode a known payload, push the encoded text through a **corruption model**, decode, and compare recovered vs. original. Run this across many corpora and corruption types to produce robustness curves — and to compare Stack A vs. Stack B objectively.

**Corpora (varied on the axes that matter):**

- length: short (tweets/SMS/chat lines), medium (emails/paragraphs), long (articles, Wikipedia dumps),
- structure: prose, markdown, source code, lists/tables (bullet-rich), chat logs,
- character profile: space-rich vs. space-poor, punctuation-heavy, multilingual / non-Latin,
- a **clean control set** never encoded — to measure the detector's false-positive rate.

**Corruption models (the "channel"), each parameterized by intensity:**

- whitespace normalization (partial → full collapse to U+0020),
- **Unicode normalization NFC/NFKC** (NFKC is a known killer — folds many space/confusable variants),
- trailing-space stripping (editor/linter/git hooks),
- copy/paste round-trips (plain-text, rich-text/HTML),
- reflow / rewrap / re-justify,
- word/sentence/paragraph deletion and insertion (the desync stressors),
- punctuation normalization (smart↔straight quotes, dash folding, bullet swaps),
- find/replace and case changes,
- markdown → HTML render round-trip,
- **LLM paraphrase / "run through another model"** (heaviest realistic attack),
- truncation (keep first/last N%), and random character edits.

**Metrics:**

- detection rate (true positive) and **false-positive rate** on the clean control set,
- payload exact-recovery rate; bit-error and symbol-error rate,
- **robustness curve**: recovery vs. corruption intensity, per model,
- capacity achieved (payload bits) vs. passage length; effective bits/slot,
- confidence **calibration** (does reported probability match actual success?),
- runtime/throughput for encode and decode.

**Harness shape:** deterministic (seeded) corruption for reproducibility; a config matrix over {stack, corpus, corruption, intensity, payload size}; output as CSV/JSON plus summary plots the visualizer can also render. Node-runnable for CI, so regressions in error rate show up automatically.

**The core evaluation is a strategy × channel matrix.** The question is not "how robust is spab" but "how does *each encoding strategy* hold up against *each channel-noise situation*." Rows = encoding strategy (spab version / ECC stack — baseline repetition, RS-erasure, block-histogram+fountain, …), columns = channel-noise situation at each intensity. Treat all corruption models as **channel noise**, including the **regexAttack** (an informed regex that strips a subset of the carrier symbols = targeted partial symbol erasure) — it's a noise situation with a specific structure (deterministic loss of certain symbol values), not a category apart. Because every run is logged with its `spab.VERSION`/algorithm descriptor, the provenance DB pivots exactly this way (`db.js query`): recovery by version × model × intensity, so a new strategy is compared head-to-head against the baseline on identical channels. Different strategies have different failure signatures per channel (repetition dies on desync; interleaving/PN helps burst; only the transposition-dictionary class survives a full character regexAttack) — surfacing those signatures is the point of the matrix.

### Corpus strategy — scale matters

A handful of hand-written samples is enough to smoke-test, but real confidence needs **volume**: the whole scheme is deterministic, so error rates only mean something when averaged over thousands of diverse passages. Target two tiers (measurement/calibration only — no ML "training"; see the DSP framing above):

- **Development / tuning corpus — 25k–100k documents.** Wide variation in length, structure, punctuation density, and language. Used to tune parameters (block size `n`, interleave `k`, symbol library, ECC rate, detector thresholds) and to produce statistically meaningful robustness curves.
- **CI corpus — a few hundred documents.** A fixed, small, fast slice that runs on every commit to catch regressions in seconds. The full corpus runs on demand / nightly.

Two sources, one iterator interface (`{count, get(i)}`):

- **Synthetic-generated** (`corpus-gen.js`) — deterministic `getDoc(i)` returns the same doc every time, so it needs no storage and a CI slice is a strict prefix of the big sweep. Good for volume and reproducibility, but the text is procedurally bland.
- **Curated real text** (`corpus/curated/`, built by `corpus-curate.js`) — a license-free mix (public-domain books, CC-BY-SA Wikipedia, permissive Markdown, CSV/TSV spreadsheets) that exercises *real* whitespace/punctuation statistics, space-poor tabular data, and genuine structure. Tens of MB is plenty. This is what the histogram detector should be calibrated against, since the whole question is how a shaped distribution stands out from *natural* text.

The curated corpus matters specifically because the channel is "a small bias on natural text statistics" — you can only know the false-positive floor and the real per-block distinguishability by measuring against authentic documents, not synthetic filler.

## Build notes

- **HARD INVARIANT: zero third-party dependencies, in every language.** Non-negotiable. The
  entire library — codec, ECC/GF math, PN/LFSR, hash/KDF, **and the ChaCha20-Poly1305 cipher** —
  is hand-implemented from specifications with no external packages, in JS/Rust/C/Python/Java.
  This is why the crypto and compression choices are what they are (ARX cipher, LZW): each is
  small, table-light, integer-only, and portable. To keep hand-rolled crypto safe: implement the
  exact published standard, add nothing, keep the ARX core constant-time, and **conform to the
  official RFC 8439 test vectors** in every port's CI. Cryptographic agility is deliberately out —
  one cipher, one hash, changed only by a format-version bump.
- **Reference implementation: JavaScript** (Node + browser), the current focus.
- **Future ports: Python and C/C++** (not now — noted for planning). Keep the design port-friendly: specify the wire format (frame layout, symbol library, slot rules, PN/LFSR polynomial + seed, ECC parameters) precisely and language-independently, so JS, Python, and C/C++ implementations interoperate bit-for-bit. Favor integer/GF math with defined widths (GF(2⁸)/GF(2⁹)) over language-specific idioms, and pin cross-language test vectors from the harness so every port validates against the same encode/decode fixtures. A C/C++ core (with thin JS/Python bindings) is a likely end state for speed and embeddability.

## Packaging & non-goals

- Ship as a self-contained ES module (`encode` / `decode`); Node + browser. Bundling a lightweight GF(256) RS is acceptable to avoid deps.
- Reference for behavior (not a dependency): Fraunhofer ISST **Innamark** and its paper *A Whitespace Replacement Information-Hiding Method*. spab differs by targeting native JS, a richer/variable-rate symbol library, short-passage grace, and a typed/executable payload container.
- Non-goals (v1): image steganography; zero-width-only schemes; synonym/word-substitution watermarking (changing actual words); guaranteeing survival against an adversary who deliberately normalizes all symbols; auto-running untrusted programs.

## Open questions

- How self-describing should the payload frame be vs. relying on shared params? (Auto-detect decode is much nicer but costs header bits — expensive on short passages.)
- Which punctuation/confusable classes are safe enough to enable by default across common editors and fonts?
- Formula for the reported success probability in `decode` metadata (hash-verified vs. ECC-margin-based).
- Variable-rate vs. uniform: is the added capacity worth the complexity and the higher decode-desync risk?
- Minimum viable passage size per payload type — what's the smallest text that can reliably carry a UUID?
- Multiple independent payloads in one document — supported, or one payload per document?
- Executable payload: what execution model is both useful and safe?
- Decoy strategy: should the trailing-line decoy carry real (lower-value) data, pure chaff, or a tamper-evidence tripwire — and does its presence ever make the true inline channel easier to detect by contrast?
- In-band handling: is slot-based reading + encode-time normalization enough, or do we also need a sync/preamble to recover from insertion/deletion desync? How much visible normalization (quotes, dashes) is acceptable by default vs. whitespace-only?
- Header mode signaling: how does decode learn which header mode (bare / typed / self-describing) is in use — fixed magic bits, a param, or attempt-in-order?
- Soft decoding: is hard-decision RS with erasure flags enough, or is a true soft-decision code (LDPC / convolutional / soft-RS) worth the complexity?
- Detection gate: what statistic best separates "encoded" from "natural" symbol histograms, and how do we calibrate the threshold to a reported probability without false positives on clean text?
- Context conditioning: how much real capacity/robustness does preceding-character conditioning buy vs. the desync risk if the two sides ever compute context differently?
- Block-histogram mode: what block size and symbol alphabet trade capacity against robustness best for short/hostile passages?
- Block-histogram capacity: how many orthogonal carrier states does a ~64-char block actually afford in real text — enough for a full 8-bit symbol, or fewer?
- Histogram separation: how cleanly do encoded vs. natural carrier distributions separate, and what's the false-positive floor for the detector?
- A/B framing: does alternating carrier sets survive real edits well enough to keep block sync, and what happens when a whole block is deleted?
- ECC choice for the block regime: fountain (LT/Raptor) vs. turbo/LDPC — which gives the best robustness-per-implementation-effort in JS?
- PN placement: does LFSR/GF pseudo-random hopping beat fixed-stride interleaving enough (on `cutPaste`/`blockErasure`) to justify the resync complexity? What modulus/polynomial?
- Position tagging vs. self-identifying symbols: are explicit position bits worth the capacity hit, or do fountain symbol IDs make them redundant?
- Multiple payloads via orthogonal PN codes (CDMA-style overlay): feasible without wrecking capacity or detectability?
