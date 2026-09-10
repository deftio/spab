# Prior art, approaches & tradeoffs — and a note on open source vs. obscurity

spab is one point in a long-explored design space. This document is the running list of related
work we study and compare against, an honest map of the main approaches and their tradeoffs, and a
discussion of a real tension for an open-source scheme: publishing the method also publishes the
attack.

## Capability matrix — where spab sits, and what it is missing

Dimensions that matter for a text watermark, across the families studied below.
**Sourced from each project's own documentation, not from running them** — the only
numbers we have measured ourselves are in `r_and_d/reports/findings.md`, produced by
`npm run compare` against reimplementations of each *technique*.

| | placement | ECC / erasure | integrity | compactness | typed payload | encrypted |
|---|---|---|---|---|---|---|
| **spab** | spread over every carrier site | repetition or RLNC fountain; resynchronises after insert/delete | wire-v2 packet, checksum 8–256 bits; **never returns a wrong payload** | length-preserving (substitution); zero-width optional | ✓ string/json/bytes/ser8/uuid/sha256 | ✓ AES-256-GCM |
| StegCloak | single insertion point | none | HMAC | payload adds bytes; visible in hex | — | AES-256-GCM |
| 330k unicode_steganography | spread across tokens | none | none | payload adds bytes | ✗ | ✗ |
| snow-family whitespace | trailing whitespace | none | none | length-changing (appends) | ✗ | optional (ICE) |
| Markov / linguistic stego | word choice | n/a — output is generated text | n/a | generates text rather than marking it | ✗ | ✗ |
| LLM generation-time (green-list, SynthID-Text) | token sampling at generation | statistical detection, not a payload | detection score, not a CRC | no payload to carry | n/a | n/a |

*Version-stamped: spab 0.5.2, wire format v2, default carriers ws+apos+hyphen. The
two right-hand columns were both ✗ through 0.4.x and closed in 0.5.0; a capability
table that is not version-stamped goes stale silently, which this one did.*

Reading the row that matters: **spab's distinguishing properties are the packet
checksum (it declines rather than guesses), length-preserving substitution carriers
that survive zero-width sanitisation, and resynchronisation after insert/delete.**
The typed-payload and encryption gaps that stood here through 0.4.x are closed.
What remains missing is tracked in `dev/roadmap.md` — chiefly the sliding histogram
detector, and a compact binary encoding for JSON payloads.

Three caveats before this table is used to argue anything:

1. **Different goals.** LLM generation-time watermarking does not carry a payload at
   all; it makes generated text statistically detectable. It is in the table because
   it is what "AI text watermarking" now usually means, not because it competes.
2. **Capability is not robustness.** Having AES says nothing about surviving a paste
   into a plain text field. Our measured comparison covers robustness; this table
   covers features.
3. **Not re-verified.** These entries come from project documentation as recorded
   below and have not been re-checked against current releases. Anything load-bearing
   should be confirmed before it is published.

## Reference implementations & tools (shout-outs)

We stand on a lot of prior work. In rough family order:

**Zero-width insertion** — hide data in invisible code points inserted between visible characters.

- **StegCloak** — <https://github.com/kurolabs/stegcloak>. The best-known modern one: JavaScript,
  hides a payload in zero-width characters with optional AES-256-GCM encryption + HMAC integrity and
  compression. Polished, widely used; the "our friends" spab measures itself against. Its zero-width
  payload changes length and is visible in a hex/byte view — the classic tradeoff of this family.
