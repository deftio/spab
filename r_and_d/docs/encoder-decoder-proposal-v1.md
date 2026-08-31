# spab — Encoder / Decoder Proposal v1

A complete, synthesized proposal for spab's encode and decode paths. It pulls the scattered
design notes (`spab-watermark-plan.md`, `symbol-catalog.md`, `glossary.md`) into one coherent
architecture. Status is mixed: the **baseline `0.1.0`** is implemented (`src/js/spab.js`); most of
what follows is the **target design** to build toward. Where they differ, it's called out.

> **North star — information-entropy management.** Text carries *spare entropy*: equivalent
> choices a reader won't notice (which space, which dash, straight vs. curly quote, one synonym
> vs. another). spab measures that latent capacity, spends some on signal, and keeps enough
> margin (redundancy + ECC) to survive the channel. It's rate–distortion at heart:
> capacity vs. robustness vs. how much the text may change.

---

## 1. Scope, goals, non-goals

**Goal.** Embed an arbitrary payload (a magic word, a hash, JSON, a small program) into existing
plain text so the result reads identically, and recover it after realistic tampering — copy/paste,
reformatting, partial deletion — with an honest confidence estimate.

**Robustness stance — incidental robustness first, adversary-cost as an explicit goal.** spab is
built for **incidental** robustness (ordinary editing, copy/paste, reflow, excerpting). Against a
*deliberate, informed* adversary it does **not** promise defeat — the honest ceiling is that a
determined rewriter (paraphrase / retype) can always remove it. But "we can't guarantee removal is
impossible" is **not** "we don't try." A core design goal is to **make the adversary work for
their meal**: push the cost of reliable removal from a one-line regex toward rewriting the document
with quality loss, and make removal *detectable* rather than clean. See §12b for the levers. So:
never *claim* adversarial robustness, but do *engineer against* it, and always report
`not-detected` (or `tampered`, when detectable) cleanly rather than emitting a false payload.

**Design invariants (non-negotiable).**

- **Deterministic** at runtime — same input + params → same output, on every platform/port.
- **Zero third-party dependencies**, in every language (JS, Rust, C/C++, Python, Java/Kotlin).
  Codec, GF/ECC math, PN/LFSR, hash/KDF, and cipher are all hand-implemented from specs.
- **Classic DSP, not gen-AI.** Modulation, demodulation, synchronization, FEC. ML/optimization
  may *tune parameters* (thresholds, window sizes) offline, producing a fixed config; nothing
  learned runs in the decode path.
- **Staged & measurable.** Build one carrier class / one ECC strategy at a time, each an
  independent strategy row in the harness's strategy × channel matrix.

---

## 2. System overview

```
ENCODE
  payload ──▶ [transform stack] ──▶ [frame] ──▶ [ECC / fountain] ──▶ symbol stream
              compress? encrypt?     type+len     rateless coded         (M-ary, soft-ready)
                                                                             │
  cover text ──▶ [site model] ──▶ [modulator] ◀───────────────────────────┘
                 find carrier      write symbols into carrier sites
                 sites (per class) (+ pilots + repeated config records)
                                                     │
                                                     ▼
                                              encoded text  +  metadata

DECODE
  encoded text ──▶ [demod / acquisition] ──▶ soft symbol stream (with confidences)
                    slide, correlate,          symbolᵢ → conf%
                    clock/timing recovery,
                    pilot & config-record detect
                                     │
                                     ▼
                    [resync / index recovery] ──▶ symbols with (relative) indices + erasures
                                     │
                                     ▼
                    [soft fountain decode] ──▶ frame ──▶ [decrypt? decompress?] ──▶ payload
                             stop when integrity hash verifies                 + metadata
```

The rest of this document specifies each block.

---

## 3. The symbol layer (carrier classes)

Carriers are places where text has interchangeable choices. Full menu in `symbol-catalog.md`;
the essentials:

| Class | Addressing | Density | Bits/site | Survives | Status |
|-------|-----------|---------|-----------|----------|--------|
| Whitespace variants | positional | high (~1/word) | 2 (→3–4) | glyph edits; **dies** to normalize/reflow/regex | **impl** |
| Punctuation confusables | positional | medium (where punct occurs) | 1–2 | **whitespace normalize/reflow**; dies to NFKC/targeted regex | priority |
| Token/phrase swaps | **content-addressed** | low (dict-gated) | ~1 | whitespace attacks, reflow, **retype**; dies to paraphrase | exploratory |
| LLM rewrite | content-addressed | high | spread | edits broadly; needs a model at decode | walled-off mode |

Two axes decide behavior more than the glyphs do:

- **Addressing — positional vs content-addressed.** Positional sites ("the gap after word 37")
  are dense and cheap but **desync** on insert/delete (indices shift). Content-addressed sites
  ("wherever the word ∈ {big,large,huge}") travel *with the words* — immune to desync, at the
  cost of density and dictionary ambiguity. Prefer content-addressing where the class allows it.
- **Capacity triangle — sites × bits/site × robustness.** Can't max all three; the classes sit
  at different corners, which is why we combine them.

**Slot/site model (in-band discipline).** A carrier glyph can occur naturally, so reads happen
only at defined *sites* (inter-word gap, punctuation position, dictionary hit), and encode
**normalizes** the site to a canonical base before writing — so every read value is one spab
placed, and pre-existing curly quotes/thin spaces elsewhere are ignored.

**LLM rewrite is deliberately out of the core** — the decoder would need the model (breaking
no-deps/deterministic/portable), and it distorts the visible text. Keep it as an optional
`spab-ml` mode; it's the same "bias a distribution" idea as token swaps with the vocabulary as
the dictionary.

---

## 4. Modulation: the block-histogram constellation

The core modulation (target design; the current lean over per-glyph reads) treats a **block of
n sites** as one M-ary symbol carried in the **histogram** of carrier variants over that block.
It's a constellation receiver, bent onto a probability simplex:

- **Constellation = M allowed histograms.** Each is a point in the space of distributions over
  the enabled carrier types. Encode shapes a block's distribution toward one target; decode snaps
  the observed distribution to the nearest target under a **divergence metric** (KL / chi-square /
  L1 / matched-filter correlation), yielding one symbol + a confidence.
- **Constellation design = max–min divergence.** Place the M points to maximize the minimum
  pairwise divergence given n — the simplex analogue of constellation shaping / sphere packing.
- **Block size n = integration time.** Larger n → tighter empirical histograms → points can sit
  closer → higher M → more bits/symbol, at the cost of fewer symbols. The capacity↔robustness knob.
- **Adaptive order.** Punctuation-rich blocks afford a bigger constellation than sparse prose —
  variable M per block, like adaptive modulation to local "SNR."
- **Gray-code the mapping** so adjacent points differ by one bit; a near-miss costs one bit error,
  which ECC absorbs cheaply.
- **Soft output.** Hand ECC the per-point divergences as log-likelihoods, not a hard decision.

Why this over per-glyph reads: the histogram is invariant to reordering within a block and
tolerant of a few substitutions/erasures — inherently robust and soft, and (with the acquisition
below) position-free in the payload.

The baseline `0.1.0` is the degenerate case: block = 1 gap, 4-point constellation, hard decision.

---

## 5. Placement & interleaving (positional classes)

For positional carriers, *where* a block's sites sit across the text controls burst tolerance:

- **Sequential** (hist-encoding-1) — contiguous blocks. Simple; a deleted paragraph wipes whole
  symbols (burst).
- **Interleaved** — each block's sites scattered in k-char chunks (k < n), so a burst becomes
  spread erasures. Depth = n/k.
- **PN-spread** — gather a block's sites from **LFSR/primitive-polynomial** pseudo-random
  positions (GF(2⁸)/GF(2⁹)); maximal burst tolerance and key-dependent placement. The same LFSR
  primitive also does key stretching and fountain symbol selection.

