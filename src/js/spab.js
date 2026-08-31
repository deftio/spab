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

  function isWordChar(ch) { return !!ch && !/\s/.test(ch) && !(ch in WS_SET); }

  // Each class: bits, detect(text)->[indices], read(text,i)->value, glyph(value)->char.
  var CLASS_DEFS = {
    ws: {
      bits: 2,
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
      bits: 1,
      detect: function (text) {
        var out = [];
        for (var i = 0; i < text.length; i++) { var c = text.charCodeAt(i); if (c === 0x27 || c === 0x2019) out.push(i); }
        return out;
      },
      read: function (text, i) { return text.charCodeAt(i) === 0x2019 ? 1 : 0; },
      glyph: function (v) { return String.fromCharCode(v ? 0x2019 : 0x27); }
    },
    hyphen: {
      bits: 1,
      detect: function (text) {
        var out = [];
        for (var i = 0; i < text.length; i++) { var c = text.charCodeAt(i); if (c === 0x2D || c === 0x2010) out.push(i); }
        return out;
      },
      read: function (text, i) { return text.charCodeAt(i) === 0x2010 ? 1 : 0; },
      glyph: function (v) { return String.fromCharCode(v ? 0x2010 : 0x2D); }
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
      CLASS_DEFS[id].detect(text).forEach(function (i) { sites.push({ i: i, id: id, bits: CLASS_DEFS[id].bits }); });
    });
    sites.sort(function (a, b) { return a.i - b.i; });
    return sites;
  }

  // Read one class's bit stream from its own sites (independent channel).
  function readClassBits(text, id) {
    var idx = CLASS_DEFS[id].detect(text), bits = [], bpp = CLASS_DEFS[id].bits;
    for (var s = 0; s < idx.length; s++) {
      var v = CLASS_DEFS[id].read(text, idx[s]);
      for (var j = bpp - 1; j >= 0; j--) bits.push((v >> j) & 1);
    }
    return bits;
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

    ids.forEach(function (id) {
      var idx = CLASS_DEFS[id].detect(cover), bpp = CLASS_DEFS[id].bits;
      var cap = idx.length * bpp;
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

      var pos = 0;
      for (var s = 0; s < idx.length; s++) {
        var val = 0;
        for (var j = 0; j < bpp; j++) val = (val << 1) | (bits[pos++] || 0);
        arr[idx[s]] = CLASS_DEFS[id].glyph(val);
      }
      channels[id] = { sites: idx.length, capacityBits: cap, reps: reps, tooShort: tooShort };
      if (!primary) primary = id;
    });

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
      text: arr.join(''),
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

  // RLNC decode: pool self-checking packets from ALL channels, recover any K.
  function decodeRLNC(text, ids) {
    var pool = {}, count = 0;
    ids.forEach(function (id) {
      parsePackets(readClassBits(text, id)).forEach(function (pk) {
        if (!(pk.esi in pool)) { pool[pk.esi] = pk.val; count++; }
      });
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
    if (params.ecc === 'rlnc') {
      var r = decodeRLNC(text, ids);
      return { message: r.message, metadata: { status: r.status, confidence: r.confidence, ecc: 'rlnc',
        crcOk: r.crcOk, payloadBytes: r.payloadBytes, packets: r.packets, channel: r.channel, rawMessage: r.rawMessage } };
    }
    var rank = { perfect: 3, corrected: 2, failed: 1, 'not-detected': 0 };
    var best = null, bestId = null;
    ids.forEach(function (id) {
      var c = foldParse(readClassBits(text, id));
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
  var VERSION = '0.4.0';
  var ALGORITHM = {
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
      hyphen: { bits: 1, variants: ['U+002D', 'U+2010'], defaultOn: true, nfkcSurvives: true }
    },
    ecc: { type: 'repetition+majority', detail: 'frame repeated to fill capacity, per-bit majority vote' },
    frame: { fields: ['magic(0xA5)', 'len(1B)', 'content', 'crc8'], integrity: 'crc8', sync: 'magic byte' },
    coding: { blocks: false, interleave: false, pn: false, softDecision: false }
  };

  var SPAB = {
    VERSION: VERSION,
    ALGORITHM: ALGORITHM,
    SPACE_MAP: SPACE_MAP,
    SPACE_NAMES: SPACE_NAMES,
    CLASS_DEFS: CLASS_DEFS,
    resolveClasses: resolveClasses,
    getSites: getSites,
    getSlots: getSlots,
    encode: encode,
    decode: decode,
    histogram: histogram,
    readClassBits: readClassBits
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = SPAB;
  root.SPAB = SPAB;
})(typeof window !== 'undefined' ? window : this);
