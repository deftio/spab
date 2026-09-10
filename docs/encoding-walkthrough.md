# How spab encodes a secret: a worked example

Status: 2026-09-09, against `src/js/spab.js` v0.5.2.

Every number in this document was produced by `r_and_d/walkthrough.js`. Run it to
regenerate them:

```
node r_and_d/walkthrough.js
```

If the codec changes and this document disagrees with that script, **the document
is wrong, not the code.**

The example is deliberately larger than one packet so the *spread* is visible:
a 27-byte secret becomes a 264-bit packet, which does not fit in any single
32-bit symbol block and must be laid across many of them.

## Two words, kept apart

This document is careful about a distinction the codebase used to blur:

| | **alphabet** | **radix** |
|---|---|---|
| what it describes | the **channel** | the **code** |
| meaning | the set of interchangeable glyphs a carrier offers at one site, and its size | the same integer *acting as the base of a positional numeral system*, inside the mixed-radix packer |
| power of two? | **no obligation** — 6 or 10 is fine | — |
| in the code | `CLASS_DEFS.ws.alphabet` | `symBlocks(radices, …)` |

A carrier has an *alphabet*. The packer has *radices*. Using "radix" for the
channel quietly implies that powers of two are privileged, and that is precisely
how the wider alphabets catalogued in `r_and_d/docs/symbol-catalog.md` went
unused for so long — see §4.

---

## The inputs

| | |
|---|---|
| **cover** | 2,535 chars — eight public-domain excerpts concatenated (Austen, Melville, Dickens, US Constitution, Lincoln, Carroll, Shelley, Doyle) |
| **carrier sites** | 461 inter-word gaps |
| **secret** | `ACCESS-KEY-7f3a91c4d8e02b6a` — 27 bytes |

---

## Step 1 — secret to bytes

```
[ 0] 41 43 43 45 53 53 2d 4b 45 59
[10] 2d 37 66 33 61 39 31 63 34 64
[20] 38 65 30 32 62 36 61
```

27 bytes. Nothing clever — UTF-8.

---

## Step 2 — bytes to wire packet (v2)

```
total 264 bits (33 bytes)     headerBits=41   len=27   padBits=7
```

The bit map, field by field:

| bits | field | value |
|---|---|---|
| 0..2 | `ver` | `010` (version 2) |
| 3..7 | `type` | `00000` (string) |
| 8..10 | `comp` | `000` (none) |
| 11..13 | `enc` | `000` (none) |
| 14..16 | `cksum` | `001` (crc16) |
| 17..40 | varint `len` + **checksum** | |
| 41..256 | content (27 bytes) | |
| 257..263 | pad to byte boundary | |

```
  0: 0100000000000000100011011111001100001001001000001010000110100001
 64: 1010001010101001101010011001011010100101101000101010110010010110
128: 1001101110110011000110011011000010011100100110001011000110011010
192: 0011001000011100001100101001100000011001001100010001101100110000
256: 10000000
```

Two properties worth noticing, both deliberate:

- **The checksum sits *before* the content.** A scanner that finds a candidate
  header can verify it without first knowing where the content ends.
- **There is no magic number.** Nothing in the packet announces "this is spab" to
  someone scanning the text. Self-validation is the checksum's job.

---

## Step 3 — packet to ECC stream (repetition, the default)

```
room    : 461 sites x 2 bits =  922 bits
packet  :                       264 bits
copies  : floor(922 / 264)    =   3
used    : 792 bits, 130 bits left over
```

The whole default ECC is: **write the same 264 bits three times, end to end.**

```
copy 0: bits   0.. 263  ->  ws sites   0..131
copy 1: bits 264.. 527  ->  ws sites 132..263
copy 2: bits 528.. 791  ->  ws sites 264..395
```

Sites 396..460 are left over. They are written as digit 0. **Remember this — it
causes a real problem in §8.**

---

## Step 4 — bits to symbols

Blocks are derived from the alphabet sequence alone, so encoder and decoder agree
with no side channel. `ws` has an alphabet of 4, and `4^16 = 2^32` is the ceiling, so:

```
block count: 29     (16 sites = 32 bits each; the last one is short)

block  0: sites   0.. 15   bits    0..  31   <- copy 0
block  1: sites  16.. 31   bits   32..  63   <- copy 0
block  2: sites  32.. 47   bits   64..  95   <- copy 0
...
```

Block 0 in full:

```
bits   01000000000000001000110111110011
v    = 1073778163
base4  3 0 3 3 1 3 0 2 0 0 0 0 0 0 0 1      (low digit first)
```

### The thing to understand here

It is tempting to read that `4^16` space — 4,294,967,296 points over 16 glyphs —
as a joint constellation symbol. **For an alphabet of 4 it is not**, and the reason is a
choice, not a law.

