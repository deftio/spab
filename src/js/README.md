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
spab encode -m "classified" -k "$(openssl rand -hex 32)" -i report.txt -o marked.txt
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

The length is a varint, so there is no 255-byte ceiling. A 64 KB sanity bound remains — no cover
text can carry that much — and a payload past it is truncated rather than written with a length
field that has wrapped.

## Optional keyed scramble

```js
SPAB.encode(text, msg, { key: 'shared-secret' });
```

Whitens and interleaves the symbol stream from a key-derived source: the right key recovers, a
wrong or missing key does not. This is a **cost multiplier, not confidentiality** — it raises the
price of stripping and hides structure. Do not treat it as encryption; for that use `encKey`
below. The two are independent and compose.

## What it is not

spab targets **incidental** robustness — ordinary editing, copy/paste, reformatting. It does not
defeat a determined stripper: anyone who knows the carrier set can remove the mark, and rewriting
the text removes it entirely. The design raises that cost and makes stripping detectable; it never
claims to be unbreakable.

## What a payload can be

Any string that survives a UTF-8 round trip and fits the budget is a valid payload,
and so is a raw byte array:

| shape | example | notes |
|---|---|---|
| identifier | `invoice-4417` | the common case |
| JSON | `{"r":"j.smith","case":42}` | stored as literal text — see the note below |
| Unicode / accents | `зака́з-42 — naïve café` | multi-byte characters cost more of the budget |
| emoji | `case ✅ 42` | fine, but each emoji is 3–4 bytes |
| base64 | `aGVsbG8gd29ybGQ=` | how to carry binary today |
| text with spaces | `two words here` | no restriction on content |

There is **no 255-byte limit**: the length is a varint (one byte to 127, two to
16 383, three beyond). What limits a payload is the cover text's capacity, which
`metadata.capacityBits` reports and `metadata.issues` warns about. Note the budget is
in *bytes*, not characters, so accented text and emoji cost several bytes each.

`metadata.payloadBytes` is the size **as stored** — after compression and encryption —
and `metadata.messageBytes` is the size of what you handed over. They differ whenever
either transform did something.

## Payload types

The packet carries a **type** so the decoder can say what a payload is, not just hand
back bytes:

