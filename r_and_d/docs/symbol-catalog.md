# spab — in-channel symbol catalog

A working catalog of the carrier/symbol classes spab can use to put bits into text.
This is a menu to discuss and prune, not a commitment. Each class notes what it rides on,
roughly how many bits it offers, where it's visible, how it survives attacks, and status.

Legend — Status: **impl** (in baseline `0.1.0`), **planned**, **exploratory**.
Visibility = where a human might notice it. Survives = which channel-noise situations it
tends to survive (see `r_and_d/corruptions.js`).

## 1. Whitespace variants (inter-word)  — Status: impl

Replace the space between words with a visually-similar Unicode space; the variant carries
bits. The baseline uses 4 (2 bits/space):

| Bits | Char | Name |
|------|------|------|
| 00 | U+0020 | space |
| 01 | U+2006 | six-per-em space |
| 10 | U+2009 | thin space |
| 11 | U+200A | hair space |

Candidate additions to widen the alphabet (3–4 bits/space): U+2004 (three-per-em), U+2005
(four-per-em), U+2007 (figure), U+2008 (punctuation), U+202F (narrow no-break), U+205F
(medium math), U+00A0 (no-break). More variants = more capacity but higher visibility/normalization risk.

- Rides on: inter-word spaces (≈ 1 slot/word).
- Visibility: invisible in web/doc/chat rendering; **code editors (Sublime/VS Code) show them**.
- Survives: saltPepper (partial), light editing. Dies on: normalize, reflow, regexAttack.

## 2. End-of-line trailing whitespace  — Status: planned (opt-in)

Append tab/space combinations before newlines (classic SNOW). Detectable and fragile
(trailing-space strippers, linters, git hooks). Useful mainly as a **decoy** layer
(`trailingLine: off|capacity|decoy`) — an attacker who strips it thinks the mark is gone.

- Rides on: line ends. Visibility: invisible but trivially stripped. Survives: little.

## 3. Zero-width characters  — Status: exploratory (mostly a non-goal)

ZWSP (U+200B), ZWNJ (U+200C), ZWJ (U+200D), word joiner (U+2060). High capacity (insert
anywhere), but editors flag them and many pipelines **auto-strip** them. Listed for
completeness; weaker stealth/robustness than whitespace variants.

## 4. Punctuation & format confusables  — Status: **priority / near-term** (pull in early)

A first-class channel to bring in alongside whitespace, **not** merely opportunistic. Only
used where the punctuation already occurs; swaps a glyph for a visual look-alike, the chosen
variant carrying bits. It alters actual glyphs (so it can show in more editors), but it
renders as *normal* punctuation rather than exotic codepoints — often better cross-editor
stealth than whitespace variants (which Sublime/VS Code flag as hex boxes).

**Why it's important — a different failure mode.** Confusables are not whitespace, so they
**survive whitespace normalization, reflow, and trailing-space stripping** — the exact channel
noise that destroys classes 1–2. That makes it complementary: whitespace and confusables die
to *different* channels, so together they cover more of the strategy × channel matrix. (Only
regexAttack targeting these specific confusable sets, or Unicode NFKC normalization of some of
them, defeats it — noted below.)

Candidate confusable groups (each a small M-ary sub-alphabet at a site):

| Group | Variants (examples) | Bits/site | Notes |
|-------|---------------------|-----------|-------|
| Hyphen/dash | `-` U+002D, ‐ U+2010, ‑ U+2011, – U+2013, — U+2014, − U+2212 | 1–2 | typographically many "dashes" read alike |
| Quotes/apostrophes | straight `'` `"` vs curly ‘ ’ “ ” | 1 | smart-quote toggling is common and natural |
| Ellipsis | `...` vs … U+2026 | 1 | one bit where an ellipsis occurs |
| Bullets (lists) | • U+2022, · U+00B7, ‣ U+2023, `-`, `*` | 1–2 | rich in structured/markdown docs |
| Spaces-after-punct | 1 vs 2 spaces after `.`/`,` (or NBSP) | ~1 | overlaps class 1; use one owner to avoid conflict |
| Homoglyph letters (risky) | Latin vs Cyrillic/Greek look-alikes (a/а, o/о, e/е) | high | **flagged for caution** — breaks search/spellcheck, easily detected/normalized; likely off by default |

