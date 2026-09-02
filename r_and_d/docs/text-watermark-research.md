# Text Watermarking — Research Notes & Attributions

Background research for spab, a robust text watermarking library. Focus: hiding a message in the *whitespace* of visible text, resiliently enough to survive normal editing.

> See also [`prior-art-and-tradeoffs.md`](prior-art-and-tradeoffs.md) — the running list of related
> tools (StegCloak, 330k, stegtext, markovTextStego, Tomato, Agarwal 2013, …), an approaches/tradeoffs
> map, and the open-source-vs-security-by-obscurity discussion.

## 1. Fragile baseline: format-based whitespace steganography

The classic approach appends invisible tabs/spaces to the ends of lines. A space = 0, a tab (or double space) = 1; markers sit before the newline so they're invisible in normal rendering.

- **SNOW / stegsnow** — the canonical tool. Hides data in trailing whitespace at line ends, uses tab vs. space to signify bits, and can encrypt the payload with a password. Originally C; Python ports exist (e.g. `pyUnicodeSteganography`).
- **dridk/ninam** — Python library that encodes secret data by adding/replacing whitespace; supports 1/2/4-bit encoding.
- **jaceddd/text_watermark** — text watermarking / invisible messaging, primarily zero-width Unicode characters but also handles standard whitespace variants.
- **cronos3k/Text-Stealth-Watermark-Cleaner-Detector** — detects/strips invisible Unicode characters and whitespace manipulation (useful as an adversary/threat model reference).

**Why this is rejected for spab:** trailing-whitespace watermarks are fragile. They are destroyed by code formatters/linters, editors that strip trailing spaces on save, and git repos with whitespace-cleanup hooks. Copy/paste into stripped text fields also erases them. No error correction, so any damage is fatal.

## 2. Robust approach: Unicode whitespace replacement + ECC

The state-of-the-art shift is from format-based hiding to **Unicode Whitespace Replacement Information Hiding backed by Error Correction Codes (ECC)**. Instead of trailing markers, replace the *inter-word* spaces with visually identical Unicode whitespace variants, and protect the payload with redundancy so it heals after partial loss.

Three conceptual layers:

```
Secret payload → Reed-Solomon ECC layer → Unicode homoglyph map (injected between words)
                 (adds redundant parity)   (visually identical spaces)
```

- **Layer 1 — Multi-space dictionary.** Map bits to subtle Unicode whitespace that renders like a normal space, e.g. 2 bits per space:
  `00 → U+0020` (space), `01 → U+2006` (six-per-em), `10 → U+2009` (thin), `11 → U+200A` (hair). Other candidates: U+2004 three-per-em, U+2005 four-per-em.
- **Layer 2 — Reed-Solomon ECC.** Same math as CDs and QR codes. With `n` parity bytes you can heal up to `n/2` corrupted bytes. Lets the decoder rebuild the payload after words/sentences are deleted or altered.
- **Layer 3 — Inter-word spreading.** Tokenize into words; each gap between words is an embedding opportunity. A 500-word passage gives ~499 slots, so the ECC-protected message can be interleaved and repeated multiple times across the whole body — surviving deletion of whole sections.

## 3. Prior art: Innamark (Fraunhofer ISST)

**Innamark** (FraunhoferISST/Innamark) is the leading academic-grade, production-oriented framework matching exactly this specification. Released/published ~2025–2026.

- **Channel:** leaves visible characters untouched; converts ordinary word-separating U+0020 spaces into an array of visually indistinguishable Unicode whitespace variants (e.g. U+2004–U+2006), each space carrying multiple bits.
- **Payload pipeline:** configurable compression, encryption, hashing, and Reed-Solomon error correction over the payload stream.
- **Redundancy:** error-corrected message is interleaved and repeated across all available spaces rather than written sequentially, so cutting the end of a paragraph doesn't destroy it.
- **Ecosystem:** Kotlin Multiplatform library (native / JVM / JavaScript), with a CLI and a web GUI out of the box.
- **Validation:** benchmarked across ~1,000,000 Wikipedia articles for hiddenness and extraction/recovery rates under document modification.

Reference paper: *"A Whitespace Replacement Information-Hiding Method"* (arXiv). This is the primary academic baseline for spab's design and edge cases. Note Innamark is Kotlin/JVM-centric — spab targets a lightweight self-contained JS implementation of the same ideas.

## 4. Gap in the ecosystem (why spab exists)

No standalone JS/npm library today offers the full combination of: a multi-whitespace dictionary, automated Reed-Solomon protection, inter-word spreading, and a simple `encode`/`decode` API that returns recovery/success statistics. Existing JS steganography packages are mostly image-focused, or inject zero-width characters in a single clump with no error correction. spab fills that gap.

## 5. Threat model / robustness expectations

Should survive: copy/paste, reflow that preserves word boundaries, deletion or replacement of words/sentences/a paragraph, and partial normalization of whitespace.

Expected to (and should honestly report) failure when: all whitespace is normalized to U+0020, the text is retyped from scratch, dedicated invisible-character cleaners are run (see cronos3k tool above), or the passage is shorter than the minimum capacity for the chosen ECC level.

## 6. Landscape: LLM watermarking vs. payload steganography (2024–2026)

Two different problems get called "text watermarking," and spab is firmly in the second camp. Worth separating clearly (external claims below, not independently verified):

**A. Generation-time statistical watermarking (detection-only, no payload).**

