# Making spab World-Class: Architecture Recommendations After the Sliding Histogram Receiver

**Working design note — September 2026**

This note assumes the current spab design described in our discussion:

- spab watermarks **already-existing text** rather than requiring text generation;
- multiple carrier classes can be used, including whitespace, punctuation, dense/insertion carriers, and potentially semantic/grammatical carriers;
- the decoder uses a **sliding histogram detector**: a window of length `n` advances one character at a time, compares the observed carrier histogram to possible symbol histograms, and therefore can reacquire after insertions/deletions;
- the output of the physical detector can be interpreted as a *probability/confidence over symbols*, not just a hard symbol;
- encoded information then flows upward through packet integrity, ECC and/or fountain strategies;
- a logical symbol or packet need not occupy one contiguous text block: its evidence can be **pseudo-randomly spread across `k` chunks** of the document;
- compression and encryption are optional payload transforms, useful when they improve capacity or confidentiality but separate from channel robustness.

The central architectural observation is:

> **spab is not fundamentally a Unicode steganography library. It is a communications system for a mutable symbolic medium.**

That framing suggests several ways to make it considerably stronger without turning it into a giant research project.

---

## 1. Start from the receiver spab already has

The sliding histogram detector changes the synchronization problem substantially.

A conventional positional watermarker effectively assumes:

```text
carrier 0 -> symbol 0
carrier 1 -> symbol 1
carrier 2 -> symbol 2
...
```

If one carrier site disappears, everything after it may shift.

spab instead looks at every possible length-`n` region:

```text
text:

.....[xxxxxxxxxxxxxxxx].........................
......[xxxxxxxxxxxxxxxx]........................
.......[xxxxxxxxxxxxxxxx].......................
........[xxxxxxxxxxxxxxxx]......................
         ^
       slide by one character
```

For each candidate window, compute the histogram of relevant carrier symbols and compare it with the allowed constellation.

Conceptually:

```text
function scan_histograms(text, n, constellation):
    H = histogram(text[0:n])
    output = []

    for pos in 0 .. len(text)-n:
        if pos > 0:
            H.remove(text[pos - 1])
            H.add(text[pos + n - 1])

        L = {}
        for symbol in constellation:
            L[symbol] = log_likelihood(
                observed_histogram = H,
                expected_histogram = constellation[symbol]
            )

        output.append({
            position: pos,
            symbol_likelihoods: normalize(L)
        })

    return output
```

An insertion before a marked region shifts the peak in position but does not permanently shift the receiver's clock. If the original signal was around characters 500–599 and seven characters are inserted before it, the receiver eventually examines approximately 507–606 and can rediscover the signal.

That means the output of the first stage should be thought of as a **likelihood field**:

\[
L(x,s) = P(s \mid \text{window beginning at }x)
\]

rather than immediately as a symbol stream.

This is an excellent foundation.

### Closest useful precedent

Davey and MacKay's insertion/deletion coding work is worth studying carefully. Their physical mechanism is different, but the layering is extremely relevant: an inner "watermark" code performs **probabilistic resynchronization**, passes **soft output** to an outer nonbinary LDPC code, and the outer code completes recovery. They explicitly attack insertion, deletion, and substitution errors rather than assuming symbol alignment.[1]

### Avoid

Do not turn every one-character-shifted window directly into an independent packet/symbol attempt. Adjacent windows overlap almost completely, so their errors and scores are heavily correlated.

---

# 2. Add a sequence/acquisition decoder over the likelihood field

The first major architectural improvement is to interpret the sliding detector as the front end of a synchronization/acquisition decoder.

A simple peak detector throws away structure. Better is to ask:

> Which sequence of candidate peaks is jointly most plausible as the transmitted watermark?

The state can include:

```text
state = {
    text_position,
    logical_symbol_index,
    local_drift,
    optional_pn_phase
}
```

Possible transitions include:

```text
NORMAL:
    advance text approximately expected distance
    advance logical symbol

INSERTION:
    advance text extra amount
    logical symbol unchanged or delayed

DELETION:
    advance logical symbol
    little/no matching text evidence

MISSING:
    expected symbol not observed -> erasure

SPURIOUS:
    ignore an isolated detector peak
```

A first implementation could be a dynamic program / Viterbi path:

```text
function acquire_sequence(field, expected_spacing):
    candidates = local_maxima(field)

    dp = map()
    back = map()

    for c in candidates:
        dp[c] = emission_score(c)

        for p in plausible_predecessors(c):
            spacing = c.position - p.position

            score =
                dp[p] +
                emission_score(c) -
                spacing_penalty(
                    spacing,
                    expected_spacing
                )

            if score > dp[c]:
                dp[c] = score
                back[c] = p

    end = argmax(dp)
    return traceback(back, end)
```

A more complete version can use an HMM/BCJR formulation and retain posterior probabilities rather than only the single best path.

### Why this helps

The sliding detector solves *local acquisition*. The sequence decoder solves *global consistency*.

It can reject:

- a random histogram that happens to resemble one constellation point;
- overlapping copies of the same physical signal;
- implausible jumps;
- isolated false peaks.

It can also label missing expected symbols as **erasures**, which is exactly what the upper coding layers want.

### Research support

Davey–MacKay is the best conceptual precedent: probabilistic resynchronization below an outer ECC.[1]

Synchronization-string research independently reinforces the principle that the ugly insertion/deletion problem should ideally be converted into ordinary indexed substitutions/erasures before normal ECC operates.[2][3]

### Avoid

Do not add a second independent synchronization system until the sliding detector + sequence decoder has been characterized. Explicit synchronization strings are elegant, but they cost carrier entropy and may simply duplicate something the sliding receiver already does well.

---

# 3. Make pseudo-random spreading a first-class layer

The idea that `n` contiguous characters represent exactly one logical symbol should *not* be fundamental.

Instead, distinguish:

