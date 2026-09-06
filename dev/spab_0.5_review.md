# Spab 0.5.0 in the Text Watermarking Landscape

## Architecture, Prior Art, Current Strengths, Gaps, and Engineering Directions

**Status:** working technical review  
**spab version reviewed:** 0.5.0, September 5, 2026

---

## 1. Executive summary

Text watermarking is a particularly difficult communications problem because the carrier is not an analog signal. In audio, images, and video, small numerical perturbations can be distributed through a signal while remaining below normal perceptual thresholds. Text is different: human readers and software routinely inspect, copy, normalize, tokenize, rewrite, and sometimes reinterpret every symbol in the stream.

A text watermarker therefore has only a limited amount of latent representational entropy available to it. Typical carriers include:

- visually equivalent whitespace characters;
- punctuation alternatives;
- Unicode confusables;
- zero-width characters;
- lexical substitutions;
- grammatical or syntactic choices;
- model-generation choices.

The text must remain readable, semantically stable, and preferably visually unchanged.

Most existing open-source text watermarking systems concentrate on the first part of the problem: **finding a carrier and mapping bits into it**. VSRMark uses variation selectors. StegCloak uses zero-width characters. Innamark uses carefully selected whitespace substitutions. Drift independently repeats a mark over several Unicode carrier classes. stegmark combines zero-width characters with synonym substitutions.

spab is increasingly different because its architectural center is the **communications channel**, not a particular carrier.

The intended model is:

```text
payload
   │
   ▼
serialization
   │
compression?
   │
encryption?
   │
framing + integrity
   │
ECC / fountain coding
   │
modulation
   │
multiple heterogeneous text carriers
   │
──────────────── noisy text channel ────────────────
   │
carrier detection / demodulation
   │
synchronization
   │
packet confidence / integrity
   │
ECC / fountain reconstruction
   │
frame validation
   │
decryption / decompression
   │
payload
```

A key consequence is that **robustness is not synonymous with repetition**.

Robustness can come from:

1. choosing carrier classes with different failure modes;
2. integrating many physical carrier observations into one statistical symbol;
3. soft rather than hard symbol decisions;
4. interleaving against burst damage;
5. synchronization after insertions and deletions;
6. converting damaged packets into erasures;
7. ECC for random errors;
8. fountain coding for missing packets;
9. repeated or distributed configuration information;
10. using additional cover-text capacity as coding margin instead of additional payload.

spab 0.5.0 already implements much of the surrounding communications stack: multiple carriers, dense carrier modes, compact typed framing, compression, encryption, repetition, systematic GF(256) RLNC fountain coding, integrity checks, phase resynchronization, capacity reporting, fuzz/property testing, and a sizable channel-noise characterization harness.

One important qualification is that **the histogram-constellation / soft-decision modem discussed in the architecture documents is not yet the modem shipping on `main` in the JavaScript implementation reviewed here**. The proposal itself calls the histogram receiver the target design and describes the current implementation as the lean/per-glyph baseline.

That is probably the largest remaining architectural step.

If the planned C/C++, Rust, Python, Java/Kotlin, and Swift ports all implement the same normative carrier behavior and wire format and pass common conformance vectors, spab would have one of the strongest architectures among the open-source systems examined here for watermarking **already-existing text**.

Innamark would still have the stronger body of published and application-level experimental evidence. That is primarily a maturity difference: the current spab implementation is roughly a week old, whereas Innamark has already undergone a million-document published benchmark and application interoperability evaluation.

---

# 2. Why text watermarking is unusually difficult

## 2.1 Text does not provide a forgiving analog substrate

An audio watermark may modify a spectral coefficient slightly. An image watermarker may perturb frequency-domain values across thousands of pixels. Human perception integrates the result and usually does not care about tiny individual changes.

Text gives us discrete choices:

```text
U+0020 SPACE

versus

U+2006 SIX-PER-EM SPACE
```

or:

```text
'     U+0027

versus

’     U+2019
```

There is no useful equivalent of:

```text
U+2006.37
```

A textual watermark therefore has to manufacture a noisy communications channel out of discrete choices that readers and applications consider equivalent enough.

Even worse, software often manipulates these characters deliberately:

- Unicode normalization;
- typography correction;
- smart quotes;
- line wrapping;
- HTML sanitization;
- Markdown rendering;
- copy/paste;
- PDF extraction;
- tokenization;
- OCR;
- search indexing;
- whitespace collapse;
- code formatting;
- LLM rewriting.

The receiver cannot assume that symbol position or even symbol count remains stable.

---

## 2.2 Text has latent representational entropy

A useful conceptual model is that ordinary text contains multiple representations that convey essentially the same visible or semantic information.

Examples include:

```text
"word word"

"word word"

"it's"

"it’s"

"well-known"

"well‐known"
```

At a higher linguistic level:

```text
however
nevertheless
```

or:

```text
demonstrates
shows
```

These alternatives represent **carrier entropy**.

spab's basic opportunity is to measure that available entropy and allocate it among:

```text
payload
framing
integrity
synchronization
FEC
fountain overhead
interleaving
modulation margin
carrier diversity
```

A system optimized entirely for payload density spends nearly all available entropy on payload.

A system optimized for robustness deliberately does not.

---

# 3. Capacity is not one number

A recurring mistake in text watermark comparisons is to quote only bits per character or bits per carrier site.

That measures **raw modulation capacity**, but it says little about whether the payload can be recovered after the text has traveled through a realistic channel.

At least four capacity concepts matter.

### 3.1 Peak raw capacity

How much information can be represented in pristine text?

VSRMark is exceptionally strong here because one variation selector can encode an entire byte.

spab also contains intentionally dense modes. The shipping JS supports:

- `ws`: radix 4, 2 bits per eligible inter-word space;
- `wsdense`: radix 8, 3 bits per eligible inter-word space;
- `zwsp`: radix 4, 2 bits per inserted zero-width character;
- a default zero-width density of 6 inserted characters per word gap, or 12 raw bits/gap;
- automatic zero-width density growth up to 64 characters per gap.

The implementation explicitly notes that this can let short cover text hold hundreds of bytes, at the cost of UTF-8 expansion and robustness/stealth.

Therefore it is inaccurate to characterize spab as intrinsically low-density.