- **330k `unicode_steganography.js`** — <https://github.com/330k/misc_tools>
  (demo: <https://330k.github.io/misc_tools/unicode_steganography.js>). Kei Misawa, MIT license. A
  clean, small implementation using a **4-symbol zero-width alphabet** (`U+200C U+200D U+202C U+FEFF`)
  = 2 bits per inserted character, shuffled among the cover's tokens. Directly informed spab's
  `zwsp` carrier (we use a 4-symbol zero-width alphabet, 2 bits/char, inserted at word gaps).
- **stegtext** — <https://github.com/btimby/stegtext>. An older Python take on invisible-character
  text steganography; useful as a minimal reference point.
- **Tomato** — <https://github.com/user1342/Tomato>. A text-steganography tool in this space; see the
  repo for its exact technique. Listed for comparison.
- **Priyansh-15 / Steganography-Tools** — <https://github.com/Priyansh-15/Steganography-Tools>. A
  multi-modal toolkit that includes a text-steganography module; handy as a survey of techniques.

**Linguistic / generative** — hide data in *word choice or generated text* rather than glyphs.

- **markovTextStego.js** — <https://github.com/jthuraisamy/markovTextStego.js>
  (demo: <https://jthuraisamy.github.io/markovTextStego.js/>, ~13 years old). Uses a Markov chain so
  the *choice among plausible next words* carries bits — the output is newly generated text, not a
  marked copy of an existing document. A different bargain entirely (below).

**LLM generation-time watermarking** — a different branch worth knowing, because it's often what
"AI text watermarking" now means. Here the mark is embedded *while a language model generates text*,
by biasing which tokens it samples — not applied to existing text afterward.

- **Green-list logit biasing** (Kirchenbauer et al., 2023) — a key seeds a per-step pseudo-random
  split of the vocabulary into "green"/"red" tokens; the model is nudged toward green ones, and a
  key-holder later detects the statistical excess of green tokens. **Cryptographic sampling**
  (Aaronson / OpenAI) and **SynthID-Text / Tournament sampling** (Dathathri et al., DeepMind, *Nature*
  2024) are related: the randomness of token *selection* carries the signal.
- Properties: it only marks text the *watermarking model itself* generates (it cannot mark arbitrary
  third-party text), needs logit/sampling access to embed, is detected statistically with a key, can
  cost a little output quality, and is weakened by paraphrase or heavy editing. It's the same broad
  area as the **Psic effect** caution above.
- **Explainer (this list's entry point):** *"Why You Cannot See a Watermark in AI Text"* — No Hype AI,
  <https://www.youtube.com/watch?v=Cmi-1QSaptA>. A popular overview of the token-distribution idea.
  (It frames the topic around LLM vendors watermarking their output; we cite it as an explainer of
  the *technique*, not as a source for any particular company's practices.)

*Orthogonal to spab, and complementary:* spab marks **any existing text** post-hoc through glyph
choices, with no model and nothing learned at decode time; an LLM watermark rides in **word choice at
generation time** and only for text that model produced. They can even coexist on the same passage —
one in the words, one in the spaces. spab deliberately stays in the non-generative, mark-any-text
lane; LLM watermarking is the tool when you control the generator and want provenance on its output.

**Survey / academic.**

- **Monika Agarwal, "Text Steganographic Approaches: A Comparison"**, IJNSA Vol.5 No.1 (Jan 2013),
  arXiv:[1302.2718](https://arxiv.org/abs/1302.2718). Presents and compares linguistic approaches
  (missing-letter puzzle; wordlist encoding; start/end-letter encoding) and scrambles the message
  with a one-time pad before embedding. A good taxonomy of the *linguistic* branch.
- **Wikipedia, "List of steganography techniques"** — catalogs the digital-text methods we build on:
  the zero-width joiner/non-joiner (ZWJ/ZWNJ) as 1/0, en/figure/whitespace characters, and
  change-tracking abuse (hiding a message in a word processor's deliberate "errors and corrections").
  It also records the **Psic effect** (Yang et al., 2020): when generative steganographic text is
  over-optimized for quality, its *overall statistical distribution* drifts further from natural
  text and becomes *easier* to detect — a caution we take seriously (see "Where spab sits").

## Approaches & tradeoffs

Five broad families, and what each trades away:

1. **Format / whitespace substitution** — swap a space (or a run of spaces, or line-end padding) for
   an equivalent whitespace variant. spab's `ws` (4 variants, 2 bits/gap) and `wsdense` (8 variants,
   3 bits/gap) live here. *Length-preserving, visually identical*; low-to-moderate capacity; **dies
   to NFKC normalization** (every space variant collapses to `U+0020`) and to whitespace-reflow.
2. **Zero-width insertion** — insert invisible code points (ZWSP/ZWNJ/ZWJ/word-joiner, BOM). spab's
   `zwsp`, StegCloak, 330k. *Highest capacity* and easy to implement; but it **adds characters** (the
   text gets longer, and the hidden run is plainly visible in a hex/byte view or a "show invisibles"
   editor), and it is **NFKC- and copy-fragile** — many editors and platforms strip or mangle it.
3. **Homoglyph / confusable substitution** — swap a character for a look-alike (straight vs. curly
   apostrophe, hyphen-minus vs. Unicode hyphen, Latin vs. Cyrillic `a`). spab's `apos`/`hyphen`.
   *Length-preserving and NFKC-surviving*; low capacity (≈1 bit per eligible glyph); dies to
   autocorrect (smart-quotes) or aggressive de-confusable passes.
4. **Linguistic / generative** — encode bits in word choice, synonyms, or Markov/NLP/LLM-generated
   text. markovTextStego, Agarwal's linguistic methods, modern LLM stego. *Survives copy/paste,
   retyping, and normalization* (the bits are in the words, not the bytes) and can be high-capacity;
   but it **changes what the text says**, quality control is hard, and — per the Psic effect — the
   better the fluency, the more detectable the statistics can become.
5. **Format / document features** — tracked-changes, revision metadata, deliberate-error puzzles,
   font/kerning tricks. High capacity in the right container; brittle and container-specific.

| Family | Capacity | Visual stealth | Hex/statistical stealth | NFKC | Copy / retype | Changes meaning? |
|---|---|---|---|---|---|---|
| Whitespace sub (`ws`,`wsdense`) | low–med | identical | medium (odd spaces) | ✗ dies | survives copy | no |
| Zero-width insert (`zwsp`) | high | identical | **low** (visible in hex; longer) | ✗ dies | often stripped | no |
| Homoglyph (`apos`,`hyphen`) | low | identical | medium | ✓ survives | survives copy | no |
| Linguistic / generative | med–high | n/a (new text) | varies (Psic effect) | ✓ survives | ✓ survives retype | **yes** |
| Format / tracked-changes | high | hidden in tooling | container-specific | n/a | brittle | no |

### Where spab sits

spab deliberately stays in the **non-generative** families (1–3): it marks an *existing* document
without changing a word, so the meaning is untouched and there is no Psic-effect quality/detectability
tradeoff to manage. Its distinguishing bets are (a) **parallel carriers across families** — whitespace
*and* confusables (*and*, opt-in, zero-width or dense whitespace) run as independent channels that
fail on *different* edits, so one surviving channel recovers the payload; (b) **real FEC** (repetition
or a GF(256) RLNC fountain) rather than raw bit-stuffing; and (c) a **frozen, portable wire format**
with cross-language conformance vectors. The zero-width (`zwsp`) and dense-whitespace (`wsdense`)
carriers were added specifically so the playground can compare spab head-to-head with the zero-width
tools above, on the same corpora and the same channel attacks.

What spab does **not** claim: to beat a determined adversary, or to be undetectable. It targets
*incidental* robustness (copy/paste, reformatting, normalization) and *tamper-evidence*.

## Lessons for spab

Reading the implementations (not just their READMEs) turns up concrete things worth adopting,
things that confirm the roadmap, and places we deliberately differ.

**Adopt — real wins we don't yet have:**

- **Base-N (non-power-of-2) carrier packing.** 330k encodes bytes into an arbitrary-alphabet alphabet
  by base conversion, so a 6-symbol zero-width set carries `log2(6) ≈ 2.58` bits/char, not 2. spab
  currently packs a whole number of bits per site (power-of-2 alphabets), which *wastes capacity*
  whenever a carrier has a non-power-of-2 number of glyphs. An arithmetic/base-N packer over the
  merged site stream would recover that fractional headroom — a measurable density gain, and it fits
  the earlier "symbol count doesn't need to be a power of two" note.
- **Keyed spread / interleave, not clustering.** 330k *shuffles* its zero-width characters among the
  cover's tokens rather than dropping them as one blob. Spreading carriers (a) is stealthier (no
  tell-tale cluster) and (b) survives *localized* edits (a cut/paste that removes one region loses
  only a slice, not the whole mark). spab already spreads via repetition, but this is the strongest
  argument yet to prioritize the **keyed PN interleave** already on the roadmap — it's stealth *and*
  robustness in one mechanism, and being key-derived it's cryptography, not obscurity.
- **A stealth / detectability metric.** Agarwal scores cover-vs-stego similarity (Jaro ≈ 0.95);
  StegCloak is blunt that a Warden can spot "an unusual amount of special invisible characters." We
  should put a **number** on this in the harness and the playground: for substitution carriers it's
  ~1 (visually identical, but a whitespace-histogram χ² is the real signal); for `zwsp` the
  invisible-char ratio (added chars / cover chars) is a direct detectability proxy. Measuring it
  keeps our comparisons honest and lets us tune density against exposure.
- **Payload whitening.** Agarwal one-time-pads the message before embedding. Even *without* a key, a
  fixed public-seed whitening (XOR a PN stream) flattens the carrier statistics — balancing 0/1 so
  the whitespace/quote histograms look natural — which directly reduces the χ² signal above. (To be
  clear: whitening is a *statistics* fix, not security; confidentiality still needs the key.)

**Confirms the roadmap:**

- **Pipeline order: compress → encrypt → FEC → carrier.** StegCloak compresses (LZ+Huffman) *then*
  encrypts (AES-256-CTR) — the right order, since ciphertext doesn't compress. It matches spab's
  planned `text → … → stream → ECC → type+payload` with `auto` compression and a single AEAD. Lock
  it as the canonical order and document that compression must precede encryption.
- **Integrity comes free with AEAD.** StegCloak bolts on optional HMAC for tamper-evidence. spab's
  planned ChaCha20-**Poly1305** *is* that MAC — the tag gives cryptographic tamper-evidence without a
  second mechanism. Until it lands, keep saying CRC-8 is a *checksum*, not tamper-proofing.
- **Honesty about the Warden.** StegCloak states plainly it "doesn't solve the Alice-Bob-Warden
  problem" — invisible characters are detectable even when the payload isn't readable. That's exactly
  spab's *incidental-robustness / tamper-evidence* posture; keep resisting any "undetectable" claim.

**Small UX borrowings** (for when encryption lands): a `SPAB_KEY` environment variable and a config
file (StegCloak's `STEGCLOAK_PASSWORD` + config), clipboard reveal, and "hide a **link** to a big
file rather than the file" — which is already spab's serial/hash/URL sweet spot (the `type` byte).

**Deliberately differ:** we stay **non-generative**. markovTextStego and the linguistic methods
survive retyping because the bits live in word choice — but they *rewrite the text*, and the Psic
effect says better fluency can mean *worse* statistical hiding. spab marks an existing document
without changing a word; we accept lower retype-robustness in exchange for never touching meaning and
never fighting the fluency/detectability tradeoff.

## Open source vs. security-by-obscurity (the honest tension)

Being open source, spab publishes its own attack surface. Anyone can read exactly which code points
each carrier uses and write a ten-line "strip spab" pass: NFKC-normalize, collapse whitespace, remove
zero-width characters, de-confuse quotes and hyphens. A closed, secret carrier scheme would raise the
attacker's cost simply because they'd have to *find* the channel first. So isn't a little
security-by-obscurity worth it here?

Our position — and it's worth stating plainly because it shapes the roadmap:

- **Kerckhoffs's principle applies.** A scheme should stay secure even when everything about it except
  the key is public. Obscurity is not a security property; it is a *speed bump* that degrades to zero
  the moment the method leaks, is reverse-engineered, or is guessed (and carrier schemes are guessable
  — there are only so many invisible/confusable code points). Designing *around* secrecy of the
  algorithm would give us a false sense of safety and an un-auditable codec.
- **Confidentiality belongs in the key, not the carrier.** What obscurity is really reaching for —
  "an attacker who sees the text still can't read or forge the payload" — is exactly what a keyed
  cipher provides *without* hiding the method. spab's planned single AEAD (ChaCha20-Poly1305, keyed,
  deterministic stretch) is the right home for that: the carriers stay public and auditable, while the
  payload's secrecy and tamper-evidence rest on the key. Reading or forging a mark then requires the
  key, no matter how well the attacker understands the carriers.
- **Obscurity as a documented *cost multiplier*, never as security.** There is legitimate,
  *non-load-bearing* value in raising the attacker's effort: a keyed, pseudo-random choice of order
  and value means that even knowing the carrier alphabet, an attacker can't cleanly separate signal
  from cover, or forge a payload, without the key. This now exists (opt-in `params.key`): the symbol
  layer whitens each symbol with a key-derived PN value and interleaves the sites by a key-derived
  permutation. Crucially that's *keyed* (derived from the secret) — just cryptography, not a hidden
  constant baked into the source — and we treat it as a cost multiplier layered under the planned
  cipher, and keep saying so, rather than letting it masquerade as the security itself.
- **What openness buys us.** Auditable carriers, cross-language conformance, community review of the
  FEC and framing, and honest benchmarks against the tools above. That is a better foundation than a
  secret that only works until someone looks.

Bottom line: spab stays open, leans on **keyed confidentiality** for the properties obscurity is
tempted to fake, and is candid that against a determined, spab-aware stripper the *carrier* is
removable — the *key-protected payload* is what stays private and tamper-evident.