```text
physical carrier site
    ↓
chip / local histogram observation
    ↓
logical modem symbol
    ↓
inner-coded packet
    ↓
fountain packet
    ↓
message
```

A logical symbol can accumulate evidence from `k` spatially separated chunks.

For a binary example, let a keyed pseudo-noise sequence be:

```text
PN = [+1, -1, +1, +1, -1, -1, +1, -1]
```

To transmit logical value `b ∈ {-1,+1}`:

```text
function spread_symbol(bit, symbol_id, K, key):
    pn = pn_sequence(key, symbol_id, K)
    chips = []

    for i in 0 .. K-1:
        chips.append(bit * pn[i])

    return chips
```

Each chip becomes a small histogram bias in a separate text region.

Decoder:

```text
function despread_symbol(observations, symbol_id, K, key):
    pn = pn_sequence(key, symbol_id, K)

    correlation = 0
    weight_sum = 0

    for obs in surviving(observations):
        w = obs.confidence

        correlation += (
            w *
            pn[obs.chip_index] *
            obs.signed_evidence
        )

        weight_sum += w

    if weight_sum == 0:
        return ERASURE

    return {
        value: sign(correlation),
        confidence: abs(correlation) / weight_sum
    }
```

Now deletion of one paragraph may destroy several chips without destroying the logical symbol.

This gives another layer of integration gain:

```text
glyph variation
    ↓
histogram integration
    ↓
chip likelihood
    ↓
PN despreading/integration
    ↓
logical symbol likelihood
```

### Why it belongs below packet ECC

The purpose of spreading is to convert **localized physical damage** into smaller reductions in evidence across several logical symbols.

ECC should see the resulting soft logical symbols, not individual glyph edits.

### Precedent

Spread-spectrum watermarking in multimedia deliberately distributes watermark energy across many host components so that local or partial distortion does not directly erase the watermark. The classic Cox et al. work is useful background even though text has very different carriers.[4]

### Avoid

Do not use raw absolute character offsets as the pseudo-random address space:

```text
PRNG(seed) -> chars 104, 911, 3014, ...
```

One insertion before position 104 shifts every later location.

Placement should be expressed relative to decoder-discoverable regions, logical candidate slots, local anchors, or PN phase recovered from the detector.

---

# 4. Use hierarchical spreading so excerpts still work

Global spreading creates a tradeoff.

If all chips for all symbols are uniformly spread through a 30-page document, a two-page excerpt might contain 10% of every packet but **zero complete/recoverable packets**.

Use at least two spatial scales:

```text
DOCUMENT
│
├── tile A
│     └── local PN spread
│
├── tile B
│     └── local PN spread
│
├── tile C
│     └── local PN spread
│
└── tile D
      └── local PN spread

fountain packets distributed across tiles
```

Pseudo:

```text
function encode_document(frame, cover, profile):
    tiles = choose_tiles(
        cover,
        target_excerpt_length = profile.excerpt_target
    )

    packets = fountain_encode(frame, profile.fountain)

    for packet in packets:
        tile = choose_tile(packet.esi, tiles)

        inner = inner_encode(packet)

        for symbol in modem_symbols(inner):
            chips = spread_symbol(
                symbol,
                symbol.id,
                profile.K,
                profile.key
            )

            slots = choose_local_slots(
                tile,
                symbol.id,
                count = profile.K
            )

            embed_chips(slots, chips)
```

Decoder:

```text
function decode_document(text):
    packets = []

    for tile_candidate in discover_tiles(text):
        field = sliding_histogram_detector(tile_candidate)

        observations = acquire(field)

        soft_symbols = despread(observations)

        packet_candidates = inner_decode(soft_symbols)

        for packet in packet_candidates:
            if packet.integrity_ok:
                packets.append(packet)

        if fountain_rank(packets) >= needed_rank:
            frame = fountain_solve(packets)

            if frame_integrity(frame):
                return frame

    return NOT_RECOVERED
```

### What this buys

Three distinct damage mechanisms get three distinct defenses:

| Damage | Primary defense |
|---|---|
| salt-and-pepper carrier edits | histogram integration |
| localized deletion/replacement | PN/chip spreading |
| whole-region/carrier disappearance | fountain/outer code |

### Avoid

Do not pick a single global spreading depth and call it "robustness." The optimum depends on expected excerpt size, burst length, cover length, and payload size. Make spreading depth a profile parameter and measure the surface.

---

# 5. Exploit encoder-only knowledge: host-aware embedding

This may be the largest conceptual improvement available on the encoding side.

The encoder sees the entire original document. The decoder does not need to know which possible sites were safe or cheap to modify.

Every candidate site should expose more than:

```text
available = true
states = [...]
```

It should expose:

```text
CarrierOpportunity {
    location
    states[]
    distortion_cost[state]
    estimated_survival[state]
    semantic_risk[state]
    visual_risk[state]
}
```

Pseudo:

```text
function analyze_site(site, channel_profile):
    options = carrier.valid_states(site)

    result = []

    for state in options:
        result.append({
            state: state,

            distortion:
                visual_cost(site, state) +
                style_cost(site, state) +
                semantic_cost(site, state),

            survival:
                estimate_survival(
                    carrier.type,
                    state,
                    channel_profile
                )
        })

    return result
```

Then embedding becomes an optimization:

```text
function shape_block(sites, target_symbol):
    target = constellation[target_symbol]

    best_solution = NONE

    search over feasible site changes:
        candidate_hist = resulting_histogram(changes)

        margin =
            detector_margin(
                candidate_hist,
                target,
                constellation
            )

        cost =
            sum(change.distortion)

        if margin >= REQUIRED_MARGIN:
            best_solution = min_cost(
                best_solution,
                changes
            )

    apply(best_solution)
```

The general objective is:

\[
\min \sum_i \rho_i(\text{chosen state})
\]

subject to the required encoded message/detection margin.

### Strong precedent: wet-paper coding