It supports multiple operating points.

---

### 3.2 Robust capacity

More interesting is:

\[
C_R(p)=
\frac{\text{payload bits successfully recovered}}
{\text{cover text size}}
\]

under corruption profile \(p\).

For example:

```text
raw capacity:
VSRMark       ████████████████████
spab robust   ███████████

after a hostile Unicode normalization channel:
VSRMark
spab robust   ████████
```

The exact numbers have to be measured, but the distinction is the important part.

An 8-bit-per-site channel that disappears entirely after normalization may have lower useful capacity than a much lower-rate channel carrying heavily coded information across several independent carrier classes.

---

### 3.3 Redundancy elasticity

Suppose a document has ten times more carrier capacity than the payload strictly needs.

What happens to the remaining capacity?

Different systems behave very differently.

```text
VSRMark
payload + mostly unused cover capacity

StegCloak
payload + mostly unused cover capacity

Innamark
payload + repeated watermark copies

spab/repetition
payload + additional redundant observations

spab/RLNC
payload + additional independent coded packets

histogram-modulated spab
payload + larger integration blocks and/or more coded packets
```

This is a useful metric:

> **How efficiently can additional cover length be converted into increased probability of successful recovery?**

---

### 3.4 Serialized expansion

A watermark can be visually invisible while enormously expanding the byte representation.

Variation selectors and zero-width symbols are particularly important here.

spab explicitly separates length-preserving substitution carriers from insertion carriers. Its zero-width implementation notes that every density increase adds another multibyte Unicode character per word gap.

So any useful capacity table should distinguish:

- visible character expansion;
- Unicode codepoint expansion;
- UTF-8 byte expansion;
- recoverable payload capacity.

---

# 4. Carrier families

## 4.1 Whitespace substitution

A normal space is replaced with one of several Unicode whitespace characters.

Advantages:

- high carrier density in ordinary prose;
- can be length-preserving;
- does not alter words;
- generally visually subtle.

Weaknesses:

- normalization may collapse distinctions;
- some variants have measurable width differences;
- retyping destroys the channel;
- text-processing pipelines may canonicalize spaces.

Innamark uses this family very carefully, choosing whitespace symbols based partly on interoperability behavior. It is length-preserving and specifically avoids the zero-width insertion model.

spab's standard `ws` alphabet provides four states, while `wsdense` provides eight.

---

## 4.2 Punctuation alternatives

Examples:

```text
'  ↔  ’

-  ↔  ‐
```

spab's shipping default combines whitespace with apostrophe and hyphen channels:

```text
['ws', 'apos', 'hyphen']
```

The point is not that punctuation has enormous capacity. It generally does not.

The point is **failure diversity**.

The source comments explicitly note that the selected punctuation alternatives survive NFKC situations that kill the whitespace channel, making them complementary channels.

---

## 4.3 Zero-width characters

Zero-width characters provide very high packing density and can be inserted without changing visible text.

StegCloak is the best-known system in this category. It compresses a payload and can protect it with encryption and HMAC before encoding it in an invisible-character alphabet.

spab also provides a zero-width carrier for cases where density matters more than length preservation.

The weakness is obvious:

> a sanitizer that strips invisible characters can destroy the entire channel.

This makes zero-width encoding useful as one available operating mode, but less attractive as the only robustness strategy.

---

## 4.4 Unicode variation selectors

VSRMark maps bytes directly to Unicode variation selectors.

Its conceptual mapping is essentially:

```text
payload byte
   ↓
one of 256 variation-selector states
   ↓
append after visible character
```

That gives exceptionally high carrier efficiency: approximately one payload byte per visible carrier character, with small framing overhead.

The implementation is also available in C, Go, Java, Rust, Swift, and TypeScript with per-language tests.

Its main limitation in the present comparison is not capacity. It is channel coding.

The scheme primarily provides framing and CRC detection. If variation selectors disappear, the CRC can tell the decoder that something is wrong, but it cannot reconstruct the missing information.

---

## 4.5 Homoglyphs

Characters from different Unicode alphabets may appear visually similar:

```text
Latin a
Cyrillic а
```

Drift uses homoglyphs as one of three independent channels, along with zero-width symbols and trailing whitespace. Each carries the payload independently.

This is a useful lesson:

> different channels should be selected because they fail differently.

The disadvantage is that confusable-normalization, ASCII conversion, security scanners, and some text pipelines deliberately detect or remove homoglyphs.

---

## 4.6 Lexical and grammatical carriers

Instead of changing Unicode representation, the text itself may be altered between semantically similar forms.

stegmark has 76 binary synonym pairs such as:

```text
however       ↔ nevertheless
therefore     ↔ consequently
demonstrates  ↔ displays
provides      ↔ offers
```

Each recognized occurrence nominally carries one bit.

This survives Unicode sanitization because the information exists in ordinary words.

However, stegmark illustrates how not to treat such a channel.

The decoder reads eligible substitutions sequentially. Natural editing can therefore create:

- bit flips;
- carrier deletions;
- carrier insertions;
- global synchronization shifts.

Its fallback verifier compares only a small prefix of an HMAC-derived fingerprint and contains no real lexical-channel ECC.

The general lexical-carrier idea remains interesting.

The lesson for spab is that a future grammatical/lexical carrier should **not** be modeled as a naïve ordered bit tape.

It should instead use content-addressed or self-locating observations.

---

# 5. Lessons from the systems examined

## 5.1 Innamark

Innamark is currently the strongest empirical reference among the post-hoc text systems examined.

Important lessons include:

### Carefully select the physical symbols

Carrier characters should be chosen based on actual real-world survivability, not merely Unicode documentation.

### Preserve text length when possible

Length preservation helps both stealth and compatibility.

### Additional cover length should increase robustness

Innamark can repeatedly encode the watermark across available text rather than merely embedding one copy and leaving the remainder unused.

### Test real applications

Its published benchmark used one million Wikipedia articles and evaluated ten algorithms. It also studied modification robustness and application/file-format transfer behavior.

### Imperceptibility deserves its own testing

The research included caret-navigation behavior, not merely visual screenshots. Some invisible-character algorithms become apparent when a user navigates through them character by character.

### Limitation

Its principal carrier remains one family: whitespace substitution.

