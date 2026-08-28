/*
 * spab.js — baseline whitespace watermark codec (exploratory)
 *
 * Scheme (v0 baseline, see dev/spab-watermark-plan.md):
 *   - Symbol library: inter-word spaces, 2 bits per space, 4 whitespace variants.
 *   - Slot model: a "slot" is a single whitespace char sitting between two word chars.
 *   - Framing: [len][content...][crc8].
 *   - ECC: repetition + majority vote (spread the frame across all slots).
 *
 * This is the simplest end-to-end path so the harness/visualizer have something to
 * measure. Richer symbol classes, soft/block-histogram decoding, and real ECC stacks
 * come later behind the same encode()/decode() interface.
 *
 * Works as a browser global (window.SPAB) and via CommonJS (module.exports).
 */
(function (root) {
  'use strict';

  // 2 bits -> whitespace variant. Index is the 2-bit value.
  var SPACE_MAP = [String.fromCharCode(0x20), String.fromCharCode(0x2006), String.fromCharCode(0x2009), String.fromCharCode(0x200A)];
  var SPACE_NAMES = ['U+0020 space', 'U+2006 six-per-em', 'U+2009 thin', 'U+200A hair'];
  var CARRIERS = {};
  SPACE_MAP.forEach(function (c, i) { CARRIERS[c] = i; });

  function isWordChar(ch) {
    return !!ch && !/\s/.test(ch) && !(ch in CARRIERS);
  }

  // A slot: index i where text[i] is a carrier/space between two word chars.
  function getSlots(text) {
    var slots = [];
    for (var i = 1; i < text.length - 1; i++) {
      var ch = text[i];
      if ((ch === ' ' || ch in CARRIERS) && isWordChar(text[i - 1]) && isWordChar(text[i + 1])) {
        slots.push(i);
      }
    }
    return slots;
  }

  // --- byte / bit helpers ---
  function crc8(bytes) {
    var c = 0;
    for (var k = 0; k < bytes.length; k++) {
      c ^= bytes[k];
      for (var i = 0; i < 8; i++) {
        c = (c & 0x80) ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
      }
    }
    return c;
  }

  function bytesToBits(bytes) {
    var bits = [];
    for (var k = 0; k < bytes.length; k++) {
      for (var i = 7; i >= 0; i--) bits.push((bytes[k] >> i) & 1);
    }
    return bits;
  }

  function bitsToBytes(bits) {
    var out = [];
    for (var k = 0; k + 8 <= bits.length; k += 8) {
      var b = 0;
      for (var i = 0; i < 8; i++) b = (b << 1) | bits[k + i];
      out.push(b);
    }
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

  // Frame: [magic=0xA5][len][content...][crc8 over magic+len+content].
  // The magic byte is a sync/sanity marker so all-zero (fully normalized) text
  // does not trivially validate as a zero-length payload — the #1 false positive.
  var MAGIC = 0xA5;
  function buildFrame(message) {
    var content = utf8Encode(message);
    if (content.length > 255) content = content.slice(0, 255);
    var frame = [MAGIC, content.length].concat(content);
    frame.push(crc8(frame));
    return frame;
  }

  function encode(cover, message, params) {
    params = params || {};
    var slots = getSlots(cover);
    var frame = buildFrame(message);
    var frameBits = bytesToBits(frame);
    var capacityBits = slots.length * 2;
    var issues = [];

    var reps = frameBits.length > 0 ? Math.floor(capacityBits / frameBits.length) : 0;
    if (capacityBits < frameBits.length) {
      issues.push('Passage too short: needs ' + Math.ceil(frameBits.length / 2) +
        ' slots, has ' + slots.length + '. Encoding a single truncated copy.');
      reps = 1;
    } else if (reps < 3) {
      issues.push('Low redundancy: only ' + reps + ' copies fit. Watermark will be brittle.');
    }

    // Build the bit stream: frame repeated, padded to slot capacity.
    var bits = [];
    for (var r = 0; r < reps; r++) bits = bits.concat(frameBits);
    while (bits.length < capacityBits) bits.push(0);
    bits = bits.slice(0, capacityBits);

    var arr = cover.split('');
    for (var s = 0; s < slots.length; s++) {
      var val = (bits[s * 2] << 1) | bits[s * 2 + 1];
      arr[slots[s]] = SPACE_MAP[val];
    }

    return {
      text: arr.join(''),
      metadata: {
        slots: slots.length,
        capacityBits: capacityBits,
        frameBits: frameBits.length,
        frameBytes: frame.length,
        reps: reps,
        payloadBytes: frame[1],
        issues: issues
      }
    };
  }

  function readSlotBits(text) {
    var slots = getSlots(text);
    var bits = [];
    for (var i = 0; i < slots.length; i++) {
      var v = CARRIERS[text[slots[i]]];
      if (v === undefined) v = 0;
      bits.push((v >> 1) & 1, v & 1);
    }
    return bits;
  }

  function decode(text, params) {
    params = params || {};
    var bits = readSlotBits(text);
    var total = bits.length;
    if (total < 16) {
      return { message: null, metadata: { status: 'not-detected', reason: 'Too few carrier slots', confidence: 0 } };
    }

    // Recover length from the first copy (byte 1, after the magic byte),
    // then fold all copies by majority vote.
    var len = 0;
    for (var i = 8; i < 16; i++) len = (len << 1) | bits[i];
    var frameBytes = 1 + 1 + len + 1; // magic, len, content, crc
    var frameBits = frameBytes * 8;
    var reps = frameBits > 0 ? Math.floor(total / frameBits) : 0;
    if (reps < 1) { reps = 1; frameBits = Math.min(frameBits, total); }

    var folded = [];
    var agreementSum = 0, agreementCount = 0;
    for (var b = 0; b < frameBits; b++) {
      var ones = 0, cnt = 0;
      for (var r = 0; r < reps; r++) {
        var idx = r * frameBits + b;
        if (idx < total) { cnt++; ones += bits[idx]; }
      }
      folded.push(ones * 2 > cnt ? 1 : 0);
      if (cnt > 0) { agreementSum += Math.max(ones, cnt - ones) / cnt; agreementCount++; }
    }

    var bytes = bitsToBytes(folded);
    var agreement = agreementCount ? agreementSum / agreementCount : 0;

    if (bytes.length < 4) {
      return { message: null, metadata: { status: 'not-detected', confidence: 0, reason: 'Frame too short after fold' } };
    }
    var magicOk = bytes[0] === MAGIC;
    var dlen = bytes[1];
    var content = bytes.slice(2, 2 + dlen);
    var crcGot = bytes[2 + dlen];
    var crcCalc = crc8(bytes.slice(0, 2 + dlen));
    var crcOk = magicOk && dlen > 0 && (content.length === dlen) && (crcGot === crcCalc);

    var message = null;
    try { message = utf8Decode(content); } catch (e) { message = null; }

    var status;
    if (!magicOk) status = 'not-detected';       // no spab frame here
    else if (crcOk) status = agreement >= 0.999 ? 'perfect' : 'corrected';
    else status = 'failed';                        // magic seen but payload corrupt
    // Confidence blends redundancy agreement with the integrity check.
    var confidence = crcOk ? Math.min(1, 0.5 + 0.5 * agreement) : (magicOk ? Math.max(0, agreement - 0.5) : 0);

    return {
      message: crcOk ? message : null,
      metadata: {
        status: status,
        confidence: +confidence.toFixed(3),
        agreement: +agreement.toFixed(3),
        reps: reps,
        payloadBytes: dlen,
        crcOk: crcOk,
        rawMessage: message // best-effort even when CRC fails, for debugging
      }
    };
  }

  // Histogram of carrier variants at slot positions.
  function histogram(text) {
    var slots = getSlots(text);
    var h = [0, 0, 0, 0];
    for (var i = 0; i < slots.length; i++) {
      var v = CARRIERS[text[slots[i]]];
      if (v !== undefined) h[v]++;
    }
    return { counts: h, total: slots.length };
  }

  // Version + machine-readable description of the CURRENT algorithm, so every
  // benchmark run can record exactly what was tested and results stay comparable
  // over time. Bump VERSION whenever the scheme changes in a way that affects
  // encode/decode behavior, and update ALGORITHM to match.
  var VERSION = '0.1.0';
  var ALGORITHM = {
    version: VERSION,
    name: 'baseline-ws2-rep',
    summary: 'Baseline: 2 bits per inter-word space over 4 whitespace variants, ' +
             'slot = space between two word chars, repetition + majority-vote ECC, ' +
             '[magic 0xA5][len][content][crc8] frame.',
    channel: {
      carrierClasses: ['inter-word-space'],
      variants: ['U+0020', 'U+2006', 'U+2009', 'U+200A'],
      bitsPerSlot: 2,
      slotRule: 'single whitespace char between two word chars'
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
    getSlots: getSlots,
    encode: encode,
    decode: decode,
    histogram: histogram,
    readSlotBits: readSlotBits
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = SPAB;
  root.SPAB = SPAB;
})(typeof window !== 'undefined' ? window : this);
