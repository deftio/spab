/*
 * baselines.js — reference implementations of the OTHER approaches, so that
 * "spab is more robust" is a measurement rather than a claim.
 *
 * IMPORTANT — what these are and are not.
 *
 * These are minimal reimplementations of each TECHNIQUE, not the libraries
 * themselves. StegCloak is not vendored here; `zwspSinglePoint` is a stand-in for
 * the design choice StegCloak makes (one insertion point, payload contiguous, no
 * error correction). Running the real projects would compare implementations —
 * their compression, their crypto, their bugs. Running technique models compares
 * the DESIGN DECISIONS, which is what a robustness table should isolate.
 *
 * Consequently: results here are evidence about placement and error correction.
 * They are not a benchmark of anyone's library, and must never be published as
 * "spab beats X" — only as "spreading beats point-insertion under this channel".
 *
 * Each baseline exposes { name, note, encode(cover, message), decode(text) },
 * decode returning null when nothing is recoverable.
 */
'use strict';

// 4-symbol zero-width alphabet, as used by 330k's unicode_steganography.js and
// (with a different set) StegCloak.
var ZW = ['​', '‌', '‍', '⁠'];
var ZW_INDEX = {};
ZW.forEach(function (c, i) { ZW_INDEX[c] = i; });

function toDigits(message) {
  var bytes = [];
  for (var i = 0; i < message.length; i++) {
    var c = message.charCodeAt(i);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) { bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63)); }
    else { bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); }
  }
  var digits = [];
  bytes.forEach(function (b) { for (var s = 6; s >= 0; s -= 2) digits.push((b >> s) & 3); });
  return { digits: digits, len: bytes.length };
}
function fromDigits(digits, len) {
  var bytes = [];
  for (var i = 0; i + 3 < digits.length && bytes.length < len; i += 4) {
    bytes.push((digits[i] << 6) | (digits[i + 1] << 4) | (digits[i + 2] << 2) | digits[i + 3]);
  }
  if (bytes.length < len) return null;
  try {
    return decodeURIComponent(bytes.map(function (b) { return '%' + b.toString(16).padStart(2, '0'); }).join(''));
  } catch (e) { return null; }
}

// A length header so a decoder knows where the payload ends — every scheme in this
// family needs one, whether it is a length prefix or a terminator.
function withHeader(message) {
  var d = toDigits(message);
  var hdr = [];
  for (var s = 6; s >= 0; s -= 2) hdr.push((d.len >> s) & 3);   // one byte of length
  return hdr.concat(d.digits);
}
function readHeader(digits) {
  if (digits.length < 4) return null;
  var len = (digits[0] << 6) | (digits[1] << 4) | (digits[2] << 2) | digits[3];
  if (!len) return null;
  return fromDigits(digits.slice(4), len);
}

// ---------------------------------------------------------------------------
// 1. Point insertion — the StegCloak shape. The whole payload sits at a single
//    place in the text, contiguous, with no redundancy.
// ---------------------------------------------------------------------------
var zwspSinglePoint = {
  name: 'zw point-insert',
  note: 'entire payload at one insertion point, no ECC (StegCloak-shaped)',
  encode: function (cover, message) {
    var run = withHeader(message).map(function (d) { return ZW[d]; }).join('');
    var at = cover.indexOf(' ');
    if (at < 0) at = 0;
    return cover.slice(0, at + 1) + run + cover.slice(at + 1);
  },
  decode: function (text) {
    var digits = [];
    for (var i = 0; i < text.length; i++) if (text[i] in ZW_INDEX) digits.push(ZW_INDEX[text[i]]);
    return readHeader(digits);
  }
};

// ---------------------------------------------------------------------------
// 2. Spread insertion — the 330k shape. Same alphabet, but the payload is
//    distributed across word gaps. Still no error correction.
// ---------------------------------------------------------------------------
var zwspSpread = {
  name: 'zw spread',
  note: 'payload spread across word gaps, no ECC (330k-shaped)',
  encode: function (cover, message) {
    var digits = withHeader(message);
    var gaps = [];
    for (var i = 1; i < cover.length - 1; i++) if (cover[i] === ' ') gaps.push(i);
    if (!gaps.length) return cover;
    var per = Math.ceil(digits.length / gaps.length), out = '', pos = 0;
    for (var c = 0; c < cover.length; c++) {
      out += cover[c];
      if (gaps.indexOf(c) >= 0) {
        for (var k = 0; k < per && pos < digits.length; k++) out += ZW[digits[pos++]];
      }
    }
    return out;
  },
  decode: zwspSinglePoint.decode
};

// ---------------------------------------------------------------------------
// 3. Naive whitespace substitution — the classic "snow"-family idea: swap spaces
//    for equivalent variants, one payload copy, no error correction. This is the
//    control that isolates what spab's ECC and framing actually buy.
// ---------------------------------------------------------------------------
var WSV = [' ', ' ', ' ', ' '];
var WSV_INDEX = {};
WSV.forEach(function (c, i) { WSV_INDEX[c] = i; });

var wsNoEcc = {
  name: 'ws substitute',
  note: 'whitespace variants, one copy, no ECC (snow-shaped)',
  encode: function (cover, message) {
    var digits = withHeader(message), out = cover.split(''), pos = 0;
    for (var i = 1; i < out.length - 1 && pos < digits.length; i++) {
      if (out[i] === ' ' || out[i] in WSV_INDEX) out[i] = WSV[digits[pos++]];
    }
    return pos < digits.length ? null : out.join('');   // did not fit
  },
  decode: function (text) {
    var digits = [];
    for (var i = 1; i < text.length - 1; i++) if (text[i] in WSV_INDEX) digits.push(WSV_INDEX[text[i]]);
    return readHeader(digits);
  }
};

module.exports = { BASELINES: [zwspSinglePoint, zwspSpread, wsNoEcc], ZW: ZW, WSV: WSV };