spab's heterogeneous-carrier and coding architecture is more general, but Innamark currently has much stronger application-level evidence.

It also has a significant licensing consideration: its repository states that patent licensing is required in addition to the software license.

---

## 5.2 VSRMark

VSRMark teaches two useful lessons.

### Extreme capacity can be valuable

Not every use case requires high corruption resistance.

Sometimes a compact cover carrying a large payload is the actual goal.

### Cross-language simplicity has real value

Its C, Go, Java, Rust, Swift, and TypeScript implementations make the format easy to integrate.

Its weakness relative to spab is that most of the sophistication stops at modulation/framing.

There is little machinery for:

- synchronization loss;
- packet erasures;
- burst deletion;
- multiple carrier classes;
- adaptive redundancy.

---

## 5.3 StegCloak

StegCloak demonstrates the usefulness of placing conventional payload engineering before the textual carrier:

```text
payload
  ↓
compression
  ↓
encryption
  ↓
integrity
  ↓
steganographic representation
```

Its use of compression is especially relevant: fewer encoded bytes means fewer physical carrier symbols must survive.

spab 0.5.0 now includes a similar conceptual transform stack, including LZSS compression and AES-256-GCM encryption.

StegCloak's weakness is that nearly all channel risk remains concentrated in the zero-width carrier.

---

## 5.4 Drift

Drift's best idea is independent carrier channels.

It encodes through:

- homoglyphs;
- zero-width characters;
- trailing whitespace.

The same payload can survive if one channel is destroyed.

spab takes this further because surviving carrier information can participate in a common decoding process rather than merely representing separate whole copies.

The difference is roughly:

```text
Drift:

payload ──► channel A copy
payload ──► channel B copy
payload ──► channel C copy
```

versus the stronger spab direction:

```text
payload
   ↓
coded packet population
   ↓
 ┌───────────────┬─────────────┬─────────────┐
 whitespace   punctuation    other carrier
 └───────────────┴─────────────┴─────────────┘
                   ↓
          surviving packet pool
                   ↓
                decode
```

---

## 5.5 stegmark

stegmark's two-channel approach is conceptually useful:

```text
zero-width channel → rich record

lexical channel    → smaller identity fingerprint
```

That provides a fallback when zero-width Unicode is removed.

Its lexical implementation demonstrates several problems spab should avoid:

- fixed sequential carrier ordering;
- no robust indexing;
- no real ECC;
- insert/delete desynchronization;
- limited vocabulary;
- semantic substitutions that may not be equally natural in context.

The takeaway is not "synonym watermarks do not work."

It is:

> **linguistic observations have to be treated as a noisy, sparse, synchronization-sensitive communications channel.**

---

## 5.6 REMARK-LLM and XMark

REMARK-LLM and XMark belong to a somewhat different category.

They modify or regenerate language itself rather than post-processing an arbitrary existing document.

REMARK-LLM learns a representation that allows a binary signature to survive text changes.

XMark biases token generation so that many generated token choices collectively communicate a multi-bit message. Its current reference implementation evaluates binary messages, token budgets, bit accuracy, perplexity, BERTScore, and other generation metrics.

These approaches teach spab two useful lessons:

### Detection can be statistical

A physical observation does not need to map immediately to a perfect hard bit.

### More text can produce confidence rather than payload

Additional observations can reinforce the same hidden information.

Their limitation as direct competitors is that they generally require control over generation and cannot trivially watermark an arbitrary existing:

- source file;
- email;
- Markdown document;
- legal memo;
- human-written report.

They therefore occupy an adjacent design space.

---

# 6. spab 0.5.0 as implemented

## 6.1 Current carrier library

The JavaScript reference implementation currently exposes several carrier classes.

| Carrier | Encoding | Raw density | Length preserving | Main failure mode |
|---|---|---:|:---:|---|
| `ws` | 4 Unicode whitespace states | 2 bits/site | yes | whitespace normalization |
| `wsdense` | 8 Unicode whitespace states | 3 bits/site | yes | normalization / visual width clues |
| `apos` | straight vs curly apostrophe | 1 bit/site | yes | smart-quote normalization |
| `hyphen` | hyphen-minus vs Unicode hyphen | 1 bit/site | yes | punctuation normalization |
| `zwsp` | 4 zero-width states | 2 bits/inserted char | no | invisible-character stripping |

The default carrier set is currently:

```text
ws + apos + hyphen
```

rather than whitespace alone.

The zero-width carrier has deliberately high-density modes, including automatic density growth to a configured maximum.

---

## 6.2 Compact wire format

Wire format v2 has a 17-bit fixed header:

```text
version : 3
type    : 5
comp    : 3
enc     : 3
cksum   : 3
```

Optional extension bytes follow only when compact field ranges are exhausted.

Length is encoded only when the payload type does not already imply it.

The checksum precedes content on the wire.

The format is explicitly bit-oriented because forcing each logical field to a byte boundary would waste carrier entropy.

This is a good fit for text watermarking because framing overhead is directly paid for in textual carrier capacity.

---

## 6.3 Typed payloads

0.5.0 supports typed payloads instead of treating everything as anonymous bytes.

The public documentation lists identifiers, JSON, UUIDs, digests, strings, and arbitrary bytes, with type metadata carried in the packet.

This is useful because fixed-size types can omit explicit lengths.

---

## 6.4 Compression

Compression is attempted before encoding and retained only when it actually reduces the stored representation.

This is particularly useful for a constrained watermark channel because every byte removed before ECC reduces the amount of physical cover entropy required afterward.

---

## 6.5 Encryption

The JS reference implementation includes AES-256-GCM.

Encrypted content is encoded as:

```text
nonce || ciphertext || authentication tag
```

with a 12-byte nonce and 16-byte tag.

This provides payload confidentiality and authenticated decryption.

It should be kept conceptually separate from watermark robustness.

Encryption protects the contents.

It does not cause damaged carrier symbols to survive.

---

# 7. Current error-control architecture

## 7.1 Repetition

Repetition remains useful because it performs well under dense random bit corruption.

If several versions of the same bit survive:

```text
1 1 0 1 1
```

majority voting produces:

```text
1
```

This is simple and surprisingly effective under the right channel model.