| type | implied size | meaning |
|---|---|---|
| `string` | variable | UTF-8 text (the default) |
| `json` | variable | UTF-8 that parses as JSON |
| `bytes` | variable | arbitrary bytes, returned as an array |
| `ser8` | 8 bytes | a short serial number or tag |
| `uuid` | 16 bytes | a canonical UUID, stored raw rather than as 36 characters |
| `sha256` | 32 bytes | a digest, stored raw rather than as 64 hex characters |
| `program` | variable | reserved for executable payloads |
| `encrypted` | variable | opaque ciphertext from elsewhere (see `encKey` for spab's own) |

A fixed-size type carries **no length field at all** and stores its payload compactly,
which is what pays for the header on the payloads people actually carry: a UUID is
128 bits of content where its string form would be 288.

Type is inferred when you do not say — JSON that actually parses is typed `json`, a
canonical UUID is typed `uuid`, an 8-byte tag is `ser8` — and an explicit
`params.type` always wins:

```js
SPAB.encode(text, '{"case":42}', {});                   // -> type "json"
SPAB.encode(text, '{"case":42}', { type: 'string' });   // -> type "string"
SPAB.decode(marked, {}).metadata.type;                  // -> "json"
```

A type code this build does not know is **carried and reported by number**, not
dropped, so a newer writer and an older reader can disagree without losing the
payload.

## Compression

Attempted on every payload and kept only when the result is strictly smaller:

```js
SPAB.encode(text, 'na'.repeat(120), {});                  // -> compression "lzss"
SPAB.encode(text, 'short', {});                           // -> compression "none"
SPAB.encode(text, longText, { compress: false });         // never compress
```

This is not an optimization detail. spab payloads are usually 8-200 bytes and every
general-purpose compressor *expands* inputs that small, so a format that compressed
unconditionally would make its most common payload bigger. `metadata.compression`
reports which algorithm was used, on both encode and decode.

The reference codec implements **LZSS**, defined in the wire-format spec so it depends
on no library and behaves identically in Node and the browser. `deflate-raw`, `gzip`,
`brotli` and `zstd` have registered code points; a packet using one is located and
reported as `unsupported` rather than silently dropped.

## Encryption

```js
const key = require('crypto').randomBytes(32);            // or 64 hex characters
const { text } = SPAB.encode(cover, 'classified', { encKey: key });
SPAB.decode(text, { encKey: key }).message;               // 'classified'
SPAB.decode(text, {}).metadata.status;                    // 'encrypted' — found, not opened
```

AES-256-GCM. The content becomes `nonce ‖ ciphertext ‖ tag`, costing 28 bytes. Key
management is yours: spab takes a 32-byte key or 64 hex characters and never derives
one from a passphrase on your behalf. `SPAB.deriveKey(password, salt, iterations)` is
provided (PBKDF2-HMAC-SHA256) and deliberately kept *out* of the packet, so no salt or
iteration count has to travel in a header where every bit is contested.

Three behaviours worth knowing:

* An encrypted mark is **findable without the key** — the packet keeps a plaintext
  checksum, so a decoder can locate it and report `status: 'encrypted'` rather than
  claiming nothing is there.
* A **wrong key** reports `status: 'auth-failed'`, which is a different fact from
  "no mark present" and callers can act on the difference.
* Compression happens **before** encryption, so a compressible payload is smaller on
  the wire even when encrypted.

Implemented in pure JS so `encode`/`decode` stay synchronous everywhere — WebCrypto's
AEAD is async in every host, which would have forced an async API on a library whose
whole surface is synchronous. It is verified against Node's own AES-256-GCM
byte-for-byte. Table-driven AES is **not constant-time**; that is outside spab's
threat model (marking happens locally; the attacker sees marked text, not the
machine), but if you need constant-time encryption, encrypt with a platform AEAD and
pass the ciphertext in as a `bytes` payload.

## Checksums

The packet's checksum width is a 3-bit exponent — `bits = 8 << n` — defaulting to
crc16, rising to crc32 above 512 stored bytes, and overridable:

```js
SPAB.encode(text, msg, { cksum: 2 });    // 0=crc8 1=crc16 2=crc32
                                         // 3=sha256/64 4=sha256/128 5=sha256/256
```

There is no "no checksum" option. With no magic number in the header, the checksum is
what tells the decoder a candidate window is a real packet, so every packet carries at
least eight bits of one.

`cksum: 0` (crc8) is reachable but not the default, and it has one consequence worth
knowing: a packet found by the **blind resync sweep** must carry at least 16 bits of
checksum or have been seen more than once, so a crc8 mark that fits only once may not
survive an edit that shifts the stream. It still decodes normally by folding. The
measurement behind that rule is in the wire-format spec (§7).

## Detecting a mark

```js
const d = SPAB.detect(marked, { classes: ['ws'] }).ws;
d.collapse        // 0 = intact carriers, ~1 = every variant folded back to a plain space
d.meanConfidence  // how reliably the sites read
d.field           // one entry per window position: { at, counts, chi2, marked }
```

`detect()` slides a window over the carrier sites and reports the histogram at each
position together with how close it sits to the distribution an encoded stream
produces. The output is a **field over position**, not a verdict — a caller
diagnosing a failed decode wants to see *where* the text stopped looking marked,
which a boolean cannot say.

The channel estimate needs no pilot symbols because the carrier histogram is the
pilot: an intact marked stream is near-uniform over the radix, so excess mass on the
plain space measures how much normalization the text has been through. Unmarked prose
estimates ~0.99, a freshly marked passage ~0.41, and the same passage after NFKC
returns to ~0.99.

The per-site model is deliberately asymmetric, because the channel is: nothing turns
a plain space into a thin space, so a variant is near-certain evidence while a plain
space is ambiguous in proportion to the estimated collapse.

This is also the statistic someone looking *for* a watermark would compute, which is
why it is exposed rather than hidden — see the detectability note in
[`dev/roadmap.md`](https://github.com/deftio/spab/blob/main/dev/roadmap.md).

## Wire format

```
[version:3 | type:5 | comp:3 | enc:3 | cksum:3]   17-bit fixed header
[extension bytes, grouped, in field order    ]   only for escaped fields
[len varint                                  ]   only when not implied
[checksum, 8 << cksum bits                   ]   before the content, deliberately
[content                                     ]
[pad to a byte boundary                      ]
```

Overhead is 25 bits for an 8-byte serial and 65 for a 2 KB blob. The checksum precedes
the content because tail truncation is spab's commonest loss: a surviving header says
what the missing bytes should have hashed to, which turns the checksum from a pass/fail
gate into an oracle the erasure decoder can query. The full rationale, the escape
mechanism, and bit-exact worked examples are in
[`dev/wire-format.md`](https://github.com/deftio/spab/blob/main/dev/wire-format.md).

Marks written by **0.4.x do not decode here**: that release had a different,
byte-oriented frame. Accepting both layouts was tried and reverted — a CRC-8 validates
by chance about once in 256, so parsing two layouts doubles the ways a random window
looks like a packet, and a UUID payload came back as a "legacy string" within the
hour. The version field exists to make the next change cheaper than this one.

## Reading a mark back

`spab decode` prints the payload on stdout and a report on stderr, so piping stays
clean:

```
$ spab decode --in marked.txt
{"user":"alice","role":"editor","org":"acme","team":"acme"}
  status perfect  ·  confidence 100%  ·  via ws  ·  ecc repetition  ·  4 copies  ·  crc16 ok
  wire v2  ·  type json  ·  compression lzss  ·  encryption none  ·  checksum crc16  ·  53 bytes stored / 59 opened
  payload: JSON
```

Encrypted marks report what they are even when they cannot be opened:

```
$ spab decode --in marked.txt
  status encrypted  ·  confidence 100%  ·  via ws  ·  ecc repetition  ·  crc16 ok
  wire v2  ·  type string  ·  compression none  ·  encryption aes-256-gcm  ·  checksum crc16  ·  38 bytes stored
  payload is encrypted; supply params.encKey
```

`spab decode --json` emits the full metadata, and `spab inspect` reports capacity,
carrier sites, zero-width count and the decode result together as JSON.

## API

### Options

| param | default | what it does |
|---|---|---|
| `classes` | `['ws','apos','hyphen']` | which carriers to use |
| `profile` | — | legacy shorthand for `classes`: `'ws'` selects whitespace only. Prefer `classes` |
| `type` | inferred | payload type (see above); an explicit value always wins |
| `ecc` | `'repetition'` | `'rlnc'` for the GF(256) fountain |
| `compress` | `true` | try compression, keep it only if the result is smaller |
| `encKey` | — | 32-byte key or 64 hex characters; encrypts with AES-256-GCM |
| `cksum` | by size | checksum exponent 0–5, `bits = 8 << n` |
| `key` | — | keyed symbol scramble (a cost multiplier, not encryption) |
| `autoGrow` | `false` | insert zero-width carriers until the payload fits |
| `redundancy` | `3` | copies to aim for when growing |
| `density` | | zero-width characters per word gap |
| `block` | | cap on symbol block size, in sites |

### Metadata

`status` is `perfect`, `corrected`, `failed`, `not-detected`, or — new in 0.5.0 —
`encrypted` (found, no key), `auth-failed` (wrong key), `unsupported` (an algorithm
this build does not implement) and `corrupt`. All four of the new ones mean *a packet
was located and verified*, which is a different fact from nothing being there.

Every decode also returns `type`, `compression`, `encryption`, `encrypted`,
`checksum`, `checksumBits`, `wireVersion`, `payloadBytes` (stored) and `messageBytes`
(opened).

### Functions

`encode(text, message, params)` → `{ text, metadata }`
`decode(text, params)` → `{ message, metadata }` (`message` is `null` when nothing verifies)
`histogram(text)`, `getSites(text, params)`, `getSlots(text, params)`, `symbols`, `resolveClasses(params)`
`deriveKey(password, salt, iterations, length)` → PBKDF2-HMAC-SHA256, for callers starting from a passphrase
`version()` → what this build is and what it can do (below)
`detect(text, params)` → the sliding histogram detector: likelihood field, per-site posteriors, channel estimate
`VERSION`, `TYPES`, `COMP`, `ENC`, `algorithm` — `algorithm` is a self-describing object: carriers, bits, ECC, packet layout
`CLASS_DEFS`, `SPACE_MAP`, `SPACE_NAMES`, `readClassBits(text, id, key, block)` — carrier internals, for introspection and visualisation
`wire` — the packet layer on its own (build/parse/checksums/LZSS/AES-GCM), exposed for conformance testing

A decode only returns a message when the packet's checksum verifies.

### Self-report

```js
SPAB.version()
// {
//   version: '0.5.0', name: '@deftio/spab', wireFormat: 2,
//   algorithm: 'plugsym-rep+rlnc',
//   carriers: ['ws','apos','hyphen','wsdense','zwsp'],
//   defaultCarriers: ['ws','apos','hyphen'],
//   ecc: ['repetition','rlnc'],
//   types: ['string','json','bytes','ser8','uuid','sha256','program','encrypted','extended'],
//   compression: ['none','lzss'],
//   encryption: ['none','aes-256-gcm'],
//   checksumBits: [8,16,32,64,128,256]
// }
```

`SPAB.VERSION` is still the bare string. `version()` exists because "which version" is
rarely the useful question about a codec on its own: a mark may have been written by an
older or newer build, so what a caller needs is **which wire format this build reads** and
**which code points it can actually honour**.

That last distinction is the point. `SPAB.algorithm.frame` lists every *registered* code
point — `deflate-raw`, `gzip`, `brotli`, `zstd`, `chacha20-poly1305`. `version()` lists the
*implemented* subset. The difference is exactly what predicts an `unsupported` decode, and
the test suite asserts these lists against what the codec actually does rather than against
another table that could drift the same way.

From the command line:

```bash
spab version           # human-readable
spab version --json    # the same object
spab --version         # alias
```

## Links

- **Playground and docs** — https://deftio.github.io/spab/pages/
- **Source, spec, and research** — https://github.com/deftio/spab

The JavaScript implementation is the reference codec; other language ports follow it and share
the same conformance vectors.