Content-addressed classes don't need this — their sites are located by content, not position.

---

## 6. Synchronization — the hard part

This is where the design earns its keep. The channel is not a clean erasure channel; it's a
**synchronization channel** with insertions and deletions. A deletion is *not* a labeled erasure:
the stream just gets shorter with an unknown gap, so naive positional reading loses all indexing.

**Three receiver functions, borrowed straight from digital comms:**

1. **Clock / timing recovery.** As the decoder slides, it must find block phase. Correlate at a
   stride and pick the phase where the constellation "lights up," aided by pilots.
2. **Pilots / training.** Reserved constellation points (a "pilot tone") at known logical
   intervals let the decoder lock timing and — critically — **re-anchor absolute index after a
   gap**. The A/B alternating framing is a training sequence for this.
3. **Resync under insert/delete.** Two roads, and we choose the first:
   - **Self-locating symbols + pilots (chosen).** Spend a few bits per symbol on an ID/sequence
     tag, and drop periodic pilots. A deletion becomes "received IDs 1,2,3,5 → 4 is a clean
     erasure," converting the *intractable* sync problem into the *tractable* erasure problem
     fountain solves. Cost: some capacity.
   - **Pure position-free + HMM (fallback).** No IDs; a hidden-Markov / BCJR decoder with
     stay/insert/delete transitions realigns (Davey–MacKay watermark-code style). Theoretically
     right for the pure deletion channel, but heavier and softer-edged.

**Design commitment:** don't be purely position-free. Small self-location + pilots is the
pragmatic glue; position-free is elegant for *reading a symbol* and a trap for *reassembling the
stream*.

---

## 7. Framing & document-level sync (excerpt survival)

Global info that decode needs (constellation profile, PN seed, ECC scheme, transform flags) can't
live in a single header — an excerpt may not contain it. Model it on **broadcast streams**
(MPEG-TS/DVB), where config tables repeat so a receiver joining mid-stream re-acquires.

- **Repeated, self-delimiting config record.** A small, heavily-ECC'd, **marker-prefixed**
  sync/config record repeated **every N blocks**. Choose N ≤ the smallest excerpt E you want to
  recover; then every span ≥ E contains a full copy. (Same math as tile size ↔ min excerpt.)
- **Split global info by kind.** *Position-independent config* (profiles, seeds, flags) is
  replicated freely. *Absolute position* (total length, "block 4197") is **meaningless in an
  excerpt** — never rely on it; use **relative indices** within a repetition period, so each
  period is an **independently-decodable tile**.
- **Bootstrap preamble.** The one chicken-and-egg item (which profile is in play) rides a fixed,
  maximally-conservative, correlatable marker so it's the last thing to die — a modem-style
  handshake; everything after is self-describing.
- **Below one repetition interval**, honestly report `not-detected` — that's the floor.

**Locality vs. spreading.** Interleaving/PN maximize burst tolerance within a retained whole;
excerpting wants *locality*. Resolve hierarchically: interleave/PN *within* a tile, keep tiles
local, size the tile ≈ the minimum excerpt.

---

## 8. Payload framing & transforms

The decoded message is a pair `[type, content]`; the type is **post-ECC** (the head of the
ECC-decoded message, possibly physically spread across coded symbols — logical, not physical).

- **Type** — a content-interpretation tag (`bytes` / `string` / `json` / `uuid` / `program`),
  flag/continuation-coded (1-bit flag + 7-bit value), optional; typeless payloads cost nothing.
- **Transforms (flags, not types)** applied `payload → compress? → encrypt? → frame → ECC`:
  - **Compression** — a 3-bit codec id (up to 8 lossless), `0=none`; **`auto`** (default) tries
    all *implemented* codecs and keeps the smallest (winner id stored). Ship a simple few first
    (none/RLE/LZW/LZ77); reserve the rest. LZW is the portable built-in.
  - **Encryption** — **one cipher: ChaCha20-Poly1305 (RFC 8439)**. Pure ARX, no tables,
    constant-time, ~200–300 lines/port, AEAD (integrity for free), verified against RFC vectors.
    Key: any-length passphrase stretched to 256 bits deterministically — **KDF/hash (default)**,
    PN-continuation, or repeat (stretch ≠ entropy; effective strength capped by the key). Nonce
    stored or SIV-derived. Encoder emits **advisory key-strength warnings** in `metadata.issues`.
