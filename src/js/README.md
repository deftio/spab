# @deftio/spab

**Watermark plain text.** Hide an arbitrary payload — a serial, a hash, JSON, a short
program — inside ordinary text, in choices a reader never notices: which space, which quote,
which dash. The words read identically, and error correction carries the mark through
copy/paste, reformatting, and Unicode normalization.

Zero dependencies. Works in Node and in the browser. BSD-2-Clause.

```bash
npm install @deftio/spab
```

**[Live playground →](https://deftio.github.io/spab/pages/#/test)** · try it on your own text
before installing anything.

## Quick start

```js
const SPAB = require('@deftio/spab');

const { text, metadata } = SPAB.encode(coverText, 'inv-4417', {});
// `text` reads the same as `coverText` — send it, paste it, publish it.

const { message } = SPAB.decode(text, {});
// => 'inv-4417'
```

Browser — the script sets `window.SPAB`:

```html
<script src="https://cdn.jsdelivr.net/npm/@deftio/spab/spab.js"></script>
<script>
  const out = SPAB.encode(document.body.innerText, 'draft-7', {});
</script>
```

CLI — installing globally puts `spab` on your path:

```bash
spab encode --message "inv-4417" --in report.txt --out marked.txt
spab decode --in marked.txt
spab capacity --in report.txt      # how much this text can hold
```

## Capacity: the one thing to know

A passage can only hold so much. Capacity comes from how many carrier sites the text has, so a
short paragraph and a long secret do not fit — and spab tells you rather than failing quietly:

```js
const { metadata } = SPAB.encode(shortText, 'a-rather-long-secret', {});
metadata.capacityBits   // what this text holds
metadata.frameBits      // what this payload needs
metadata.issues         // ['Passage too short for any channel: …']
```

Check `metadata.issues`, or decode what you just encoded to confirm the round trip. More text, or
a shorter payload, buys redundancy — and redundancy is what survives editing.

## Carriers

Each carrier is an independent channel that carries the whole payload, so an edit that destroys
one can leave another intact. The default set is chosen so the channels fail on *different* edits.

| class | bits/site | on by default | survives NFKC | notes |
|---|---|---|---|---|
| `ws` | 2 | yes | **no** | 4 whitespace variants; length-preserving |
| `apos` | 1 | yes | yes | straight vs. curly apostrophe |
| `hyphen` | 1 | yes | yes | hyphen-minus vs. Unicode hyphen |
| `wsdense` | 3 | no | no | 8 whitespace variants; some differ in width |
| `zwsp` | 2 | no | no | inserts zero-width chars; text length grows |

NFKC normalization erases every whitespace variant but leaves the confusables; a smart-quote
autocorrect does the reverse. Running both classes is why the payload usually survives one.

```js
SPAB.encode(text, msg, { classes: ['ws', 'apos', 'hyphen'] });   // the default
SPAB.encode(text, msg, { classes: ['apos', 'hyphen'] });         // NFKC-durable only
```

## Error correction

```js
SPAB.encode(text, msg, { ecc: 'repetition' });   // default: frame repeated, per-bit majority vote
SPAB.encode(text, msg, { ecc: 'rlnc' });         // GF(256) fountain; packets pool across channels
```

`repetition` is strongest when a single channel is dense. `rlnc` breaks the payload into
self-checking, self-locating packets that pool across *all* channels, so surviving carriers can
reconstruct the whole message. Both are dependency-free and hand-rolled.

### Edits that add or remove text

Inserting or deleting a word usually changes the number of carrier sites, which shifts the whole
symbol stream — everything after the edit would otherwise decode to noise, no matter how much
redundancy was spent. The decoder resynchronises: it re-cuts the block grid at each phase, pooling
RLNC packets from every phase and, for repetition, scanning for one intact self-contained frame.

Recovery still depends on having spare capacity. A passage that holds exactly one copy of the
payload has nothing to fall back on when part of it is disturbed; give the text room for two or
three copies and edits become survivable. `metadata.reps` tells you how many copies fit.

Resynchronisation is disabled when `params.key` is set — the keyed interleave spans the whole
stream and cannot be undone on a shifted one.

## Payloads larger than the text can hold

Substitution carriers are bounded by the text: a passage has however many spaces and quotes it has.
When a payload does not fit, encode writes one truncated copy and says so in `metadata.issues`.

`autoGrow` trades length preservation for capacity. It enables the zero-width carrier and raises its
density until the payload fits, aiming for `redundancy` copies (default 3):

```js
SPAB.encode(shortText, longSecret, { autoGrow: true });
SPAB.encode(shortText, longSecret, { autoGrow: true, redundancy: 5 });
```

The visible text is unchanged — same words, same punctuation, same line breaks — but the string now
contains extra zero-width characters, so its **byte length grows** and the mark is obvious to anyone
inspecting the bytes. That is why it is opt-in: substitution carriers leave the text byte-for-byte
the same length, and that is the property most callers are relying on.

**Allowed, but not recommended.** Stuffing a large payload into a small passage works — this is the
same trade StegCloak makes — and it is a reasonable choice when the mark only has to survive
copy/paste between systems that preserve the characters. It is a poor choice when the mark is meant
to go unnoticed: hundreds of zero-width characters in a short paragraph are trivially visible in a
hex dump, survive no normalization, and are stripped by anything that filters invisible characters.
Prefer giving the payload more cover text over inflating a short one.

Decoding needs no flag. Zero-width characters are either present or not, so `decode()` looks for
that channel whenever the text contains them, even if the caller did not list it.

The frame's length field is one byte, so **255 content bytes is a hard limit**. A longer message is
silently truncated; compare `metadata.payloadBytes` against your message length if that matters.

## Optional keyed scramble

```js
SPAB.encode(text, msg, { key: 'shared-secret' });
```

Whitens and interleaves the symbol stream from a key-derived source: the right key recovers, a
wrong or missing key does not. This is a **cost multiplier, not confidentiality** — it raises the
price of stripping and hides structure, but real secrecy awaits the planned authenticated cipher.
Do not treat it as encryption.

## What it is not

spab targets **incidental** robustness — ordinary editing, copy/paste, reformatting. It does not
defeat a determined stripper: anyone who knows the carrier set can remove the mark, and rewriting
the text removes it entirely. The design raises that cost and makes stripping detectable; it never
claims to be unbreakable.

## API

`encode(text, message, params)` → `{ text, metadata }`
`decode(text, params)` → `{ message, metadata }` (`message` is `null` when nothing verifies)
`histogram(text)`, `getSites(text, params)`, `getSlots(text, params)`, `symbols`, `resolveClasses(params)`
`VERSION`, `algorithm` — `algorithm` is a self-describing object: carriers, bits, ECC, frame layout.

Frame: `[magic 0xA5][len][content][crc8]`. A decode only returns a message when the CRC verifies.

## Links

- **Playground and docs** — https://deftio.github.io/spab/pages/
- **Source, spec, and research** — https://github.com/deftio/spab

The JavaScript implementation is the reference codec; other language ports follow it and share
the same conformance vectors.
