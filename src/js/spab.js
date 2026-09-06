/*
 * spab.js — text watermark codec (reference implementation)
 *
 * Hides a payload in choices a reader never notices: which of several visually
 * equivalent whitespace characters sits between two words, whether an apostrophe is
 * straight or curly, whether a hyphen is U+002D or U+2010.
 *
 * Carrier classes, each contributing "sites" that carry symbols:
 *     ws      — inter-word space, 4 whitespace variants   (2 bits/site)  [default]
 *     apos    — U+0027 <-> U+2019                         (1 bit/site)   [default]
 *     hyphen  — U+002D <-> U+2010                         (1 bit/site)   [default]
 *     wsdense — 8 whitespace variants                     (3 bits/site)  [opt-in]
 *     zwsp    — INSERTS zero-width characters             (2 bits/char)  [opt-in]
 *   ('punct' is shorthand for apos+hyphen.)
 *
 * Classes are INDEPENDENT PARALLEL CHANNELS, each carrying the whole payload, so an
 * edit that destroys one can leave another intact. Default = ws + apos + hyphen,
 * chosen because they fail differently: whitespace dies to NFKC normalization, the
 * confusables survive it.
 *
 * Payload path:
 *   message -> type -> compress? -> encrypt? -> packet -> ECC -> symbols -> text
 *
 * Wire format v2 (normative spec in dev/wire-format.md):
 *   [version:3 | type:5 | comp:3 | enc:3 | cksum:3]  17-bit fixed header
 *   [extension bytes, grouped, in field order]       only for escaped fields
 *   [len varint]                                     only when not implied by type
 *   [checksum, 8 << cksum bits]                      BEFORE the content, deliberately
 *   [content][pad to a byte boundary]
 * There is no magic number: the header's own plausibility plus the checksum is the
 * discriminator. Packets written by 0.4.x are NOT read by this version.
 *
 * ECC: per-channel repetition + per-bit majority vote (default), or a GF(256)
 * systematic RLNC fountain (ecc:'rlnc') whose self-checking 32-bit packets pool
 * across channels.
 *
 * Determinism: same input and same explicit params give the same output on every
 * port — EXCEPT that encryption draws a fresh 12-byte nonce when `params.nonce` is
 * not supplied, which is correct AEAD behaviour and intentionally nondeterministic.
 *
 * Works as a browser global (window.SPAB) and via CommonJS (module.exports).
 * Zero dependencies, including for SHA-256, AES-256-GCM and compression.
 */