`4^16 = 2^32` *exactly*, so mixed-radix conversion degenerates into plain
bit-slicing: digit `s` is simply bits `2s, 2s+1` of `v`. Measured avalanche —
perturb one digit, count bit flips in the block:

| alphabet | block | mean flips | max | |
|---|---|---|---|---|
| 4 | 16 sites / 32 bits | 1.69 | 2 | pure bit-slice, no mixing |
| **6** | 12 sites / 31 bits | **6.17** | 10 | **joint — digits mix** |
| 8 | 10 sites / 30 bits | 2.00 | 3 | pure bit-slice, no mixing |
| **10** | 9 sites / 29 bits | **6.78** | 13 | **joint — digits mix** |

So the absence of joint structure is **entirely an artifact of choosing
power-of-two alphabets.** It is not a property of spab, and it is not a property
of the mixed-radix layer — which handles non-power-of-two alphabets at 97–100%
efficiency and was built for exactly this:

| alphabet | sites/block | bits | bits/site | theoretical | efficiency |
|---|---|---|---|---|---|
| 4 | 16 | 32 | 2.000 | 2.000 | 100.00% |
| 6 | 12 | 31 | 2.583 | 2.585 | **99.94%** |
| 7 | 11 | 30 | 2.727 | 2.807 | 97.15% |
| 8 | 10 | 30 | 3.000 | 3.000 | 100.00% |
| 10 | 9 | 29 | 3.222 | 3.322 | 97.00% |

### What rounding to a power of two costs

`r_and_d/docs/symbol-catalog.md` lists more usable variants than the shipping
alphabets use. Capacity left on the table:

| class | shipping | catalog candidates | bits/site now | if all used | gain |
|---|---|---|---|---|---|
| `ws` | 4 | 10 | 2.000 | 3.322 | **+66%** |
| `wsdense` | 8 | 10 | 3.000 | 3.322 | +11% |
| `hyphen` | **2** | **6** | 1.000 | 2.585 | **+158%** |

The `hyphen` channel is the sharpest case: the catalog lists six dash forms that
read alike typographically (`U+002D`, `U+2010`, `U+2011`, `U+2013`, `U+2014`,
`U+2212`) and the implementation uses two of them.

**Caveat before acting on this table:** the candidate variants are not equally
safe. Some are more visible, some behave differently under reflow, and none of
these wider alphabets has been run through `r_and_d/attacks.js`. The gains above
are arithmetic, not measured robustness.

### The coupling this creates

Widening the alphabets and building a soft receiver are **not independent
choices** — they are the same decision seen twice:

- Non-power-of-two alphabets produce joint structure, which is the only thing a
  joint/soft receiver could exploit. With power-of-two alphabets there is
  provably nothing there to gain.
- But avalanche cuts the other way for the *current* decoder: one damaged site
  corrupts ~6 of 31 bits instead of 1 of 32, and per-bit majority voting over
  repetition copies gets strictly worse.

There is one exception worth noting: **RLNC is indifferent to avalanche inside a
packet**, because a packet failing its CRC is discarded whole either way. So
wide alphabets pair naturally with the fountain layer and badly with repetition.

Open geometry problem if this is pursued: an alphabet-6 block carries 31 bits and an
RLNC packet is 32, so packets would straddle block boundaries — the same
misalignment `wsdense` already has at 30 bits (see `dev/symbol-layers.md` §4).

---

## Step 5 — digits to glyphs

```
0 -> U+0020 space        2 -> U+2009 thin
1 -> U+2006 six-per-em   3 -> U+200A hair
```

```
digits at first 32 sites: 3,0,3,3,1,3,0,2,0,0,0,0,0,0,0,1,1,0,2,2,1,0,2,2,0,0,2,0,1,2,0,0
```

Result — `-` marks a gap holding a variant space:

```
"It-is a-truth-universally-acknowledged,-that a-single man in possession
 of a good fortune,-must-be in-want-of-a wife.-Ho"
```

2,535 chars in, 2,535 chars out. Substitution, not insertion: the length is
identical and no character was added.

---

## Step 6 — decode

```
recovered: "ACCESS-KEY-7f3a91c4d8e02b6a"   status=perfect
```

The receiver, per stage:

| stage | operation | decision type |
|---|---|---|
| glyph → digit | table lookup | **hard, independent per site** |
| digits → v → bits | exact positional inverse | deterministic |
| across copies | per-bit majority vote over 3 copies | hard |
| bits → packet | header parse + checksum | validate |

---

## Step 7 — RLNC mode, and what "spread" means

```
S.encode(cover, secret, { ecc: 'rlnc' })   ->   status=perfect, packets=28
```

Geometry of the `default` preset: **8-bit ESI | 16-bit data | 8-bit CRC = 32 bits.**

```
source symbols K = ceil(33 bytes / 2 bytes per symbol) = 17
room = 922 bits -> floor(922/32) = 28 packets emitted
```