- **Integrity hash** — verifies recovery (and is decode's "am I done?" signal); AEAD can subsume it.
- **Header ladder** — bare / typed / self-describing, so short passages pay only for what they use.

**Determinism corollary:** any randomness (KDF salt, nonce) is either stored as a public frame
param or deterministically derived — never ephemeral, or decode can't reproduce it.

---

## 9. Error correction

The ECC is the load-bearing layer, and the choice follows the channel:

- **Rateless / fountain (LT/Raptor) is the target**, for three reasons:
  1. **Burst/erasure tolerant** — matches cut/paste and retyped-paragraph loss.
  2. **Rate-agnostic decode** — the decoder gathers whatever symbols survived and stops when the
     integrity hash verifies. It never needs to know the encoder's bits-vs-redundancy choice —
     which directly answers "at decode we don't know what was chosen."
  3. **Heterogeneous merge** — one fountain over all surviving symbols regardless of carrier
     class/alphabet (mixed-radix M-ary), so if whitespace is stripped, punctuation/swap symbols
     still contribute. Graceful degradation across the different failure modes.
- **Soft-decision** throughout — symbol confidences become LLRs/erasure-probabilities; a soft
  decoder (soft-fountain / LDPC) consumes them.
- **RS is not the destination.** It assumes symbol alignment this channel doesn't have. At most an
  interim erasure baseline once slot loss is detectable.
- **Erasure vs. deletion** — self-locating symbols convert deletions into labeled erasures (§6),
  which is what makes fountain applicable at all.
- Baseline `0.1.0` uses repetition + majority vote — the placeholder to beat.

**Which fountain — RLNC first, RaptorQ later.** RaptorQ (RFC 6330) is the high-end target
(systematic, rateless, near-zero overhead even at small K), but it's a heavy dependency-free port
across five languages and carries an IPR history (Qualcomm / Digital Fountain — check expiry before
shipping). For spab's common regime (small payloads → small K), a **systematic random-linear
fountain over GF(256)** gives ~most of the benefit at a fraction of the cost: each repair symbol is
a random linear combination of source symbols (coefficients from a seed), decode is Gaussian
elimination (cheap at small K), and it's **just linear algebra — no patents**. Ship RLNC first to
validate the pipeline; keep RaptorQ as a drop-in outer-code upgrade for the large-payload regime.
The symbol format is identical either way (next section), so the outer code swaps behind one interface.

---

## 9b. Packetized fountain pipeline — the v1 design questions

High-level model (deliberately not yet pinned to numbers):

```
(secret, type) → message → chop into source symbols → fountain → PACKETS
each PACKET is embedded as a group of channel symbols across ~c chars of cover,
   by perturbing that span's whitespace/punctuation histograms (an "encode block")
→ the text carries the packet set → some packets survive, some are erased or swapped
→ collect surviving packets → message-level fountain rebuilds the secret
```

Terms (to avoid "block" overload): a **packet** = one fountain-coded unit (payload fragment +
metadata + integrity); an **encode block** = the ~`c`-char span of cover text whose channel symbols
are perturbed to carry one packet. The **channel symbols** are the M-ary histogram states from the
symbol library.

The open questions, and the tension in each (all measurable in the harness):

1. **Symbol diversity (M).** How many distinguishable channel-symbol states per encode block. More
   diversity → more bits/packet, but harder to tell apart under edit-noise and more visible. Driven
   by which carrier classes populate the span. *Lean:* start modest, adapt to what the span affords.
2. **Block size (`c` chars).** Bigger block → more bits per packet and a more reliable histogram
   (law of large numbers), but coarser erasure granularity (one damaged span kills a whole packet)
   and fewer packets overall. Direct capacity↔robustness knob.
3. **Info per packet.** Usable payload bits after metadata + integrity overhead ≈ (M-bits × symbols
   in block) − (ESI + type/flags + check). Small packets spend a big fraction on overhead; large
   packets waste capacity when erased. Sweet spot is empirical.
4. **FEC vs. CRC per packet.** Two philosophies:
   - **CRC-only per packet** — cheap; a packet is *clean or erased*; rely entirely on the
     message-level fountain (erasure code) to fill the gaps. Simplest, matches RLNC/RaptorQ.
   - **FEC per packet** — an inner code that *corrects* small in-packet damage and *detects* the
     rest → fewer packets erased (more usable), at higher per-packet overhead. You get both
     correction and detection.
   *Lean:* CRC-per-packet + strong message-level fountain first; add per-packet FEC only if too many
   packets are erased in practice. A measured tradeoff.
5. **Per-packet metadata — the hard one (ESI).** A fountain *must* know which symbol each packet is
   (its ESI / stream position) to combine them; but identity bits are expensive on small packets.
   This is the challenge you flagged. Options, cheapest-first: derive identity from a shared
   **deterministic placement** (PN/order) so it's implicit; a **short explicit index** (a few bits);
   or a **seed** that both identifies and defines the packet's linear combination. Goal: keep
   metadata to ESI + a couple of flags; everything else lives in the payload, protected.
6. **Does message-level fountain clean up the mess?** Yes — *if two conditions hold:* (a) enough
   packets survive intact (≥ K + small overhead), and (b) swaps/corruption are turned into
   **erasures, not errors**, by the per-packet integrity check (Q4). Fountains fix erasures, not
   errors, so Q4 is precisely what makes Q6 work. The residual risk is an *undetected* swap (a CRC
   collision) feeding a wrong symbol in — sized down by the check length. So Q6 succeeds exactly when
   Q4 is honest and Q2/Q3 leave enough surviving packets.

The through-line: **Q5 (identity) + Q4 (clean-or-erasure) are what let Q6 (fountain) work at all** —
they convert a messy, edited channel into the clean erasure channel the fountain needs. Q1–Q3 set
how much you carry and how gracefully it degrades. None are pinned yet; each is a harness sweep.

---

## 10. The decoder pipeline ("gluing it back together")

Being the decoder: you face a gap-riddled soft symbol stream with no side information. The engine:

1. **Slide + correlate** → soft symbol candidates with confidences, plus candidate block phase
   (clock recovery).
2. **Marker / pilot / config-record detection** → locate repeated config records by matched
   filter; read profile/flags; re-establish coarse index; segment the stream at anchors so a
   deletion scrambles indices only *within* a segment.
3. **Resync + label** → self-locating IDs bucket symbols by index (missing IDs → erasures); or,
   fallback, HMM posterior indices.
4. **Soft fountain decode**, collecting across all surviving channels until the **integrity hash
   verifies** — the success signal.
5. **On failure**, widen the search (other phases, the small bootstrap-profile set) and retry.
6. **Report** `status` (`not-detected`/`perfect`/`corrected`/`failed`), recovered `type`+message,
   and confidence (hash-verified + ECC margin + detection-gate score).

**Encoder-side investments that make this possible** (a little cost for a lot of decodability):
self-locating symbols, periodic pilots, a conservative repeated config record/preamble — all on a
rateless code. Pilots do double duty: clock recovery *and* index re-anchoring after missing frames.

---

## 11. Capacity vs. robustness (user-facing)

Match payload to text length, then spend the rest on redundancy (see `docs/capacity-vs-robustness.md`).

- **Serial regime (≤ ~8 B).** Magic word / short ID; fits short text, embed ultra-redundantly.
  Repetition is fine here.
- **Hash regime (160–256 bit).** Needs long passages; repetition fails (one copy barely fits) —
  real coding over the whole payload, and higher bits/site (richer symbol library) to keep text
  reasonable.
- **Message regime (JSON / program).** Long documents only; compression earns its keep; the
  "novel with a hidden easter egg" case.

Test profiles: `magic`(4) / `magic8`(8) / `sha1`(20) / `sha256`(32) / `json`(67) / `program`(130+).

---

## 12. Channel-noise model & evaluation

The core evaluation is a **strategy × channel matrix**: rows = encoding strategy (spab version /
ECC stack), columns = channel-noise situation × intensity. All corruption is *channel noise*,
including **regexAttack** (an informed regex stripping a subset of carrier symbols = targeted
partial erasure). Provenance is logged per run (`spab.VERSION` + algorithm descriptor), so the DB
pivots version × model × intensity — new strategies are compared head-to-head against the baseline
on identical channels. Channels (`r_and_d/corruptions.js`): saltPepper, normalize, blockErasure,
cutPaste, truncate, wordDelete, wordInsert, reflow, regexAttack, fullStrip.

---

## 12b. Adversary cost & tamper-evidence (making the stripper work for it)

We can't make removal impossible, but we can make it **expensive, lossy, and visible**. The
posture is defense-in-depth / cost-escalation, like media watermarking: never unbreakable, but the
bar rises from "trivial regex" toward "rewrite the text," and clean removal is hard to prove.
Levers, roughly in order of leverage:

1. **Carrier–content overlap (collateral damage).** The more a carrier coincides with characters
   the text legitimately uses, the more a blanket strip *damages the visible document*. This
   ranks the classes: whitespace variants strip with ~zero collateral (cheap for the attacker);
   punctuation confusables overlap real typography (dashes/quotes) so a blanket fold changes the
   document; **word-choice (transposition) carriers have no character class at all** — removal
   means paraphrasing. Prioritizing confusables and the dictionary is *itself* the primary
   anti-stripping move.

2. **Defense-in-depth across orthogonal channels.** Spread the mark across whitespace **and**
   confusables **and** word swaps with a fountain merge. No single regex covers all; to remove the
   mark the attacker must defeat *every* channel — normalize whitespace **and** fold confusables
   **and** paraphrase — and the union of those operations approaches "rewrite the document." Each
   channel a survivor lets fountain still reconstruct.

3. **Key-gated carriers over a large pool (raise "which to strip" uncertainty).** Draw carriers
   from a *large* pool of variants/positions but only use a **key-selected subset** (PN placement,
   key-chosen variant set). The attacker doesn't know which subset carries signal, so to *guarantee*
   removal they must normalize the entire superset — maximizing collateral — and may not even know
   the full pool. (Kerckhoffs caveat: don't rely on the pool being secret for security; rely on it
   to force broader, more damaging normalization.)

4. **Move signal beyond character classes.** Carriers a character regex can't touch: optional
   punctuation choices (Oxford comma), sentence-split/merge choices, allowed word-order variation,
   whitespace *counts* that survive some reflow. These force the attacker up to NLP-level editing.

5. **Tamper-evidence (detect removal even when the payload is gone).** Recovery and *detection* are
   separate goals. Even when the payload can't be rebuilt, decode can often tell **"a watermark was
   here and was stripped"** vs. **"never watermarked"**: a fragile decoy/tripwire layer (e.g. the
   trailing-line decoy) whose absence-with-residue signals tampering; statistical fingerprints of
   aggressive normalization (uniform spacing, NFKC folding) on text that carries structural residue.
   This adds a `tampered` decode status and denies the adversary *clean, deniable* removal.