spab's own 0.5.0 characterization is important here: on cases where both repetition and RLNC could fit, repetition currently measured better overall in the paired comparison, approximately 88% versus 80%.

That is useful evidence against assuming the more sophisticated code is automatically better.

---

## 7.2 RLNC fountain mode

spab implements systematic random-linear network coding over GF(256).

The current source treats each source byte as one source symbol.

A coded packet is:

```text
ESI high byte
ESI low byte
coded value byte
CRC8
```

or 32 bits total.

Systematic ESIs directly represent source symbols.

Repair ESIs deterministically generate a GF(256) coefficient vector and transmit a linear combination of the source bytes.

The decoder performs Gaussian elimination over GF(256).

This gives spab a useful property:

> packets recovered from different surviving carrier channels can jointly reconstruct the frame.

The source explicitly describes the packets as self-locating through the ESI and self-checking through the CRC.

---

## 7.3 Fountain coding is not merely repetition

A repetition scheme produces:

```text
P P P P P P
```

A fountain scheme produces:

```text
F0 F1 F2 F3 F4 F5 ...
```

where each repair symbol gives additional independent information about the original source.

If enough independent equations survive, reconstruction is possible even though no complete copy survived.

This is particularly attractive for heterogeneous text carriers:

```text
       whitespace ── F2
       whitespace ── F7
payload
       apostrophe ─── F13
       hyphen ─────── F21
```

Destroying the whitespace channel may still leave enough other equations.

---

# 8. Synchronization is as important as ECC

Text corruption is not merely a bit-error or packet-erasure channel.

It is frequently an **insertion/deletion channel**.

Suppose the transmitter emits:

```text
A B C D E F G
```

and the decoder assumes every block begins at a fixed symbol index.

Deleting `C` gives:

```text
A B D E F G
```

Everything after the deletion can now be framed incorrectly.

Increasing repetition does not solve this.

Every repeated copy after the deletion may be shifted in exactly the same way.

spab 0.5.0 explicitly recognizes this problem.

The decoder tries alternative phases over the raw symbol stream, re-cutting the stream into candidate block boundaries. The current implementation tries up to 32 phases.

That is a significant architectural distinction from simple steganographic encoders.

---

# 9. The histogram-modem direction

The R&D architecture proposes moving away from hard per-glyph decoding.

Instead, a block of carrier sites represents one symbol through its **histogram**.

For example, using four equivalent spaces:

```text
S0 → 70% A, 10% B, 10% C, 10% D
S1 → 10% A, 70% B, 10% C, 10% D
S2 → 10% A, 10% B, 70% C, 10% D
S3 → 10% A, 10% B, 10% C, 70% D
```

After channel corruption, a transmitted S0 might be observed as:

```text
58% A, 17% B, 13% C, 12% D
```

The decoder need not demand exact glyph preservation.

It estimates which target distribution most likely produced the observation.

The proposal describes:

- histogram constellations;
- nearest-state matching by KL divergence, chi-square, L1, or correlation;
- constellation shaping;
- block size as integration time;
- adaptive modulation order;
- Gray mapping;
- soft likelihood output into the coding layer.

This transforms the underlying model from:

```text
glyph → bit
```

to:

```text
many discrete textual observations
               ↓
       empirical distribution
               ↓
        noisy symbol estimate
               ↓
          likelihoods
```

This is much closer to a modem.

---

## 9.1 Why this can materially improve robustness

Suppose a 32-site block contains five altered carrier glyphs.

A direct per-glyph system may experience five corrupted physical symbols.

A histogram receiver may experience **no decoded-symbol error at all** if the aggregate distribution remains closer to the transmitted constellation point than to its neighbors.

Thus robustness can occur *before* the ECC layer.

The stack becomes:

```text
physical glyph corruption
       ↓
block integration
       ↓
soft symbol decision
       ↓
packet confidence / integrity
       ↓
ECC / fountain
       ↓
payload integrity check
```

This is fundamentally different from asking the ECC to repair every altered Unicode character.

---

## 9.2 Length becomes integration time

For a histogram scheme, longer text can be spent on bigger blocks.

Sampling error decreases approximately with the familiar \(1/\sqrt{N}\) behavior as the number of independent observations rises.

More cover text can therefore purchase:

```text
more payload
or
larger integration blocks
or
more fountain packets
or
deeper interleaving
or
more synchronization markers
or
more carrier diversity
```

This means the watermarker has a **rate/robustness surface**, not a single capacity value.

---

# 10. Current comparison

The following table compares the systems primarily as engineering architectures rather than adoption rankings.

| Dimension | spab 0.5 | Innamark | VSRMark | StegCloak | Drift | stegmark |
|---|---:|---:|---:|---:|---:|---:|
| arbitrary payload | excellent | excellent | excellent | excellent | good | mixed |
| peak density | excellent with dense modes | moderate | exceptional | exceptional | moderate | moderate |
| length-preserving mode | yes | yes | no | no | partial | partial |
| multiple carrier classes | **yes** | limited | no | no | yes | yes |
| compact framing | **strong** | strong | simple | moderate | moderate | moderate |
| compression | yes | configurable | no | yes | no | no |
| authenticated encryption | AES-GCM | supported framework | no | yes | key protection | HMAC identity |
| repetition | yes | yes | no | no | yes | effectively no lexical ECC |
| fountain / erasure code | **yes** | no comparable core | no | no | no | no |
| insertion/deletion resync | **phase recovery** | some structural robustness | weak | weak | limited | poor lexical sync |
| high-density mode | yes | bounded | **excellent** | **excellent** | moderate | moderate |
| soft symbol output | **target, not yet shipping** | no | no | no | no | no |
| histogram integration | **target, not yet shipping** | no | no | no | no | no |
| realistic corruption harness | **strong and growing** | strong published evaluation | limited | limited | 10 attack models | limited |
| cross-language implementation today | JS only | JVM/JS/Kotlin ecosystem | **6 languages** | JS | Python | Python |
| published application evidence | very early | **excellent** | little | anecdotal/mature usage | little | little |
| semantic paraphrase survival | no | no | no | no | no | poor |
| deliberate removal resistance | not a goal | limited | limited | limited | limited | limited |

