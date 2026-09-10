# Symbol layers: what is implemented, what was intended

Status: 2026-09-09, against `src/js/spab.js` @ v0.5.2.

For a worked end-to-end example with real numbers, see
[`docs/encoding-walkthrough.md`](../docs/encoding-walkthrough.md).

This document exists because the vocabulary collapsed. "Symbol" names three
different things in the codebase and "block" names five. Before any more modem
work, this is the map. Every number here was read out of the running code, not
from a design note.

---

## 1. The stack as built

```
  message bytes
      │
      ▼
  ┌─────────────────────────────────────────────────────────┐
  │ WIRE PACKET (v2)   header | ext | checksum | content     │  §wire-format.md
  └─────────────────────────────────────────────────────────┘
      │  bit string
      ▼
  ┌─────────────────────────────────────────────────────────┐
  │ ECC   repetition+majority (default)  |  RLNC 8/16/8      │  §wire-format.md 9b
  └─────────────────────────────────────────────────────────┘
      │  bit string (many copies / many packets)
      ▼
  ┌─────────────────────────────────────────────────────────┐
  │ SYMBOL MODEM   bitsToSymbols() / symbolsToBits()         │  <-- LAYER 2 below
  │ mixed-radix, blocked, ORDERED                            │
  └─────────────────────────────────────────────────────────┘
      │  one digit per site
      ▼
  ┌─────────────────────────────────────────────────────────┐
  │ CARRIER CLASS   glyph <-> digit, alphabet r                 │  <-- LAYER 1 below
  └─────────────────────────────────────────────────────────┘
      │
      ▼
    text
```

`detect()` / `SPAB.soft` hang off the side of LAYER 1. Nothing in `decode()`
calls them. That is the gap this document is mostly about.

---

## 2. Three things called "symbol"

### LAYER 1 — the site digit (implemented, both directions)

One glyph position carries one digit in alphabet `r`.

| class | alphabet | bits/site | kind | default |
|---|---|---|---|---|
| `ws` | 4 | 2 | substitute | on |
| `apos` | 2 | 1 | substitute | on |
| `hyphen` | 2 | 1 | substitute | on |
| `wsdense` | 8 | 3 | substitute | **off** |
| `zwsp` | 4 | 2 | **insert** | off (auto-grow may add it) |

Classes are independent parallel channels. `wsdense` and `zwsp` are what we have
been loosely calling "dense encoding" — see §5.

### LAYER 2 — the mixed-radix block symbol (implemented on TX, half-implemented on RX)

`bitsToSymbols()` takes a run of consecutive sites and treats them as **one
integer** in the product space `r1·r2·…·rn`, bounded by `SYM_CAP = 2^32`.

Measured block geometry, `maxSites = 0`:

| class | alphabet | block | carries | bits/site |
|---|---|---|---|---|
| `ws` | 4 | **16 sites** | 32 bits | 2.000 |
| `apos` / `hyphen` | 2 | **32 sites** | 32 bits | 1.000 |
| `zwsp` | 4 | **16 sites** | 32 bits | 2.000 |
| `wsdense` | 8 | **10 sites** | **30 bits** | 3.000 |

It is tempting to call this a multi-site constellation. **For the alphabets
currently shipping it is not — but that is a choice, not a constraint.**

Every alphabet in the table above is a power of two (2, 4, 8), and `4^16 = 2^32`
*exactly*, so mixed-radix conversion degenerates into plain bit-slicing: digit
`s` is simply bits `2s, 2s+1` of `v`. Measured avalanche, one digit perturbed:

| alphabet | block | mean bit flips | max | |
|---|---|---|---|---|
| 4 | 16 sites / 32 bits | 1.69 | 2 | bit-slice, no mixing |
| **6** | 12 sites / 31 bits | **6.17** | 10 | **joint — digits mix** |
| 8 | 10 sites / 30 bits | 2.00 | 3 | bit-slice, no mixing |
| **10** | 9 sites / 29 bits | **6.78** | 13 | **joint — digits mix** |