6. **Scale cost.** For an adversary stripping provenance at volume (a platform), forcing
   model-based paraphrase instead of a regex is a real latency/compute/quality tax. The goal isn't
   one unbeatable document — it's making automated bulk removal costly and quality-degrading.

**Honest ceiling, restated:** a patient human who paraphrases or retypes wins, and text that has
been fully rewritten carries no spab mark. That's fine — the aim is to make *that* the cheapest
reliable attack, not a one-liner, and to leave evidence when someone takes the cheaper, dirtier
shortcuts.

## 13. Public API

```js
encode(baseText, message, key?, options?) → { text, metadata }
decode(markedText, key?, options?)        → { message, metadata }
```

- `key` optional (absent → no encryption). `options.compression = 'auto' | id | 'none'`, plus
  symbol-library profile, ECC settings, header mode, redundancy strategy, payload `type`.
- `encode` metadata: capacity, used, redundancy achieved, type, **chosen codec + ratio**,
  encryption applied, warnings (too short / weak key / codec unavailable), effective options.
- `decode` metadata: `status`, type, codec used, symbols corrected, confidence, channel-health;
  on failure, `message: null` with a reason ("encrypted — key required", "codec N unavailable").

CLI (`demo/spabdemo.js`) mirrors the verbs: `encode` / `decode` (+ `capacity`, `demo`).