- **Google DeepMind SynthID-Text.** Biases token-selection probabilities during LLM generation to embed an imperceptible statistical pattern, then a scorer estimates the likelihood text is watermarked. Survives copy/paste and light edits. Open-source, integrated into Hugging Face `transformers` (v4.46.0+) and a DeepMind reference repo. Key limit: it is a **binary "is this AI-generated?" signal — it does not carry an arbitrary payload** (no user ID, hash, or message).
- **Anthropic / Claude watermarking + C2PA.** Reports of Claude adding imperceptible, machine-readable watermarks to generated text (surviving copy/paste and light edits) plus C2PA content-provenance signing, partly for EU AI Act compliance. Again provenance/detection, not arbitrary payload.
- **PRO: Precise and Robust text watermark for open-source LLMs** (arXiv) — research on robust origin-verification watermarks for LLM output.

These are the closest thing to the **transposition-dictionary** idea (bias equivalent choices, recover statistically) — but done *at generation time* and for *detection*, whereas spab does bias-of-choices *post-hoc* on arbitrary existing text and carries a *real payload* with ECC.

**B. Payload-carrying text steganography (what spab is).** Embeds an arbitrary readable message/ID into existing text. Same technique families as spab's symbol catalog:

- **Zero-width character injection** — map bits to ZWSP/ZWNJ (U+200B/U+200C) inserted between letters. Highest capacity, simplest; **easily stripped** by plain-text editors/sanitizers. → spab class 3 (noted as mostly a non-goal).
- **Homoglyph substitution** — swap Latin letters for Cyrillic/Greek look-alikes to carry bits; survives plain-text paste but **flagged as IDN-homograph security risk**. Tool: **StegCloak** (JS; homoglyphs + zero-width + encrypted, password-protected payloads). → spab class 4 (the risky "homoglyph letters" sub-group).
- **Natural-language / synonym & structural substitution** — encode bits by choosing synonyms ("huge" vs "large") or restructuring sentences; survives even print-and-retype. Tool: **AWT (Adversarial Watermarking Transformer)** — a deep-learning framework embedding bit-strings while preserving meaning. → spab class 7 (transposition dictionary), and the one class robust to character-stripping.

**How StegCloak actually works (studied from its output).** Given a secret, a password, and a
cover message, StegCloak: (1) optionally HMAC-tags the secret for integrity; (2) **compresses**
(zlib/deflate); (3) **encrypts** (AES-256-CTR keyed by the password); (4) maps the resulting bytes
to a small set of **zero-width / invisible Unicode characters** (ZWSP U+200B, ZWNJ U+200C, ZWJ
U+200D, and invisible math operators U+2061–U+2064 — ~5-6 symbols, so several bits per char); and
(5) **injects that whole block at a single point** in the cover (right after the first space). So
the payload is a *concentrated clump of invisible characters in one location*, not distributed —
which is why it looks like a short burst of hidden chars after the first word, and why it's
compact. Consequences: high capacity and tiny footprint, but **no redundancy and no spread** — the
entire mark lives in one spot, so any editor/sanitizer that strips zero-width chars, or any edit
that deletes that region, destroys all of it. There is no ECC and no robustness model; it's
confidentiality (encryption) plus invisibility, not survivability. (The clustered characters the
user observed — `⁠⁢‌‍⁡…` — are exactly these zero-width/invisible-operator codepoints.)

This is the sharpest contrast with spab: StegCloak concentrates an encrypted block in zero-width
chars (max capacity, zero robustness, trivially stripped); spab **spreads** an ECC-protected
payload across **visible-but-equivalent** carriers (whitespace variants, confusables) in many
places, trading raw capacity for surviving real-world edits — and reports tamper honestly. Same
compression+encryption idea (spab adopts it as flags), opposite robustness philosophy.

**Where spab sits.** Post-hoc, arbitrary-payload text steganography with real ECC and a *multi-carrier* symbol library (whitespace + punctuation confusables + transposition dictionary), plus a strategy × channel robustness benchmark. It differs from SynthID/Claude (generation-time, detection-only, no payload), from single-method tools like StegCloak (one carrier, no ECC/robustness study), and from AWT (learned, very-low payload) by being a deterministic, portable codec that spans the carrier classes and measures each against every channel-noise situation. The entropy north star unifies them: SynthID mines token-choice entropy at generation; spab mines formatting- and phrasing-choice entropy after the fact.

## References

- SNOW / stegsnow — trailing-whitespace steganography (CTF Support writeups).
- dridk/ninam — GitHub (whitespace encode/decode, 1/2/4-bit).
- jaceddd/text_watermark — GitHub (invisible messaging).
- cronos3k/Text-Stealth-Watermark-Cleaner-Detector — GitHub (detector/cleaner; adversary reference).
- FraunhoferISST/Innamark — GitHub (Kotlin Multiplatform watermarking framework).
- *A Whitespace Replacement Information-Hiding Method* — arXiv (Innamark paper).
- `reedsolo` (Python) / `reedsolomon.js`, `erc-js` (JS) — Reed-Solomon implementations referenced during design.
- Google DeepMind **SynthID-Text** — gen-time statistical watermark, detection-only; open-source in HF `transformers` v4.46.0+ and DeepMind repo.
- Anthropic **Claude** text watermarking + **C2PA** provenance signing (news/landscape reports).
- **PRO: Precise and Robust text watermark for open-source LLMs** — arXiv.
- **StegCloak** — JS homoglyph + zero-width steganography with encryption.
- **AWT (Adversarial Watermarking Transformer)** — learned natural-language bit-string watermarking.