The mixed-radix layer already handles fractional alphabets at **97–100%**
efficiency (alphabet 6: 99.94%). It was built for this and has never been used for
it, because every carrier alphabet was rounded down to a power of two.

**Capacity forgone by that rounding**, against the candidates in
`r_and_d/docs/symbol-catalog.md`:

| class | shipping alphabet | candidates | bits/site now | if all used | gain |
|---|---|---|---|---|---|
| `ws` | 4 | 10 | 2.000 | 3.322 | **+66%** |
| `wsdense` | 8 | 10 | 3.000 | 3.322 | +11% |
| `hyphen` | **2** | **6** | 1.000 | 2.585 | **+158%** |

**Consequences, stated carefully:**

1. Joint detection over a *power-of-two* block provably buys nothing — scoring
   `4^16` candidates against 16 independent posteriors factorises into 16
   independent argmaxes. This is arithmetic, not opinion.
2. That result **does not generalise**. At alphabet 6 or 10 the digits genuinely
   mix, and joint detection has real structure to exploit.
3. So "widen the alphabets" and "build a soft receiver" are one decision, not
   two. Neither is worth much without the other.
4. Avalanche is a cost for the *current* decoder: per-bit majority voting over
   repetition copies degrades when one site corrupts ~6 bits instead of 1.
   **RLNC is indifferent** — a packet failing CRC is discarded whole regardless.
   Wide alphabets pair with the fountain layer, not with repetition.

None of this is measured for robustness. The capacity figures are arithmetic;
no wide alphabet has been run through `r_and_d/attacks.js`, and the candidate
variants differ in visibility and reflow behaviour.

### LAYER 3 — the histogram window symbol (NOT implemented as data)

`likelihoodField()` slides a window of `n` sites (default 32) and reports the
value histogram plus a chi-square distance from uniform. Its output is a field
over position. **No caller consumes it for data recovery.**

Verified call graph: `likelihoodField`, `classSoft`, `siteConfidence` and
`posteriors` have zero callers outside `detect()` and the `SPAB.soft` export.

---

## 3. Ordered vs unordered — the distinction that got lost

These are **not** the same scheme, and conflating them is where the design
discussion keeps going in circles:

|  | mixed-radix block (LAYER 2) | histogram (LAYER 3) |
|---|---|---|
| what it reads | position **and** value | value counts only |
| ordered? | yes | no |
| capacity over n sites, alphabet r | `n·log2(r)` bits | `log2 C(n+r-1, r-1)` bits |
| ws, n=16 | **32 bits** | **9.92 bits** (969 distinct histograms) |

`dev/roadmap.md` line 189 argues against *histogram-as-codeword* on exactly this
capacity comparison. That passage is drafted prose, not a signed-off decision,
and capacity is only the deciding factor if capacity is what binds. **That rejection does not apply to
histogram-as-detector**, which is a different proposal and is still open:

> Use the windowed histogram to estimate the channel and produce **soft
> per-site posteriors**, then let the mixed-radix block resolve to a
> constellation point using those posteriors instead of hard digits.

Capacity stays at `n·log2(r)` — nothing is spent on the histogram. The histogram
is the channel estimator and the demodulator, not the codeword. This is the
reconciliation between "histogram is data retrieval" and "histogram as a
codeword is a bad scheme". Both are true and they are about different layers.

---

## 4. Five things called "block" (all of them 32, none the same unit)

| name | value | **unit** | where |
|---|---|---|---|
| symbol block payload | 32 | **bits** | `SYM_CAP = 2^32` |
| `KEY_BLOCK` | 32 | **digits** | keyed interleave period |
| `MAX_PHASE` | 32 | **phases** | resync sweep |
| RLNC packet | 32 | **bits** | 8 esi + 16 data + 8 crc |
| `detect()` window | 32 | **sites** | histogram window `n` |

They coincide numerically and are independent by construction. `params.block`
sets `maxSites`, which is a **site** cap on LAYER 2 — not any of the others.