### 13a. `plan()` — advisory / dry-run (feasibility before committing)

A non-mutating third call that lets a caller decide *what* to embed given *this* passage, instead
of guessing and failing:

```js
plan(baseText, message, options?) → { feasible, confidence, capacity, suggestions[] }
```

It answers "will this work, and if not, what should I do instead?" by returning a **list of
options**, each **dual-readable** — machine-actionable *and* human-explained — so a caller can
branch in code or show a person a recommendation:

```
suggestions: [
  { payloadBytes, classes, redundancy, pRecover: { normalize01, cutPaste05, ... , overall },
    action: 'embed'|'downgrade'|'enableClasses'|'abort',
    recommend: true|false,
    why: "fits a 4-byte watermark at ~3× copies; ~0.9 recovery under light edits" }, ...
]
```

The **programmatic** half is the numbers a caller keys off — payload size, class set, redundancy,
and per-channel + overall recovery probabilities. The **human** half is a one-line recommendation
and *why*. Typical options for a short passage: `{embed 4B watermark}` (recommended),
`{downgrade program→uuid}`, `{enableClasses ws+punct for +N bits}`, `{abort — nothing fits at your
robustness target}`. This makes the magazine-vs-novel decision programmatic: check `plan()`, embed
the full message, fall back to a bare watermark, or abort — the caller's choice, on real numbers
with a stated rationale.

