# spab wire format v2

The **packet** is what spab hides in text. This document specifies it completely:
every field, every width, every escape, and the reasoning behind each choice.

Status: normative for spab 0.5.0 and later (current: 0.5.2). Packets written by 0.4.x are **not** readable by
this format and vice versa — that break is the reason the version field exists, and
the reason this is a minor bump rather than a patch.

---

## 1. Where the packet sits

```
  message ──▶ serialize ──▶ compress ──▶ encrypt ──▶ [ PACKET ] ──▶ ECC ──▶ symbols ──▶ text
                (type)       (comp)       (enc)                    (rep/RLNC)  (carriers)
```

This document covers the bracketed stage only. It is a **post-ECC** format: error
correction wraps *around* the packet, so the packet itself carries no redundancy
parameters, no interleaver state, and no carrier information. Change the ECC and
this format does not move.

Two consequences follow, and both are load-bearing:

* **The packet is a bit string, not a byte string.** It is packed into carrier
  symbols by the mixed-radix modem, which is already bit-oriented. Rounding fields
  up to byte boundaries would buy nothing and cost real capacity — see §9 for what
  the byte-aligned version of this header would have cost.
* **The decoder finds packets by sweeping bit offsets and validating.** There is no
  framing layer underneath to delimit them. Everything about the header is designed
  so that a wrong guess fails fast and cheaply (§7).

## 2. Layout

```
┌─ fixed header ── 17 bits, always present, always this shape ──────────────┐
│  version : 3   │  type : 5   │  comp : 3   │  enc : 3   │  cksum : 3      │
├─ variable header ── present only as the fixed header says ────────────────┤
│  version ext : 8      only if version == 7                                │
│  type    ext : 8      only if type    == 31                               │
│  comp    ext : 8      only if comp    == 7                                │
│  enc     ext : 8      only if enc     == 7                                │
│  cksum   ext : 8      only if cksum   == 7                                │
│  len : varint         only if the type does not imply a length            │
│  checksum : 8 << cksum bits                                               │
├─ content ─────────────────────────────────────────────────────────────────┤
│  len bytes (or the type's implied length), as stored:                     │
│  serialized, then compressed if comp != 0, then encrypted if enc != 0     │
├─ pad ─────────────────────────────────────────────────────────────────────┤
│  0..7 zero bits, to a byte boundary                                       │
└───────────────────────────────────────────────────────────────────────────┘
```

Read strictly in that order. No field's position depends on anything that follows
it, and no field is written twice.

## 3. Why the order is what it is

The field order is not a style preference. It is forced by two dependencies, and
only one arrangement satisfies both:

* The **checksum's width** is determined by `cksum`. So the `cksum` extension, if
  present, must be read before the checksum.
* The **presence of `len`** is determined by `type`. So the `type` extension, if
  present, must be read before `len`.

Grouping every extension immediately after the fixed header satisfies both at once,
and it buys a property worth having on its own: **the parser reads exactly 17 bits
and then knows the complete geometry of the packet** — which extensions follow,
whether a length follows, how wide the checksum is, and therefore where content
starts and ends. Everything after those 17 bits is a straight-line read with no
branches that can fail.

### Why the checksum precedes the content

A checksum conventionally trails the data it covers. Here it must not, and the
reason is specific to this channel.

The two corruption models spab loses to most often are **tail truncation** (a
document is cut short) and **mid-excerpt** (someone quotes two paragraphs out of
ten). Both destroy the end of the bit stream. With a trailing checksum, tail loss
takes the verifier *and* the data, so a partially recovered packet is unverifiable
and gets discarded whole.

With the checksum in the header, a surviving prefix of ~25–40 bits tells the
decoder what type this is, how many bytes to expect, and what those bytes must hash
to. That converts three failures into three recoveries:

1. Truncation is **detected** rather than mis-parsed — `len` bytes were promised and
   fewer arrived, which is a different and more useful fact than "checksum failed".