- Rides on: existing punctuation sites (sparser than inter-word spaces; density is text-dependent
  — markdown/lists are punctuation-rich, plain prose less so). Bits: 1–few per site.
- Survives: whitespace normalization, reflow, trailing-strip. Dies on: **NFKC** normalization
  (folds some confusables), a confusable-targeted regexAttack, or a spell/grammar pass that
  rewrites punctuation.
- Decode: strict per-group character classes at punctuation slots (same slot-model discipline as
  whitespace, so pre-existing curly quotes etc. aren't misread — canonicalize at those slots on encode).

Design caveats: apply only meaning/appearance-preserving swaps; keep it toggleable; and pick
default-on groups (dash/quote/ellipsis/bullet) vs. default-off risky ones (homoglyph letters)
by measuring visibility on real text. This is the class most worth building right after
whitespace.

## 5. Block histogram (aggregate)  — Status: exploratory (the current lean)

Not a single glyph: a **distribution of classes 1/4 over a window of text** is one soft,
M-ary symbol (M distinguishable histogram shapes → log₂M bits/block; M need not be 2ᵏ).
Read by matched-filter correlation; inherently soft and robust to per-position noise and
single insert/delete. This is a *coding* over classes 1/4, not a separate carrier.

- Survives: saltPepper, some normalize, and (with interleaving/PN) burst/cut-paste better.

## 6. Pilot / sync symbol  — Status: exploratory

Reserve one (or more) of the M histogram/symbol values for **framing/reacquisition**
instead of data (data alphabet shrinks to M−1). The M-ary analogue of a pilot tone; aids
the sliding-window decoder holding lock on a messy channel.

## 7. Transposition dictionary (word/symbol swaps)  — Status: exploratory (deferred)

User-supplied permitted equivalents chosen probabilistically to bias a distribution and read
back as signal — a **word-level** carrier. Synonyms (big/large), spelling (color/colour),
optional punctuation (Oxford comma), contractions (it's/it is), symbol equivalents.

- Rides on: swap points in the text (author-supervised). Bits: fraction of a bit per swap.
- **Survives whitespace attacks** (the mark is in word choices) — complements classes 1–6.
- Cost: changes actual words; must be meaning-preserving and in-voice. Post-processing
  analogue of LLM-output-bias watermarking.

## Cross-cutting knobs (not symbol classes, but shape the channel)

- **Bits per slot / variable-rate:** how many bits a slot carries (2 → 3–4 with more variants),
  possibly varying per slot by what glyphs are locally available.
- **Slot model:** which structural positions are read/written (inter-word gap, post-punctuation,
  bullet, line end) — makes the channel positional to dodge the in-band problem.
- **Placement:** sequential / interleaved / PN-spread across the text (burst tolerance).

## First-pass symbol set (v1 — LOCKED, implemented in 0.3.0)

Chosen from data, not intuition. The decisive fact: **NFKC normalization** (a common, benign
transform in databases/web forms/search indexers) **collapses every whitespace variant to a plain
space** — U+2006/2009/200A, NBSP, narrow-NBSP, all of them — so the whitespace class is *destroyed
by a single normalization pass*. The **confusables survive NFKC** (verified): U+0027↔U+2019,
U+0022/U+201C/U+201D, U+002D↔U+2010. So the carriers fail on **orthogonal** channels, and the v1
default enables **both, co-equal**, as independent parallel channels (decode picks the survivor).

| Class | Carriers (v1) | Bits/site | Survives NFKC? | Role |
|-------|--------------|-----------|----------------|------|
| **whitespace** | U+0020, U+2006, U+2009, U+200A | 2 | ✗ (→ space) | dense **capacity** carrier; dies to NFKC/reflow/strip |
| **apostrophe** | U+0027 `'` ↔ U+2019 `’` | 1 | ✓ | **robust** carrier; dies to smart-quote autocorrect |
| **hyphen** | U+002D `-` ↔ U+2010 `‐` | 1 | ✓ | **robust** carrier; sparse |

Implemented (`src/js/spab.js` 0.3.0): default `classes = ['ws','apos','hyphen']`; pass
`{classes:['ws']}` for whitespace-only.

**Dropped from v1** (measured out): ellipsis `…` U+2026 (NFKC → `...`), non-breaking hyphen U+2011
(NFKC → U+2010), NBSP/narrow-NBSP (NFKC → space). **Off** (risky/weak): homoglyph letters,
zero-width, trailing-line, double-quote (open/close ambiguity — deferred), bullets. Token/phrase
swaps (class 7) come later as the first content-addressed channel.

**Orthogonal failure — demonstrated** (single punct-rich passage, `ID-42`): default recovers under
clean, NFKC, smart-quote, and full-whitespace-strip; the decoder switches channels (ws when clean,
apostrophe when NFKC/strip kills whitespace). ws-only fails under NFKC and strip. The harness has
`nfkc` and `smartQuotes` channels to measure this at scale on punct-rich corpora.

## Regex-discoverability / strip-resistance (the long-standing concern)

The oldest worry with substitution steganography is that the carrier symbols are *easy to
find and strip* with a one-line regex, and that different classes vary a lot on this. Ranked
from easiest to hardest to strip without collateral damage:

| Class | Strip difficulty | Why |
|-------|------------------|-----|
| Zero-width (3) | trivial | a fixed tiny codepoint set; sanitizers already remove them by default |
| Whitespace variants (1) | easy | fixed exotic-space codepoints; `s/[   ]/ /g` and it's gone, no visible harm |
| Trailing-line (2) | easy | strip trailing whitespace — a standard editor/linter action |
| Punctuation confusables (4) | **medium–hard** | the variants overlap *legitimate* typography (dashes, curly quotes); a blanket strip **changes the visible text** and mangles normal documents, so it's not a clean win for an attacker |
| Homoglyph letters (4, risky) | medium | detectable (mixed scripts), but stripping requires script normalization that can corrupt legitimate non-Latin text |
| Transposition dictionary (7) | **hard** | the "symbols" are ordinary words/punctuation *choices* — there is no character class to strip; removing the mark means paraphrasing/rewriting the text |

Takeaways that shape priorities:

- **Confusables and the transposition dictionary are the strip-resistant classes.** They're
  harder to regex out precisely because their carriers coincide with characters/choices the
  text legitimately uses — an attacker can't remove them without editing the visible content.
  This is the concrete reason to pull confusables in early and keep the dictionary on the map.
- **A pure character regexAttack has a cost to the attacker**, and the cost rises as the carrier
  set overlaps normal text. Whitespace variants have ~zero collateral (easy to strip);
  confusables have real collateral (visible changes); word choices have maximal collateral
  (rewrite required). Measuring recovery vs. that attacker-cost tradeoff is a benchmark axis.
- **Nothing is strip-proof against a determined rewriter** (paraphrase / retype) — that's the
  honest ceiling. But moving up this table meaningfully raises the bar from "trivial one-liner."

## Combining classes — staged, not all at once

The end goal is appealing: use whitespace **and** punctuation **and** the transposition
dictionary together, so the mark survives more channels (each class fails differently —
character classes die to regexAttack, the dictionary survives it; whitespace survives glyph
edits, punctuation survives whitespace normalization). But a decoder juggling three carrier
classes at once is genuinely hard to debug — a recovery failure could come from any layer,
their interaction, or the sync between them.

So the plan is **staged**, and we decide as we develop:

1. Build and validate **one class at a time**, each behind the same `encode`/`decode`
   interface and measured in the same harness (its own strategy row in the strategy × channel
   matrix).
2. Design every class to be **independently decodable and independently togglable** — a per-class
   symbol stream with its own detector/ECC that can be run and scored *alone*. Isolation is the
   debugging tool: when combined, you can turn classes off one at a time and see which layer a
   failure lives in.
3. Combine only once each class is solid on its own, likely as **parallel channels** (each with
   its own ECC) rather than one entangled stream, so a weak/absent class degrades gracefully
   instead of corrupting the others. Whether a merged stream ever beats parallel channels is a
   later measurement question.

Verdict for now: keep the door open, don't build the combo yet.

## Discussion questions

- Which classes ship by default? (Leaning: whitespace variants on; **punctuation/format
  confusables a near-term priority** — dash/quote/ellipsis/bullet groups on once visibility is
  validated, homoglyph letters off; trailing-line/zero-width off.)
- How wide to push the whitespace alphabet (4 → 8 variants) before normalization/visibility bites?
- Do we treat classes 1, 4, 7 as independent parallel channels (with their own ECC) or one
  merged symbol stream?
- Which classes are worth their complexity given that regexAttack defeats all character-based
  ones anyway — is the transposition dictionary the only class with a different failure mode?