### 13b. Re-encoding policy — the "already-spab-encoded input" problem

Before encoding, spab should run its **presence detector** (the cheap histogram/statistical test —
the "is this already encoded?" check, no key or full decode needed) on the *cover*. The perverse
case the caller can't see: their document contains a span that was **pasted from an
already-watermarked source**, so an internal block already carries *someone else's* mark. Encoding
naively canonicalizes those carriers and **silently destroys that third-party mark** (possibly a
provenance/copyright signal). So this must be surfaced, not swallowed.

`encode`/`plan` return a `preexisting` report — `{ detected, confidence, scope: whole|partial,
locations, decoded? }` — and take an `onExisting` policy:

- **`report` (default)** — encode as requested but *warn* in metadata that a prior mark was present
  (and, where possible, what it was). Never silently clobber without telling the caller.
- **`reject`** — refuse; return the report and let the caller decide.
- **`overwrite`** — deliberately canonicalize and re-mark (the old mark is intentionally replaced).
- **`preserve-regions`** — encode only in the clean spans, leaving detected marked regions untouched
  (costs capacity; needs region-accurate detection).
- **`layer` (if orthogonal)** — if the prior mark uses one carrier class and we use a *different*
  one (e.g. it's in whitespace, we mark in punctuation), both can coexist — a way to add a mark
  without destroying the existing one.

**Detected-but-opaque is a first-class state.** The presence detector can tell a passage *is*
spab-encoded without being able to *read* it — e.g. an **encrypted mark** we lack the key for, or a
profile/version we don't decode. So the report distinguishes: `present` (statistically encoded),
`readable` (we recovered a payload), and `opaque` (encoded but unreadable). "There's a mark here,
contents unknown" is a legitimate, useful answer — and the honest one for encrypted third-party marks.

**The coexistence / derivative-work case is the interesting one.** Two common real situations:

- *Whole document already marked* → decide at the report level (report / reject / overwrite / layer).
- *A portion is marked* (you quote a watermarked passage inside a larger article, or build a
  derivative work) → the useful question becomes **"can we add our mark in the remaining space?"** —
  encode in the un-marked regions, and/or in a **carrier class the existing mark doesn't use** (they
  used whitespace → we use punctuation). Both marks then coexist: theirs on the quoted span, ours
  across the new material.