2. The surviving content is a **known-length erasure pattern**, not an
   unknown-length fragment, which is exactly what the fountain decoder needs.
3. Candidate reconstructions of the missing symbols can be **tested against a
   checksum the decoder already holds**.

That last point is the whole argument. A trailing checksum is a pass/fail gate on a
complete packet. A leading checksum is an oracle the erasure decoder can query
while it is still working — which is the point of using a fountain code for
erasures rather than a block code for errors.

### What the checksum covers

Everything before it, plus the content: the fixed header, any extension bytes, and
`len` if present, concatenated with the content bytes, zero-padded at the end to a
byte boundary, and run through the algorithm for its width.

Covering the header matters — a flipped `type` field with an intact content
checksum would decode confidently into the wrong thing.

Covering the content **as stored** (compressed, encrypted) rather than as
originally supplied matters more. It means a decoder can validate a candidate
packet without decompressing it, without decrypting it, and without holding a key.
That is what makes the offset sweep in §7 affordable, and it is why a decoder with
no key can still *locate* an encrypted packet even though it cannot read one.

## 4. Fields

### 4.1 version : 3 bits

The wire format version. Current value **2**.

| value | meaning |
|---|---|
| 0 | reserved (never emitted; a zeroed region is not a packet) |
| 1 | reserved — 0.4.x used a different, byte-oriented frame |
| 2 | this format |
| 3–6 | future formats |
| 7 | escape (§5) |

Three bits, not one byte. A version field's job is to let a decoder refuse
confidently rather than misread, and six code points plus an unbounded escape does
that for as long as anyone will care. The 0.4.x frame spent a whole byte on a magic
number and had no version at all, which is precisely the combination that makes a
format change unsafe.

A decoder MUST reject a packet whose version it does not implement. It MUST NOT
attempt a best-effort parse: a CRC-8 validates by chance about once in 256, and
parsing two layouts doubles the number of ways a random bit window can look like a
packet. This was tried in 0.4.3 development and reverted within the hour — a UUID
payload came back as a "legacy string".

### 4.2 type : 5 bits

What the content *is*. This field was in the original design and was missing from
the implementation from the first working commit until 0.5.0, which meant a decoder
could not tell an identifier from JSON from ciphertext.

| value | name | implied length | notes |
|---|---|---|---|
| 0 | `string` | variable | UTF-8 text |
| 1 | `json` | variable | UTF-8, parses as JSON |
| 2 | `bytes` | variable | opaque octets |
| 3 | `ser8` | **8 bytes** | serial number / short tag |
| 4 | `uuid` | **16 bytes** | stored raw, not as 36 characters |
| 5 | `sha256` | **32 bytes** | stored raw, not as 64 hex characters |
| 6 | `program` | variable | reserved for executable/structured payloads |
| 7 | `encrypted` | variable | legacy alias; prefer `enc` field + real type |
| 8–30 | — | — | unassigned |
| 31 | escape (§5) | | |

Five bits rather than eight. Eight named types today, 23 unassigned code points, and
an escape when those run out.

**Fixed-length types earn their code points twice.** They omit the `len` field
entirely, and they *compact*: a UUID presented as `f81d4fae-7dec-11d0-a765-00a0c91e6bf6`
travels as 16 bytes rather than 36, a SHA-256 as 32 rather than 64. On the payloads
people actually carry, the type field more than pays for itself — a UUID packet is
128 bits of content where the string form would be 288.

A fixed type is a promise about length. If the payload does not match, the encoder
falls back to `string` rather than writing a header that lies about its own content.

**A decoder MUST accept an unassigned type code and report it by number.** This is the
one field where forward compatibility outranks sweep discrimination (§7), because an
unknown type still yields usable bytes — the caller gets the payload and can decide
what it is — whereas an unknown compression or cipher yields nothing at all. Measured:
rejecting unassigned codes lets through 1 random window in 533k, accepting them 1 in
133k; on a page-sized stream both measure zero false packets over 200 trials. The 2
bits are worth it here and nowhere else.