For generative approaches such as REMARK and XMark, semantic robustness is much stronger, but their payload sizes and operational model are fundamentally different.

---

# 11. What spab currently does particularly well

## 11.1 It separates the carrier from the communications architecture

Carrier definitions are pluggable.

The higher-level system does not fundamentally depend on one particular Unicode trick.

That is probably spab's most important architectural decision.

---

## 11.2 It treats carrier families as separate failure domains

Whitespace and punctuation are not just extra capacity.

They are diversification.

This is much stronger than adding more characters from a single Unicode family.

---

## 11.3 It explicitly handles synchronization failure

Most small watermark libraries assume the receiver knows where symbol \(n\) is.

spab recognizes that insertion/deletion destroys this assumption.

This is essential.

---

## 11.4 It uses cover length as a robustness resource

The README is unusually clear on this point:

> spare capacity is needed for robustness; text length buys that margin.

That is a much better model than treating carrier capacity as something to maximize blindly.

---

## 11.5 It measures rather than assumes

The 0.5.0 characterization suite currently covers:

- ten fixed sample types;
- seven payload sizes;
- four carrier sets;
- both repetition and RLNC;
- 23 corruption models;
- paired comparisons where capability overlaps.

Corruption models include realistic operations such as:

- plain-text paste;
- PDF/rendered extraction models;
- tokenize/rejoin;
- email quoting;
- whitespace trimming;
- typos;
- terminology replacement;
- sentence reordering;
- Markdown stripping;
- concatenation;
- truncation and excerpts.

An especially positive sign is that the harness has already disproved assumptions in the implementation.

For example, the initial measurements made RLNC look stronger than repetition because the two modes could encode different subsets of the test matrix. The paired comparison reversed the conclusion.

Likewise, a structured damaged stream produced a false frame that random-stream false-positive testing had underestimated. The checksum policy was changed as a result.

This is exactly what a characterization harness should do.

---

# 12. Current shortcomings in the JavaScript implementation

These are not objections to the overall architecture. Most are normal consequences of an implementation that is only days old.

They are worth recording precisely so future ports do not accidentally make them permanent.

---

## 12.1 The shipping decoder is still a hard per-glyph modem

The biggest architectural gap is that the current JavaScript source reads each carrier position as an exact radix digit:

```text
carrier glyph
    ↓
digit
    ↓
mixed-radix conversion
    ↓
bits
```

The source does not currently contain the histogram constellation machinery.

The R&D proposal explicitly describes histogram modulation as the **target design** and the current system as the lean/per-glyph implementation.

### Improvement

Implement the block modem as an explicit abstraction:

```text
observe(block)
    ↓
histogram
    ↓
distance to each constellation point
    ↓
P(symbol_i | observation)
```

Keep both:

```text
hard demodulator
soft histogram demodulator
```

because the hard modem will remain useful for high-density pristine channels.

---

## 12.2 Soft information is currently discarded

The proposed architecture expects:

```text
symbol_i → confidence / likelihood
```

and eventually soft FEC/fountain decoding.

The current JS path converts carrier states into hard digits before the ECC layer.

That loses potentially valuable information.

For example:

```text
P(0) = .51
P(1) = .49
```

and:

```text
P(0) = .999
P(1) = .001
```

currently become the same bit:

```text
0
```

A soft decoder should treat those observations very differently.

---

## 12.3 Keyed scrambling conflicts with resynchronization

This is one of the most important current weaknesses.

The source explicitly says phase sweeps are only attempted for unkeyed marks.

The keyed scramble permutes the entire digit stream, so once carrier count changes the decoder can no longer invert the permutation reliably.

The changelog also records that simply appending text can break keyed marks because the permutation depends on the total digit count.

This is an architectural conflict:

```text
global keyed interleave
       ↓
great spreading

but

one insertion/deletion
       ↓
global indexing failure
```

### Improvement

Move toward independently synchronized regions:

```text
anchor
  ↓
packet / local region
  ↓
keyed local interleave
  ↓
next anchor
```

or derive placement from stable local/content identifiers rather than total carrier count.

Then insertion damage can remain local.

---

## 12.4 RLNC has very high packet overhead

The current RLNC representation spends:

```text
16 bits ESI
 8 bits coded value
 8 bits CRC
----------------
32 bits
```

for one coded byte.

The changelog explicitly notes that RLNC therefore requires 32 transmitted bits per source byte; a 52-byte frame requires 1664 coded bits before additional redundancy, versus 416 frame bits under repetition.

This is extremely simple and useful for experimentation, but inefficient for larger payloads or short covers.

### Improvement

Move from scalar one-byte coding to vector symbols:

```text
ESI
coded bytes [N]
integrity
```

For example, a 16-byte coded symbol might cost:

```text
2 bytes ESI
16 bytes data
2 bytes CRC
```

rather than:

```text
16 × 4 = 64 bytes
```

for sixteen scalar packets.

This would materially improve robust payload efficiency.

Packet size could become an adaptive parameter:

- very short symbols for heavily bursty channels;
- larger symbols when capacity is scarce;
- larger symbols for long payloads.

---

## 12.5 "Any K packets" is slightly too strong

The implementation comments state that any \(K\) clean RLNC packets reconstruct the payload.

Strictly, the decoder needs:

> **K linearly independent equations.**

The systematic first \(K\) ESIs are guaranteed independent.

Random repair rows over GF(256) are extremely likely to be independent, but arbitrary sets of \(K\) random rows are not mathematically guaranteed to have full rank.

The solver correctly detects an under-rank matrix and can return failure.

### Improvement

Change documentation/comments to:

> any \(K\) linearly independent packets reconstruct; normally collect \(K+\delta\) repair packets.

Also measure rank-deficiency probability as part of fountain characterization.

---

## 12.6 A single false RLNC packet can be disproportionately harmful

The changelog notes that scanning too many candidate bit offsets produced chance CRC8-valid packets and that one false packet could poison an RLNC solve.

The current packet-level CRC is still CRC8.

The stronger frame-level checksum protects the final result, but a false packet can still waste or derail a candidate solve.

### Improvement

Possible approaches include:

- configurable CRC16 for coded packets;
- confidence-weighted packet admission;
- solve, validate frame, then progressively remove lowest-confidence packets;
- multiple candidate solves;
- stronger ESI plausibility constraints;
- packet-local soft information;
- bounded list decoding.