**Why we scope this now even though we won't implement it:** the answer changes *encoding and
carrier choices upstream*. If part of the input is already marked, our encoder may need to (a) avoid
those regions, (b) pick an orthogonal carrier class to layer without collision, or (c) budget
capacity around the occupied space. That feeds back into symbol selection and the `plan()` output,
so the design has to leave room for "some of this text is already spoken for" — a detector result
that biases carrier/region choice, not just a yes/no flag.

Idempotency falls out of the slot model: because encode canonicalizes carriers at slots first,
re-encoding a spab document is well-defined (a second `overwrite` cleanly replaces the first). The
genuinely hard part is *partial* marks (pasted fragments / quotations) — preserve vs. layer vs.
encode-around — a real product decision, surfaced via the report rather than hidden.

---

## 14. Wire format (to be frozen as a normative spec)

The interop contract for all language ports — must be specified bit-for-bit:

- Symbol library ids and per-class variant tables (codepoints); site-derivation rules.
- Constellation profiles (M, target histograms, Gray map) per block size.
- Placement: PN polynomial + seed derivation; interleave params.
- Pilot pattern; config-record layout, marker, and repetition interval N.
- Frame: magic/version, type (flag-coded), length, flags (ECC scheme, compression id,
  encryption + nonce), content, integrity hash; the header-mode ladder.
- ECC: fountain construction (degree distribution, symbol IDs), soft-decoding conventions.
- Transforms: LZW/… bitstreams; ChaCha20-Poly1305 parameters; KDF definition.

Shared **conformance test vectors** exported from the JS reference validate every port.

---

## 15. Staged roadmap

1. **[done] `0.1.0` baseline** — whitespace 2 bits/site, repetition ECC, magic+CRC frame; harness,
   corpora, provenance, profiles, CLI, visualizer.
2. **Confusables carrier class** — the strip-resistant, complementary-failure-mode class; measure
   as a new strategy row.
3. **Real ECC (`0.2.x`)** — erasure-aware rateless/fountain behind the swappable interface; attack
   the desync rows.
4. **Block-histogram constellation + acquisition** — matched-filter decoder, pilots, A/B framing,
   soft output.
5. **Interleaving / PN placement**; self-locating symbols.
6. **Repeated config records / tiles** — document-level sync; excerpt survival.
7. **Content-addressed channel** — a small curated synonym dictionary; the desync-immune class.
8. **Fountain merge** across parallel channels; combine only once each is solid alone.
9. **Transforms** — LZW(+auto), ChaCha20-Poly1305, key stretch + warnings.
10. **Multi-language ports** (Rust/C/Python/Java), no-deps, CI, conformance vectors, docs, frozen spec.
11. **(later, walled-off)** `spab-ml` LLM-rewrite mode.

---

## 16. Open questions

- Parallel channels (each own ECC) vs. one merged symbol stream — measure.
- Self-locating symbol overhead vs. fountain self-identification — how many bits on IDs?
- Constellation M vs. block size n vs. divergence metric — the empirical distinguishability curve.
- Default-on confusable groups (dash/quote/ellipsis/bullet) — visibility-validate on real text.
- Pilot/config-record repetition interval N vs. target minimum excerpt and overhead.
- Compression default for large payloads (ratio vs. hand-port cost); which few codecs ship first.
- Nonce: stored vs. SIV-derived; header-bit budget on short passages.