Wet-paper coding was created for embedding where the sender knows which positions are safely modifiable but the receiver does not share that selection channel. It explicitly exploits arbitrary encoder-side information.[5]

That maps very naturally onto text, where:

- one apostrophe replacement may be harmless;
- another may be stylistically odd;
- one grammar transformation may be perfectly natural;
- another should be "wet" / forbidden.

### Strong precedent: syndrome-trellis codes

Syndrome-trellis codes formulate embedding as a minimum-distortion problem: each possible cover modification gets a cost, and the encoder finds a representation satisfying the payload while minimizing total distortion. The published method supports binary and nonbinary embedding and is a mature steganographic approach.[6][7]

### Avoid

Do not assume:

> "carrier site exists" == "all carrier states are equally safe."

That is increasingly false as spab adds punctuation and especially semantic carriers.

---

# 6. Make histogram modulation host-relative

Absolute constellation points are easy to reason about but may create a detectable statistical signature.

For example, a four-state space carrier might use:

```text
S0 = [0.70, 0.10, 0.10, 0.10]
S1 = [0.10, 0.70, 0.10, 0.10]
S2 = [0.10, 0.10, 0.70, 0.10]
S3 = [0.10, 0.10, 0.10, 0.70]
```

Those are well separated, but natural text may have:

```text
host = [0.97, 0.01, 0.01, 0.01]
```

A detector could spot spab statistically even when humans cannot.

Instead consider a **host-relative constellation**:

```text
function target_histogram(original_hist, symbol, profile):
    modulation_axis =
        profile.axes[symbol]

    target =
        original_hist +
        profile.strength * modulation_axis

    return project_to_simplex(target)
```

Or more generally:

```text
host_projection = project(original_hist)

target =
    nearest_code_coset_point(
        host_projection,
        desired_symbol
    )
```

The important idea is:

> Encode a controlled displacement from the natural host statistics rather than force every document toward globally identical histograms.

### Precedent: QIM

Quantization Index Modulation (QIM) is foundational watermarking work that treats embedding as choosing among quantizers/codebooks while accounting for the host. The theory explicitly considers rate, distortion, and robustness tradeoffs.[8][9]

spab's histogram simplex is not the same mathematical channel, but a **QIM-like host-relative quantization of histogram space** is worth exploring.

### Avoid

Do not use the word QIM in a paper unless the implemented operation really maps cleanly to QIM theory. "QIM-inspired host-relative constellation" is safer until the mathematics is formalized.

---

# 7. Preserve soft information through the inner decoder

If the sliding histogram detector reports:

```text
S0: 0.02
S1: 0.71
S2: 0.22
S3: 0.05
```

do not immediately collapse that to:

```text
S1
```

Likewise the PN despreader should produce likelihood/confidence, not only a bit.

Pseudo:

```text
function modem_to_llr(symbol_probabilities):
    # binary example
    p0 = probability(bit = 0)
    p1 = probability(bit = 1)

    return log((p0 + EPS) / (p1 + EPS))
```

For M-ary symbols:

```text
function symbol_log_probs(chip_evidence):
    scores = despread_soft(chip_evidence)
    return log_softmax(scores)
```

Then:

```text
function decode_packet(soft_symbols):
    candidates =
        soft_inner_ecc_decode(
            soft_symbols,
            list_size = L
        )

    for candidate in candidates:
        if packet_crc(candidate):
            return candidate

    return ERASURE
```

### Why

These observations are very different:

```text
P(0)=0.51  P(1)=0.49
```

and

```text
P(0)=0.999 P(1)=0.001
```

A hard decoder calls both `0`.

A good decoder knows the first one is almost an erasure.

### Precedent

Soft decoding of Raptor/rateless constructions has been studied because hard erasure decoding discards useful channel information. Soft iterative Raptor decoding can use demodulator likelihoods through inner and outer graph components.[10]

### Avoid

Do not make the fountain solver itself absorb arbitrary unreliable equations unless it has a principled reliability model. A bad fountain equation is more dangerous than a missing equation.

---

# 8. Separate inner error correction from the outer fountain

This split fits spab extremely well.

Use:

```text
histogram / spread receiver
        ↓
soft logical symbols
        ↓
INNER CODE
        ↓
CRC / packet integrity
        ↓
good packet OR erasure
        ↓
OUTER FOUNTAIN
        ↓
message
```

The inner code handles:

- substitutions;
- uncertain modem decisions;
- small distributed corruption.

The outer fountain handles:

- lost packets;
- killed carrier classes;
- deleted regions;
- excerpting.

Pseudo:

```text
function transmit_packet(packet):
    coded_bits = inner_ecc.encode(packet.bytes)
    symbols = modem.map(coded_bits)
    return spread(symbols)
```

```text
function receive_packet(observations):
    soft_bits = modem.soft_decode(observations)

    candidate =
        inner_ecc.soft_decode(soft_bits)

    if not crc_valid(candidate):
        return ERASURE

    return candidate
```

Then:

```text
while packets_available:
    p = receive_packet(...)

    if p != ERASURE:
        fountain.add(p)

    if fountain.full_rank():
        candidate = fountain.solve()

        if frame_integrity(candidate):
            return candidate
```

### Why this is architecturally clean

It deliberately converts:

```text
messy text channel
```

into:

```text
mostly-correct packets + explicit erasures
```

which is the channel fountain codes are naturally good at.

### Avoid

Do not select an inner code because it is fashionable. Benchmark short BCH/RS variants, convolutional codes, LDPC-like options, and even repetition. For short watermarks and weird error distributions, simple codes may win.

---

# 9. Improve fountain packet geometry

If the current fountain mode codes one source byte per RLNC equation and spends substantial ESI/integrity overhead per byte, retain that implementation as a correctness/reference baseline but add vector symbols.

Instead of:

```text
[ESI][1 coded byte][CRC]
[ESI][1 coded byte][CRC]
...
```

