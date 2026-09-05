/*
 * spab.js — text watermark codec (reference implementation)
 *
 * Pluggable symbol library over a mixed-bit slot stream:
 *   - Carrier CLASSES, each contributing "sites" in the text that carry bits:
 *       ws     — inter-word space, 4 whitespace variants (2 bits/site)   [default]
 *       apos   — apostrophe/right-single-quote  U+0027 <-> U+2019 (1 bit) [opt-in]
 *       hyphen — hyphen-minus/Unicode hyphen     U+002D <-> U+2010 (1 bit) [opt-in]
 *     ('punct' is shorthand for apos+hyphen.)
 *   - All enabled classes' sites are merged in text order into one bit stream.
 *   - Framing: [magic 0xA5][len][content...][crc8].
 *   - ECC: repetition + majority vote across the whole stream.
 *
 * Default params ({}) = whitespace-only, identical to the 0.1.x baseline. Enable
 * confusables with params.classes:['ws','punct'] (or profile:'ws+punct'). The
 * confusable classes survive whitespace-only attacks (normalize/reflow/regex),
 * giving a second, strip-resistant channel. encode/decode must use the same classes.
 *
 * Works as a browser global (window.SPAB) and via CommonJS (module.exports).
 */
(function (root) {
  'use strict';

  // ---------- carrier classes ----------
  var SPACE_MAP = [String.fromCharCode(0x20), String.fromCharCode(0x2006), String.fromCharCode(0x2009), String.fromCharCode(0x200A)];
  var SPACE_NAMES = ['U+0020 space', 'U+2006 six-per-em', 'U+2009 thin', 'U+200A hair'];
  var WS_SET = {};
  SPACE_MAP.forEach(function (c, i) { WS_SET[c] = i; });

  function isWordChar(ch) { return !!ch && !/\s/.test(ch) && !(ch in WS_SET) && !(ch in ZW_SET); }

  // Dense length-preserving whitespace: 8 space variants => 3 bits per inter-word gap
  // (vs 2 for `ws`). Higher capacity, still no added characters; some variants differ
  // subtly in width, so it trades a little stealth for density. NFKC still collapses it.
  var WSDENSE_MAP = [0x20, 0x2009, 0x200A, 0x2006, 0x2005, 0x2004, 0x2008, 0x205F].map(function (c) { return String.fromCharCode(c); });
  var WSDENSE_SET = {};
  WSDENSE_MAP.forEach(function (c, i) { WSDENSE_SET[c] = i; });

  // Zero-width carrier (dense, INSERTED not substituted — StegCloak / 330k style):
  // a 4-symbol zero-width alphabet = 2 bits per inserted char. Highest capacity, but it
  // ADDS characters (text length grows; visible in a hex/byte view) and is NFKC-fragile.
  var ZW_CHARS = [0x200B, 0x200C, 0x200D, 0x2060]; // ZWSP, ZWNJ, ZWJ, WORD JOINER
  var ZW_STR = ZW_CHARS.map(function (c) { return String.fromCharCode(c); });
  var ZW_SET = {};
  ZW_STR.forEach(function (c, i) { ZW_SET[c] = i; });
  var ZW_DENSITY = 6; // default zero-width chars inserted per word gap (12 bits/gap)

  // Each class: radix (alphabet size = distinct symbols per site), bits (= floor(log2 radix),
  // kept for display/back-compat), detect(text)->[indices], read(text,i)->digit(0..radix-1),
  // glyph(digit)->char. The symbol modem (below) maps the ECC bit stream to/from these radices.
  var CLASS_DEFS = {
    ws: {
      radix: 4, bits: 2,
      detect: function (text) {
        var out = [];
        for (var i = 1; i < text.length - 1; i++) {
          var ch = text[i];
          if ((ch === ' ' || ch in WS_SET) && isWordChar(text[i - 1]) && isWordChar(text[i + 1])) out.push(i);
        }
        return out;
      },
      read: function (text, i) { var v = WS_SET[text[i]]; return v === undefined ? 0 : v; },
      glyph: function (v) { return SPACE_MAP[v & 3]; }
    },
    apos: {
      radix: 2, bits: 1,
      detect: function (text) {
        var out = [];
        for (var i = 0; i < text.length; i++) { var c = text.charCodeAt(i); if (c === 0x27 || c === 0x2019) out.push(i); }
        return out;
      },
      read: function (text, i) { return text.charCodeAt(i) === 0x2019 ? 1 : 0; },
      glyph: function (v) { return String.fromCharCode(v ? 0x2019 : 0x27); }
    },
    hyphen: {
      radix: 2, bits: 1,
      detect: function (text) {
        var out = [];
        for (var i = 0; i < text.length; i++) { var c = text.charCodeAt(i); if (c === 0x2D || c === 0x2010) out.push(i); }
        return out;
      },
      read: function (text, i) { return text.charCodeAt(i) === 0x2010 ? 1 : 0; },
      glyph: function (v) { return String.fromCharCode(v ? 0x2010 : 0x2D); }
    },
    // Dense length-preserving whitespace (substitution, 8 variants / radix 8).
    wsdense: {
      radix: 8, bits: 3,
      detect: function (text) {
        var out = [];
        for (var i = 1; i < text.length - 1; i++) {
          if ((text[i] in WSDENSE_SET) && isWordChar(text[i - 1]) && isWordChar(text[i + 1])) out.push(i);
        }
        return out;
      },
      read: function (text, i) { var v = WSDENSE_SET[text[i]]; return v === undefined ? 0 : v; },
      glyph: function (v) { return WSDENSE_MAP[v & 7]; }
    },
    // Dense zero-width (INSERTION, 2 bits per inserted char). kind:'ins' — encode inserts
    // a run of zero-width chars after each word gap; decode extracts every zero-width char.
    zwsp: {
      kind: 'ins', radix: 4, bits: 2,
      anchors: function (text) { return CLASS_DEFS.ws.detect(text); }, // insert after inter-word spaces
      // embed a flat digit stream (perGap zero-width chars per word gap).
      embed: function (text, digits, perGap) {
        var idx = this.anchors(text), run = {}, pos = 0;
        for (var a = 0; a < idx.length; a++) {
          var s = '';
          for (var k = 0; k < perGap; k++) { s += ZW_STR[digits[pos++] || 0]; }
          run[idx[a]] = s;
        }
        var outp = '';
        for (var i = 0; i < text.length; i++) { outp += text[i]; if (run[i] !== undefined) outp += run[i]; }
        return outp;
      },
      // recover the digit stream (every zero-width char, in order).
      extract: function (text) {
        var digits = [];
        for (var i = 0; i < text.length; i++) { var v = ZW_SET[text[i]]; if (v !== undefined) digits.push(v); }
        return digits;
      }
    }
  };

  // Default carrier set = whitespace + confusables (quote + hyphen), co-equal parallel
  // channels. Whitespace is dense but dies to NFKC normalization; the confusables
  // (U+0027/U+2019, U+002D/U+2010) survive NFKC — so together they cover orthogonal
  // channel-noise situations. Pass params.classes to override (e.g. ['ws'] only).
  var DEFAULT_CLASSES = ['ws', 'apos', 'hyphen'];
  function resolveClasses(params) {
    var ids = params && params.classes;
    if (!ids) {
      var p = params && params.profile;
      ids = (p === 'ws') ? ['ws'] : DEFAULT_CLASSES.slice();
    }
    var out = [];
    ids.forEach(function (id) { if (id === 'punct') { out.push('apos', 'hyphen'); } else out.push(id); });
    return out.filter(function (id) { return CLASS_DEFS[id]; });
  }

  // Merged, text-ordered list of sites across enabled classes: {i, id, bits}.
  // (Introspection/visualization; the codec uses independent per-class channels.)
  function getSites(text, params) {
    var ids = resolveClasses(params), sites = [];
    ids.forEach(function (id) {
      var def = CLASS_DEFS[id], locate = def.detect || def.anchors;
      locate(text).forEach(function (i) { sites.push({ i: i, id: id, bits: def.bits }); });
    });
    sites.sort(function (a, b) { return a.i - b.i; });
    return sites;
  }

  // Read one class's bit stream from its own sites (independent channel). Insert-kind
  // carriers (zero-width) recover their bits by extraction rather than site reads.
  function classDigits(text, id) {
    var def = CLASS_DEFS[id], digits;
    if (def.kind === 'ins') digits = def.extract(text);
    else { var idx = def.detect(text); digits = new Array(idx.length); for (var s = 0; s < idx.length; s++) digits[s] = def.read(text, idx[s]); }
    return digits;
  }
  function readClassBits(text, id, key, maxSites) {
    var def = CLASS_DEFS[id], digits = classDigits(text, id);
    if (key) digits = descramble(digits, def.radix, keySeed(key, id)); // invert keyed scramble
    return symbolsToBits(digits, filledRadices(digits.length, def.radix), maxSites);
  }

  // ---------- resynchronisation ----------
  // Inserting or deleting a carrier site (deleting a word usually collapses two
  // gaps into one) shifts the whole symbol stream. Blocks are cut from that stream
  // by index, so every block after the edit is cut one position off and decodes to
  // noise — which is why raising redundancy never helped: the extra copies were
  // shifted too. Re-cutting the grid at each phase restores the original block
  // boundaries for whatever follows the edit.
  //
  // Phases are tried on the RAW digit stream, and only when unkeyed: the keyed
  // scramble interleaves across the whole stream, so a shifted stream cannot be
  // descrambled and sweeping it would produce noise.
  var MAX_PHASE = 32;   // largest block length spab produces (radix-2 packs 32 sites)
  function phaseCount(key, n) { return key ? 1 : Math.min(MAX_PHASE, n); }
  function phaseBits(digits, ph, def, key, id, maxSites) {
    var d = ph ? digits.slice(ph) : digits;
    if (key) d = descramble(d, def.radix, keySeed(key, id));
    return symbolsToBits(d, filledRadices(d.length, def.radix), maxSites);
  }

  // ---------- GF(256) + systematic RLNC fountain (ecc:'rlnc') ----------
  // Rateless erasure code over GF(2^8). Packets are self-checking (CRC) and
  // self-locating (ESI), spread across all carrier channels; any K clean packets
  // reconstruct the payload, so surviving carriers cover for killed ones.
  var GF_EXP = new Uint8Array(512), GF_LOG = new Uint8Array(256);
  (function () { var x = 1; for (var i = 0; i < 255; i++) { GF_EXP[i] = x; GF_LOG[x] = i; x = (x << 1) ^ (x & 0x80 ? 0x11d : 0); x &= 0xff; } for (i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]; })();
  function gmul(a, b) { return (a && b) ? GF_EXP[GF_LOG[a] + GF_LOG[b]] : 0; }
  function ginv(a) { return GF_EXP[255 - GF_LOG[a]]; }
  function prng32(seed) { var a = seed >>> 0; return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; var t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return (t ^ (t >>> 14)) >>> 0; }; }
  // Coefficient row for encoding-symbol id `esi` given K source symbols.
  function rlncCoeffs(esi, K) {
    var r = new Uint8Array(K);
    if (esi < K) { r[esi] = 1; return r; }        // systematic
    var g = prng32(0x9E37 + esi);
    for (var j = 0; j < K; j++) r[j] = g() & 0xff; // repair
    return r;
  }
  function rlncValue(source, esi) { var K = source.length, c = rlncCoeffs(esi, K), v = 0; for (var j = 0; j < K; j++) v ^= gmul(c[j], source[j]); return v; }
  // Solve for the K source bytes from packets [{esi,val}]; null if under-rank.
  function rlncSolve(packets, K) {
    var m = [];
    for (var p = 0; p < packets.length; p++) { var row = Array.from(rlncCoeffs(packets[p].esi, K)); row.push(packets[p].val); m.push(row); }
    var nrow = m.length, prow = 0;
    for (var col = 0; col < K && prow < nrow; col++) {
      var piv = -1; for (var i = prow; i < nrow; i++) if (m[i][col] !== 0) { piv = i; break; }
      if (piv < 0) continue; // cov-ignore: rank-deficient column; distinct-ESI packets give independent rows
      var t = m[prow]; m[prow] = m[piv]; m[piv] = t;
      var invp = ginv(m[prow][col]);
      for (var j = 0; j <= K; j++) m[prow][j] = gmul(m[prow][j], invp);
      for (i = 0; i < nrow; i++) if (i !== prow && m[i][col] !== 0) { var f = m[i][col]; for (j = 0; j <= K; j++) m[i][j] ^= gmul(f, m[prow][j]); }
      prow++;
    }
    if (prow < K) return null; // cov-ignore: under-rank system; unreachable with genuine distinct-ESI packets
    var out = new Uint8Array(K);
    for (i = 0; i < nrow; i++) { var lead = -1, cnt = 0; for (j = 0; j < K; j++) if (m[i][j] !== 0) { lead = j; cnt++; } if (cnt === 1) out[lead] = m[i][K]; }
    return out;
  }
  // Packet = [esiHi][esiLo][val][crc] = 32 bits. CRC is seeded with MAGIC so an
  // all-zero (blank/erased) packet does NOT validate — the "zero is a valid codeword" trap.
  function packetCrc(b) { return crc8([MAGIC, b[0], b[1], b[2]]); }
  function packetBits(esi, val) {
    var bytes = [(esi >> 8) & 0xff, esi & 0xff, val & 0xff];
    bytes.push(packetCrc(bytes));
    var bits = []; for (var k = 0; k < 4; k++) for (var i = 7; i >= 0; i--) bits.push((bytes[k] >> i) & 1);
    return bits;
  }
  function parsePackets(bits) {
    var out = []; var np = Math.floor(bits.length / 32);
    for (var p = 0; p < np; p++) {
      var b = [0, 0, 0, 0];
      for (var k = 0; k < 4; k++) { var v = 0; for (var i = 0; i < 8; i++) v = (v << 1) | bits[p * 32 + k * 8 + i]; b[k] = v; }
      if (packetCrc(b) === b[3]) out.push({ esi: (b[0] << 8) | b[1], val: b[2] });
    }
    return out;
  }

  // ---------- byte / bit helpers ----------
  function crc8(bytes) {
    var c = 0;
    for (var k = 0; k < bytes.length; k++) {
      c ^= bytes[k];
      for (var i = 0; i < 8; i++) c = (c & 0x80) ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    }
    return c;
  }
  function bytesToBits(bytes) {
    var bits = [];
    for (var k = 0; k < bytes.length; k++) for (var i = 7; i >= 0; i--) bits.push((bytes[k] >> i) & 1);
    return bits;
  }
  function bitsToBytes(bits) {
    var out = [];
    for (var k = 0; k + 8 <= bits.length; k += 8) { var b = 0; for (var i = 0; i < 8; i++) b = (b << 1) | bits[k + i]; out.push(b); }
    return out;
  }
  function utf8Encode(str) {
    if (typeof TextEncoder !== 'undefined') return Array.prototype.slice.call(new TextEncoder().encode(str));
    return Array.prototype.slice.call(Buffer.from(str, 'utf8'));
  }
  function utf8Decode(bytes) {
    var u8 = Uint8Array.from(bytes);
    if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(u8);
    return Buffer.from(u8).toString('utf8');
  }

  var MAGIC = 0xA5;
  function buildFrame(message) {
    var content = utf8Encode(message);
    if (content.length > 255) content = content.slice(0, 255);
    var frame = [MAGIC, content.length].concat(content);
    frame.push(crc8(frame));
    return frame;
  }

  // ---------- symbol modem: ECC bit stream <-> carrier symbols (mixed-radix, blocked) ----------
  // Carriers expose a radix per site (ws=4, apos/hyphen=2, wsdense=8, zwsp=4, …). To spend
  // capacity fully — including the fractional bits of a non-power-of-two radix — bits are packed
  // into symbols by MIXED-RADIX (base) conversion. Crucially this is done in bounded BLOCKS, not
  // as one giant number: a damaged symbol corrupts only its block (≤ ~32 bits), preserving spab's
  // locality so ECC can repair it. Blocks derive purely from the radix sequence, so encoder and
  // decoder agree with no side channel. Integer-only (no log/float) for cross-port determinism.
  var SYM_CAP = 0x100000000; // 2^32 — block radix-product ceiling (Number-safe; bounds avalanche)
  // Block grouping. A block is as many consecutive sites as fit under the radix-product
  // ceiling AND under an optional site-count cap `maxSites`. Block size need NOT be a power
  // of two (nor the bits it carries); maxSites is an empirical knob (0 = product-cap only) we
  // can tune later. Encoder and decoder must use the same value (it's a codec param).
  function symBlocks(radices, maxSites) {
    var cap = maxSites > 0 ? maxSites : radices.length || 1;
    var blocks = [], i = 0;
    while (i < radices.length) {
      var prod = 1, j = i;
      while (j < radices.length && (j - i) < cap && prod * radices[j] <= SYM_CAP) { prod *= radices[j]; j++; }
      if (j === i) { j = i + 1; prod = radices[i]; } // cov-ignore: a single radix > 2^32 never occurs for spab carriers
      var p2 = 1, bits = 0;
      while (p2 * 2 <= prod) { p2 *= 2; bits++; } // bits = floor(log2 prod), integer-only
      blocks.push({ start: i, len: j - i, bits: bits });
      i = j;
    }
    return blocks;
  }
  function symCapacityBits(radices, maxSites) { var b = symBlocks(radices, maxSites), n = 0; for (var i = 0; i < b.length; i++) n += b[i].bits; return n; }
  function bitsToSymbols(bits, radices, maxSites) {
    var blocks = symBlocks(radices, maxSites), digits = new Array(radices.length), pos = 0;
    for (var b = 0; b < blocks.length; b++) {
      var blk = blocks[b], v = 0, k, s;
      for (k = 0; k < blk.bits; k++) v = v * 2 + (bits[pos++] || 0); // v < 2^bits ≤ radix product
      for (s = 0; s < blk.len; s++) { var r = radices[blk.start + s]; digits[blk.start + s] = v % r; v = Math.floor(v / r); }
    }
    return digits;
  }
  function symbolsToBits(digits, radices, maxSites) {
    var blocks = symBlocks(radices, maxSites), bits = [];
    for (var b = 0; b < blocks.length; b++) {
      var blk = blocks[b], v = 0, k, s, out = new Array(blk.bits);
      for (s = blk.len - 1; s >= 0; s--) v = v * radices[blk.start + s] + (digits[blk.start + s] || 0);
      for (k = blk.bits - 1; k >= 0; k--) { out[k] = v % 2; v = Math.floor(v / 2); }
      for (k = 0; k < blk.bits; k++) bits.push(out[k]);
    }
    return bits;
  }
  function filledRadices(n, r) { var a = new Array(n); for (var i = 0; i < n; i++) a[i] = r; return a; }

  // ---------- keyed scramble (opt-in): interleave + whitening over the symbol stream ----------
  // With params.key set, the digit stream is (1) whitened — each digit += a key-derived PN value
  // (mod radix), flattening carrier statistics and hiding structure — and (2) interleaved by a
  // key-derived permutation, spreading burst damage across mixed-radix blocks and obscuring order.
  // Both are keyed (derived from the secret), so this is cryptography-flavored, NOT hidden-constant
  // obscurity; and it is a COST MULTIPLIER, not confidentiality — that awaits the planned AEAD.
  // Identity when no key, so keyless behavior (and existing vectors) is unchanged.
  function keySeed(key, id) { var s = String(key) + '|' + id, h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function keyStreams(n, radix, seed) {
    var g = prng32(seed), perm = new Array(n), pn = new Array(n), i, j, t;
    for (i = 0; i < n; i++) perm[i] = i;
    for (i = n - 1; i > 0; i--) { j = g() % (i + 1); t = perm[i]; perm[i] = perm[j]; perm[j] = t; } // Fisher–Yates
    for (i = 0; i < n; i++) pn[i] = g() % radix;
    return { perm: perm, pn: pn };
  }
  function scramble(digits, radix, seed) {
    var n = digits.length, ks = keyStreams(n, radix, seed), out = new Array(n), i;
    for (i = 0; i < n; i++) out[ks.perm[i]] = (digits[i] + ks.pn[i]) % radix; // whiten then interleave
    return out;
  }
  function descramble(physical, radix, seed) {
    var n = physical.length, ks = keyStreams(n, radix, seed), out = new Array(n), i;
    for (i = 0; i < n; i++) out[i] = ((physical[ks.perm[i]] - ks.pn[i]) % radix + radix) % radix;
    return out;
  }

  // ---------- encode ----------
  // Independent per-class channels: each enabled class carries the WHOLE frame
  // (repetition across just its own sites). Parallel channels → a whitespace-only
  // attack can kill the ws channel while the confusable channels still decode.
  function encode(cover, message, params) {
    params = params || {};
    var ids = resolveClasses(params);
    var ecc = (params.ecc === 'rlnc') ? 'rlnc' : 'repetition';
    var frame = buildFrame(message);
    var frameBits = bytesToBits(frame);
    var K = frame.length; // RLNC source symbols (= frame bytes)
    var arr = cover.split('');
    var channels = {}, issues = [], primary = null;
    var esiBase = 0; // RLNC: channels emit DISJOINT esi ranges so their packets combine
    var density = params.density || ZW_DENSITY;
    var maxSites = params.block || 0; // optional block-size cap (sites); 0 = product-cap only
    var key = params.key;             // optional keyed scramble (interleave + whitening)
    var insPlans = []; // insert-kind carriers applied after substitution carriers

    ids.forEach(function (id) {
      var def = CLASS_DEFS[id], isIns = def.kind === 'ins';
      var idx = isIns ? def.anchors(cover) : def.detect(cover);
      var nSites = isIns ? idx.length * density : idx.length; // ins: perGap symbols per gap
      var radices = filledRadices(nSites, def.radix);
      var cap = symCapacityBits(radices, maxSites); // usable bits after mixed-radix packing
      var bits, reps, tooShort;

      if (ecc === 'rlnc') {
        // Fill capacity with self-checking/self-locating fountain packets (32 bits each),
        // using a global esi so every channel carries distinct packets (they pool on decode).
        var nPk = Math.floor(cap / 32);
        tooShort = nPk < K;
        bits = [];
        for (var e = 0; e < nPk; e++) { var esi = esiBase + e; bits = bits.concat(packetBits(esi, rlncValue(frame, esi))); }
        esiBase += nPk;
        while (bits.length < cap) bits.push(0);
        bits = bits.slice(0, cap);
        reps = nPk;
      } else {
        reps = Math.floor(cap / frameBits.length); // frame is always ≥3 bytes, so frameBits ≥ 24
        tooShort = cap < frameBits.length;
        if (tooShort) reps = 1;
        bits = [];
        for (var r = 0; r < reps; r++) bits = bits.concat(frameBits);
        while (bits.length < cap) bits.push(0);
        bits = bits.slice(0, cap);
      }

      var digits = bitsToSymbols(bits, radices, maxSites); // ECC bit stream -> carrier symbols
      if (key) digits = scramble(digits, def.radix, keySeed(key, id)); // opt-in interleave + whitening
      if (isIns) {
        insPlans.push({ def: def, digits: digits, perGap: density });
      } else {
        for (var s = 0; s < idx.length; s++) arr[idx[s]] = def.glyph(digits[s]);
      }
      channels[id] = { sites: idx.length, capacityBits: cap, reps: reps, tooShort: tooShort };
      if (!primary) primary = id;
    });

    var outText = arr.join('');
    insPlans.forEach(function (pl) { outText = pl.def.embed(outText, pl.digits, pl.perGap); });

    // Warnings from the strongest channel (the one carrying the most copies).
    var best = null;
    Object.keys(channels).forEach(function (id) { if (!best || channels[id].reps > channels[best].reps) best = id; });
    if (best) {
      var bc = channels[best];
      if (bc.tooShort) issues.push('Passage too short for any channel: needs ' + frameBits.length +
        ' bits, best channel has ' + bc.capacityBits + '. Encoding a single truncated copy.');
      else if (bc.reps < 3) issues.push('Low redundancy: best channel fits only ' + bc.reps + ' copies. Brittle.');
    }

    // best is a real channel key whenever any class produced sites; empty only when
    // no classes resolved (e.g. classes:['bogus']) — then fall back to zeros.
    var pc = channels[best] || { sites: 0, capacityBits: 0, reps: 0 };
    return {
      text: outText,
      metadata: {
        classes: ids,
        ecc: ecc,
        channels: channels,
        slots: pc.sites,             // back-compat: primary/strongest channel
        capacityBits: pc.capacityBits,
        frameBits: frameBits.length,
        frameBytes: frame.length,
        reps: pc.reps,
        payloadBytes: frame[1],
        issues: issues
      }
    };
  }

  // Fold a single channel's repeated bit stream and parse the frame.
  function foldParse(bits) {
    var total = bits.length;
    if (total < 16) return { status: 'not-detected', message: null, confidence: 0, crcOk: false };
    var len = 0;
    for (var i = 8; i < 16; i++) len = (len << 1) | bits[i];
    var frameBits = (1 + 1 + len + 1) * 8;
    var reps = Math.floor(total / frameBits); // frameBits = (len+3)*8 ≥ 24, always > 0
    if (reps < 1) { reps = 1; frameBits = Math.min(frameBits, total); }

    var folded = [], agSum = 0, agCnt = 0;
    for (var b = 0; b < frameBits; b++) {
      var ones = 0, cnt = 0;
      for (var r = 0; r < reps; r++) { var idx = r * frameBits + b; if (idx < total) { cnt++; ones += bits[idx]; } }
      folded.push(ones * 2 > cnt ? 1 : 0);
      if (cnt > 0) { agSum += Math.max(ones, cnt - ones) / cnt; agCnt++; }
    }
    var bytes = bitsToBytes(folded), agreement = agSum / agCnt; // agCnt ≥ 1 (bit 0 always sampled)
    if (bytes.length < 4) return { status: 'not-detected', message: null, confidence: 0, crcOk: false };
    var magicOk = bytes[0] === MAGIC, dlen = bytes[1];
    var content = bytes.slice(2, 2 + dlen), crcGot = bytes[2 + dlen], crcCalc = crc8(bytes.slice(0, 2 + dlen));
    var crcOk = magicOk && dlen > 0 && content.length === dlen && crcGot === crcCalc;
    var message = null; try { message = utf8Decode(content); } catch (e) { message = null; } // cov-ignore: TextDecoder is non-fatal, never throws
    var status = !magicOk ? 'not-detected' : (crcOk ? (agreement >= 0.999 ? 'perfect' : 'corrected') : 'failed');
    var confidence = crcOk ? Math.min(1, 0.5 + 0.5 * agreement) : (magicOk ? Math.max(0, agreement - 0.5) : 0);
    return { status: status, message: crcOk ? message : null, confidence: +confidence.toFixed(3),
      agreement: +agreement.toFixed(3), reps: reps, payloadBytes: dlen, crcOk: crcOk, rawMessage: message };
  }

  // Frame bytes (from RLNC or fold) -> parsed message result.
  function frameToResult(bytes, extra) {
    if (!bytes || bytes.length < 4) return { status: 'not-detected', message: null, confidence: 0, crcOk: false }; // cov-ignore: rlncSolve always returns K≥4 bytes
    var magicOk = bytes[0] === MAGIC, dlen = bytes[1];
    var content = bytes.slice(2, 2 + dlen), crcGot = bytes[2 + dlen], crcCalc = crc8(bytes.slice(0, 2 + dlen));
    var crcOk = magicOk && dlen > 0 && content.length === dlen && crcGot === crcCalc;
    var message = null; try { message = utf8Decode(Array.from(content)); } catch (e) { message = null; } // cov-ignore: TextDecoder is non-fatal, never throws
    var status = !magicOk ? 'not-detected' : (crcOk ? 'perfect' : 'failed');
    return Object.assign({ status: crcOk ? (extra && extra.corrected ? 'corrected' : 'perfect') : status, // cov-ignore: extra.corrected unused by decodeRLNC
      message: crcOk ? message : null, confidence: crcOk ? 1 : 0, payloadBytes: dlen, crcOk: crcOk, rawMessage: message }, extra || {});
  }

  // Look for one intact frame anywhere in the stream, across block-grid phases and
  // byte-aligned starts. Frames are self-contained and CRC-checked, so an intact
  // copy needs no agreement from its neighbours — this is what recovers a payload
  // whose later copies were shifted by an edit.
  function scanFrame(text, id, key, maxSites) {
    var def = CLASS_DEFS[id], digits = classDigits(text, id), phases = phaseCount(key, digits.length);
    for (var ph = 0; ph < phases; ph++) {
      var bits = phaseBits(digits, ph, def, key, id, maxSites);
      var bytes = bitsToBytes(bits);
      for (var o = 0; o + 4 <= bytes.length; o++) {
        if (bytes[o] !== MAGIC) continue;
        var dlen = bytes[o + 1];
        if (dlen < 1 || o + 2 + dlen >= bytes.length) continue;
        var content = bytes.slice(o + 2, o + 2 + dlen);
        if (bytes[o + 2 + dlen] !== crc8(bytes.slice(o, o + 2 + dlen))) continue;
        var message = null;
        try { message = utf8Decode(content); } catch (e) { message = null; } // cov-ignore: TextDecoder is non-fatal
        return { status: 'corrected', message: message, confidence: 0.75, agreement: 1,
          reps: 1, payloadBytes: dlen, crcOk: true, rawMessage: message, resynced: true };
      }
    }
    return null;
  }

  // RLNC decode: pool self-checking packets from ALL channels, recover any K.
  function decodeRLNC(text, ids, key, maxSites) {
    var pool = {}, count = 0;
    ids.forEach(function (id) {
      var def = CLASS_DEFS[id], digits = classDigits(text, id), phases = phaseCount(key, digits.length);
      // Phase 0 first, so an undamaged stream pools exactly the packets it always
      // did; later phases only add what a shift had hidden. Packets stay on 32-bit
      // boundaries within a phase — scanning every bit offset instead finds ~8
      // false packets per document, and one false packet poisons the solve.
      for (var ph = 0; ph < phases; ph++) {
        parsePackets(phaseBits(digits, ph, def, key, id, maxSites)).forEach(function (pk) {
          if (!(pk.esi in pool)) { pool[pk.esi] = pk.val; count++; }
        });
      }
    });
    if (count < 4) return { status: 'not-detected', message: null, confidence: 0, crcOk: false, packets: count };
    var packets = Object.keys(pool).map(function (e) { return { esi: +e, val: pool[e] }; });
    // K = source symbols = frame length = len + 3; get len from systematic packet esi=1 if clean.
    var candidates = [];
    if (1 in pool) candidates.push(pool[1] + 3);
    for (var Kg = 4; Kg <= 80; Kg++) if (candidates.indexOf(Kg) < 0) candidates.push(Kg);
    for (var ci = 0; ci < candidates.length; ci++) {
      var K = candidates[ci];
      if (packets.length < K) continue;
      var src = rlncSolve(packets, K);
      if (!src) continue; // cov-ignore: pairs with rlncSolve's under-rank return (unreachable with genuine packets)
      var res = frameToResult(src, { channel: 'rlnc', packets: count });
      if (res.crcOk) return res;
    }
    return { status: 'failed', message: null, confidence: 0, crcOk: false, packets: count, channel: 'rlnc' };
  }

  // ---------- decode ----------
  // Try each enabled class independently; return the best-decoding channel.
  function decode(text, params) {
    params = params || {};
    var ids = resolveClasses(params);
    var key = params.key, maxSites = params.block || 0;
    if (params.ecc === 'rlnc') {
      var r = decodeRLNC(text, ids, key, maxSites);
      return { message: r.message, metadata: { status: r.status, confidence: r.confidence, ecc: 'rlnc',
        crcOk: r.crcOk, payloadBytes: r.payloadBytes, packets: r.packets, channel: r.channel, rawMessage: r.rawMessage } };
    }
    var rank = { perfect: 3, corrected: 2, failed: 1, 'not-detected': 0 };
    var best = null, bestId = null;
    ids.forEach(function (id) {
      var c = foldParse(readClassBits(text, id, key, maxSites));
      // Majority voting assumes every copy starts where the first one did. After an
      // insertion or deletion the later copies are shifted, and folding averages
      // intact copies together with noise. A single self-contained frame
      // (magic/len/content/crc) is enough on its own, so go looking for one.
      if (!c.crcOk) { var r = scanFrame(text, id, key, maxSites); if (r) c = r; }
      var better = !best ||
        (c.crcOk && !best.crcOk) ||
        (c.crcOk === best.crcOk && (rank[c.status] > rank[best.status] ||
          (rank[c.status] === rank[best.status] && c.confidence > best.confidence)));
      if (better) { best = c; bestId = id; }
    });
    if (!best) return { message: null, metadata: { status: 'not-detected', confidence: 0 } };
    return {
      message: best.message,
      metadata: {
        status: best.status, confidence: best.confidence, agreement: best.agreement,
        reps: best.reps, payloadBytes: best.payloadBytes, crcOk: best.crcOk,
        channel: bestId, rawMessage: best.rawMessage
      }
    };
  }

  // ---------- introspection (ws-only, back-compat) ----------
  function getSlots(text) { return CLASS_DEFS.ws.detect(text); } // whitespace sites
  function histogram(text) {
    var slots = CLASS_DEFS.ws.detect(text), h = [0, 0, 0, 0];
    for (var i = 0; i < slots.length; i++) { var v = WS_SET[text[slots[i]]]; if (v !== undefined) h[v]++; }
    return { counts: h, total: slots.length };
  }

  // ---------- version / algorithm descriptor ----------
  var VERSION = '0.4.1';
  var algorithm = {
    version: VERSION,
    name: 'plugsym-rep+rlnc',
    summary: 'Pluggable symbol library, independent parallel per-class channels. Two ECC ' +
             'modes: repetition+majority (default) per channel, or a GF(256) systematic ' +
             'RLNC fountain (ecc:"rlnc") whose self-checking/self-locating 32-bit packets ' +
             'pool across channels so surviving carriers reconstruct any K. Default carriers ' +
             '= whitespace + confusables (quote, hyphen), co-equal; whitespace is NFKC-fragile, ' +
             'confusables survive NFKC. [magic 0xA5][len][content][crc8] frame.',
    ecc: { repetition: 'per-channel frame repetition + majority vote', rlnc: 'GF(256) systematic random-linear fountain; 32-bit packets [esi|val|crc]; brute-force/len-hinted K' },
    classes: {
      ws: { bits: 2, variants: ['U+0020', 'U+2006', 'U+2009', 'U+200A'], defaultOn: true, nfkcSurvives: false },
      apos: { bits: 1, variants: ['U+0027', 'U+2019'], defaultOn: true, nfkcSurvives: true },
      hyphen: { bits: 1, variants: ['U+002D', 'U+2010'], defaultOn: true, nfkcSurvives: true },
      wsdense: { bits: 3, kind: 'substitute', variants: ['U+0020', 'U+2009', 'U+200A', 'U+2006', 'U+2005', 'U+2004', 'U+2008', 'U+205F'], defaultOn: false, nfkcSurvives: false, note: 'dense, length-preserving; some variants differ in width' },
      zwsp: { bits: 2, kind: 'insert', variants: ['U+200B', 'U+200C', 'U+200D', 'U+2060'], defaultOn: false, nfkcSurvives: false, note: 'dense, ADDS zero-width chars (StegCloak/330k style); length grows, visible in hex' }
    },
    ecc: { type: 'repetition+majority', detail: 'frame repeated to fill capacity, per-bit majority vote' },
    frame: { fields: ['magic(0xA5)', 'len(1B)', 'content', 'crc8'], integrity: 'crc8', sync: 'magic byte' },
    modem: { type: 'mixed-radix', blocked: true, blockCapBits: 32, note: 'ECC bit stream is packed into per-site carrier symbols by blocked mixed-radix (base) conversion, recovering fractional bits of non-power-of-two radices; blocks bound a damaged symbol to ≤32 bits' },
    coding: { symbolLayer: 'mixed-radix (blocked)', blocks: true, interleave: 'keyed (opt-in)', pn: 'keyed (opt-in)', softDecision: false },
    resync: {
      phases: MAX_PHASE,
      note: 'Inserting or deleting a carrier site shifts the whole symbol stream, so blocks are cut one position off and everything after the edit decodes to noise — redundancy does not help, because every copy shifts together. The decoder therefore re-cuts the block grid at each phase: RLNC pools packets from all phases (32-bit aligned, so chance CRC hits stay out of the solve), and repetition falls back to scanning for one intact self-contained frame when majority folding fails. Disabled when a key is set: the keyed interleave spans the whole stream and cannot be undone on a shifted one.'
    }
  };

  var SPAB = {
    VERSION: VERSION,
    algorithm: algorithm,
    SPACE_MAP: SPACE_MAP,
    SPACE_NAMES: SPACE_NAMES,
    CLASS_DEFS: CLASS_DEFS,
    resolveClasses: resolveClasses,
    getSites: getSites,
    getSlots: getSlots,
    encode: encode,
    decode: decode,
    histogram: histogram,
    readClassBits: readClassBits,
    // symbol modem (mixed-radix, blocked) — exposed for introspection/conformance tests
    symbols: { blocks: symBlocks, capacity: symCapacityBits, toSymbols: bitsToSymbols, toBits: symbolsToBits }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = SPAB;
  root.SPAB = SPAB;
})(typeof window !== 'undefined' ? window : this);