### A real misalignment this exposes

For `ws`/`apos`/`hyphen`/`zwsp` a 32-bit RLNC packet lands on exactly one
32-bit symbol block. **For `wsdense` the block is 30 bits**, so packets straddle
block boundaries and the two grids only realign every `lcm(30,32) = 480` bits,
i.e. every 15 packets. One damaged `wsdense` site can therefore corrupt two
packets instead of one. Unmeasured; `wsdense` is off by default, which is likely
why it has never been noticed.

---

## 5. "Dense encoding" — what it actually refers to

Two distinct opt-in carriers, both LAYER 1, neither a separate scheme:

- **`wsdense`** — 8 whitespace variants instead of 4. Length-preserving,
  3 bits/gap. Trades stealth for density (some variants differ subtly in width).
- **`zwsp`** — 4 zero-width characters, **inserted** rather than substituted.
  Highest capacity, but text length grows and it is visible in a hex view.
  `encode()` adds it automatically under auto-grow when a payload will not fit;
  `decode()` re-adds it on sight of any zero-width character.

Both die to NFKC. Neither changes LAYER 2 or 3 — they only change `r`.

---

## 6. Implemented vs intended

| | intended | implemented |
|---|---|---|
| per-site digit | yes | **yes** |
| multi-site joint symbol on TX | yes | **yes** (mixed-radix block) |
| multi-site joint detection on RX | yes | **no** — per-site hard slicer |
| windowed histogram | as detector | **computed, never consumed** |
| soft posteriors | feed the decoder | **exposed only via `SPAB.soft`** |
| channel estimate (pilot-free) | yes | **computed, never consumed** |
| histogram as codeword | explicitly not wanted | correctly absent |
| `softDecision` descriptor flag | — | **`false`** — the one honest field |

The one attempt to connect LAYER 3 to the decoder was a reliability-weighted
majority vote. It was measured and it **hurt**: scattered folding 5% went
56% → 50%, 20% went 6% → 0%. Diagnosis in `spab.js:1506` — the weight cannot
distinguish a *damaged* default glyph from a *legitimately sent* one, and about
`1/r` of sites carry the default in an intact stream, so it penalises good
blocks for their content.

**That result is about the junction, not the idea.** Weighting a repetition vote
by per-site confidence throws away the joint structure. Resolving a mixed-radix
block against posteriors does not — it is the thing the block was built for.

---

## 7. The next concrete step — ERASURES, not weights

Soft information has two possible destinations, and which one is right depends
on a decision that has not been made:

- **If the alphabets stay power-of-two**, the symbol layer has no joint structure
  (§2), so soft information cannot pay there and must reach the **ECC layer**.
- **If the alphabets widen to their full candidate sets** (alphabet 6, 10, …), the
  symbol layer *does* acquire joint structure, and a soft receiver there has
  something real to exploit.

The soft layer already computes the right quantity. `softDigit()` says:

- a **non-default** glyph is near-certain (only the encoder writes one): `1-eps`
- the **default** glyph is ambiguous — sent, or any variant collapsed onto it,
  with the split set by `estimateCollapse()` read straight off the histogram

That is an **erasure detector**, and erasures are exactly what a fountain code
wants: far cheaper to correct than errors, and RLNC is already in the build.

This also re-reads the failed weighted-vote experiment. It treated a default
glyph as *weak evidence for value 0*. Calibrated against the channel estimate, a
default glyph under heavy collapse is not weak evidence for 0 — it is **no
evidence at all**, an erasure. Marking it as such and excluding those packets
from the RLNC solve is a different mechanism from down-weighting a vote, and it
is untested. Worth measuring; not decided.

Open question to settle by experiment rather than argument: whether per-site
erasure marking beats the current CRC-per-packet discard, given that a 32-bit
packet already validates itself.

Prerequisite for honesty: `softDecision: false` in the descriptor must not flip
to `true` until `decode()` actually consumes posteriors.