So 28 self-checking equations are laid down for 17 unknowns. Each 32-bit packet
occupies **exactly one 16-site symbol block**, which is why 32 bits is the right
packet width for this modem — the packet and block grids coincide.

The contrast with repetition is the point:

| | repetition | RLNC |
|---|---|---|
| unit | 3 identical copies | 28 distinct equations |
| a damaged unit | salvaged bit-by-bit by majority vote | discarded whole (CRC fails) |
| recovery needs | most copies of each bit | **any 17 clean packets** |
| survives losing | scattered bits | whole regions |

---

## Step 8 — damage, and two findings

```
delete a 300-char span      -> status=corrected      RECOVERED
collapse ALL whitespace     -> status=not-detected   null
NFKC normalize              -> status=not-detected   null
```

Deleting 300 characters is survived. Whitespace collapse and NFKC are **total
losses** for the `ws` carrier by construction — both fold every variant back to
U+0020, so there is nothing left to read. That is a known limit, not a bug; it is
why `docs/capacity-vs-robustness.md` exists and why other carriers are offered.

### Finding 1 — the channel estimator false-positives on an intact mark

`estimateCollapse()` infers how much collapsing a channel did by measuring excess
mass on the default value, assuming an intact marked stream is near-uniform.
On this example, **with no damage at all**:

```
histogram over 461 sites : [194, 78, 138, 51]
estimateCollapse         : 0.2278       <-- ground truth is 0.0
```

Two causes, both measured:

1. **The zero-filled tail.** Sites 396..460 carry no data and are written as
   digit 0: `[62, 1, 1, 1]`. That is 14% of all sites forced to the default.
2. **The packet is not uniform.** Restricted to the 396 sites that carry data,
   the estimate is still `0.1111` — headers are mostly zeros (`type=00000`,
   `comp=000`, `enc=000`) and ASCII payload is 0-heavy.

**This matters because every posterior the soft layer produces is derived from
this estimate.** A biased channel estimate yields miscalibrated posteriors before
any damage occurs, and that is a plausible contributor to the failed
reliability-weighted-vote experiment recorded at `src/js/spab.js:1506`.

### Finding 2 — whitening fixes it, and whitening is opt-in

The keyed scramble already applies whitening over the symbol stream. Same cover,
same secret, same absence of damage:

| configuration | histogram | `estimateCollapse` |
|---|---|---|
| no key (default) | `[194, 78, 138, 51]` | **0.2278** |
| with key | `[108, 114, 135, 104]` | **0.0000** |

And both still correctly report `0.9900` under real whitespace collapse, so
whitening costs nothing in detection sensitivity.

The estimator is only unbiased when the symbol stream is whitened — but whitening
today requires a key. **Keyless whitening against a fixed constant would make the
channel estimate correct in the default configuration**, at no capacity cost and
no change to the wire format. It looks cheap, but it is a proposal, not a
decision — it changes what every unkeyed encoder emits, so it needs measuring
and sign-off before it goes anywhere.

---

## Where the histogram fits

Nothing in the walkthrough above uses a histogram. Steps 1–6 are hard decisions
end to end, and `detect()` / `SPAB.soft` sit off to the side with no caller in
`decode()`.

The place a histogram belongs is **Step 6's first arrow**, `glyph → digit`, which
is currently an exact-match lookup. The histogram turns it into a probability,
and `softDigit()` already computes exactly the right quantity:

- a **non-default** glyph is near-certain — only the encoder writes a thin space
- the **default** glyph is ambiguous — sent as 0, or *any* variant collapsed onto
  it, split according to the channel estimate

That would be an **erasure detector**. It costs no capacity, because it carries
no bits — it only says how much to trust each site. Whether it is worth building
is open.

This is the distinction that keeps causing confusion, so stated plainly:

|  | histogram as **codeword** | histogram as **detector** |
|---|---|---|
| the message is | the counts themselves | still the ordered digits |
| ws capacity, 16 sites | 969 histograms = **9.92 bits** | **32 bits**, unchanged |
| status | **not chosen — open** | **not chosen — open** |

The capacity figures are measured. **The choice between them is not made.** The
argument against composition coding recorded in `dev/roadmap.md` is drafted
prose, not a project decision that anyone signed off on — and it rests on a
capacity comparison alone, which is only decisive if capacity is the binding
constraint. It may not be: low information per symbol and robustness to a lost
symbol are the same property, so a scheme that trades capacity for surviving
symbol loss is not self-evidently wrong for a watermark. That tradeoff is
undecided and is the maintainer's call.

What §4 does establish is narrower, and it is a measurement rather than a
preference: because the symbol layer has no joint structure, soft information
cannot pay *there*. Where it should go instead — the ECC layer as erasures, the
window level, or nowhere — is not settled. Erasures are cheaper for a fountain
code to correct than errors and RLNC is already in the build, which makes it
worth testing; it does not make it the answer.

See `dev/symbol-layers.md` for the full layer map and `dev/roadmap.md` for
sequencing.