(function (root) {
  'use strict';

  // ---------- carrier classes ----------
  var SPACE_MAP = [String.fromCharCode(0x20), String.fromCharCode(0x2006), String.fromCharCode(0x2009), String.fromCharCode(0x200A)];
  var SPACE_NAMES = ['U+0020 space', 'U+2006 six-per-em', 'U+2009 thin', 'U+200A hair'];
  var WS_SET = {};
  SPACE_MAP.forEach(function (c, i) { WS_SET[c] = i; });

  // Is the code point at `at` pictographic — emoji, symbol, regional indicator, or a
  // variation selector/tag that belongs to one? Used only to tell an emoji joiner
  // apart from a zero-width carrier. Works on UTF-16 code units, so a low surrogate
  // is checked by pairing it with the high surrogate before it.
  function isPictographic(text, at) {
    if (at < 0 || at >= text.length) return false;
    var c = text.charCodeAt(at);
    if (c >= 0xDC00 && c <= 0xDFFF && at > 0) {          // low surrogate: rebuild the pair
      var hi = text.charCodeAt(at - 1);
      if (hi >= 0xD800 && hi <= 0xDBFF) c = (hi - 0xD800) * 0x400 + (c - 0xDC00) + 0x10000;
    } else if (c >= 0xD800 && c <= 0xDBFF && at + 1 < text.length) {
      var lo = text.charCodeAt(at + 1);
      if (lo >= 0xDC00 && lo <= 0xDFFF) c = (c - 0xD800) * 0x400 + (lo - 0xDC00) + 0x10000;
    }
    if (c === 0xFE0F || c === 0xFE0E) return true;        // variation selectors
    // Regional indicators (U+1F1E6..U+1F1FF) need no line of their own: they sit
    // inside the emoji block range below.
    if (c >= 0x1F000 && c <= 0x1FAFF) return true;        // emoji blocks
    if (c >= 0x2600 && c <= 0x27BF) return true;          // misc symbols and dingbats
    if (c >= 0xE0020 && c <= 0xE007F) return true;        // tag characters (flag sequences)
    return false;
  }
  function isWordChar(ch) { return !!ch && !/\s/.test(ch) && !(ch in WS_SET) && !(ch in ZW_SET); }
  // Neighbours, skipping zero-width characters. They are invisible, so they must
  // not change what counts as a word boundary: without this, inserting a
  // zero-width carrier after a space stops that space being seen as an inter-word
  // gap and silently destroys the whitespace channel underneath it.
  function wordCharBefore(text, i) { var j = i - 1; while (j >= 0 && (text[j] in ZW_SET)) j--; return j >= 0 ? text[j] : ''; }
  function wordCharAfter(text, i) { var j = i + 1; while (j < text.length && (text[j] in ZW_SET)) j++; return j < text.length ? text[j] : ''; }

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
  // Ceiling for auto-grow. Each step adds one invisible character per word gap, so
  // the tarball grows by roughly (gaps x 3) bytes per step in UTF-8. 64 lets a
  // short note carry a few hundred bytes; beyond that the caller should be passing
  // a longer cover text rather than inflating a small one indefinitely.
  var ZW_MAX_DENSITY = 64;
  var AUTO_GROW_REPS = 3;   // copies to aim for when growing a passage to fit

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
          if ((ch === ' ' || ch in WS_SET) && isWordChar(wordCharBefore(text, i)) && isWordChar(wordCharAfter(text, i))) out.push(i);
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
          if ((text[i] in WSDENSE_SET) && isWordChar(wordCharBefore(text, i)) && isWordChar(wordCharAfter(text, i))) out.push(i);
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
      // `at` is the anchor set encode planned against, taken from the ORIGINAL cover.
      // Recomputing anchors here instead was a latent bug: substitution carriers run
      // first, and wsdense swaps spaces for variants outside the whitespace class's
      // own set, so the anchors it found afterwards were fewer than the digit stream
      // was sized for. The stream was silently truncated, which unkeyed decoding
      // partly tolerated and keyed decoding could not — the descramble permutation
      // depends on the digit count. Substitution is one-for-one, so positions from
      // the cover remain valid in the substituted text.
      embed: function (text, digits, perGap, at) {
        var idx = at || this.anchors(text), run = {}, pos = 0;
        for (var a = 0; a < idx.length; a++) {
          var s = '';
          for (var k = 0; k < perGap; k++) { s += ZW_STR[digits[pos++] || 0]; }
          run[idx[a]] = s;
        }
        var outp = '';
        for (var i = 0; i < text.length; i++) { outp += text[i]; if (run[i] !== undefined) outp += run[i]; }
        return outp;
      },
      // recover the digit stream (every zero-width char, in order) — except the ones
      // that were already in the cover doing a job.
      //
      // U+200D is both a carrier variant and the EMOJI ZERO WIDTH JOINER. A family
      // emoji is man-ZWJ-woman-ZWJ-girl, and a flag is a tag sequence; read
      // naively, those joiners come back as payload digits. Measured on the emoji
      // document in tests/corpus.js: two spurious digits extracted from an UNMARKED
      // cover, which shifts every real digit after them and desynchronises the
      // stream. The mark still decoded there because the ECC absorbed two errors,
      // but that is luck, not design — a document with many emoji would not be.
      //
      // A joiner sitting between two pictographic characters is doing emoji work,
      // not carrying data, so it is skipped. The encoder never inserts there anyway:
      // anchors are inter-word gaps, and the inside of an emoji cluster is not one.
      extract: function (text) {
        var digits = [];
        for (var i = 0; i < text.length; i++) {
          var v = ZW_SET[text[i]];
          if (v === undefined) continue;
          if (text.charCodeAt(i) === 0x200D && isPictographic(text, i - 1) && isPictographic(text, i + 1)) continue;
          digits.push(v);
        }
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
  function hasZeroWidth(text) {
    for (var i = 0; i < text.length; i++) if (text[i] in ZW_SET) return true;
    return false;
  }
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
  // Keyed marks sweep phases too, now that the keyed permutation is block-local and
  // no longer a function of the carrier count.
  function phaseCount(key, n) { return Math.min(MAX_PHASE, n); }
  function phaseBits(digits, ph, def, key, id, maxSites) {
    var d = ph ? digits.slice(ph) : digits;
    if (key) d = descramble(d, def.radix, keySeed(key, id));
    return symbolsToBits(d, filledRadices(d.length, def.radix), maxSites);
  }

  // ---------- GF(256) + systematic RLNC fountain (ecc:'rlnc') ----------
  // Rateless erasure code over GF(2^8). Packets are self-checking (CRC) and
  // self-locating (ESI), spread across all carrier channels; any K LINEARLY
  // INDEPENDENT packets
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
  // Packet = [esiHi][esiLo][val][crc] = 32 bits. CRC is seeded with a constant so an
  // all-zero (blank/erased) packet does NOT validate — the "zero is a valid codeword" trap.
  function packetCrc(b) { return crc8([PKT_SEED, b[0], b[1], b[2]]); }
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

  // ============================================================================
  // Wire format v2 — normative specification in dev/wire-format.md.
  //
  //   [ version:3 | type:5 | comp:3 | enc:3 | cksum:3 ]   17-bit fixed header
  //   [ extension bytes, grouped, in field order       ]   only for escaped fields
  //   [ len varint                                     ]   only when not implied
  //   [ checksum, 8 << cksum bits                      ]   BEFORE the content
  //   [ content, len bytes                             ]   stored form
  //   [ 0..7 zero bits                                 ]   pad to a byte boundary
  //
  // Three choices carry most of the weight, and each is argued in the spec:
  //   - bit-level, not byte-aligned: the modem is bit-oriented, so byte-rounding
  //     these five fields would spend 40 bits where 17 do;
  //   - the checksum precedes the content, so a truncated packet still says what
  //     it should have contained — the fountain decoder needs an oracle, not a gate;
  //   - no magic number: the header's own plausibility plus the checksum does that
  //     job, and unlike a constant it also tells the decoder something.
  // ============================================================================

  var WIRE_VER = 2;
  var PKT_SEED = 0xA5;      // RLNC packet CRC seed — independent of the frame layout

  // ---------- checksums ----------
  // CRC-16/CCITT-FALSE: init 0xFFFF, poly 0x1021, no reflection.
  function crc16(bytes) {
    var c = 0xffff;
    for (var k = 0; k < bytes.length; k++) {
      c ^= (bytes[k] << 8);
      for (var i = 0; i < 8; i++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
    }
    return c;
  }
  // CRC-32, reflected (poly 0xEDB88320) — the zip/png one.
  var CRC32_TAB = null;
  function crc32(bytes) {
    if (!CRC32_TAB) {
      CRC32_TAB = new Int32Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        CRC32_TAB[n] = c;
      }
    }
    var crc = -1;
    for (var i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ CRC32_TAB[(crc ^ bytes[i]) & 0xff];
    return (crc ^ -1) >>> 0;
  }

  // SHA-256. Needed for checksum widths at and above 64 bits (there is no standard
  // CRC that wide, and the reason to want one that wide is collision resistance,
  // which a CRC does not give at any width), and it powers deriveKey().
  var K256 = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  function rotr(x, n) { return ((x >>> n) | (x << (32 - n))) >>> 0; }
  function sha256(bytes) {
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var msg = Array.prototype.slice.call(bytes), bitLen = msg.length * 8;
    msg.push(0x80);
    while (msg.length % 64 !== 56) msg.push(0);
    // 64-bit big-endian length. Payloads here are far below 2^29 bytes, so the
    // high word is always zero.
    msg.push(0, 0, 0, 0, (bitLen >>> 24) & 0xff, (bitLen >>> 16) & 0xff, (bitLen >>> 8) & 0xff, bitLen & 0xff);
    var w = new Int32Array(64), i, off;
    for (off = 0; off < msg.length; off += 64) {
      for (i = 0; i < 16; i++) {
        w[i] = (msg[off + i * 4] << 24) | (msg[off + i * 4 + 1] << 16) | (msg[off + i * 4 + 2] << 8) | msg[off + i * 4 + 3];
      }
      for (i = 16; i < 64; i++) {
        var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        var s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var t1 = (h + S1 + ((e & f) ^ (~e & g)) + K256[i] + w[i]) | 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    var out = [];
    for (i = 0; i < 8; i++) out.push((H[i] >>> 24) & 0xff, (H[i] >>> 16) & 0xff, (H[i] >>> 8) & 0xff, H[i] & 0xff);
    return out;
  }
  function hmacSha256(key, msg) {
    var k = key.length > 64 ? sha256(key) : Array.prototype.slice.call(key);
    while (k.length < 64) k.push(0);
    var ipad = [], opad = [];
    for (var i = 0; i < 64; i++) { ipad.push(k[i] ^ 0x36); opad.push(k[i] ^ 0x5c); }
    return sha256(opad.concat(sha256(ipad.concat(Array.prototype.slice.call(msg)))));
  }
  // PBKDF2-HMAC-SHA256. Deliberately NOT part of the packet: the format requires a
  // raw 32-byte key so no salt or iteration count has to travel in a header where
  // every bit is contested. This is here so callers who start from a passphrase
  // have one correct way to get a key, not because the wire format knows about it.
  function deriveKey(password, salt, iterations, dkLen) {
    iterations = iterations || 100000; dkLen = dkLen || 32;
    var pw = typeof password === 'string' ? utf8Encode(password) : Array.prototype.slice.call(password);
    var s = typeof salt === 'string' ? utf8Encode(salt) : Array.prototype.slice.call(salt);
    var out = [], block = 1;
    while (out.length < dkLen) {
      var u = hmacSha256(pw, s.concat([(block >>> 24) & 0xff, (block >>> 16) & 0xff, (block >>> 8) & 0xff, block & 0xff]));
      var acc = u.slice();
      for (var i = 1; i < iterations; i++) {
        u = hmacSha256(pw, u);
        for (var j = 0; j < acc.length; j++) acc[j] ^= u[j];
      }
      out = out.concat(acc); block++;
    }
    return out.slice(0, dkLen);
  }

  // cksum:3 is an EXPONENT: bits = 8 << n. CRC below 64 bits, truncated SHA-256 at
  // and above it. 6 (512 bits) is reserved — it needs SHA-512 — and 7 escapes.
  var CK_ESCAPE = 7, CK_MAX_EXP = 5;
  function cksumBits(exp) { return 8 << exp; }
  function computeChecksum(bytes, exp) {
    if (exp === 0) return [crc8(bytes)];
    if (exp === 1) { var a = crc16(bytes); return [(a >> 8) & 0xff, a & 0xff]; }
    if (exp === 2) { var b = crc32(bytes); return [(b >>> 24) & 0xff, (b >>> 16) & 0xff, (b >>> 8) & 0xff, b & 0xff]; }
    return sha256(bytes).slice(0, cksumBits(exp) / 8);
  }

  // ---------- AES-256-GCM ----------
  // Pure JS, so encode/decode stay SYNCHRONOUS in every host. WebCrypto's AEAD is
  // async everywhere, which would force an async public API on a library whose
  // entire surface — including the browser demo — is synchronous.
  //
  // Caveat, stated plainly: table-driven AES is not constant-time. An attacker able
  // to measure cache timing of this process while it encrypts could recover the
  // key. That is outside spab's threat model (marking happens locally; the attacker
  // sees marked text, not the machine), but a caller who needs constant-time
  // encryption should encrypt with a platform AEAD and pass the ciphertext in as a
  // `bytes` payload. Verified against the NIST GCM vectors in tests/wire.test.js.
  var AES_SBOX = null;
  function xtime(a) { return ((a << 1) ^ ((a & 0x80) ? 0x1b : 0)) & 0xff; }
  function aesInit() {
    if (AES_SBOX) return;
    var sbox = new Uint8Array(256), p = 1, q = 1;
    do {
      p = (p ^ ((p << 1) & 0xff) ^ ((p & 0x80) ? 0x1b : 0)) & 0xff;
      q ^= (q << 1) & 0xff; q ^= (q << 2) & 0xff; q ^= (q << 4) & 0xff;
      if (q & 0x80) q ^= 0x09;
      q &= 0xff;
      sbox[p] = (q ^ ((q << 1) | (q >>> 7)) ^ ((q << 2) | (q >>> 6)) ^ ((q << 3) | (q >>> 5)) ^ ((q << 4) | (q >>> 4)) ^ 0x63) & 0xff;
    } while (p !== 1);
    sbox[0] = 0x63;
    AES_SBOX = sbox;
  }
  function aesExpandKey(key) {
    aesInit();
    var Nk = 8, Nr = 14, w = [], i;
    for (i = 0; i < Nk; i++) w.push([key[4 * i], key[4 * i + 1], key[4 * i + 2], key[4 * i + 3]]);
    var rcon = 1;
    for (i = Nk; i < 4 * (Nr + 1); i++) {
      var t = w[i - 1].slice();
      if (i % Nk === 0) {
        t = [AES_SBOX[t[1]] ^ rcon, AES_SBOX[t[2]], AES_SBOX[t[3]], AES_SBOX[t[0]]];
        rcon = xtime(rcon);
      } else if (i % Nk === 4) {
        t = [AES_SBOX[t[0]], AES_SBOX[t[1]], AES_SBOX[t[2]], AES_SBOX[t[3]]];
      }
      w.push([w[i - Nk][0] ^ t[0], w[i - Nk][1] ^ t[1], w[i - Nk][2] ^ t[2], w[i - Nk][3] ^ t[3]]);
    }
    return w;
  }
  // State is column-major: s[c*4 + r]. GCM needs only the forward direction.
  function aesEncryptBlock(w, input) {
    var s = input.slice(0, 16), Nr = 14, r, c, i;
    for (c = 0; c < 4; c++) for (r = 0; r < 4; r++) s[c * 4 + r] ^= w[c][r];
    for (var round = 1; round <= Nr; round++) {
      for (i = 0; i < 16; i++) s[i] = AES_SBOX[s[i]];
      var t = s.slice();
      for (c = 0; c < 4; c++) for (r = 0; r < 4; r++) s[c * 4 + r] = t[(((c + r) % 4) * 4) + r];
      if (round !== Nr) {
        for (c = 0; c < 4; c++) {
          var a0 = s[c * 4], a1 = s[c * 4 + 1], a2 = s[c * 4 + 2], a3 = s[c * 4 + 3];
          var x = a0 ^ a1 ^ a2 ^ a3;
          s[c * 4]     = a0 ^ x ^ xtime(a0 ^ a1);
          s[c * 4 + 1] = a1 ^ x ^ xtime(a1 ^ a2);
          s[c * 4 + 2] = a2 ^ x ^ xtime(a2 ^ a3);
          s[c * 4 + 3] = a3 ^ x ^ xtime(a3 ^ a0);
        }
      }
      for (c = 0; c < 4; c++) for (r = 0; r < 4; r++) s[c * 4 + r] ^= w[round * 4 + c][r];
    }
    return s;
  }
  function be32(b, at) { return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0; }
  function toWords(b) { return [be32(b, 0), be32(b, 4), be32(b, 8), be32(b, 12)]; }
  function fromWords(w) {
    var out = [];
    for (var i = 0; i < 4; i++) out.push((w[i] >>> 24) & 0xff, (w[i] >>> 16) & 0xff, (w[i] >>> 8) & 0xff, w[i] & 0xff);
    return out;
  }
  // Multiplication in GF(2^128) with the GCM (reversed) bit order.
  function gcmMul(X, Y) {
    var Z = [0, 0, 0, 0], V = Y.slice();
    for (var i = 0; i < 128; i++) {
      if ((X[i >>> 5] >>> (31 - (i & 31))) & 1) {
        Z[0] = (Z[0] ^ V[0]) >>> 0; Z[1] = (Z[1] ^ V[1]) >>> 0;
        Z[2] = (Z[2] ^ V[2]) >>> 0; Z[3] = (Z[3] ^ V[3]) >>> 0;
      }
      var lsb = V[3] & 1;
      V[3] = ((V[3] >>> 1) | ((V[2] & 1) << 31)) >>> 0;
      V[2] = ((V[2] >>> 1) | ((V[1] & 1) << 31)) >>> 0;
      V[1] = ((V[1] >>> 1) | ((V[0] & 1) << 31)) >>> 0;
      V[0] = (V[0] >>> 1) >>> 0;
      if (lsb) V[0] = (V[0] ^ 0xe1000000) >>> 0;
    }
    return Z;
  }
  // `data` must be a whole number of 16-byte blocks; both callers pad before calling.
  function ghash(H, data) {
    var Y = [0, 0, 0, 0];
    for (var i = 0; i < data.length; i += 16) {
      var X = toWords(data.slice(i, i + 16));
      Y = gcmMul([(Y[0] ^ X[0]) >>> 0, (Y[1] ^ X[1]) >>> 0, (Y[2] ^ X[2]) >>> 0, (Y[3] ^ X[3]) >>> 0], H);
    }
    return Y;
  }
  function gcmLenBlock(aLen, cLen) {
    // Both lengths in BITS, 64-bit big-endian. Payloads never approach 2^29 bytes,
    // so the high words are zero.
    return [0, 0, 0, 0, (aLen * 8 / 0x100000000) | 0, 0, 0, 0].slice(0, 4)
      .concat([(aLen * 8 >>> 24) & 0xff, (aLen * 8 >>> 16) & 0xff, (aLen * 8 >>> 8) & 0xff, (aLen * 8) & 0xff])
      .concat([0, 0, 0, 0])
      .concat([(cLen * 8 >>> 24) & 0xff, (cLen * 8 >>> 16) & 0xff, (cLen * 8 >>> 8) & 0xff, (cLen * 8) & 0xff]);
  }
  function gcmCtr(w, j0, data) {
    var out = [], ctr = j0.slice();
    for (var i = 0; i < data.length; i += 16) {
      // inc32 on the low word of the counter block
      var n = (be32(ctr, 12) + 1) >>> 0;
      ctr[12] = (n >>> 24) & 0xff; ctr[13] = (n >>> 16) & 0xff; ctr[14] = (n >>> 8) & 0xff; ctr[15] = n & 0xff;
      var ks = aesEncryptBlock(w, ctr);
      for (var k = 0; k < 16 && i + k < data.length; k++) out.push(data[i + k] ^ ks[k]);
    }
    return out;
  }
  // Returns nonce ‖ ciphertext ‖ tag — the content of an encrypted packet (§4.4).
  function aesGcmSeal(key, plain, nonce) {
    var w = aesExpandKey(key), H = toWords(aesEncryptBlock(w, [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]));
    var j0 = nonce.slice(0, 12).concat([0, 0, 0, 1]);
    var ct = gcmCtr(w, j0, plain);
    var S = ghash(H, ct.concat(new Array((16 - ct.length % 16) % 16).fill(0)).concat(gcmLenBlock(0, ct.length)));
    var tag = fromWords(S);
    var ks0 = aesEncryptBlock(w, j0);
    for (var i = 0; i < 16; i++) tag[i] ^= ks0[i];
    return nonce.slice(0, 12).concat(ct).concat(tag);
  }
  function aesGcmOpen(key, content) {
    if (content.length < 28) return null;
    var nonce = content.slice(0, 12), ct = content.slice(12, content.length - 16), tag = content.slice(content.length - 16);
    var w = aesExpandKey(key), H = toWords(aesEncryptBlock(w, [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]));
    var j0 = nonce.concat([0, 0, 0, 1]);
    var S = ghash(H, ct.concat(new Array((16 - ct.length % 16) % 16).fill(0)).concat(gcmLenBlock(0, ct.length)));
    var want = fromWords(S), ks0 = aesEncryptBlock(w, j0), diff = 0;
    for (var i = 0; i < 16; i++) diff |= (want[i] ^ ks0[i]) ^ tag[i];
    if (diff !== 0) return null;
    return gcmCtr(w, j0, ct);
  }
  function normalizeKey(k) {
    if (k === undefined || k === null) return null;
    if (typeof k === 'string') {
      if (/^[0-9a-fA-F]{64}$/.test(k)) return hexToBytes(k.toLowerCase());
      return null;
    }
    var a = Array.prototype.slice.call(k);
    return a.length === 32 ? a : null;
  }
  function randomBytes(n) {
    // cov-ignore: globalThis exists in every supported host; `root` is the ES5 fallback
    var g = (typeof globalThis !== 'undefined') ? globalThis : root;
    // cov-ignore: Node <19 has no global crypto; every supported host takes the path below
    if (!(g.crypto && g.crypto.getRandomValues)) return Array.prototype.slice.call(require('crypto').randomBytes(n));
    var out = new Uint8Array(n); g.crypto.getRandomValues(out); return Array.prototype.slice.call(out);
  }

  // ---------- LZSS (comp = 1) ----------
  // Defined in dev/wire-format.md §6 so the format depends on no library: 4 KB
  // window, match lengths 3-18, groups of one flag byte plus up to 8 items, a set
  // flag bit meaning a literal and a clear one a 16-bit `offset:12|(len-3):4` token.
  // Chosen because it is small, exactly symmetric, synchronous in every host, and
  // has no browser/Node split — not because it is the strongest compressor.
  var LZSS_WINDOW = 4096, LZSS_MAX_MATCH = 18, LZSS_MIN_MATCH = 3;
  var INFLATE_CAP = 64;   // decompression-bomb bound: output may not exceed 64x input
  function lzssCompress(src) {
    var out = [], i = 0, n = src.length;
    while (i < n) {
      var flagPos = out.length, flags = 0, items = 0;
      out.push(0);
      for (; items < 8 && i < n; items++) {
        var bestLen = 0, bestOff = 0;
        var start = i - LZSS_WINDOW < 0 ? 0 : i - LZSS_WINDOW;
        var maxLen = Math.min(LZSS_MAX_MATCH, n - i);
        for (var j = i - 1; j >= start && maxLen >= LZSS_MIN_MATCH; j--) {
          var l = 0;
          while (l < maxLen && src[j + l] === src[i + l]) l++;
          if (l > bestLen) { bestLen = l; bestOff = i - j; if (l === maxLen) break; }
        }
        if (bestLen >= LZSS_MIN_MATCH) {
          var tok = (((bestOff - 1) & 0xfff) << 4) | ((bestLen - LZSS_MIN_MATCH) & 0xf);
          out.push((tok >> 8) & 0xff, tok & 0xff);
          i += bestLen;
        } else {
          flags |= (0x80 >> items);
          out.push(src[i]); i++;
        }
      }
      out[flagPos] = flags;
    }
    return out;
  }
  function lzssDecompress(src) {
    var out = [], i = 0, cap = src.length * INFLATE_CAP + 64;
    while (i < src.length) {
      var flags = src[i++], items = 0;
      while (items < 8 && i < src.length) {
        if (flags & (0x80 >> items)) { out.push(src[i++]); }
        else {
          if (i + 1 >= src.length) return null;
          var tok = (src[i] << 8) | src[i + 1]; i += 2;
          var off = ((tok >> 4) & 0xfff) + 1, len = (tok & 0xf) + LZSS_MIN_MATCH;
          if (off > out.length) return null;
          var p = out.length - off;
          for (var k = 0; k < len; k++) out.push(out[p + k]);
        }
        if (out.length > cap) return null; // cov-ignore: 64x bound; unreachable from a 4-bit length field
        items++;
      }
    }
    return out;
  }

  // ---------- bit I/O ----------
  function BitWriter() { this.bits = []; }
  BitWriter.prototype.u = function (val, n) {
    for (var i = n - 1; i >= 0; i--) this.bits.push((val >>> i) & 1);
  };
  BitWriter.prototype.bytes = function (arr) {
    for (var k = 0; k < arr.length; k++) this.u(arr[k] & 0xff, 8);
  };
  function BitReader(bits, at) { this.bits = bits; this.at = at || 0; }
  BitReader.prototype.u = function (n) {
    if (this.at + n > this.bits.length) return null;
    var v = 0;
    for (var i = 0; i < n; i++) v = (v << 1) | this.bits[this.at + i];
    this.at += n;
    return v >>> 0;
  };
  BitReader.prototype.bytes = function (n) {
    if (this.at + n * 8 > this.bits.length) return null;
    var out = [];
    for (var i = 0; i < n; i++) out.push(this.u(8));
    return out;
  };
  function bitsToBytesPadded(bits) {
    var padded = bits.slice();
    while (padded.length % 8) padded.push(0);
    return bitsToBytes(padded);
  }

  // ---------- field codes ----------
  var VER_ESCAPE = 7;         // version:3
  var TYPE_EXTENDED = 31;     // type:5
  var COMP_ESCAPE = 7;        // comp:3
  var ENC_ESCAPE = 7;         // enc:3

  // size 0 = variable (carries a varint length); non-zero = the type implies it.
  // Fixed types also COMPACT: a uuid travels as its 16 raw bytes rather than 36
  // characters, a sha256 as 32 rather than 64 — which more than pays back the
  // header on exactly the payloads people carry.
  var TYPE_DEFS = {
    string:    { code: 0,  size: 0 },
    json:      { code: 1,  size: 0 },
    bytes:     { code: 2,  size: 0 },
    ser8:      { code: 3,  size: 8 },
    uuid:      { code: 4,  size: 16 },
    sha256:    { code: 5,  size: 32 },
    program:   { code: 6,  size: 0 },
    encrypted: { code: 7,  size: 0 },
    extended:  { code: TYPE_EXTENDED, size: 0 }
  };
  var TYPE = {}, TYPE_NAME = {}, TYPE_SIZE = {};
  Object.keys(TYPE_DEFS).forEach(function (k) {
    TYPE[k] = TYPE_DEFS[k].code; TYPE_NAME[TYPE_DEFS[k].code] = k; TYPE_SIZE[TYPE_DEFS[k].code] = TYPE_DEFS[k].size;
  });

  var COMP = { none: 0, lzss: 1, deflateRaw: 2, gzip: 3, brotli: 4, zstd: 5 };
  var COMP_NAME = { 0: 'none', 1: 'lzss', 2: 'deflate-raw', 3: 'gzip', 4: 'brotli', 5: 'zstd' };
  var COMP_IMPL = { 0: 1, 1: 1 };   // what this codec can actually read or write
  var ENC = { none: 0, aes256gcm: 1, chacha20poly1305: 2 };
  var ENC_NAME = { 0: 'none', 1: 'aes-256-gcm', 2: 'chacha20-poly1305' };
  var ENC_IMPL = { 0: 1, 1: 1 };
  var ENC_OVERHEAD = 28;            // 12-byte nonce + 16-byte tag

  // A numeric type is passed through rather than masked to 5 bits, so a caller can
  // write a code point above 30 and exercise the escape. This codec will not READ
  // one back — parseFrameBits rejects unassigned types, because loosening that is
  // what pays for having no magic number (§7) — but the format must be able to
  // express what it specifies.
  function typeCode(t) {
    if (t === undefined || t === null) return TYPE.string;
    if (typeof t === 'number') return t < 0 ? TYPE.string : (t | 0);
    return TYPE[t] === undefined ? TYPE.string : TYPE[t];
  }

  // varint: 7 bits per byte, high bit set means another follows. One byte to 127,
  // and no 255-byte ceiling. Measured against exp-Golomb, which loses above
  // length 16 (11-17 bits vs 8-16) and costs a bit-serial decode.
  function putVarint(n) {
    var out = [];
    do { var b = n & 0x7f; n >>>= 7; out.push(n > 0 ? (b | 0x80) : b); } while (n > 0);
    return out;
  }
  function getVarint(bytes, at) {
    var n = 0, shift = 0, i = at;
    while (i < bytes.length) {
      var b = bytes[i++];
      n |= (b & 0x7f) << shift;
      if (!(b & 0x80)) return { value: n >>> 0, next: i };
      shift += 7;
      if (shift > 28) return null;   // absurd length: not a frame
    }
    return null;
  }
  function readVarintBits(r) {
    var n = 0, shift = 0;
    for (;;) {
      var b = r.u(8);
      if (b === null) return null;
      n |= (b & 0x7f) << shift;
      if (!(b & 0x80)) return n >>> 0;
      shift += 7;
      if (shift > 28) return null;
    }
  }

  // An escaped field continues in 8-bit extension bytes appended to `ext`, which the
  // caller emits grouped after the fixed header (§5). Ranges continue with no gap:
  // a 3-bit field covers 0-6 directly, 7-261 with one extension byte, and 0xFF in
  // an extension byte means another follows.
  function putField(w, ext, value, width) {
    var escape = (1 << width) - 1;
    if (value < escape) { w.u(value, width); return; }
    w.u(escape, width);
    var e = value - escape;
    while (e >= 0xff) { ext.push(0xff); e -= 0xff; }
    ext.push(e);
  }
  function readExt(r, escape) {
    var total = 0;
    for (;;) {
      var b = r.u(8);
      if (b === null) return null;
      total += b;
      if (b !== 0xff) return escape + total;
      if (total > 0xffff) return null;   // an absurd extension chain is not a packet
    }
  }

  function hexToBytes(h) {
    var out = []; for (var i = 0; i + 1 < h.length; i += 2) out.push(parseInt(h.substr(i, 2), 16));
    return out;
  }
  function bytesToHex(b) {
    var out = ''; for (var i = 0; i < b.length; i++) out += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return out;
  }
  function contentBytes(message, code) {
    if (code === TYPE.uuid) return hexToBytes(String(message).replace(/-/g, ''));
    if (code === TYPE.sha256) return hexToBytes(String(message));
    if (message instanceof Uint8Array || Array.isArray(message)) return Array.from(message);
    return utf8Encode(String(message));
  }
  function contentToMessage(bytes, code) {
    if (code === TYPE.uuid) {
      var h = bytesToHex(bytes);
      return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
    }
    if (code === TYPE.sha256) return bytesToHex(bytes);
    if (code === TYPE.bytes) return Array.prototype.slice.call(bytes);
    try { return utf8Decode(Array.from(bytes)); } catch (e) { return null; } // cov-ignore: TextDecoder is non-fatal
  }

  function inferType(message) {
    if (message instanceof Uint8Array || Array.isArray(message)) return TYPE.bytes;
    if (typeof message !== 'string') return TYPE.string;   // numbers, booleans: carried as text
    var t = message.trim();
    if ((t.charAt(0) === '{' && t.charAt(t.length - 1) === '}') ||
        (t.charAt(0) === '[' && t.charAt(t.length - 1) === ']')) {
      try { JSON.parse(t); return TYPE.json; } catch (e) { return TYPE.string; }
    }
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) return TYPE.uuid;
    if (/^[0-9a-f]{64}$/i.test(t)) return TYPE.sha256;
    // An 8-byte tag is the commonest payload there is, and the fixed type carries
    // it with no length field at all.
    if (utf8Encode(t).length === 8 && t === message) return TYPE.ser8;
    return TYPE.string;
  }

  // Default checksum width by stored size. The floor is crc16, NOT crc8, and that is
  // a measured decision rather than a cautious one.
  //
  // crc8 was the default for payloads under 32 bytes, on the reasoning that a short
  // payload cannot afford 16 bits of checksum on 64 bits of content. Then the noise
  // matrix caught a wrong payload: a damaged mark whose own copies had been shifted
  // fell back to the blind sweep, and the sweep accepted a chance window as a
  // 32-byte `sha256` packet — a fixed type, so no length field constrained it, and
  // 8 bits of CRC let 1 window in 256 through. The earlier false-accept measurement
  // (§7) used RANDOM streams and understated this: a real stream is structured, and
  // shifted copies of a real packet produce header-shaped bit patterns far more
  // often than noise does.
  //
  // crc16 costs 8 bits and drops that by a factor of 256. The capacity argument for
  // crc8 was weak anyway: an 8-byte serial is 89 bits with crc8 and 97 with crc16,
  // and a memo-sized passage holds 64 either way, so crc8 rescued nothing.
  function defaultCksumExp(nBytes) { return nBytes <= 512 ? 1 : 2; }

  // Build a v2 packet. Returns { bits, bytes, ...fields } — bits is the wire form,
  // bytes is the same padded to a byte boundary (what the RLNC layer splits on).
  function buildFrame(message, type, opts) {
    opts = opts || {};
    var code = typeCode(type);
    var content = contentBytes(message, code);
    var fixed = TYPE_SIZE[code] || 0;
    // A fixed type promises a size. If the payload does not match it is not that
    // type, so fall back rather than write a header that lies about itself.
    if (fixed && content.length !== fixed) { code = TYPE.string; content = utf8Encode(String(message)); fixed = 0; }
    // Sanity bound. No cover text can carry a 64 KB payload, but a caller can hand
    // one over, and truncating is better than emitting a packet whose length field
    // has silently wrapped.
    if (content.length > 65535) content = content.slice(0, 65535);
    var rawLen = content.length;   // before compression/encryption, for metadata

    // Compress, then keep the result only if it is strictly smaller (§4.3). spab
    // payloads are usually 8-200 bytes and every general-purpose compressor expands
    // inputs that small, so a format that compressed unconditionally would make its
    // most common payload bigger. Ties go to `none`: an uncompressed packet is
    // readable by a decoder that implements no compression at all.
    var comp = COMP.none;
    if (opts.compress !== false) {
      var z = lzssCompress(content);
      if (z.length < content.length) { content = z; comp = COMP.lzss; }
    }

    // Encrypt last, so the checksum and the length both describe the stored bytes.
    var enc = ENC.none, key = normalizeKey(opts.encKey);
    if (key) {
      content = aesGcmSeal(key, content, opts.nonce ? Array.prototype.slice.call(opts.nonce) : randomBytes(12));
      enc = ENC.aes256gcm;
    }

    // A fixed type may omit the length only while the stored form still has the
    // size the type implies. Compression or encryption changes it, so the length
    // comes back.
    var hasLen = !fixed || comp !== COMP.none || enc !== ENC.none;
    var ckExp = opts.cksum === undefined ? defaultCksumExp(content.length) : (opts.cksum | 0);

    var ext = [], w = new BitWriter();
    putField(w, ext, WIRE_VER, 3);
    putField(w, ext, code, 5);
    putField(w, ext, comp, 3);
    putField(w, ext, enc, 3);
    putField(w, ext, ckExp, 3);
    w.bytes(ext);
    if (hasLen) w.bytes(putVarint(content.length));

    // The checksum covers the header before it, plus the content — zero-padded to a
    // byte boundary — and then sits BEFORE the content on the wire (§3).
    var pre = w.bits, contentBits = bytesToBits(content);
    var ck = computeChecksum(bitsToBytesPadded(pre.concat(contentBits)), ckExp);
    var out = new BitWriter();
    out.bits = pre.slice();
    out.bytes(ck);
    out.bits = out.bits.concat(contentBits);
    while (out.bits.length % 8) out.bits.push(0);
    var headerBits = pre.length + cksumBits(ckExp);
    return { bits: out.bits, bytes: bitsToBytes(out.bits), type: code, comp: comp, enc: enc,
      cksum: ckExp, len: content.length, messageBytes: rawLen, ver: WIRE_VER,
      headerBits: headerBits, padBits: out.bits.length - headerBits - content.length * 8 };
  }

  // Read the header at bit offset `at`, or return null when this is not a packet —
  // which is the common case, since the sweep asks at every byte offset. Rejects
  // cheaply and in order: version, then comp/enc/cksum, then length plausibility.
  // The checksum is deliberately NOT checked here: folding needs the stride before
  // it can vote, so it needs a header read that costs nothing.
  function readHeader(bits, at) {
    var start = at || 0, r = new BitReader(bits, start);
    var vRaw = r.u(3), tRaw = r.u(5), cRaw = r.u(3), eRaw = r.u(3), kRaw = r.u(3);
    if (kRaw === null) return null;
    var ver = vRaw, type = tRaw, comp = cRaw, enc = eRaw, ckExp = kRaw;
    if (vRaw === VER_ESCAPE) { ver = readExt(r, VER_ESCAPE); if (ver === null) return null; }
    // Strictly this version. Accepting anything else would double the number of ways
    // a random bit window can look like a packet, and the sweep tests thousands.
    if (ver !== WIRE_VER) return null;
    if (tRaw === TYPE_EXTENDED) { type = readExt(r, TYPE_EXTENDED); if (type === null) return null; }
    // ANY type code is accepted, assigned or not. An unknown type still yields usable
    // bytes — the caller gets the payload and can interpret it — so forward
    // compatibility is worth real discrimination here. comp and enc are NOT relaxed
    // the same way: an unknown compression or cipher yields nothing usable, so
    // accepting one buys no capability and only costs sweep margin. Measured: strict
    // types reject all but 1 random window in 533k, permissive types 1 in 133k; on a
    // page-sized stream both measure zero false packets. dev/wire-format.md §7.
    if (cRaw === COMP_ESCAPE) { comp = readExt(r, COMP_ESCAPE); if (comp === null) return null; }
    if (COMP_NAME[comp] === undefined) return null;
    if (eRaw === ENC_ESCAPE) { enc = readExt(r, ENC_ESCAPE); if (enc === null) return null; }
    if (ENC_NAME[enc] === undefined) return null;
    if (kRaw === CK_ESCAPE) { ckExp = readExt(r, CK_ESCAPE); if (ckExp === null) return null; }
    // 6 (512 bits) is reserved — it needs SHA-512 — and anything above is an
    // extension this build does not implement. Refuse rather than guess.
    if (ckExp > CK_MAX_EXP) return null;

    var fixed = TYPE_SIZE[type] || 0;
    // A fixed type may omit its length only while the stored form still has the size
    // the type implies. Compression or encryption changes it, so the length returns.
    var hasLen = !fixed || comp !== COMP.none || enc !== ENC.none;
    var len;
    if (hasLen) { len = readVarintBits(r); if (len === null) return null; } else { len = fixed; }
    if (len < 1) return null;
    return { ver: ver, type: type, comp: comp, enc: enc, cksum: ckExp, len: len, at: r.at, start: start };
  }

  // How many bits a packet occupies, read from its own header — the stride the fold
  // needs before it can vote.
  function frameBitSize(bits, at) {
    var h = readHeader(bits, at);
    if (!h) return null;
    var total = (h.at - h.start) + cksumBits(h.cksum) + h.len * 8;
    while (total % 8) total++;
    return total;
  }

  // Read and verify a whole packet at bit offset `at`.
  function parseFrameBits(bits, at) {
    var h = readHeader(bits, at);
    if (!h) return null;
    var r = new BitReader(bits, h.at);
    var preEnd = h.at;
    var ckBytes = r.bytes(cksumBits(h.cksum) / 8);
    if (ckBytes === null) return null;
    var contentAt = r.at;
    var content = r.bytes(h.len);
    if (content === null) return null;

    // The checksum covers the header before it, then the content as stored, the two
    // concatenated and zero-padded to a byte boundary (§3).
    var want = computeChecksum(bitsToBytesPadded(
      bits.slice(h.start, preEnd).concat(bits.slice(contentAt, contentAt + h.len * 8))), h.cksum);
    for (var i = 0; i < want.length; i++) if (want[i] !== ckBytes[i]) return null;

    var end = r.at;
    while ((end - h.start) % 8) end++;
    return { ver: h.ver, type: h.type, comp: h.comp, enc: h.enc, cksum: h.cksum, len: h.len,
      content: content, bits: end - h.start };
  }

  // Undo the stored form: decrypt, then decompress, then interpret as the type.
  // Every failure is named rather than collapsed into "not detected", because a
  // packet that was found and could not be opened is a different fact from a packet
  // that was never there — and the caller can act on the difference.
  function openContent(f, opts) {
    var bytes = f.content;
    if (f.enc !== ENC.none) {
      if (!ENC_IMPL[f.enc]) return { fail: 'unsupported', detail: 'enc=' + ENC_NAME[f.enc] };
      var key = normalizeKey(opts && opts.encKey);
      if (!key) return { fail: 'encrypted', detail: 'payload is encrypted; supply params.encKey' };
      bytes = aesGcmOpen(key, bytes);
      if (!bytes) return { fail: 'auth-failed', detail: 'wrong key, or the ciphertext was altered' };
    }
    if (f.comp !== COMP.none) {
      if (!COMP_IMPL[f.comp]) return { fail: 'unsupported', detail: 'comp=' + COMP_NAME[f.comp] };
      bytes = lzssDecompress(bytes);
      if (!bytes) return { fail: 'corrupt', detail: 'compressed stream did not decode' };
    }
    return { bytes: bytes, message: contentToMessage(bytes, f.type) };
  }

  // Field names for metadata, so a caller (and the CLI) can see what was on the wire.
  function frameFields(f) {
    return {
      wireVersion: f.ver,
      type: TYPE_NAME[f.type] || ('0x' + f.type.toString(16)),
      typeCode: f.type,
      // comp and enc are always assigned code points: readHeader rejects anything
      // else, so unlike `type` these need no unknown-value fallback.
      compression: COMP_NAME[f.comp],
      encryption: ENC_NAME[f.enc],
      encrypted: f.enc !== ENC.none,
      checksum: 'crc' + cksumBits(f.cksum),
      checksumBits: cksumBits(f.cksum),
      payloadBytes: f.len
    };
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
  // The keyed layer used to build ONE Fisher-Yates permutation over all `n` digits.
  // That made the permutation a function of the carrier count, so any edit that
  // added or removed a site — appending a sentence, quoting an excerpt — changed
  // every position at once and the stream descrambled to noise. Resynchronisation
  // had to be switched off for keyed marks as a result, and the cost was measured:
  // under structural damage, keyed recovery was 27% against unkeyed's 97%, and the
  // correlation with carrier-count change was exact. Every model that preserved the
  // count recovered; every model that changed it scored zero.
  //
  // Now the permutation is over a FIXED-SIZE BLOCK and is identical for every block,
  // so it does not depend on `n` at all. A shift of k sites moves which block a
  // digit lands in but not the permutation itself, and the phase sweep — which
  // tries "assume p digits were dropped from the front" for p in 0..31 — realigns
  // it. Whitening stays keyed to absolute index, which the same sweep re-derives.
  //
  // The cost, stated plainly: a permutation that repeats every KEY_BLOCK digits is
  // weaker than a global one. That is the right trade now in a way it was not
  // before 0.5.0 — `key` is documented as a cost multiplier rather than
  // confidentiality, and `encKey` (AES-256-GCM) is the real confidentiality
  // mechanism. Resynchronisable keyed marks are worth more than an unbreakable
  // interleave on a mark that any edit destroys.
  var KEY_BLOCK = 32;   // <= MAX_PHASE, so one phase always realigns the grid

  function keyStreams(n, radix, seed) {
    var g = prng32(seed), b = Math.min(KEY_BLOCK, n), perm = new Array(b), i, j, t;
    for (i = 0; i < b; i++) perm[i] = i;
    for (i = b - 1; i > 0; i--) { j = g() % (i + 1); t = perm[i]; perm[i] = perm[j]; perm[j] = t; } // Fisher-Yates
    // Whitening is block-local for the same reason the permutation is. Keying it to
    // ABSOLUTE index left one failure standing: quoting the last two thirds of a
    // document drops ~125 sites off the front, and no sweep over 32 phases can undo
    // a shift that large. Repeating every KEY_BLOCK makes any shift equivalent to
    // shift mod 32, which the sweep does cover. Whitening exists for energy
    // dispersal, not secrecy, so a repeating sequence costs little here.
    var pn = new Array(b);
    for (i = 0; i < b; i++) pn[i] = g() % radix;
    return { perm: perm, pn: pn, block: b };
  }
  // Map position i to its permuted position within i's own block. A trailing
  // partial block is left in place: permuting it would need a different-sized
  // permutation, which is exactly the n-dependence this removes.
  function keyIndex(ks, i, n) {
    var base = i - (i % ks.block);
    return (base + ks.block <= n) ? base + ks.perm[i % ks.block] : i;
  }
  function scramble(digits, radix, seed) {
    var n = digits.length, ks = keyStreams(n, radix, seed), out = new Array(n), i;
    for (i = 0; i < n; i++) out[keyIndex(ks, i, n)] = (digits[i] + ks.pn[i % ks.block]) % radix; // whiten then interleave
    return out;
  }
  function descramble(physical, radix, seed) {
    var n = physical.length, ks = keyStreams(n, radix, seed), out = new Array(n), i;
    for (i = 0; i < n; i++) out[i] = ((physical[keyIndex(ks, i, n)] - ks.pn[i % ks.block]) % radix + radix) % radix;
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
    // Type: explicit wins; otherwise infer, since a caller passing JSON almost
    // always wants it back as JSON. Inference only ever picks `json` for something
    // that actually parses, so a string that merely starts with a brace is safe.
    var payloadType = params.type !== undefined ? params.type : inferType(message);
    var packet = buildFrame(message, payloadType, {
      compress: params.compress, cksum: params.cksum, encKey: params.encKey, nonce: params.nonce
    });
    var frameBits = packet.bits;
    var frame = packet.bytes;
    var K = frame.length; // RLNC source symbols (= packet bytes, padded to a byte boundary)
    var arr = cover.split('');
    var channels = {}, issues = [], primary = null;
    var esiBase = 0; // RLNC: channels emit DISJOINT esi ranges so their packets combine
    var density = params.density || ZW_DENSITY;
    var maxSites = params.block || 0; // optional block-size cap (sites); 0 = product-cap only
    var key = params.key;             // optional keyed scramble (interleave + whitening)
    var insPlans = []; // insert-kind carriers applied after substitution carriers

    // ---- auto-grow: make room for a payload the cover text cannot hold ----
    //
    // Substitution carriers are bounded by the text: a passage has however many
    // spaces and quotes it has, and a long payload simply does not fit — encode
    // used to emit one truncated copy and a warning, which decodes to nothing.
    // The zero-width carrier inserts rather than substitutes, so its capacity is
    // set by `density` (zero-width chars per word gap) and can be raised until the
    // payload fits. That is the StegCloak trade: the text reads identically and
    // keeps its visible length, but it now carries extra invisible characters, so
    // the byte count grows and the mark is obvious to anyone looking at hex.
    //
    // `redundancy` is how many copies of the frame to aim for. When growth is
    // needed it defaults to 3 rather than 1: these are cases that previously
    // encoded a truncated copy and decoded to nothing, so there is no behaviour to
    // preserve, and a single copy is brittle by construction — one edit anywhere
    // destroys it. Growing to one copy would trade a broken mark for a fragile
    // one. Passages that already fit are untouched.
    var redundancy = Math.max(1, params.redundancy || AUTO_GROW_REPS);
    // OPT-IN, deliberately. Growing means inserting zero-width characters, which
    // breaks the invariant most callers are here for: substitution carriers leave
    // the text byte-for-byte the same length. Defaulting this on turned every
    // "payload does not fit" case into a silent length change — the fuzz suite
    // caught it as 894 length-changed failures. A caller who wants a payload
    // larger than the text can hold has to say so.
    var autoGrow = params.autoGrow === true && ids.length > 0;
    if (autoGrow) {
      var oneCopy = (ecc === 'rlnc' ? K * 32 : frameBits.length);
      var needBits = oneCopy * redundancy;
      var subCap = 0;
      ids.forEach(function (id) {
        var d = CLASS_DEFS[id];
        if (d.kind === 'ins') return;
        subCap = Math.max(subCap, symCapacityBits(filledRadices(d.detect(cover).length, d.radix), maxSites));
      });
      // Grow only when the payload does not fit AT ALL. Length preservation is the
      // property most callers are here for, so a passage that holds even one copy
      // is left exactly as written — growing it to reach the redundancy target
      // would inflate text that was working. Once growth is unavoidable, though,
      // size for `redundancy` copies: the characters are being inserted anyway.
      if (subCap < oneCopy) {
        if (ids.indexOf('zwsp') < 0) ids = ids.concat(['zwsp']);
        var gaps = CLASS_DEFS.zwsp.anchors(cover).length;
        if (gaps > 0) {
          // Raise density until the zero-width channel alone covers the target.
          // Capacity is not exactly gaps*density*2 bits (mixed-radix blocks round
          // down), so ask the packer rather than assuming.
          var want = density;
          while (want < ZW_MAX_DENSITY &&
                 symCapacityBits(filledRadices(gaps * want, CLASS_DEFS.zwsp.radix), maxSites) < needBits) want++;
          density = want;
        }
      }
    }

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
        insPlans.push({ def: def, digits: digits, perGap: density, at: idx });
      } else {
        for (var s = 0; s < idx.length; s++) arr[idx[s]] = def.glyph(digits[s]);
      }
      channels[id] = { sites: idx.length, capacityBits: cap, reps: reps, tooShort: tooShort };
      if (!primary) primary = id;
    });

    var outText = arr.join('');
    insPlans.forEach(function (pl) { outText = pl.def.embed(outText, pl.digits, pl.perGap, pl.at); });

    // Warnings from the strongest channel (the one carrying the most copies).
    var best = null;
    Object.keys(channels).forEach(function (id) {
      if (!best) { best = id; return; }
      var c = channels[id], b = channels[best];
      var better = (!c.tooShort && b.tooShort) ||
        (c.tooShort === b.tooShort && (c.reps > b.reps ||
          (c.reps === b.reps && c.capacityBits > b.capacityBits)));
      if (better) best = id;
    });
    if (best) {
      var bc = channels[best];
      // The requirement differs by ECC mode, and reporting the wrong one is worse
      // than reporting nothing: RLNC spends a 32-bit self-checking packet per source
      // byte, so a 52-byte packet needs 1664 bits where repetition needs 416. The
      // message used to quote the repetition figure in both modes, which read as
      // "needs 416, has 1314" — a warning that contradicted itself.
      var needBits = (ecc === 'rlnc') ? K * 32 : frameBits.length;
      if (bc.tooShort) issues.push('Passage too short for any channel: ' + ecc + ' needs ' + needBits +
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
        type: TYPE_NAME[packet.type] || ('0x' + packet.type.toString(16)),
        typeCode: packet.type,
        wireVersion: packet.ver,
        frameVersion: 'v' + packet.ver,
        compression: COMP_NAME[packet.comp],
        encryption: ENC_NAME[packet.enc],
        encrypted: packet.enc !== ENC.none,
        checksum: 'crc' + cksumBits(packet.cksum),
        checksumBits: cksumBits(packet.cksum),
        channels: channels,
        slots: pc.sites,             // back-compat: primary/strongest channel
        capacityBits: pc.capacityBits,
        frameBits: frameBits.length,
        frameBytes: frame.length,
        headerBits: packet.headerBits,
        padBits: packet.padBits,
        reps: pc.reps,
        payloadBytes: packet.len,
        messageBytes: packet.messageBytes,
        issues: issues
      }
    };
  }

  // Fold a channel's repeated bit stream and parse one packet out of it.
  //
  // Packets repeat back-to-back to fill the channel, so `reps` copies of the same
  // bits are voted per position. The stride has to be known before the vote can
  // start, and the header is what states it — which is why frameBitSize() is
  // header-only and does not verify the checksum.
  function foldParse(bits, opts) {
    var total = bits.length;
    if (total < 32) return notDetected();
    var frameBits = frameBitSize(bits, 0);
    if (!frameBits || frameBits > total) return notDetected();
    var reps = Math.floor(total / frameBits); // frameBits ≥ 32, so this is ≥ 1 here

    // Plain per-bit majority vote, deliberately.
    //
    // A reliability-weighted vote was built and measured, using per-site confidence
    // from the soft layer (SPAB.soft) to down-weight blocks holding more ambiguous
    // default glyphs. It never helped and twice hurt: scattered folding at 5% went
    // 56% -> 50%, at 20% went 6% -> 0%. The reason is that the weight cannot tell a
    // DAMAGED default glyph from a legitimately sent one — about 1/radix of sites
    // carry the default value in an intact stream — so it penalises good blocks for
    // their content. Soft information is real and the detector exposes it, but this
    // is not where it pays. Recorded in dev/roadmap.md so it is not rebuilt.
    var folded = [], agSum = 0, agCnt = 0;
    for (var b = 0; b < frameBits; b++) {
      var ones = 0, cnt = 0;
      for (var r = 0; r < reps; r++) { var idx = r * frameBits + b; if (idx < total) { cnt++; ones += bits[idx]; } }
      folded.push(ones * 2 > cnt ? 1 : 0);
      agSum += Math.max(ones, cnt - ones) / cnt; agCnt++;
    }
    var agreement = agSum / agCnt; // agCnt = frameBits ≥ 32
    var f = parseFrameBits(folded, 0);
    if (!f) {
      // The header parsed well enough to give a stride, so something was there;
      // that is a different fact from "no packet at all".
      return { status: 'failed', message: null, confidence: +Math.max(0, agreement - 0.5).toFixed(3),
        agreement: +agreement.toFixed(3), reps: reps, payloadBytes: 0, crcOk: false, rawMessage: null };
    }
    return Object.assign(frameResult(f, opts, agreement >= 0.999 ? 'perfect' : 'corrected',
      Math.min(1, 0.5 + 0.5 * agreement)), { agreement: +agreement.toFixed(3), reps: reps });
  }

  function notDetected() {
    return { status: 'not-detected', message: null, confidence: 0, crcOk: false };
  }

  // A parsed packet -> the caller-facing result. The packet is intact (its checksum
  // verified) even when the content cannot be opened: an unreadable payload with a
  // valid checksum means "found it, could not open it", and saying so is more
  // useful than reporting nothing was there.
  function frameResult(f, opts, status, confidence) {
    var open = openContent(f, opts);
    var base = Object.assign({ crcOk: true, confidence: +confidence.toFixed(3) }, frameFields(f));
    if (open.fail) {
      return Object.assign(base, { status: open.fail, message: null, rawMessage: null,
        detail: open.detail, bytes: f.content });
    }
    return Object.assign(base, { status: status, message: open.message, rawMessage: open.message,
      bytes: open.bytes, messageBytes: open.bytes.length });
  }

  // Frame bytes (from the RLNC solve) -> parsed message result.
  // ONE layout, deliberately. Accepting the 0.4.x frame as a fallback was tried and
  // reverted: a CRC-8 validates by chance about once in 256, so parsing two layouts
  // doubles the odds of a false frame, and it happened immediately — a uuid payload
  // came back as a "legacy string". Marks written by 0.4.x therefore do not decode
  // here, which is what the version field exists to make explicit rather than a
  // guess. That is a wire-format break and is why this is a minor bump.
  function frameToResult(bytes, extra, opts) {
    // cov-ignore: rlncSolve always returns at least K ≥ 4 bytes
    if (!bytes || bytes.length < 4) return Object.assign(notDetected(), extra);
    var f = parseFrameBits(bytesToBits(bytes), 0);
    if (!f) {
      return Object.assign({ status: 'failed', message: null, confidence: 0,
        payloadBytes: 0, crcOk: false, rawMessage: null }, extra);
    }
    // cov-ignore: extra.corrected is unused by decodeRLNC today
    return Object.assign(frameResult(f, opts, (extra && extra.corrected) ? 'corrected' : 'perfect', 1), extra);
  }

  // Look for one intact packet anywhere in the stream, across block-grid phases and
  // byte-aligned starts. Packets are self-contained and checksummed, so an intact
  // copy needs no agreement from its neighbours — this is what recovers a payload
  // whose later copies were shifted by an edit.
  //
  // Byte-aligned starts, not every bit: packets are padded to a byte boundary
  // precisely so this sweep tests one offset in eight. With no magic number the
  // header's own plausibility plus the checksum is the whole discriminator
  // (dev/wire-format.md §7), and testing 8x fewer windows is 3 of those bits back.
  function scanFrame(text, id, key, maxSites, opts) {
    var def = CLASS_DEFS[id], digits = classDigits(text, id), phases = phaseCount(key, digits.length);
    var seen = {}, best = null;

    // Collect every packet that parses, across phases and byte offsets, and count
    // how often each distinct payload appears. A CRC-8 validates by chance about
    // once in 256 and this sweep tests thousands of windows, so the first packet
    // that parses is not necessarily the real one — an unknown-type payload was
    // being lost to exactly that. Real packets repeat (the payload is written many
    // times over); a chance match does not. Frequency separates them.
    for (var ph = 0; ph < phases; ph++) {
      var bits = phaseBits(digits, ph, def, key, id, maxSites);
      for (var o = 0; o + 32 <= bits.length; o += 8) {
        var f = parseFrameBits(bits, o);
        if (!f) continue;
        var sig = f.type + ':' + f.comp + ':' + f.enc + ':' + f.content.join(',');
        var hit = seen[sig];
        if (hit) { hit.n++; } else { seen[sig] = hit = { n: 1, f: f }; }
        if (!best || hit.n > best.n) best = hit;
      }
    }
    // A blind sweep is held to a higher evidentiary standard than the fold, and
    // deliberately so. The fold knows where packets start and measures agreement
    // across copies; this tests thousands of windows (32 block-grid phases x every
    // byte offset) and any one of them may pass by chance. So a packet found here
    // must either carry a checksum of at least 16 bits, or have been seen more than
    // once.
    //
    // Measured over 1539 thin damaged marks — thin meaning at most two copies fit,
    // which is what forces this path — across checksum widths 8 to 256 bits:
    //
    //   without this rule:  2 WRONG payloads,  885 recovered
    //   with it:            0 WRONG payloads,  864 recovered
    //
    // So it costs 21 recoveries (2.4%) to remove a 0.13% chance of confidently
    // returning something that was never written. Both failures were the same shape:
    // a chance window read as a 32-byte `sha256` packet, which is a FIXED type, so no
    // length field constrained it and 8 bits of CRC were the only thing standing in
    // the way. For a provenance tool a wrong answer is categorically worse than a
    // missed one, and "never a silent wrong answer" is a contract the noise matrix
    // asserts, so this is the right side of that trade.
    if (best && best.f.cksum < 1 && best.n < 2) best = null;
    if (!best) return null;
    return Object.assign(frameResult(best.f, opts, 'corrected', 0.75),
      { agreement: 1, reps: best.n, resynced: true });
  }

  // RLNC decode: pool self-checking packets from ALL channels and solve.
  //
  // The requirement is K linearly INDEPENDENT equations, not merely K packets. The
  // systematic ESIs (0..K-1) are independent by construction; repair rows are random
  // over GF(256) and independent with overwhelming probability, but an arbitrary set
  // of K rows is not guaranteed full rank. rlncSolve detects an under-rank system and
  // returns null rather than a wrong answer, and callers should collect K + a few
  // repair packets rather than exactly K.
  function decodeRLNC(text, ids, key, maxSites, opts) {
    var pool = {}, count = 0;

    // Pool packets from one block-grid phase across every channel.
    function addPhase(ph) {
      ids.forEach(function (id) {
        var def = CLASS_DEFS[id], digits = classDigits(text, id);
        if (ph >= phaseCount(key, digits.length)) return;
        parsePackets(phaseBits(digits, ph, def, key, id, maxSites)).forEach(function (pk) {
          if (!(pk.esi in pool)) { pool[pk.esi] = pk.val; count++; }
        });
      });
    }

    // Phase 0 alone first — the ordinary case, and identical to what this always
    // did. Extra phases are only reached when that fails, because they are not
    // free: a packet CRC is 8 bits, so roughly 1 window in 256 validates by
    // chance, and a long stream swept across 32 phases offers thousands of
    // windows. One false packet is enough to poison the linear solve, so the
    // sweep is held back until there is nothing to lose by trying it.
    addPhase(0);
    // K = source symbols = frame length = len + 3; get len from systematic packet esi=1 if clean.
    function attempt() {
      var pk = Object.keys(pool).map(function (e) { return { esi: +e, val: pool[e] }; });
      var cand = [];
        // K = frame length = content length + framing. The length now lives in byte 3
      // of the frame, so the systematic packet that carries it is esi 3, not 1.
      if (3 in pool) cand.push(pool[3] + 5);
      for (var Kg = 4; Kg <= 80; Kg++) if (cand.indexOf(Kg) < 0) cand.push(Kg);
      for (var ci = 0; ci < cand.length; ci++) {
        var K = cand[ci];
        if (pk.length < K) continue;
        var src = rlncSolve(pk, K);
        if (!src) continue; // cov-ignore: pairs with rlncSolve's under-rank return (unreachable with genuine packets)
        var res = frameToResult(src, { channel: 'rlnc', packets: count }, opts);
        if (res.crcOk) return res;
      }
      return null;
    }

    var got = count >= 4 ? attempt() : null;
    if (got) return got;

    // Nothing solved from the aligned pass, so the stream may have been shifted by
    // an inserted or deleted site. Widen to the other phases and try again. Note
    // this runs even when phase 0 pooled almost nothing: a shift early in the text
    // leaves the aligned pass with a handful of packets or none, and that is
    // exactly the case the sweep exists for.
    var maxPh = 1;
    ids.forEach(function (id) { maxPh = Math.max(maxPh, phaseCount(key, classDigits(text, id).length)); });
    for (var ph = 1; ph < maxPh; ph++) addPhase(ph);

    if (count < 4) return { status: 'not-detected', message: null, confidence: 0, crcOk: false, packets: count };
    got = attempt();
    if (got) return got;

    return { status: 'failed', message: null, confidence: 0, crcOk: false, packets: count, channel: 'rlnc' };
  }

  // ---------- decode ----------
  // Try each enabled class independently; return the best-decoding channel.
  function decode(text, params) {
    params = params || {};
    var ids = resolveClasses(params);
    var key = params.key, maxSites = params.block || 0;

    // Zero-width carriers announce themselves: the characters are either in the
    // text or they are not. encode() adds this channel on its own when a payload
    // will not fit the substitution carriers (see auto-grow), and a caller
    // decoding with the same params would otherwise never look for it. Checking
    // costs one scan and nothing at all when no such character is present.
    if (ids.indexOf('zwsp') < 0 && hasZeroWidth(text)) ids = ids.concat(['zwsp']);
    if (params.ecc === 'rlnc') {
      var r = decodeRLNC(text, ids, key, maxSites, params);
      return { message: r.message, metadata: { status: r.status, confidence: r.confidence, ecc: 'rlnc',
        crcOk: r.crcOk, payloadBytes: r.payloadBytes, packets: r.packets, channel: r.channel, rawMessage: r.rawMessage,
        type: r.type, typeCode: r.typeCode, wireVersion: r.wireVersion, frameVersion: r.wireVersion && ('v' + r.wireVersion),
        compression: r.compression, encryption: r.encryption, encrypted: r.encrypted,
        checksum: r.checksum, checksumBits: r.checksumBits, detail: r.detail,
        messageBytes: r.messageBytes, bytes: r.bytes } };
    }
    var rank = { perfect: 3, corrected: 2, failed: 1, 'not-detected': 0 };
    var best = null, bestId = null;
    ids.forEach(function (id) {
      var c = foldParse(readClassBits(text, id, key, maxSites), params);
      // Majority voting assumes every copy starts where the first one did. After an
      // insertion or deletion the later copies are shifted, and folding averages
      // intact copies together with noise. A single self-contained packet is enough
      // on its own — it carries its own checksum — so go looking for one.
      if (!c.crcOk) { var r = scanFrame(text, id, key, maxSites, params); if (r) c = r; }
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
        // Reported on both paths: decodeRLNC sets it too, and a caller comparing the
        // two results should not have to know which one filled the field in.
        ecc: 'repetition',
        reps: best.reps, payloadBytes: best.payloadBytes, crcOk: best.crcOk,
        channel: bestId, rawMessage: best.rawMessage,
        type: best.type, typeCode: best.typeCode,
        wireVersion: best.wireVersion, frameVersion: best.wireVersion && ('v' + best.wireVersion),
        compression: best.compression, encryption: best.encryption, encrypted: best.encrypted,
        checksum: best.checksum, checksumBits: best.checksumBits, detail: best.detail,
        messageBytes: best.messageBytes, bytes: best.bytes
      }
    };
  }


  // ---------- soft layer: channel estimation and the likelihood field ----------
  //
  // The shipping demodulator reads each site as an exact digit and throws away how
  // sure it was. That discards real information, because THE CHANNEL IS ASYMMETRIC:
  // normalization, typography correction and whitespace collapse all fold carrier
  // variants back onto the default glyph, and nothing does the reverse. No pipeline
  // turns a plain space into a thin space.
  //
  // So the two observations are not equally informative:
  //   - a NON-DEFAULT variant is near-certain — only the encoder puts one there;
  //   - the DEFAULT glyph is ambiguous — it may have been sent, or it may be any
  //     variant that got collapsed on the way.
  //
  // How ambiguous depends on how much collapsing happened, and that is measurable
  // from the carrier histogram itself: an intact marked stream is close to uniform
  // over the radix, so excess mass on the default value is the signature of
  // collapse. That is channel estimation with no pilots — the histogram IS the
  // pilot. See dev/roadmap.md.
  var SOFT_EPS = 0.02;   // residual doubt on a non-default observation

  // Fraction of sites that look collapsed. If a fraction f of a uniform stream is
  // folded onto value 0, then h[0] ~ n/r + n*f*(1 - 1/r), so f follows from the
  // excess. Returns 0 for an intact stream, ->1 for a fully normalized one.
  function estimateCollapse(digits, radix) {
    var n = digits.length;
    if (!n) return 0;
    var h0 = 0;
    for (var i = 0; i < n; i++) if (digits[i] === 0) h0++;
    var excess = h0 - n / radix;
    if (excess <= 0) return 0;
    return Math.min(0.99, excess / (n * (1 - 1 / radix)));
  }

  // P(sent = v | observed), as a vector over the radix.
  function softDigit(observed, radix, collapse) {
    var p = new Array(radix), v;
    if (observed !== 0) {
      for (v = 0; v < radix; v++) p[v] = SOFT_EPS / (radix - 1);
      p[observed] = 1 - SOFT_EPS;
      return p;
    }
    // The default glyph: either it was sent, or a variant collapsed onto it.
    var sent0 = 1 / radix, collapsed = collapse / radix, tot = sent0 + (radix - 1) * collapsed;
    p[0] = sent0 / tot;
    for (v = 1; v < radix; v++) p[v] = collapsed / tot;
    return p;
  }

  // Per-site posterior over the radix, plus the channel estimate that produced it.
  function classSoft(text, id) {
    var digits = classDigits(text, id), radix = CLASS_DEFS[id].radix;
    var collapse = estimateCollapse(digits, radix), out = new Array(digits.length);
    for (var i = 0; i < digits.length; i++) out[i] = softDigit(digits[i], radix, collapse);
    return { digits: digits, radix: radix, collapse: collapse, posteriors: out };
  }

  // Confidence that a site's hard read is right — max of its posterior. 1/radix
  // means "no information", 1 means certain.
  function siteConfidence(p) {
    var m = 0;
    for (var i = 0; i < p.length; i++) if (p[i] > m) m = p[i];
    return m;
  }

  // ---------- the sliding histogram detector ----------
  //
  // Slide a window of `n` sites and, at each position, report the histogram of
  // carrier values and how far it sits from the uniform distribution an encoded
  // stream produces. This is the acquisition primitive the architecture asks for:
  // its output is a FIELD over position, not a symbol stream, and a caller (or a
  // later sequence decoder) picks structure out of it.
  //
  // Why a window rather than the whole document: marks are local. A document that
  // is half marked and half pasted-in plain text has a uniform histogram over the
  // marked half and a spike at the default over the other, and only a sliding view
  // can see the boundary. The window is advanced incrementally — one site out, one
  // site in — so the whole field costs O(sites), not O(sites x n).
  function likelihoodField(text, id, n) {
    var d = classSoft(text, id), digits = d.digits, radix = d.radix;
    n = n || Math.min(32, digits.length);
    var out = [];
    if (!digits.length || n <= 0 || n > digits.length) return { window: n, radix: radix, collapse: d.collapse, field: out };
    var h = new Array(radix), i, v;
    for (v = 0; v < radix; v++) h[v] = 0;
    for (i = 0; i < n; i++) h[digits[i]]++;
    for (var pos = 0; pos + n <= digits.length; pos++) {
      if (pos > 0) { h[digits[pos - 1]]--; h[digits[pos + n - 1]]++; }
      // Chi-square against uniform. A marked window sits near 0; unmarked prose,
      // where every site is the default glyph, sits at its maximum.
      var expct = n / radix, chi = 0;
      for (v = 0; v < radix; v++) chi += (h[v] - expct) * (h[v] - expct) / expct;
      var chiMax = n * (radix - 1);      // all mass on one value
      out.push({ at: pos, counts: h.slice(), chi2: +chi.toFixed(4),
        marked: +Math.max(0, 1 - chi / chiMax).toFixed(4) });
    }
    return { window: n, radix: radix, collapse: d.collapse, field: out };
  }

  // Public: the likelihood field for every enabled carrier class, plus the per-site
  // posteriors. Exposed because the physical layer should be inspectable on its own
  // — a caller diagnosing a failed decode wants to see WHERE the mark stopped
  // looking like a mark, which a boolean cannot say.
  function detect(text, params) {
    params = params || {};
    var ids = resolveClasses(params), n = params.window || 0, out = {};
    ids.forEach(function (id) {
      var soft = classSoft(text, id);
      var lf = likelihoodField(text, id, n || Math.min(32, soft.digits.length));
      var confSum = 0;
      for (var i = 0; i < soft.posteriors.length; i++) confSum += siteConfidence(soft.posteriors[i]);
      out[id] = {
        sites: soft.digits.length,
        radix: soft.radix,
        collapse: +soft.collapse.toFixed(4),
        meanConfidence: soft.digits.length ? +(confSum / soft.digits.length).toFixed(4) : 0,
        window: lf.window,
        field: lf.field,
        posteriors: soft.posteriors
      };
    });
    return out;
  }

  // ---------- introspection (ws-only, back-compat) ----------
  function getSlots(text) { return CLASS_DEFS.ws.detect(text); } // whitespace sites
  function histogram(text) {
    var slots = CLASS_DEFS.ws.detect(text), h = [0, 0, 0, 0];
    for (var i = 0; i < slots.length; i++) { var v = WS_SET[text[slots[i]]]; if (v !== undefined) h[v]++; }
    return { counts: h, total: slots.length };
  }

  // ---------- version / algorithm descriptor ----------
  var VERSION = '0.5.1';
  var algorithm = {
    version: VERSION,
    name: 'plugsym-rep+rlnc',
    summary: 'Pluggable symbol library, independent parallel per-class channels. Two ECC ' +
             'modes: repetition+majority (default) per channel, or a GF(256) systematic ' +
             'RLNC fountain (ecc:"rlnc") whose self-checking/self-locating 32-bit packets ' +
             'pool across channels so surviving carriers reconstruct from any K linearly ' +
             'independent packets. Default carriers ' +
             '= whitespace + confusables (quote, hyphen), co-equal; whitespace is NFKC-fragile, ' +
             'confusables survive NFKC. Wire format v2 packets (dev/wire-format.md).',
    classes: {
      ws: { bits: 2, variants: ['U+0020', 'U+2006', 'U+2009', 'U+200A'], defaultOn: true, nfkcSurvives: false },
      apos: { bits: 1, variants: ['U+0027', 'U+2019'], defaultOn: true, nfkcSurvives: true },
      hyphen: { bits: 1, variants: ['U+002D', 'U+2010'], defaultOn: true, nfkcSurvives: true },
      wsdense: { bits: 3, kind: 'substitute', variants: ['U+0020', 'U+2009', 'U+200A', 'U+2006', 'U+2005', 'U+2004', 'U+2008', 'U+205F'], defaultOn: false, nfkcSurvives: false, note: 'dense, length-preserving; some variants differ in width' },
      zwsp: { bits: 2, kind: 'insert', variants: ['U+200B', 'U+200C', 'U+200D', 'U+2060'], defaultOn: false, nfkcSurvives: false, note: 'dense, ADDS zero-width chars (StegCloak/330k style); length grows, visible in hex' }
    },
    ecc: {
      repetition: 'per-channel packet repetition + per-bit majority vote',
      rlnc: 'GF(256) systematic random-linear fountain; 32-bit packets [esi|val|crc]; brute-force/len-hinted K'
    },
    // This descriptor is the CONTRACT, and tests assert the implementation matches
    // it. It previously described whatever the code happened to do — which is how a
    // type field specified in the original design was absent from the first working
    // commit onward and nothing ever noticed. A self-description that mirrors the
    // implementation cannot catch the implementation drifting from the spec.
    frame: {
      version: WIRE_VER,
      spec: 'dev/wire-format.md',
      layout: '[ver:3|type:5|comp:3|enc:3|cksum:3][extensions, grouped, field order]' +
        '[len varint, when not implied][checksum][content][pad to byte]',
      fields: ['version:3', 'type:5', 'comp:3', 'enc:3', 'cksum:3', 'extension bytes (escaped fields only)',
        'len (varint; omitted for a fixed type stored plain)', 'checksum (8 << cksum bits)', 'content', 'pad'],
      fixedHeaderBits: 17,
      // The checksum precedes the content deliberately: tail truncation is spab's
      // commonest loss, and a surviving header says what the missing bytes must
      // hash to, which turns the checksum from a gate into an oracle the erasure
      // decoder can query. See dev/wire-format.md §3.
      checksumPosition: 'before content',
      checksumCovers: 'header before checksum, then content as stored, zero-padded to a byte boundary',
      // No magic number: the header's own plausibility plus the checksum does that
      // work, and unlike a constant it also tells the decoder something. §7.
      sync: 'header plausibility + checksum; packets are byte-aligned so the sweep tests 1 offset in 8',
      types: TYPE,
      fixedSizes: TYPE_SIZE,
      compression: COMP,
      compressionImplemented: Object.keys(COMP_IMPL).map(Number),
      encryption: ENC,
      encryptionImplemented: Object.keys(ENC_IMPL).map(Number),
      checksumExponents: { 0: 8, 1: 16, 2: 32, 3: 64, 4: 128, 5: 256, 6: '512 (reserved)', 7: 'escape' },
      escapes: { version: VER_ESCAPE, type: TYPE_EXTENDED, comp: COMP_ESCAPE, enc: ENC_ESCAPE, cksum: CK_ESCAPE },
      extension: 'an escaped field is followed by 8-bit extension bytes, grouped after the fixed header in ' +
        'field order; 0xFF continues into another byte, and ranges continue with no gap',
      encOverheadBytes: ENC_OVERHEAD,
      note: 'Bit-level, not byte-aligned: the modem is bit-oriented, so byte-rounding these five fields ' +
        'would spend 40 bits where 17 do. Fixed types imply their length and carry none unless compression ' +
        'or encryption changed the stored size. Fixed types also compact: a uuid travels as 16 raw bytes ' +
        'rather than 36 characters, a sha256 as 32 rather than 64. Compression is attempted and kept only ' +
        'if strictly smaller. Packets written by 0.4.x are not read — the version field makes that break ' +
        'explicit rather than a guess.'
    },
    modem: { type: 'mixed-radix', blocked: true, blockCapBits: 32, note: 'ECC bit stream is packed into per-site carrier symbols by blocked mixed-radix (base) conversion, recovering fractional bits of non-power-of-two radices; blocks bound a damaged symbol to ≤32 bits' },
    coding: { symbolLayer: 'mixed-radix (blocked)', blocks: true, interleave: 'keyed (opt-in)', pn: 'keyed (opt-in)', softDecision: false },
    resync: {
      phases: MAX_PHASE,
      note: 'Inserting or deleting a carrier site shifts the whole symbol stream, so blocks are cut one position off and everything after the edit decodes to noise — redundancy does not help, because every copy shifts together. The decoder therefore re-cuts the block grid at each phase: RLNC pools packets from all phases (32-bit aligned, so chance CRC hits stay out of the solve), and repetition falls back to scanning for one intact self-contained packet when majority folding fails. Disabled when a key is set: the keyed interleave spans the whole stream and cannot be undone on a shifted one.'
    }
  };

  // What this build is and what it can actually do. A codec is read by software
  // that may be older or newer than the one that wrote the mark, so "which version"
  // is rarely the useful question on its own — `wireFormat` says what layout this
  // build reads, and the capability lists say which code points it can actually
  // honour rather than merely name. `SPAB.algorithm.frame` names every REGISTERED
  // code point; these are the implemented subset, and the difference is exactly what
  // a caller needs to predict an `unsupported` result before encoding.
  function version() {
    return {
      version: VERSION,
      name: '@deftio/spab',
      wireFormat: WIRE_VER,
      algorithm: algorithm.name,
      carriers: Object.keys(CLASS_DEFS),
      defaultCarriers: DEFAULT_CLASSES.slice(),
      ecc: ['repetition', 'rlnc'],
      types: Object.keys(TYPE_DEFS),
      compression: Object.keys(COMP_IMPL).map(function (k) { return COMP_NAME[k]; }),
      encryption: Object.keys(ENC_IMPL).map(function (k) { return ENC_NAME[k]; }),
      checksumBits: [0, 1, 2, 3, 4, 5].map(cksumBits)
    };
  }

  var SPAB = {
    VERSION: VERSION,
    version: version,
    TYPES: TYPE,
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
    detect: detect,
    soft: { classSoft: classSoft, estimateCollapse: estimateCollapse, softDigit: softDigit,
      siteConfidence: siteConfidence, likelihoodField: likelihoodField },
    readClassBits: readClassBits,
    COMP: COMP,
    ENC: ENC,
    deriveKey: deriveKey,
    // symbol modem (mixed-radix, blocked) — exposed for introspection/conformance tests
    symbols: { blocks: symBlocks, capacity: symCapacityBits, toSymbols: bitsToSymbols, toBits: symbolsToBits },
    // wire format internals — exposed so the conformance suite can drive the packet
    // layer directly instead of inferring it through the carrier and ECC layers.
    wire: {
      build: buildFrame, parse: parseFrameBits, size: frameBitSize, fields: frameFields, open: openContent,
      crc8: crc8, crc16: crc16, crc32: crc32, sha256: sha256, hmacSha256: hmacSha256,
      checksum: computeChecksum, cksumBits: cksumBits,
      lzssCompress: lzssCompress, lzssDecompress: lzssDecompress,
      aesGcmSeal: aesGcmSeal, aesGcmOpen: aesGcmOpen, aesExpandKey: aesExpandKey, aesEncryptBlock: aesEncryptBlock,
      putVarint: putVarint, getVarint: getVarint,
      bytesToBits: bytesToBits, bitsToBytes: bitsToBytes,
      hexToBytes: hexToBytes, bytesToHex: bytesToHex, inferType: inferType
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = SPAB;
  root.SPAB = SPAB;
})(typeof window !== 'undefined' ? window : this);