use:

```text
[ESI][8 or 16 coded bytes][CRC16]
```

Pseudo:

```text
function rlnc_encode_vector(source_blocks, esi):
    coeffs = derive_coefficients(esi)

    out = zero_vector(SYMBOL_BYTES)

    for j in 0 .. K-1:
        out ^= gf256_multiply_vector(
            coeffs[j],
            source_blocks[j]
        )

    return {
        esi: esi,
        data: out,
        crc: crc16(esi || out)
    }
```

Make symbol size adaptive:

```text
if payload very small:
    rlnc_symbol_bytes = 1..4

elif cover is constrained:
    rlnc_symbol_bytes = 8..16

else:
    choose from benchmark profile
```

### Avoid

Do not make packets so large that one localized corruption throws away a huge fraction of useful information. Packet geometry is another **rate vs erasure-granularity** knob.

---

# 10. Make fountain admission reliability-aware

A false equation can poison a linear solve.

The receiver should prefer:

```text
missing packet
```

to:

```text
wrong packet accepted as valid
```

Possible strategy:

```text
function admit_packet(candidate):
    if not packet_crc(candidate):
        return REJECT

    if candidate.confidence < MIN_CONF:
        return HOLD

    return ACCEPT
```

For difficult decodes:

```text
function robust_fountain_solve(packet_pool):
    ordered =
        sort_by_confidence_desc(packet_pool)

    for size in K .. min(len(ordered), K + EXTRA):
        subset = ordered[0:size]

        frame = try_solve(subset)

        if frame and frame_integrity(frame):
            return frame

    # optional: remove suspicious equations
    for suspect in lowest_confidence(ordered):
        frame = try_solve(ordered - suspect)

        if frame and frame_integrity(frame):
            return frame

    return FAIL
```

### Avoid

Do not rely on CRC8 chance rejection once the search space becomes huge. Sliding windows × profiles × phases × packet hypotheses creates many opportunities for false packet candidates. Stronger packet integrity becomes cheaper once vector packets are larger.

---

# 11. Add channel estimation using pilots

A text transformation may distort different carrier states asymmetrically.

Suppose a channel behaves approximately like:

```text
space A -> A 99%
space B -> B 65%, A 35%
space C -> A 95%
space D -> D 85%, B 15%
```

The receiver should not compare observed histograms only to the *transmitted* constellation. It should compare them to the constellation **after the estimated channel**.

Embed occasional known pilots.

Pseudo:

```text
function estimate_channel(pilot_observations):
    channel = {}

    for carrier in carrier_classes:
        matrix =
            zeros(
                carrier.tx_states,
                carrier.rx_states
            )

        for pilot in pilot_observations[carrier]:
            accumulate_transition_counts(
                matrix,
                pilot.known_tx_histogram,
                pilot.observed_rx_histogram
            )

        channel[carrier] =
            normalize_rows(matrix)

    return channel
```

Then:

```text
function score_symbol(H_rx, symbol, channel):
    H_tx = constellation[symbol]

    H_expected_rx =
        apply_channel_model(H_tx, channel)

    return multinomial_log_likelihood(
        H_rx,
        H_expected_rx
    )
```

The same pilots can estimate carrier-class reliability:

```text
quality.ws      = 0.18
quality.apos    = 0.93
quality.hyphen  = 0.74
quality.semantic= 0.88
```

### Why

This lets a decoder adapt when:

- whitespace was partially normalized;
- smart quotes were canonicalized;
- a Unicode carrier was entirely stripped.

### Avoid

Do not overspend capacity on pilots. Because spab has repeated text opportunities, a small pilot/control signal repeated periodically may be enough.

---

# 12. Combine carrier classes at two different levels

spab can benefit from both:

1. **packet-level diversity**, and
2. **soft symbol-level diversity**.

Packet-level:

```text
whitespace -> packet 17
apostrophe -> packet 42
semantic   -> packet 103

all valid packets -> fountain
```

Soft-level when several carriers represent the same logical chip:

```text
function fuse_carrier_evidence(observations, quality):
    total = zero_log_probs(NUM_SYMBOLS)

    for carrier, evidence in observations:
        w = quality[carrier]

        for s in symbols:
            total[s] += (
                w *
                evidence.log_probability[s]
            )

    return normalize_log_probs(total)
```

This resembles diversity combining: an unhealthy carrier contributes little; a strong one contributes more.

### 2-D view

Think of a document as:

| Spatial region | whitespace | punctuation | semantic | other |
|---|---:|---:|---:|---:|
| A | evidence | evidence | evidence | evidence |
| B | evidence | evidence | evidence | evidence |
| C | evidence | evidence | evidence | evidence |

A paragraph deletion removes a **row**.

Whitespace normalization removes a **column**.

A strong design spreads information over both dimensions.

### Avoid

Do not force all carrier types through identical block geometry. Semantic sites may be sparse and content-addressed while whitespace is dense and positional.

---

# 13. Add a tiny, extremely robust control plane

Bootstrap/configuration data is more important than ordinary payload data.

A decoder may need to learn:

- protocol generation;
- carrier/profile family;
- modulation mode;
- packet/fountain generation identifier;
- perhaps block/spreading parameters.

Protect this separately.

```text
CONTROL PLANE:
    tiny
    fixed/simple modulation
    low rate
    repeated
    cross-carrier where possible
    heavy ECC

DATA PLANE:
    adaptive
    higher rate
    fountain
    optional semantic carriers
```

Pseudo:

```text
function encode_control(config):
    raw = serialize_minimal_config(config)

    coded =
        very_strong_small_code(raw)

    return repeat_and_spread(
        coded,
        across = ROBUST_CARRIERS
    )
```

Decoder:

```text
function acquire_control(text):
    candidates =
        conservative_control_scan(text)

    control =
        soft_combine_and_decode(candidates)

    if not control.integrity_ok:
        return NOT_DETECTED

    return control
```

