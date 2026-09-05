# spab roadmap

Work that is known, scoped, and not done. Kept here so it is tracked rather than
remembered. Items are ordered roughly by how much they change the wire format —
decoder-only changes are cheap, frame changes are not.

Status legend: **open** (not started), **partial** (some of it shipped), **done**.

## Payload handling

### Typed payloads — **done** (frame v1, unreleased)
The frame is now `[magic][ver][type][len][content][crc8]`. Type covers string / json
/ uuid / bytes / program / encrypted, with `0xFF` reserved in both the version and
type fields so the space can grow. Inferred when the caller does not say; explicit
`params.type` wins.

Two notes for whoever revisits this. The original design argued for **flag-coded**
types (a bit, not a byte) precisely because header bytes are expensive on short
passages — and the measured cost of the simpler layout is real: framing went from 3
to 5 bytes, so a 7-byte secret's frame grew 10 -> 12 bytes, about 20% more capacity
for the same payload. Moving to a varint later is exactly what the version field is
for. And it went missing in the first place because nothing tested it: the
`algorithm.frame` descriptor described the code rather than the spec, so the gap was
invisible. The descriptor is now the contract and `tests/branches.test.js` asserts
against it.

### Compact JSON encoding — **open**
JSON payloads are stored as their literal text, which is the least efficient
representation available: `{"r":"j.smith","case":42}` is 25 bytes of a 255-byte
budget. The intended pipeline is **JSON → compact binary → compress → ECC → carriers**.
A CBOR-shaped encoding plus a small dictionary for repeated keys should cut typical
metadata payloads by half or better. Needs the type field above so the decoder knows
to reverse it. Measure before committing: for payloads under ~40 bytes the framing
overhead of a compressor can exceed its saving.

### Encryption / authenticated payloads — **open**
`params.key` today whitens and interleaves the symbol stream. That is a cost
multiplier, not confidentiality, and the docs say so. A real AEAD (payload encrypted
and authenticated, key separate from the scramble) would make the "encrypted or not"
question meaningful — and needs the type field to be answerable by a decoder.

### Payloads over 255 bytes — **open**
The frame's length field is one byte. Longer messages are **silently truncated**:
they encode cleanly and decode to a *different* string, which callers can only
detect by comparing `metadata.payloadBytes` against their own message length. Either
make it an explicit error or widen the field (frame change). Silent truncation is
the wrong default whichever way it goes.

## Robustness

### Redundancy sizing beyond auto-grow — **partial**
`redundancy` currently only shapes how far `autoGrow` inflates a passage. It does
not apply to substitution-only encoding, where redundancy is whatever capacity
happens to allow. A caller who wants "three copies or tell me it will not fit"
cannot ask for that today.

### Keyed marks cannot tolerate a change in carrier count — **open**
The keyed interleave permutation is derived from the digit count, so *any* change to
the number of carriers — including appending text at the end, which is otherwise
harmless — descrambles to noise. Resynchronisation is disabled when a key is set for
this reason. A key-derived permutation over fixed-size blocks rather than the whole
stream would make keyed marks resynchronisable. Caught by `tests/noise.test.js`.

### NFKC survival needs more confusable capacity — **open**
"How it works" says the payload survives normalization via the apostrophe and hyphen
channels. In practice those channels are tiny: carrying a 7-byte secret through NFKC
alone needs ~80 apostrophes and hyphens, and measured prose has 8–26 sites. It
survives only for very small payloads in long, punctuation-heavy text. Either find
more NFKC-durable carriers or state the limit more precisely than the current table
does.

### Whitespace variants are visible in proportional type — **open**
Thin, hair and six-per-em spaces are narrower than a plain space, so a marked
paragraph sets about 3% narrower than its source (measured: -3.26% system-ui,
-2.13% Georgia, 0.00% ui-monospace). Documented on the site. A carrier set chosen
for equal advance width would remove the tell at some cost in capacity.

## Tooling

### Recovery benchmark in CI — **open**
`r_and_d/harness.js` produces recovery-by-model numbers and is run as a smoke test
only. Tracking those numbers over time — even as a report, not a gate — would show
robustness regressions that the pass/fail suites cannot.

### Language ports — **open**
`src/python`, `src/rust`, `src/c_cpp`, `src/java`, `src/swift` are skeletons. The
conformance vectors that a port must satisfy live in `tests/`; the JS implementation
is the reference.
