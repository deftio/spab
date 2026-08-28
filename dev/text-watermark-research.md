# Text Watermarking — Research Notes & Attributions

Background research for spab, a robust text watermarking library. Focus: hiding a message in the *whitespace* of visible text, resiliently enough to survive normal editing.

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

## References

- SNOW / stegsnow — trailing-whitespace steganography (CTF Support writeups).
- dridk/ninam — GitHub (whitespace encode/decode, 1/2/4-bit).
- jaceddd/text_watermark — GitHub (invisible messaging).
- cronos3k/Text-Stealth-Watermark-Cleaner-Detector — GitHub (detector/cleaner; adversary reference).
- FraunhoferISST/Innamark — GitHub (Kotlin Multiplatform watermarking framework).
- *A Whitespace Replacement Information-Hiding Method* — arXiv (Innamark paper).
- `reedsolo` (Python) / `reedsolomon.js`, `erc-js` (JS) — Reed-Solomon implementations referenced during design.