For small payloads, spending another byte on packet integrity may be cheaper than losing an entire decoding attempt.

For larger vector RLNC packets, CRC16 overhead becomes relatively inexpensive.

---

## 12.7 The source header is stale

The top comment in `spab.js` still describes:

```text
magic 0xA5
len
content
crc8
```

and says the default is whitespace-only.

Neither is true for 0.5.0.

Wire format v2 has no magic byte and the default carrier set is:

```text
ws + apos + hyphen
```



This is particularly dangerous now that other language ports are planned.

An agent or contributor reading the source header could faithfully port obsolete behavior.

### Improvement

Treat normative documentation drift as a CI failure where practical.

At minimum:

- source header version;
- wire version;
- default carriers;
- ECC list;
- implemented transform list;

should be generated from one descriptor or checked automatically.

---

## 12.8 The prior-art document is also stale

`prior-art-and-tradeoffs.md` currently says spab lacks typed payloads and real encryption.

Both are now implemented in 0.5.0.

Again, this is understandable given the speed of development, but a technical project with several algorithm generations can become difficult to reason about if old capability matrices are not version-stamped.

### Improvement

Every empirical or architectural table should carry something like:

```text
spab version: 0.5.0
wire version: 2
carrier profile:
ECC:
payload:
cover corpus:
test-suite revision:
```

---

## 12.9 The JavaScript implementation is becoming monolithic

The current reference implementation is approximately 1,600 source lines / 84 KB in one file.

That is not inherently bad, particularly for a zero-dependency library.

But the file now contains:

- carrier detection;
- modulation;
- scrambling;
- GF(256);
- RLNC;
- checksums;
- SHA-256;
- AES;
- GCM;
- compression;
- bit streams;
- wire framing;
- payload typing;
- public API.

This increases audit and porting difficulty.

### Improvement

Keep the distributed source logically separated:

```text
carrier/
modem/
sync/
fec/
wire/
crypto/
compression/
types/
```

and optionally generate one dependency-free `spab.js` distribution artifact.

That retains the "drop in one file" property without making the source architecture one file.

---

## 12.10 Handwritten cryptography increases audit surface

spab currently contains its own SHA-256, AES, GCM, and related primitives.

The tests include published vectors, which is good engineering. The 0.5.0 wire tests explicitly validate primitives against FIPS/RFC vectors and Node behavior.

Nevertheless, implementing cryptography independently in every future language port creates unnecessary security and conformance risk.

### Improvement

Define crypto behavior normatively at the wire-format level but permit:

```text
native audited crypto backend
```

when available.

The pure implementation can remain:

- reference code;
- fallback;
- test oracle.

The ports should not independently reinvent AES-GCM six times.

---

## 12.11 The deterministic-runtime invariant needs clarification for encryption

The README states:

> same input + params → same output, on every port.



But encrypted encoding generates a random 12-byte nonce unless `opts.nonce` is explicitly supplied.

Therefore encrypted output is intentionally nondeterministic under otherwise identical user-visible input.

This is correct cryptographic behavior, but the documentation invariant should say so.

A more accurate statement might be:

> deterministic for identical explicit inputs, including nonce/seed; secure APIs generate nonce values when none are provided.

---

## 12.12 Unicode site semantics need to become normative before ports

The JavaScript implementation scans strings using JavaScript string indexing and `charCodeAt`, meaning UTF-16 code-unit behavior participates in carrier detection.

Python, Rust, C++, Swift, and Java expose different default string/index abstractions.

Most ordinary Latin text will behave identically.

Edge cases may not:

- astral Unicode characters;
- combining marks;
- unusual whitespace;
- malformed surrogate sequences;
- grapheme clusters;
- emoji adjacent to carrier sites.

### Improvement

The conformance specification should define site detection in terms of one explicit representation:

- UTF-8 bytes;
- Unicode scalar values;
- UTF-16 code units;

and provide adversarial Unicode vectors.

This is probably one of the most important details to settle before agent-generated ports begin.

---

## 12.13 Fuzz and coverage gates are not yet fully blocking

The README reports 100% branch coverage and deterministic property-based fuzzing, but currently says those report-only jobs become blocking once stable.

That is sensible during rapid development.

Before calling the format stable, they should become release gates.

Especially important invariants include:

```text
decode(encode(x)) == x

decoder never throws on arbitrary input

unmarked input never returns a valid payload

corruption may produce:
    correct payload
    no payload

but never:
    incorrect accepted payload
```

The last is arguably the project's most important safety invariant.

---

# 13. Gaps where spab can improve architecturally

## 13.1 Finish the histogram / soft-decision modem

This is the largest remaining architectural improvement.

It would give robustness below the packet layer and allow physical carrier noise to become probabilistic evidence rather than immediate bit corruption.

Priority: **very high**.

---

## 13.2 Make keyed placement locally resynchronizable

Global carrier-count-dependent permutations are incompatible with insertion/deletion robustness.

Local packet interleaving, pilots, stable anchors, or content-addressed placement should replace global permutation.

Priority: **very high**.

---

## 13.3 Improve fountain symbol geometry

Scalar RLNC is useful as a reference implementation but expensive.

Experiment with:

- 4-byte symbols;
- 8-byte symbols;
- 16-byte symbols;
- adaptive symbol size.

Measure:

```text
recovery probability
vs
cover size
vs
burst size
vs
packet overhead
```

Priority: **high**.

---

## 13.4 Combine inner FEC with outer erasure coding

Current experimental results already suggest the split.

Repetition performs well under dense random corruption.

RLNC performs conceptually better for packet/channel erasures.

The natural architecture is:

```text
physical text channel
      ↓
soft demodulation
      ↓
small inner ECC
      ↓
integrity
      ↓
packet erasure
      ↓
outer fountain
```

Candidate inner codes include:

- BCH;
- shortened Reed-Solomon;
- Hamming-like small block codes;
- convolutional codes;
- LDPC if soft decoding becomes worthwhile.

The best choice should be empirical rather than ideological.

---

## 13.5 Add content-addressed linguistic carriers

A lexical/grammatical channel is attractive because it survives the transformations that kill Unicode carriers.