### 4.3 comp : 3 bits

How the content was compressed, applied after serialization and before encryption.

| value | name | notes |
|---|---|---|
| 0 | none | |
| 1 | `lzss` | spab's own LZSS (§6) — dependency-free, synchronous, identical in every host |
| 2 | `deflate-raw` | registered; not produced by the reference codec |
| 3 | `gzip` | registered; not produced by the reference codec |
| 4 | `brotli` | registered; not produced by the reference codec |
| 5 | `zstd` | registered; not produced by the reference codec |
| 6 | — | unassigned |
| 7 | escape (§5) |

Three bits, not four. There are five plausible algorithms and an escape that makes
the ceiling irrelevant; a fourth bit would buy eight code points nobody has names
for, and it would cost that bit on the one size class that is genuinely
capacity-starved (§9 — an 8-byte serial already needs 89 bits against a memo's 64).

**The encoder tries and skips.** Compression is attempted on every payload, and the
result is used only if it is strictly smaller than the original. Otherwise `comp`
stays 0 and the original bytes are stored. This is not an optimization detail, it is
required behaviour: spab payloads are usually 8–200 bytes, and every general-purpose
compressor *expands* inputs that small. A format that compressed unconditionally
would make its most common payload bigger.

Compression is compared on the stored size only, and the smaller result wins ties
in favour of `none` — an uncompressed packet is readable by a decoder that
implements no compression at all.

### 4.4 enc : 3 bits

How the content was encrypted, applied last, after compression.

| value | name | notes |
|---|---|---|
| 0 | none | plaintext content |
| 1 | `aes-256-gcm` | nonce ‖ ciphertext ‖ tag, see below |
| 2 | `chacha20-poly1305` | registered |
| 3–6 | — | unassigned |
| 7 | escape (§5) |

Zero means plaintext, so there is no separate "is encrypted" bit. A one-bit presence
flag with a conditional 3-bit field was considered and measured: it saves 2 bits on
plaintext packets and costs 1 bit on encrypted ones, in exchange for a
conditionally-present field in the parser. Not worth it. Three bits, always.

**Nonce and tag live inside the content, not the header.** For an AEAD algorithm the
content is `nonce ‖ ciphertext ‖ tag`, with both sizes implied by the algorithm.
This keeps the header a fixed shape and lets the AEAD tag cover the entire
ciphertext, which it could not if the sizes were negotiated in header fields the
tag does not protect.

**An encrypted packet still carries a plaintext checksum**, and this is not
redundant with the AEAD tag. The offset sweep runs before decryption and without a
key; the tag is useless for locating a packet. Without a plaintext checksum an
encrypted packet would be unfindable by anyone who cannot already decrypt it. Eight
bits, mandatory — 0.05% of a 2 KB encrypted packet.

*Reference codec status: the field is written, parsed, reported, and extension-capable,
but only `enc = 0` is produced. Encryption requires WebCrypto's AEAD, which is
async in every host, and therefore an async encode/decode API. See `dev/roadmap.md`.
A packet with `enc != 0` decodes to `status: 'unsupported'` with its metadata intact
rather than failing silently.*

### 4.5 cksum : 3 bits

The checksum width, as an **exponent**: `bits = 8 << cksum`.

| value | bits | algorithm |
|---|---|---|
| 0 | 8 | CRC-8/ATM (poly 0x07) |
| 1 | 16 | CRC-16/CCITT-FALSE (poly 0x1021) |
| 2 | 32 | CRC-32 (reflected, poly 0xEDB88320) |
| 3 | 64 | SHA-256, truncated to the leading 64 bits |
| 4 | 128 | SHA-256, truncated to the leading 128 bits |
| 5 | 256 | SHA-256, full |
| 6 | 512 | reserved (requires SHA-512) |
| 7 | escape (§5) — the extension continues the same ladder |

One scale, one rule, and the escape *extends* the ladder rather than introducing a
second encoding: extension value `e` means `8 << e`, so `e = 7` is 1024 bits.

The reference codec implements exponents 0–5. It refuses 6 and every escaped value,
because a decoder that cannot compute the checksum cannot verify the packet and must
not pretend otherwise — and because the sweep tests thousands of windows, so every
value it accepts without being able to use it is pure false-accept surface.

**Default width.** The encoder's floor is **crc16**, rising to crc32 above 512 stored
bytes. `params.cksum` overrides it in either direction.

crc8 was the original default for payloads under 32 bytes, on the reasoning that a
short payload cannot afford 16 bits of checksum on 64 bits of content. Measurement
overruled it. See §7: on structured streams the sweep accepted a chance window as a
32-byte `sha256` packet — a fixed type, so no length field constrained it, and 8 bits
of CRC were the only obstacle. The capacity argument for crc8 was weak anyway: an
8-byte serial is 89 bits with crc8 and 97 with crc16, against a memo-sized passage
that holds 64 either way. crc8 rescued nothing and cost a factor of 256 in false
accepts, so it stays in the format and out of the default.

**Value 0 is the smallest checksum, not "no checksum".** There is deliberately no
code point for "none". A packet with no checksum cannot be validated at all, because
there is no magic number underneath to delimit packets (§7) — the checksum *is* the
delimiter. The tempting exception is AEAD, where a 128-bit tag already
authenticates; §4.4 explains why that exception is refused.

**Why CRC below 64 bits and a digest above.** A CRC's value is guaranteed burst
detection at low cost, which is exactly right at 8–32 bits. There is no standard
CRC-128 and no reason to invent one: at those widths the reason to want a wide
checksum is collision resistance against an adversary, which a CRC does not provide
at any width. Truncated SHA-256 does, and truncation is standard practice.

### 4.6 len : varint, conditional

The length of the content **as stored** — after compression, after encryption — in
bytes. Present when either:

* `type` does not imply a length (§4.2); **or**
* `comp != 0` or `enc != 0`.

The second clause matters and is easy to miss. A fixed type promises a *stored* size,
and compression or encryption changes it — an encrypted `uuid` is 44 bytes on the wire,
not 16. So a fixed type omits the length only while it is stored plain, and the field
comes back the moment either transform is applied. Omitting it there would make the
header lie about the packet's own extent, which is the one thing the sweep cannot
tolerate.

Seven bits per byte, high bit set means another byte follows, least significant
group first:

```
  0 .. 127          1 byte    0xxxxxxx
  128 .. 16 383     2 bytes   1xxxxxxx 0xxxxxxx
  16 384 ..         3 bytes   1xxxxxxx 1xxxxxxx 0xxxxxxx
```

Exp-Golomb was measured against this and loses above length 16 — 11 to 17 bits where
the varint spends 8 to 16 — and it costs a bit-serial decode where the varint costs
a byte read. Cover texts that can carry more than 16 bytes are the normal case.

`len` is the *stored* size so a decoder knows the packet's extent without
understanding its compression or holding its key. The original uncompressed size is
therefore not in the header. That is a decompression-bomb surface, and it is handled
as decoder policy — a hard expansion cap — rather than as a field, because an
original-length varint would cost 8–24 bits on every compressed packet to defend
against something a cap handles for free.

## 5. Extension

Every enumerated field reserves its **all-ones** value as an escape. The rule is the
same for all of them, and it composes:

> An escaped field is followed by 8 more bits, carrying the real value. Extension
> bytes appear grouped after the fixed header, in field order. If an extension byte
> is itself `0xFF`, another 8 bits follow, and so on.

The extended value is the raw extension byte, so the ranges continue without a gap:

| field | base range | with one extension byte | with two |
|---|---|---|---|
| version | 0–6 | 7–261 | 262–… |
| type | 0–30 | 31–285 | 286–… |
| comp | 0–6 | 7–261 | 262–… |
| enc | 0–6 | 7–261 | 262–… |
| cksum | 0–6 | 7–261 (as `8 << e`) | — |

Nothing moves to the end of the packet, and the reader stays strictly sequential.

**A decoder that meets an extended value it does not implement still knows where the
packet ends** — `len` and the checksum are readable regardless — so it reports
`status: 'unsupported'` with the fields it did understand, and the sweep continues
past the packet rather than resynchronizing blindly.

### Worked example — an extended type

A hypothetical type 40 (`type` base 31 = escape, extension byte 9), variable length,
no compression, no encryption, CRC-16, 3-byte content:

```
  bits   field          value
  ─────  ─────────────  ───────────────────────────────
  010    version        2
  11111  type           31  → escape
  000    comp           0   (none)
  000    enc            0   (none)
  001    cksum          1   (16 bits)
  00001001  type ext    9   → real type = 31 + 9 = 40
  00000011  len         3
  <16 bits> checksum
  <24 bits> content
  <pad>                 to a byte boundary
```

17 + 8 + 8 + 16 + 24 = 73 bits → 80 with padding. The unextended equivalent would be
65 bits: the extension costs exactly the 8 bits it says it does.

## 6. LZSS (comp = 1)

A minimal LZSS chosen because it is small, exactly symmetric, synchronous in every
host, and has no dependency that a browser might lack. It is defined here so the
format does not depend on a library.

* 4 KB sliding window, match lengths 3–18.
* The stream is a sequence of **groups**: one flag byte, then up to 8 items, most
  significant flag bit first.
* Flag bit 1 → a literal byte. Flag bit 0 → a 16-bit big-endian match token:
  `offset:12 | (length - 3):4`, where `offset` is the distance back from the current
  output position, 1–4096, stored as `offset - 1`.
* A group with fewer than 8 items ends the stream; unused flag bits are 0 and no
  token follows them, so `len` is what terminates decoding.

Compression is greedy longest-match. The encoder emits this only when the result is
strictly smaller than the input (§4.3), so a stream that would expand is never
written.

**Expansion is structurally bounded.** The densest possible stream is one flag byte
plus 8 match tokens (17 bytes in) yielding 8 × 18 = 144 bytes out, so LZSS cannot
expand by more than about 8.5×. The decoder still enforces a 64× cap, which no
conforming stream can reach; it is there so the bound does not have to be re-derived
if a future `comp` code point has a weaker one.

## 7. Finding a packet without a magic number

v1 opened with a magic byte `0xA5`. v2 has none, and the difference is worth stating
plainly because it is a real trade.

The decoder recovers a bit stream from the carriers and does not know where packets
begin — an inserted or deleted carrier site shifts everything after it. So it sweeps
candidate offsets and asks "is a valid packet here?". A candidate is accepted only
if all of the following hold:

1. `version` is implemented (1 of 8 values);
2. `comp`, `enc` and `cksum` are values this build implements (`type` is deliberately
   *not* constrained — see §4.2);
3. `len`, if present, is a well-formed varint and the packet fits the bits remaining;
4. the checksum matches.

The estimate going in was that this is about 8 bits weaker per offset than v1's magic
byte. **The measurement says otherwise**, because the length field is a much stronger
filter than it looks: a candidate must also state a length that fits the bits actually
remaining. Sweeping random streams at every byte offset:

| variant | false packets | windows | rate |
|---|--:|--:|---|
| page-sized stream (8k bits) | 0 | 199 400 | none in 200 trials |
| 64k-bit stream, unassigned types rejected | 3 | 1 599 400 | 1 in 533 000 |
| 64k-bit stream, unassigned types accepted | 12 | 1 599 400 | 1 in 133 000 |

The middle row is the strict discriminator; the last is the one this format actually
uses, having spent 2 bits on forward compatibility for the type field (§4.2). Both are
far better than the ~1 in 65k the v1 magic-plus-CRC combination gave, so dropping the
magic byte cost nothing measurable and saved 8 bits on every packet.

Three further things make the trade safe, and the tests check all three:

* **Frames are byte-aligned in the repetition stream** (the pad in §2). The sweep
  tests one offset in 8, not every bit — recovering three of the eight bits directly.
* **Frequency voting.** The payload is written many times over, so a real packet
  appears at many offsets with identical content; a chance match appears once. The
  decoder counts distinct payloads and takes the most frequent, which is decisive
  whenever redundancy is above 1.
* **A blind sweep is held to a higher evidentiary standard than the fold.** A packet
  found by scanning must carry at least a 16-bit checksum *or* have been seen more
  than once. The fold knows where packets start and measures agreement across copies;
  the sweep does neither, so it demands more.

### What the random-stream numbers missed

The table above measures random bits. Real streams are structured — they contain
shifted, partially damaged copies of a real packet — and those produce header-shaped
bit patterns far more often than noise does. Measured over 1539 *thin* damaged marks
(at most two copies fit, which is what forces the sweep), across checksum widths 8 to
256 bits:

| | wrong payloads | recovered | of |
|---|--:|--:|--:|
| without the evidentiary rule | **2** | 885 | 1539 |
| with it | **0** | 864 | 1539 |

The rule costs 21 recoveries — 2.4% — to remove a 0.13% chance of confidently
returning a payload that was never written. Both failures were the same shape: a
chance window read as a 32-byte `sha256` packet, a fixed type with no length field to
constrain it and 8 bits of CRC as the only obstacle. For a provenance tool a wrong
answer is categorically worse than a missed one, so the rule stays and the default
checksum floor moved to crc16 (§4.5).

This is the honest version of the trade, and it is worth stating plainly that the
first version of this section was wrong: it justified dropping the magic byte on
random-stream measurements alone, which understated the risk by enough to let a real
false positive through.

If measurement ever shows this trade going the wrong way, the fix is a sync field
added under a new `version` value — which is exactly the situation the version field
exists to make possible, and which v1 could not have done.

## 8. Worked examples, by size class

Bit-exact layouts for representative payloads. `hdr` is everything before the
content; `total` includes the pad to a byte boundary.

<!-- BEGIN GENERATED EXAMPLES -->
Bit-exact layouts, generated from the implementation by `npm run wire:tables`.
`hdr` is everything before the content; `total` includes the pad to a byte boundary.

| class | payload | ver | type | comp | enc | cksum | len | checksum | hdr | content | pad | total |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| `tiny` | 8-byte serial | 3 | 5 | 3 | 3 | 3 | 0 | 16 | **33** | 64 | 7 | 104 |
| `small` | 16-byte uuid | 3 | 5 | 3 | 3 | 3 | 0 | 16 | **33** | 128 | 7 | 168 |
| `small+` | 32-byte sha256 | 3 | 5 | 3 | 3 | 3 | 0 | 16 | **33** | 256 | 7 | 296 |
| `medium` | 40-byte json | 3 | 5 | 3 | 3 | 3 | 8 | 16 | **41** | 304 | 7 | 352 |
| `medium-z` | 200-byte json, deflated | 3 | 5 | 3 | 3 | 3 | 8 | 16 | **41** | 800 | 7 | 848 |
| `large` | 200-byte blob | 3 | 5 | 3 | 3 | 3 | 16 | 16 | **49** | 1600 | 7 | 1656 |
| `xl` | 2 KB blob | 3 | 5 | 3 | 3 | 3 | 16 | 32 | **65** | 16384 | 7 | 16456 |
| `enc-tiny` | 8-byte serial, AES-GCM | 3 | 5 | 3 | 3 | 3 | 8 | 16 | **41** | 288 | 7 | 336 |
| `enc-med` | 40-byte json, AES-GCM | 3 | 5 | 3 | 3 | 3 | 8 | 16 | **41** | 528 | 7 | 576 |
| `enc-xl` | 2 KB blob, AES-GCM | 3 | 5 | 3 | 3 | 3 | 16 | 256 | **289** | 16608 | 7 | 16904 |

Every row has the same 17 bits of fixed header. What varies is the length field
(absent for a fixed type stored plain, one varint byte to 127, two beyond) and the
checksum, which the encoder widens as the payload grows.
<!-- END GENERATED EXAMPLES -->

## 9. Overhead, and what it is spent on

<!-- BEGIN GENERATED OVERHEAD -->
| class | payload | original | stored | header | overhead | vs payload | fits one copy |
|---|---|--:|--:|--:|--:|--:|---|
| `tiny` | 8-byte serial | 64 | 64 | 33 | 40 | 63% | no (memo = 64b) |
| `small` | 16-byte uuid | 128 | 128 | 33 | 40 | 31% | yes (page = 196b) |
| `small+` | 32-byte sha256 | 256 | 256 | 33 | 40 | 16% | no (page = 196b) |
| `medium` | 40-byte json | 304 | 304 | 41 | 48 | 16% | yes (chapter = 790b) |
| `medium-z` | 200-byte json, deflated | 1296 | 800 | 41 | 48 | 6.0% | no (chapter = 790b) |
| `large` | 200-byte blob | 1600 | 1600 | 49 | 56 | 3.5% | yes (novel = 7918b) |
| `xl` | 2 KB blob | 16384 | 16384 | 65 | 72 | 0.4% | no (novel = 7918b) |
| `enc-tiny` | 8-byte serial, AES-GCM | 64 | 288 | 41 | 48 | 17% | no (page = 196b) |
| `enc-med` | 40-byte json, AES-GCM | 304 | 528 | 41 | 48 | 9.1% | yes (chapter = 790b) |
| `enc-xl` | 2 KB blob, AES-GCM | 16384 | 16608 | 289 | 296 | 1.8% | no (novel = 7918b) |

All figures in bits. `original` is what the caller handed over; `stored` is what went
on the wire after compression and encryption. The two compressed rows are the ones
where they differ, and the `enc-*` rows pay 224 bits for the nonce and tag.
<!-- END GENERATED OVERHEAD -->

The header is expensive only where the payload is trivially small, which is the
right place for it to be expensive — and even there it is 25 bits, against a v1
frame's 24 bits that carried no compression field, no encryption field, no checksum
choice, and a magic number.

A byte-aligned version of this same header — one byte each for version, type, comp,
enc, and cksum — would be 40 bits before the length and checksum. Bit packing saves
23 bits per packet; the trailing pad gives back at most 7.

## 9b. The ECC layer

Everything above specifies the **packet**. This section specifies what is written into
the carrier stream, which is a different thing and was previously left to the
implementation — a gap, since a port cannot be bit-compatible without it.

The packet is the *payload* of this layer. Both modes zero-pad to the channel's
capacity after emitting.

### Repetition (default)

No framing of its own. The packet's bits are concatenated back to back:

```
[ packet ][ packet ][ packet ] … [ 0 0 0 … ]
```

`reps = floor(capacity / packetBits)`. If the packet does not fit once, one truncated
copy is written and `metadata.issues` says so. The decoder recovers the stride from
the packet header (which is why the header parse must not verify the checksum — the
fold needs the stride before it can vote), folds the copies with a per-bit majority
vote, then parses.

### RLNC fountain (`ecc: 'rlnc'`)

A GF(2⁸) systematic random-linear code. Field polynomial **0x11D**, generator 2,
log/antilog tables.

The packet is split into **K source symbols** of `sym` bytes, zero-padded:
`K = ceil(packetBytes / sym)`.

Each emitted fountain packet is three bit fields:

```
[ esi : esiBits ][ data : sym*8 ][ crc : crcBits ]
```

Only `data` is byte-aligned; `esi` and `crc` are bit fields and never take part in
field arithmetic.

| geometry | esi | data | crc | width | payload share |
|---|--:|--:|--:|--:|--:|
| `v1` | 16 | 8 | 8 | 32 | 25% |
| **`default`** | **8** | **16** | **8** | **32** | **50%** |
| `wide` | 16 | 32 | 16 | 64 | 50% |
| `widest` | 12 | 128 | 16 | 156 | 82% |

The geometry is **not signalled on the wire**: encoder and decoder must be given the
same `rlncGeom`, exactly as they must agree on `ecc` and `classes`. That is a known
limitation, not a design choice — see `dev/roadmap.md`.

**Packet width is coupled to the modem.** The mixed-radix layer groups carrier sites
into 32-bit blocks and the resync sweep re-cuts that grid one site at a time, so a
packet wider than one block is far harder to realign after an insertion or deletion.
Measured on desync damage: 32-bit packets recover 20%, 40-bit 1%, 64-bit 3%, 96-bit
0%. A conforming implementation may offer wider geometries but should default to 32.

**ESI semantics.** The coefficient row for symbol id `esi` over `K` sources is:

* `esi < K` — **systematic**: the unit vector `e[esi]`, so `data` is source symbol
  `esi` verbatim.
* `esi ≥ K` — **repair**: `K` bytes drawn from `prng32(0x9E37 + esi)`, and
  `data = Σ coeff[j] · source[j]` over GF(2⁸).

`rlncCoeffs(esi, K)` is a **pure function**, so a given `esi` always encodes the same
equation.

**Checksum.** `crc8` for `crcBits ≤ 8`, otherwise `crc16`, taken over
`[0xA5, esiHi, esiLo] ‖ data` and truncated to `crcBits`. The `0xA5` seed means an
all-zero (blank or erased) window does not validate — the "zero is a valid codeword"
trap.

**Emission and wrapping.** Each enabled carrier class emits `floor(capacity / width)`
packets. `esiBase` advances across classes so classes carry different equations and
their survivors pool into one solve. When `esiBase + n` exceeds the ESI space, the id
**wraps**: since the coefficients are a pure function of `esi`, a wrapped packet is an
identical duplicate rather than a second equation claiming the same id, and the
decoder keeps the first valid copy of each. Capacity beyond the distinct-equation
space therefore buys redundancy rather than being discarded — measured on a 200K
character cover, that takes heavy-damage recovery from 60% to 80%.

**Decoding.** Collect packets whose checksum passes, keyed by `esi`, first copy wins.
Guess `K` upward and solve by Gaussian elimination over GF(2⁸) with a vector
right-hand side; a wrong `K` fails the packet checksum and the next candidate is
tried. Recovery needs **K linearly independent** equations, not merely K packets.

---

## 10. Conformance

An implementation conforms if it:

* writes the fixed header as 17 bits in the order of §2;
* writes extensions grouped, in field order, only for escaped fields;
* omits `len` only for a fixed-length type stored plain, and writes a varint whenever
  the type is variable or either transform changed the stored size;
* accepts and reports unassigned `type` codes, and refuses unassigned `comp` and `enc`
  codes;
* computes the checksum over header-before-checksum ‖ content, zero-padded to a byte
  boundary;
* pads the packet to a byte boundary;
* rejects, rather than guesses at, any version, type, comp, or enc value it does not
  implement, and reports `unsupported` while still skipping the packet correctly.

`SPAB.algorithm.frame` in the reference implementation is a machine-readable copy of
this specification, and the test suite asserts the implementation matches *it* rather
than the other way around. The type field went missing for the whole of 0.1–0.4
because the descriptor documented whatever the code happened to do; a description
that mirrors the implementation cannot catch the implementation drifting from the
spec.