Then configure the data decoder.

### Precedent

This is a form of **unequal error protection**: allocate more protection to the small portions whose loss is catastrophic. UEP is common communications engineering; RFC 5109 is one concrete example where unequal FEC strength is used for differently important media data.[11]

### Avoid

Do not make the control record large. Anything that can be inferred or tried from a small bounded profile set should remain out of the control channel.

---

# 14. Make payload recovery progressive

Not every payload bit has equal value.

A useful watermark might contain:

```text
L0: 64-bit document/fingerprint ID
L1: provenance/authentication data
L2: structured metadata
L3: optional bulk message
```

Protect layers differently.

Pseudo:

```text
layers = [
    {
        data: document_id,
        protection: VERY_HIGH
    },
    {
        data: provenance,
        protection: HIGH
    },
    {
        data: metadata,
        protection: MEDIUM
    },
    {
        data: bulk,
        protection: NORMAL
    }
]

for layer in layers:
    encode_layer(
        layer.data,
        fountain_overhead =
            protection_to_overhead(layer.protection)
    )
```

Decoder can return:

```text
identity: recovered
provenance: recovered
metadata: not recovered
bulk: not recovered
```

rather than just failure.

This is particularly valuable for excerpts.

### Avoid

Do not confuse progressive payload with truncating cryptographic authentication arbitrarily. Define the layers cryptographically and structurally so each recoverable layer can be validated independently.

---

# 15. Treat synchronization strings as an experimental comparator

Synchronization strings are worth implementing as an R&D strategy row, not necessarily as the production architecture.

They attach indexing information that lets insertion/deletion corruption be transformed into conventional substitution/erasure errors. Modern synchronization-string work gives near-optimal insdel coding constructions and efficient reductions of synchronization errors to ordinary symbol errors.[2][3]

Conceptual experiment:

```text
for i in 0 .. num_symbols-1:
    tx.append({
        sync: sync_string[i],
        data: payload_symbol[i]
    })
```

Decode:

```text
sync_observations =
    sliding_detector(...)

estimated_indices =
    sync_decode(sync_observations)

for obs in data_observations:
    place obs at estimated_indices[obs]

missing indices -> ERASURE

outer_decode(...)
```

### Why benchmark it

If it beats sliding acquisition + PN phase recovery under realistic text channels, use it.

If not, it is useful prior art demonstrating why spab's statistical acquisition is a better fit.

### Avoid

Do not add it solely because it has better worst-case theoretical guarantees. Your real channel is structured, carrier-dependent, and far from an arbitrary adversarial finite-alphabet insdel stream.

---

# 16. Add a semantic/grammar carrier as another physical channel

A semantic layer makes sense if it obeys the same modem interface rather than becoming a separate ML watermark product.

Potential transformations:

- vetted synonym choices;
- contraction/non-contraction;
- optional discourse markers;
- grammar-neutral punctuation;
- phrase ordering;
- limited syntax transformations with strong equivalence checks.

The carrier interface should still return:

```text
{
    canonical_anchor,
    possible_states,
    distortion_costs,
    observed_state_likelihood
}
```

Encoder:

```text
function semantic_opportunities(sentence):
    parse = parse(sentence)

    opportunities = []

    for transform in SAFE_TRANSFORMS:
        if not transform.applies(parse):
            continue

        variants =
            transform.generate(parse)

        variants =
            filter_semantic_equivalence(variants)

        variants =
            filter_fluency(variants)

        if count(variants) >= 2:
            opportunities.append({
                anchor:
                    canonical_content_anchor(
                        sentence,
                        transform
                    ),

                variants: variants,

                costs:
                    score_distortion(variants)
            })

    return opportunities
```

Decoder:

```text
function read_semantic_site(text_region):
    parse = parse(text_region)

    site =
        recognize_canonical_transform(parse)

    if not site:
        return NO_OBSERVATION

    return {
        anchor: site.anchor,
        symbol_likelihoods:
            classify_variant(site)
    }
```

### Important: content-address it

Do **not** use:

```text
first synonym occurrence  -> next bit
second synonym occurrence -> next bit
...
```

One added word then shifts the whole stream.

Use stable local context:

```text
anchor =
    hash(
        normalized neighboring words,
        syntactic relation,
        transform class
    )
```

Then losing one semantic site produces an erasure, not global desynchronization.

### Precedent

Chang and Clark's contextual synonym-substitution work explicitly addressed practical synonym applicability and ambiguity, using corpus context checks plus graph/vertex coding to ensure deterministic bit interpretation across synonym sets.[12]

Related linguistic steganography literature also explores word order and paraphrase transformations. The key lesson is that semantic carrier quality has to be evaluated in context, not from a flat synonym dictionary.[13]

### Avoid

Do not make LLM inference mandatory for base spab decoding if portability, deterministic behavior, and zero dependencies remain design goals. A richer `spab-ml` companion layer can generate/validate semantic sites while the core wire/coding architecture stays deterministic.

---

# 17. Make false-alarm probability a first-class metric

The sliding detector may examine tens or hundreds of thousands of candidate windows per document.

If several profiles, symbol constellations, PN phases, and packet hypotheses are searched, there are enormous numbers of opportunities for accidental matches.

Therefore the meaningful false-positive metric is not:

\[
P(\text{false symbol in one window})
\]

but:

\[
P(\text{decoder reports a valid spab payload}
  \mid \text{whole unmarked document})
\]

Calibrate empirically.

Pseudo:

```text
function calibrate_false_alarm(unmarked_corpus):
    document_maxima = []

    for doc in unmarked_corpus:
        result =
            scan_all_supported_profiles(doc)

        document_maxima.append(
            result.maximum_detection_statistic
        )

    return empirical_quantiles(
        document_maxima
    )
```

Then measure:

```text
false positive per document
false positive per million characters
false positive per profile searched
false valid packet rate
false accepted frame rate
```