But it should not use stegmark's sequential-bit model.

A stronger design is:

```text
canonical context
      ↓
hash(context + key)
      ↓
stable carrier ID
      ↓
symbol observation
```

Then deletion of one phrase creates an erasure instead of shifting every subsequent bit.

Potential carriers include:

- synonym choices;
- optional conjunctions;
- punctuation grammar;
- equivalent phrase orderings;
- contraction choices;
- style-neutral syntactic transformations.

These need strong semantic-safety constraints.

Priority: **medium / experimental**.

---

## 13.6 Adaptive profile selection

The encoder can inspect the cover before choosing its operating point.

A punctuation-rich legal document and a sparse chat message expose very different carrier distributions.

Eventually:

```text
analyze cover
   ↓
estimate carrier entropy
   ↓
estimate requested payload size
   ↓
estimate target channel profile
   ↓
choose:
    carriers
    modulation order
    block size
    inner ECC
    fountain overhead
    packet size
```

That turns spab from a configurable codec into an adaptive modem.

---

## 13.7 Repeated configuration acquisition

If a decoder receives only an excerpt, it should not depend on a header that existed only near the original beginning.

The architecture proposal already considers repeated pilots/configuration records, analogous to broadcast systems.

This deserves implementation before excerpt recovery is considered fully solved.

---

# 14. Real-world validation should now become a major workstream

spab's synthetic and modeled channel suite is already unusually good for such a young library.

The next step is not necessarily another algorithm.

It is **physical interoperability evidence**.

A useful reproducible matrix would include:

```text
Microsoft Word
Google Docs
LibreOffice
Apple Pages

Gmail
Outlook
Apple Mail

Slack
Teams
Discord
WhatsApp
SMS/RCS

Chrome clipboard
Safari clipboard
Firefox clipboard

Markdown parsers
HTML sanitizers
rich-text editors

PDF generation
PDF extraction
print-to-PDF
OCR

Git
GitHub
code formatters

LLM summarize
LLM proofread
LLM reformat
LLM paraphrase
```

Each path should produce machine-readable measurements.

For example:

```text
profile: robust-1
payload: 64 bits
cover: 2000 words
channel: Word → PDF → copy text
trials: N
encode success:
decode success:
wrong decode:
undetected:
carrier survival:
packets recovered:
rank margin:
```

---

# 15. Metrics worth standardizing

Raw capacity alone is not enough.

A useful benchmark should report at least:

| Metric | Meaning |
|---|---|
| raw bits/site | ideal carrier modulation capacity |
| carrier sites/1K chars | natural density in the corpus |
| UTF-8 expansion | storage/network overhead |
| minimum cover size | smallest usable text |
| robust payload capacity | recoverable payload under a channel profile |
| BER | physical/demodulated bit error rate |
| symbol error rate | histogram/modem output errors |
| packet erasure rate | packets rejected or lost |
| packet false-accept rate | bad packets admitted |
| frame false-positive rate | incorrect accepted payloads |
| fountain rank margin | equations beyond minimum rank |
| recovery probability | end-to-end success |
| excerpt survival | recovery from arbitrary subranges |
| burst tolerance | deletion/replacement span sensitivity |
| normalization survival | Unicode processing resistance |
| application survival | real workflow performance |
| imperceptibility | visual/caret/detection behavior |
| decode cost | runtime/memory |
| encode distortion | proportion of eligible sites changed |

The central metric should probably be some form of:

\[
P(\text{correct decode}
\mid
L,P,C,R)
\]

where:

- \(L\) = cover length;
- \(P\) = payload size;
- \(C\) = corruption/channel profile;
- \(R\) = coding/modulation profile.

That produces a useful operating surface rather than a marketing capacity number.

---

# 16. Cross-platform implementation

If the planned ports are completed, spab can become particularly strong here.

The target languages already scaffolded are:

- JavaScript;
- C/C++;
- Rust;
- Python;
- Java/Kotlin;
- Swift.

The repo explicitly calls for a portable wire format and shared conformance vectors.

The important test should not merely be:

```text
Python encode → Python decode
```

It should be the complete matrix:

```text
JS     → C
JS     → Rust
JS     → Python
JS     → Java
JS     → Swift

C      → JS
C      → Rust
...

Swift  → Java
Swift  → Python
...
```

For every meaningful combination of:

- payload type;
- carrier class;
- compression;
- encryption;
- checksum;
- ECC;
- density;
- key/seed;
- Unicode edge cases.

A porting agent should implement **the normative format and vectors**, not mechanically translate JavaScript syntax.

This is particularly important for:

- UTF behavior;
- integer width;
- endian handling;
- GF(256);
- PRNG behavior;
- bit packing;
- varints;
- compression;
- crypto;
- normalization.

If this matrix is rigorous, cross-language conformance becomes one of spab's strongest features rather than merely a port-count feature.

---

# 17. Relative assessment if the ports are completed

Assuming the language ports are complete and cross-conformant:

| Dimension | spab | Innamark | VSRMark | StegCloak |
|---|:---:|:---:|:---:|:---:|
| carrier architecture | **A+** | A- | B | C |
| raw density range | **A** | C+/B | **A+** | A+ |
| rate/robustness flexibility | **A+** | B+ | C | C |
| arbitrary payload | **A+** | A | A | A |
| compact framing | **A** | A- | B+ | B |
| heterogeneous channels | **A+** | C | D | D |
| dense noise handling | A today; potentially **A+** with histogram/inner FEC | A-/B+ | D | D |
| erasure handling | **A+** | B | D | D |
| insertion/delete reasoning | **A** | B | D | D |
| extra cover → coding gain | **A+** | A- | D | D |
| cross-platform | **A+** | B+/A- | **A+** | B |
| empirical real-app maturity | C today | **A+** | C | B |
| published methodology | C today | **A** | C | C |

The distinction between the last two rows and the architecture rows is important.

spab's lower maturity scores are not architectural deficiencies.

The present implementation is simply extremely young.

Those grades can only improve by accumulating evidence.

---

# 18. A useful taxonomy of the field

The systems examined fall into approximately four families.

## 18.1 Steganographic encoders

Examples:

- VSRMark;
- StegCloak;
- many zero-width tools.

Philosophy:

