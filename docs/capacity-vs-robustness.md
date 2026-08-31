# spab: capacity vs. robustness

A practical guide to choosing what to embed and how robustly, based on how much text
you have. spab hides bytes in the whitespace of text; longer text holds more bytes and
repeats them more, so it survives more damage. This is a direct trade — pick the point
on the curve that fits your use case.

## The core trade

Two things pull against each other:

- **Payload size** — a 4-byte magic word vs. a 20-byte SHA-1 vs. a 130-byte program.
- **Redundancy** — how many times the payload fits in the text (more copies = survives
  more corruption). Redundancy = capacity ÷ payload size.

A short payload in a long passage gets many copies and is very robust. A long payload in
a short passage barely fits once and is fragile. The baseline uses ~2 bits per inter-word
space, so a passage of *W* words holds roughly *W/4 − 3* payload bytes per copy.

## Payload profiles

Named test profiles (see `r_and_d/payloads.js`), spanning the spectrum:

| Profile | Bytes | What it's for |
|---------|------:|---------------|
| `magic`   | 4  | a tiny magic word — stamp everything, ultra-redundantly |
| `magic8`  | 8  | a short serial / tag |
| `sha1`    | 20 | a 160-bit provenance fingerprint |
| `sha256`  | 32 | a 256-bit hash |
| `json`    | 67 | structured metadata (author, id, rights) |
| `program` | 130+ | a long payload — a mini program, URL, or easter egg |

## Two worlds (the intuition)

- **The major magazine.** You stamp a short **magic word** or serial on every article,
  including short ones. You don't need much data — you need it to *survive* copy/paste,
  reformatting, and light editing. Embed a tiny payload with maximum redundancy. Even a
  few hundred words carries a 4-byte mark many times over.
- **The novelist.** You ship a long work, so capacity is abundant. Now you can embed real
  **metadata** (rights, edition, author id as JSON) — or, as an easter egg, a **program,
  a link, or a small game** revealed by a decoder. A novel has room for a hash *and* a
  message *and* redundancy.

The rule of thumb: **match payload size to text length, then spend the rest on redundancy.**

## What the numbers look like

From `node r_and_d/harness.js --gen 4000 --profile-bench` on the (short-skewed) synthetic
corpus, "encodable" = fraction of docs long enough to hold the payload, and the columns
are recovery under each corruption at a mild setting:

| Profile | Bytes | Encodable | avg copies | normalize 10% | blockErasure 25% |
|---------|------:|----------:|-----------:|--------------:|-----------------:|
| magic   | 4  | 68% | 2.2 | 21% | 24% |
| magic8  | 8  | 49% | 1.5 | 8%  | 13% |
| sha1    | 20 | 21% | 1.1 | ~0% | 3%  |
| sha256  | 32 | 10% | 1.0 | ~0% | 1%  |

Smaller payloads fit in far more documents and survive far more damage. Hash-sized and
larger payloads need long passages (a curated corpus of books shifts these rows up a lot).

And recovery rises with passage length (`--by-size`, magic-sized payload, normalize 10%):

| Slots (≈ words) | Recovery |
|-----------------|---------:|
| 50–99   | ~4%  |
| 100–199 | ~16% |
| 200–499 | ~61% |

(The baseline codec is deliberately simple; the histogram/ECC work in the plan is aimed
squarely at lifting these curves — especially for copy/paste and hash-sized payloads.)

## Corruption types (what "robust" means)

The benchmark measures recovery against a channel of realistic damage
(`r_and_d/corruptions.js`):

- **saltPepper** — subtle per-symbol substitution noise.
- **normalize** — some special spaces collapse back to plain spaces.
- **blockErasure** — a paragraph gets retyped/rewritten.
- **cutPaste** — someone copies only part of the document.
- **truncate** — the text is cut off.
- **wordDelete / wordInsert** — edits that add or drop words (these *desync* the stream —
  the baseline's weak spot).
- **reflow** — a formatter rewraps whitespace (total loss for the baseline).
- **regexAttack** — an informed adversary strips the carrier characters. `1.0` removes all
  of them; a partial value models an attacker who only caught some.
- **fullStrip** — every carrier normalized away (defeat).

Important honesty: an informed **regexAttack / fullStrip always wins**. spab is built for
*incidental* robustness (ordinary editing, copy/paste, reformatting), not for defeating a
determined stripper — no whitespace scheme can be.

## Choosing settings

1. **Measure your capacity.** `./cli/spabdemo.js capacity --in yourtext.txt` reports usable slots
   and max bytes per copy.
2. **Pick a payload that fits with room to spare.** Aim for several copies, not one — one
   copy is brittle. If it only fits once, use a smaller payload.
3. **Match the profile to the job:** magic/serial for short high-volume content; sha1/sha256
   for provenance; json/program when you have a long document.
4. **Know your threat model.** Copy/paste and reformatting: reasonable. A dedicated
   character stripper: out of scope — don't rely on it.

## Try it

```bash
# See capacity vs robustness across profiles
node r_and_d/harness.js --gen 5000 --profile-bench

# See recovery scale with text length
node r_and_d/harness.js --gen 6000 --by-size

# Same, against a real curated corpus (books, wikipedia, spreadsheets)
node r_and_d/corpus-curate.js
node r_and_d/harness.js --corpus-dir corpuses/curated --profile-bench

# Hide a magic word in your own text and reveal it
./cli/spabdemo.js encode --message "MAG1C" --in yourtext.txt --out out.txt
./cli/spabdemo.js decode --in out.txt --verbose
```