Use final frame integrity/MAC as the strongest acceptance criterion.

### Avoid

Do not quote a per-window false-positive probability and multiply by the number of windows as if adjacent sliding windows were independent. They are strongly correlated. Measure the maximum statistic over complete unmarked documents directly.

---

# 18. Add detectability/steganalysis to the objective

A watermark can be invisible to humans while statistically obvious to software.

Every profile should eventually be evaluated across three axes:

\[
\boxed{\text{rate}}
\qquad
\boxed{\text{robustness}}
\qquad
\boxed{\text{detectability/distortion}}
\]

Pseudo:

```text
function evaluate_profile(original, encoded, channel_suite):
    return {
        raw_rate:
            payload_bits / visible_chars,

        robust_rate:
            recovered_payload_bits(
                encoded,
                channel_suite
            ) / visible_chars,

        edit_distortion:
            carrier_change_cost(
                original,
                encoded
            ),

        visual_distortion:
            render_difference(
                original,
                encoded
            ),

        steganalysis_score:
            detector_probability(encoded)
    }
```

For a fixed payload, optimize something like:

\[
J =
\lambda_r(\text{recovery})
-
\lambda_d(\text{distortion})
-
\lambda_s(\text{detectability})
\]

### Precedent

Syndrome-trellis-code work explicitly optimizes embedding distortion for a fixed payload.[6]

QIM literature explicitly treats watermark design as a rate/distortion/robustness problem.[8]

### Avoid

Do not train only one steganalyzer and optimize against it indefinitely. That risks overfitting the encoder to a particular detector rather than preserving natural text statistics generally.

---

# 19. Add deliberate channel estimation to the test harness

The corruption harness should not only say:

```text
recovered = yes/no
```

It should characterize *how* the channel changed the carrier.

For each trial capture:

```text
carrier sites before
carrier sites after
variant transition matrix
symbol likelihood distributions
acquisition offset/drift
chip survival
inner ECC corrections
packet accepted/rejected
fountain rank
frame verification
```

Pseudo:

```text
result = {
    channel: attack.name,

    physical: {
        sites_tx,
        sites_rx,
        transition_matrix,
        insertions,
        deletions
    },

    modem: {
        symbol_errors,
        erasures,
        confidence_histogram
    },

    packet: {
        valid,
        rejected,
        false_candidates
    },

    fountain: {
        equations,
        rank,
        excess_rank
    },

    final: {
        recovered,
        false_accept
    }
}
```

This will make failures explainable and help select architecture rather than merely tune a success percentage.

---

# 20. Use a proper benchmark surface, not one "robustness score"

The fundamental function is approximately:

\[
P(\text{correct decode} \mid
    L, P, C, M, E, S)
\]

where:

- `L` = cover length / carrier opportunities;
- `P` = payload size;
- `C` = corruption/channel;
- `M` = modulation profile;
- `E` = ECC/fountain profile;
- `S` = spreading geometry.

Report slices such as:

```text
payload = 64 bits

cover length:
500 words
1000 words
2000 words
5000 words

attacks:
0..30% random symbol corruption
0..50% block deletion
head truncation
tail truncation
middle excerpt
NFKC
smart quote
copy/paste
render/PDF/extract
sentence reorder
```

The useful result is a family of curves, not:

```text
spab robustness = 91%
```

### Avoid

Do not average fundamentally different attacks into one headline number unless the exact weighting is stated and justified.

---

# 21. Keep multi-language conformance part of the architecture

If spab is meant to be a portable codec, the language ports should implement a **normative format**, not translate the JS implementation line-by-line.

Golden vectors should include:

```text
JS encode -> Python decode
Python encode -> Rust decode
Rust encode -> Swift decode
Swift encode -> C decode
...
```

For every important combination:

- wire version;
- payload type;
- carrier profile;
- checksum;
- compression;
- encryption;
- ECC;
- fountain parameters;
- PN sequence;
- histogram constellation;
- Unicode edge cases.

Pseudo CI:

```text
for vector in golden_vectors:
    for encoder in ports:
        output = encoder.encode(vector.input)

        assert output == vector.expected_encoding

        for decoder in ports:
            decoded = decoder.decode(output)

            assert decoded == vector.payload
```

If random nonces are allowed:

```text
deterministic test vectors:
    nonce explicitly supplied

production secure mode:
    nonce generated securely
```

### Avoid

Do not allow each language's default Unicode iteration model to define the protocol accidentally. Specify whether algorithms operate on UTF-8 bytes, Unicode scalar values, grapheme clusters, or explicitly defined carrier sites.

---

# 22. Keep collusion-resistant fingerprints above the modem

If spab eventually issues unique copies to many recipients, ordinary payload ECC does not solve collusion.

Two recipients can compare differently marked copies and combine them.

This belongs in an optional upper layer:

```text
recipient
    ↓
fingerprint code
    ↓
fingerprint payload
    ↓
spab
```

Pseudo:

```text
fingerprint =
    traitor_code.issue(recipient_id)

marked_text =
    spab.encode(
        text,
        payload = fingerprint
    )
```

Later:

```text
observed =
    spab.decode(leaked_text)

suspects =
    traitor_code.accuse(observed)
```

Tardos-style fingerprint codes are classic collusion-resistant constructions and are worth considering if leak tracing becomes a serious spab use case.[14]

### Avoid

Do not put collusion coding inside the physical modem. It is application-layer semantics.

---

# 23. Recommended target architecture

Putting the pieces together:

```text
                         APPLICATION PAYLOAD
                                  │
                    progressive / typed framing
                                  │
                  compression? / encryption?
                                  │
                        unequal protection
                                  │
                         source symbols
                                  │
                         OUTER FOUNTAIN
                                  │
                        fountain packets
                                  │
                           INNER ECC
                                  │
                         modem symbols
                                  │
                        PN CHIP SPREADING
                                  │
                 host-aware placement/embedding
                                  │
            ┌────────────┬────────────┬─────────────┐
            │            │            │             │
        whitespace   punctuation   semantic      dense/ZW
            │            │            │             │
            └────────────┴────────────┴─────────────┘
                                  │
                                TEXT
                                  │
                         CHANNEL / EDITING
                                  │
                sliding histogram detector
                   (one-character stride)
                                  │
                      likelihood field L(x,s)
                                  │
                 acquisition / timing decoder
                       + optional PN phase
                                  │
                       soft chip evidence
                                  │
                          DESPREADING
                                  │
                       soft modem symbols
                                  │
                        INNER ECC decode
                                  │
                       packet integrity gate
                                  │
                       packet or ERASURE
                                  │
                         OUTER FOUNTAIN
                                  │
                     frame integrity / auth
                                  │
                               PAYLOAD
```

This architecture deliberately gives different jobs to different layers:

| Layer | Primary job |
|---|---|
| carrier | provide semantically/visually acceptable states |
| histogram | absorb small local carrier corruption |
| sliding acquisition | recover from shifts/insertions/deletions |
| PN spreading | convert localized burst damage into weak distributed damage |
| inner ECC | repair wrong/uncertain logical symbols |
| packet integrity | turn untrustworthy packets into erasures |
| fountain | recover from missing packets/regions/carrier classes |
| frame integrity | prevent false accepted payloads |
| progressive framing | preserve most valuable information under partial recovery |

---

# 24. What I would build next

If the goal is a world-class open implementation plus one solid inexpensive paper, I would prioritize experiments that establish the architecture rather than add many features.

## P0 — Preserve and expose the likelihood field

The physical detector should have a first-class API that exposes:

```text
position × symbol likelihood
```

not only decoded symbols.

This is prerequisite for almost everything else.

## P0 — Build sequence/acquisition decoding

Benchmark:

```text
peak picking
vs
Viterbi/HMM acquisition
```

under:

- insertion;
- deletion;
- burst editing;
- extra paragraphs;
- excerpts.

## P0 — Implement PN/chip spreading

Sweep:

```text
K = 1, 2, 4, 8, 16...
```

and:

```text
chunk size
tile size
spread depth
```

Measure block deletion and excerpt behavior.

## P1 — Inner ECC + outer fountain

Compare:

```text
repetition
BCH/short block
RS where aligned
LDPC-style if worthwhile
```

as inner codes while retaining fountain as the erasure layer.

## P1 — Host-aware embedding costs

Even a simple first model:

```text
normal whitespace   cost 1
punctuation         cost 2
unusual Unicode     cost 5
semantic transform  learned/manual cost
unsafe context      INF
```

would establish the abstraction.

## P1 — False-alarm corpus

Create a large clean corpus that is **never encoded** and run every decoder/profile against it.

This is essential evidence.

## P1 — Real application round trips

At minimum:

```text
Word
Google Docs
LibreOffice
Gmail
Outlook
Slack/Teams
browser clipboard
Markdown render/extract
HTML sanitization
PDF generate/extract
```

This closes the biggest evidence gap with Innamark.

## P2 — Channel estimation / pilots

Add after the base likelihood decoder is producing useful probabilities.

## P2 — Host-relative constellations

Compare absolute histogram constellations with host-relative/QIM-inspired schemes.

## P2 — Semantic carrier

Make it one additional carrier class and keep the core decoder model unchanged.

## P3 — Synchronization-string experiment

Use as a theory-grounded benchmark against your existing acquisition strategy.

---

# 25. What could make a spab paper interesting

A paper should not primarily claim:

> "we invented text watermarking."

That would be easy to dismiss; there is extensive prior work.

It should instead make a narrower claim:

> **Existing text watermarking is usefully modeled as communication through a heterogeneous symbolic channel with substitutions, carrier erasures, burst deletion, and synchronization errors. spab combines statistical histogram modulation, sliding blind acquisition, spatial spreading, carrier diversity, and layered error/erasure coding in one open portable system.**

A strong paper can make several measurable contributions:

1. **Channel model.** A concrete taxonomy of text corruption rather than one generic "editing attack."
2. **Sliding histogram acquisition.** Demonstrate recovery after carrier insertions/deletions.
3. **Spread logical symbols.** Show gain against burst corruption versus contiguous blocks.
4. **Layered coding.** Demonstrate inner error correction + packet integrity + outer fountain behavior.
5. **Carrier diversity.** Quantify whole-channel loss.
6. **Rate/robustness surface.** Show that text length can buy coding margin rather than only payload.
7. **False-alarm measurement.** Report document-level false detection on clean text.
8. **Open reproducible harness.** Publish every corruption test and corpus recipe.
9. **Real application testing.** Validate modeled channels against actual software.
10. **Cross-language conformance.** Demonstrate that this is a real wire/modem specification, not one script.

The paper becomes much stronger if the results show where spab **loses** as clearly as where it wins.

For example:

```text
VSRMark wins:
    pristine high-density capacity

Innamark wins:
    some application round trips / maturity

semantic watermark wins:
    complete paraphrase

spab wins:
    mixed ordinary editing
    burst loss
    carrier-class loss
    excerpt recovery
    payload flexibility
```

That reads as engineering rather than marketing.

---

# 26. Areas where spab should explicitly avoid overclaiming

A world-class project becomes more credible when its failure envelope is clear.

Do not claim:

- resistance to a knowledgeable attacker who deliberately canonicalizes every supported carrier;
- survival of complete human retyping unless a semantic carrier demonstrates it;
- survival of unrestricted LLM paraphrasing unless measured;
- indistinguishability from natural text without steganalysis evidence;
- cryptographic authenticity solely because a checksum passes;
- "any K RLNC packets" unless they are guaranteed linearly independent;
- raw bits/site as equivalent to robust useful capacity;
- superiority over competing libraries from simulator stand-ins alone.