> find an invisible representation and put payload bits in it.

---

## 18.2 Robust carrier systems

Best example:

- Innamark.

Philosophy:

> choose carrier symbols carefully and add enough structure/repetition to survive realistic handling.

---

## 18.3 Text-channel modems

Current example:

- spab.

Philosophy:

> treat text as a heterogeneous noisy synchronization channel and design modulation, synchronization, integrity, ECC, fountain coding, and carrier choice together.

This is probably the clearest positioning for spab.

---

## 18.4 Generative / semantic watermarking

Examples:

- REMARK-LLM;
- XMark;
- other generation-time LLM watermarks.

Philosophy:

> make the natural-language generation process itself carry statistical evidence or a small message.

These can survive transformations that destroy Unicode watermarks, but solve a different problem.

---

# 19. Recommended near-term engineering priorities

Given the state of 0.5.0, the highest-value work does not appear to be adding many more carrier alphabets.

A reasonable ordering is:

### P0 — keep specification and implementation synchronized

Fix stale source headers and prior-art tables immediately.

This matters before automated language ports begin.

### P0 — build cross-language golden vectors

Define the behavior the ports must reproduce before generating them.

### P1 — finish histogram modulation and soft demodulation

This is the largest remaining improvement to the physical-channel model.

### P1 — fix keyed synchronization

Replace global count-dependent scrambling with locally recoverable placement/interleaving.

### P1 — improve RLNC packet efficiency

Move beyond one-byte source symbols.

### P1 — harden packet admission

Reduce the ability of a single chance-valid packet to poison a fountain solve.

### P1 — build the real-application interoperability matrix

This is what eventually closes the evidence gap with Innamark.

### P2 — combine inner FEC with outer fountain coding

Treat random symbol noise and packet erasures as different problems.

### P2 — adaptive modulation/profile selection

Let the cover and requested channel determine the operating point.

### P3 — experiment with content-addressed linguistic carriers

Only after the lower text-channel stack is stable.

---

# 20. What spab should avoid

Several attractive directions could weaken the project if pursued too early.

## Do not optimize exclusively for payload density

spab already has high-density modes.

Raw density is not the interesting differentiator.

## Do not equate ECC with robustness

Synchronization failure can render arbitrarily strong ECC irrelevant.

## Do not equate encryption with watermark security

Encryption protects payload contents, not carrier survival.

## Do not claim resistance to deliberate removal

The README correctly states that this is not the goal. Someone who knows the carrier families can intentionally strip them.

## Do not prematurely claim superiority from modeled benchmarks

The current `compare` harness intentionally reimplements representative techniques rather than benchmarking the competing libraries directly. That isolates algorithmic ideas, which is useful, but it is not evidence that spab beats every actual library implementation.

## Do not let generative watermarking distort the goal

REMARK/XMark-style work is interesting prior art but solves a different problem.

spab's ability to watermark an arbitrary already-existing document is valuable in its own right.

---

# 21. A concise description of spab

A technically accurate short description would be:

> **spab is a text-channel modem for embedding recoverable payloads in the latent representational entropy of existing text. It can use multiple typographic and Unicode carrier classes, compact framing, optional compression and authenticated encryption, and configurable repetition or fountain coding. Rather than assuming textual symbols survive intact, its architecture treats editing, normalization, insertion, deletion, truncation, and carrier loss as channel impairments and uses synchronization and coding margin to recover where possible.**

Once histogram modulation is shipping, this can be extended to:

> **The physical modem integrates distributions of interchangeable textual symbols over blocks and produces probabilistic symbol estimates, allowing corruption to be absorbed both below and above the ECC layer.**

---

# 22. Overall assessment

For watermarking **arbitrary existing text**, spab 0.5.0 already has an unusually strong architecture for such a new implementation.

Its most important strengths are not any individual Unicode characters.

They are:

1. **carrier abstraction;**
2. **heterogeneous failure domains;**
3. **explicit synchronization handling;**
4. **compact bit-level framing;**
5. **real payload typing and transforms;**
6. **multiple error-control strategies;**
7. **fountain reconstruction across surviving carrier channels;**
8. **high-density and high-robustness operating modes rather than one fixed rate;**
9. **a serious corruption characterization harness;**
10. **a design philosophy that treats excess text entropy as coding margin.**

The largest remaining architectural gap is the one already identified in the design work:

> **turn the current hard per-glyph carrier reader into the histogram/soft-decision modem that the higher-level architecture expects.**

The most important implementation issue is probably:

> **make keyed placement/interleaving compatible with synchronization recovery.**

The most obvious efficiency issue is:

> **reduce the current 32-bit-RLNC-packet-per-source-byte overhead.**

The most important evidence gap is:

> **run actual application round-trip experiments at the same level of rigor as the synthetic channel suite.**

And the most immediate project-hygiene issue is:

> **freeze normative behavior into conformance vectors and remove stale architectural comments before automated ports multiply them.**

If those pieces land, the distinction between spab and most existing post-hoc text watermarkers becomes fairly sharp.

VSRMark is an extremely dense Unicode encoder.

StegCloak is a mature encrypted zero-width steganography utility.

Innamark is a carefully engineered and empirically validated whitespace watermark.

Drift is a multi-channel redundant fingerprint system.

spab is aiming at something broader:

> **a portable communications stack for sending small amounts of recoverable information through the strange, discrete, lossy channel that is editable text.**

That appears to be the genuinely interesting niche.

---

# References and projects examined

- **spab 0.5.0** — JavaScript reference implementation, wire-format v2, R&D architecture, changelog, capacity documentation, and characterization suite.
- **Innamark** — Fraunhofer ISST whitespace-replacement watermarking system and 2025 IEEE Access evaluation.
- **VSRMark** — variation-selector payload encoding implemented in C, Go, Java, Rust, Swift, and TypeScript.
- **StegCloak** — zero-width JavaScript steganography with compression, encryption, and integrity.
- **stegmark** — zero-width plus synonym-substitution watermarking.
- **Drift** — Python multi-channel homoglyph/zero-width/whitespace fingerprinting.
- **REMARK-LLM** — learned robust generative text watermarking, USENIX Security 2024.
- **XMark** — multi-bit generation-time LLM watermarking, ACL 2026.
