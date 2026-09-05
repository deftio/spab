# What we have learned — measured findings

A running log of what the harnesses actually show, so design decisions cite evidence
rather than intuition. Every number here is reproducible with the command given.
When a finding is superseded, it is struck through rather than deleted — being
wrong earlier is part of the record.

Raw data in this directory: `results.csv`, `results.jsonl`, `runs.jsonl`,
`gen-results.csv`, `spab-bench.sqlite`.

---

## 2026-09-05 — characterization sweep

`npm run characterize` — 10 fixed samples x 7 payload sizes x 4 carrier sets x
2 ECC modes x 25 corruption models, ~3,465 rows, deterministic.

### Redundancy is the variable, not text length

Within the length-preserving carriers: **1 copy 29%, 2 copies 36%, 5–8 copies 57%**.
Text length only matters because it buys copies. Capacity work should therefore be
expressed as "how many copies does this passage hold", and `metadata.reps` is the
number a caller should be shown — not character count.

### Paired comparison reverses the ECC conclusion

| comparison | raw (confounded) | paired |
|---|---|---|
| repetition vs RLNC | RLNC 80% > rep 70% | **rep 88% > RLNC 80%** (n=900) |

The raw table compares different populations: RLNC only encodes where there is room
for K packets, so it is scored on roomier cases. Paired over the cells both modes
could encode, repetition wins. **RLNC's cross-channel pooling has not yet paid for
itself.** Any table that compares arms with different capacities must be paired.

### The confusable channels never encode alone

`classes: ['apos','hyphen']` failed to fit a payload in **every** combination of the
sweep. They carry ~1 bit per site and ordinary prose has single digits of them. The
"survives NFKC via the confusables" story on the site needs either denser
NFKC-durable carriers or a payload far smaller than anything in this matrix.

### Real-world channels split cleanly in two

- **Lossless for our carriers (100%):** JSON round trip, trailing-space trim, email
  quoting, concatenation into a larger document, markdown stripping,
  find-and-replace.
- **Destructive (69%, and the survivors are zero-width runs):** pasting into a plain
  text field, PDF/rendered-page extraction, tokenise-and-rejoin. All three collapse
  whitespace runs, which is the single most common way a whitespace mark dies.
- Sentence reordering 91%; per-word typos 75%.

### Weakest survivable cases

cut/paste 40%, word deletion 44%, truncation 52% — even after the resync work.
This is where more redundancy or a resynchronisable keyed mode would pay.

---

## 2026-09-05 — technique comparison

`npm run compare` — spab against reference reimplementations of the other
approaches, through the same channel. **These are models of each technique, not the
libraries** (see the header of `r_and_d/baselines.js`): they isolate two design
decisions — where the payload sits, and whether there is error correction.

### Solid: spab never returns a wrong payload

Across every scheme and model, **96 wrong-payload events**: the schemes without a
frame CRC (`ws substitute`, and the zero-width models under noise) return a
confidently wrong answer. spab returned **0** in every run of every sweep. This is
the clearest thing the framing and CRC buy, and it holds at large n. For a
provenance mark, a wrong answer is worse than no answer.

### Solid: substitution survives zero-width sanitisation

Stripping invisible characters — routine in sanitisers, CMS paste filters and diff
tools — takes **100%** of a zero-width payload and **0%** of spab's default
(substitution) carriers. This is the best-known weakness of the whole zero-width
family and the clearest argument for spab's default configuration.

### Directional, small n: point insertion beats spreading on desync

On the paired cells, point insertion recovers from word insert/delete and from
excerpting where spab does not. The reason is structural: a contiguous payload with
a scan-anywhere decoder is **position-independent**, so shifting the text does not
matter; spab's block grid is indexed by position. The resync work narrowed this and
did not close it.

**Caveat, and it is a large one:** the paired set is only **6–20 cells** — pairing
requires every scheme to encode, which restricts to roomy samples with small
payloads. These percentages are indicative, not measurements. The corpus needs more
mid-length samples that all four schemes can encode before this is quotable.

### Two measurement biases found and fixed

1. **The corruption suite was written for the whitespace channel.** `saltPepper`,
   `normalize`, `regexAttack` and `fullStrip` all target U+2006/2009/200A, so
   zero-width schemes sailed through a suite that never attacked them. Added
   `stripZw` and `zwNoise`.
2. **`truncate` keeps the head**, which silently favours any scheme that anchors its
   payload at the start — a point-insertion scheme at the first space could never
   lose to it. Added `truncTail` and `midExcerpt`. Point insertion's excerpt score
   fell from 83% to 36% once the mirror cases were included.

Both are worth remembering as a general rule: **a robustness suite written around
one design will flatter that design.**

---

## Open questions this raises

- Would a position-independent framing (sync markers, or packets addressed by
  content rather than site index) give spab point-insertion's desync robustness
  without giving up spreading? See `dev/roadmap.md`.
- Is RLNC worth keeping if repetition wins paired? It should win where damage is
  bursty and channels differ in survival — the current corpus may not contain that
  case. Needs a targeted test before the answer is trusted either way.
- What is the actual capacity floor for NFKC survival, and is there a denser
  NFKC-durable carrier than the apostrophe and hyphen?