Prefer claims like:

> "Under corruption profile X and cover distribution Y, payload Z recovered in N/M trials with zero false accepted frames over Q clean documents."

That is difficult to argue with.

---

# 27. References / useful prior art

**[1] Davey, M. C. and MacKay, D. J. C. — "Reliable Communication over Channels with Insertions, Deletions, and Substitutions."**  
IEEE Transactions on Information Theory 47(2), 2001. DOI: 10.1109/18.910582.  
Useful for: probabilistic resynchronization, soft-output inner decoder, outer ECC.  
https://doi.org/10.1109/18.910582

**[2] Haeupler, B. and Shahrasbi, A. — "Synchronization Strings and Codes for Insertions and Deletions — a Survey."**  
IEEE Transactions on Information Theory / arXiv:2101.00711.  
Useful for: converting synchronization errors into indexed substitution/erasure-type errors.  
https://arxiv.org/abs/2101.00711

**[3] Haeupler, B., Shahrasbi, A., Vitercik, E. — "Synchronization Strings: Channel Simulations and Interactive Coding for Insertions and Deletions."**  
ICALP 2018.  
https://doi.org/10.4230/LIPIcs.ICALP.2018.75

**[4] Cox, I. J. et al. — spread-spectrum watermarking work.**  
Useful for: distributing watermark evidence across host components rather than localizing a complete mark.  
Search starting point: DOI/publication records for Cox et al. spread-spectrum digital watermarking.

**[5] Fridrich, J., Goljan, M., Soukal, D. — "Wet Paper Codes with Improved Embedding Efficiency."**  
IEEE Transactions on Information Forensics and Security, 2006.  
Useful for: encoder-only knowledge of writable sites / non-shared selection channels.  
https://ws.binghamton.edu/fridrich/publications.html

**[6] Filler, T., Judas, J., Fridrich, J. — "Minimizing Additive Distortion in Steganography Using Syndrome-Trellis Codes."**  
IEEE Transactions on Information Forensics and Security 6(3), 2011. DOI: 10.1109/TIFS.2011.2134094.  
Useful for: minimum-distortion embedding with per-site costs; payload-limited and distortion-limited embedding.  
https://doi.org/10.1109/TIFS.2011.2134094

**[7] Binghamton Syndrome-Trellis Codes Toolbox.**  
Useful for: reference implementation and practical STC construction.  
https://dde.binghamton.edu/download/syndrome/

**[8] Chen, B. and Wornell, G. W. — "Quantization Index Modulation: A Class of Provably Good Methods for Digital Watermarking and Information Embedding."**  
IEEE Transactions on Information Theory 47(4), 2001. DOI: 10.1109/18.923725.  
Useful for: host-aware modulation; rate/distortion/robustness framing.  
https://doi.org/10.1109/18.923725

**[9] MIT Signals, Information, and Algorithms Laboratory — QIM publications/reference materials.**  
https://sia.mit.edu/publications/quantization-index-modulation-a-class-of-provably-good-methods-for-digital-watermarking-and-information-embedding/

**[10] Zhang, M. and Kim, S. — "Soft Decoding Method for Systematic Raptor Codes."**  
IET Communications, 2015. DOI: 10.1049/iet-com.2015.0100.  
Useful for: retaining soft demodulator evidence into rateless decoding.  
https://doi.org/10.1049/iet-com.2015.0100

**[11] RFC 5109 — RTP Payload Format for Generic Forward Error Correction / Unequal Level Protection.**  
Useful as a practical communications example of unequal error protection.  
https://www.rfc-editor.org/rfc/rfc5109

**[12] Chang, C.-Y. and Clark, S. — "Practical Linguistic Steganography using Contextual Synonym Substitution and a Novel Vertex Coding Method."**  
Computational Linguistics 40(2), 2014. DOI: 10.1162/COLI_a_00176.  
Useful for: context-sensitive synonym suitability and avoiding ambiguous synonym-to-bit mappings.  
https://aclanthology.org/J14-2006/

**[13] Chang/Clark linguistic steganography bibliography.**  
Includes work on word order, paraphrases, contextual substitution, and deletion.  
https://aclanthology.org/people/ching-yun-chang/

**[14] Tardos, G. — collusion-resistant fingerprinting / traitor tracing.**  
Useful only as an optional application-layer fingerprint mode, not as part of the spab modem.

---

# 28. Bottom line

The sliding histogram receiver means spab already has a much stronger answer to text synchronization than a conventional positional text watermarker.

The architecture worth pursuing is not:

```text
carrier symbols
    ↓
more repetition
```

It is:

```text
host-aware embedding
    ↓
weak distributed physical signal
    ↓
sliding statistical acquisition
    ↓
soft evidence
    ↓
PN/spatial integration
    ↓
inner error correction
    ↓
packet integrity -> erasures
    ↓
outer fountain
    ↓
verified payload
```

The most valuable improvements from here are therefore:

1. **turn the sliding detector output into a real likelihood field;**
2. **perform sequence/acquisition decoding instead of independent window decisions;**
3. **make PN/chip spreading a first-class layer;**
4. **use hierarchical/local spreading so excerpts remain useful;**
5. **exploit encoder-only host knowledge with minimum-distortion embedding;**
6. **retain soft information into an inner decoder;**
7. **use fountain coding strictly as the outer erasure layer;**
8. **estimate carrier/channel health from pilots;**
9. **build an ultra-robust control plane and progressive payload layers;**
10. **measure document-level false alarms and statistical detectability;**
11. **treat semantic/grammar modification as another soft carrier, not a parallel architecture;**
12. **publish the complete harness, failures, and cross-language vectors.**

If those pieces work empirically, spab's strongest contribution is not any one space character, ECC, or fountain code. It is the **composition of statistical modulation, blind synchronization, spatial diversity, heterogeneous carriers, and layered coding into a portable text-channel modem**.
