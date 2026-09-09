#!/usr/bin/env node
/*
 * basen.js — mixed-radix (base-N) carrier packing prototype.  [R&D / not shipped]
 *
 * Lesson from 330k's unicode_steganography.js: encoding into an arbitrary-alphabet
 * alphabet (base conversion) captures the FRACTIONAL bits that a power-of-two,
 * per-site packer throws away. Today spab consumes floor(log2(alphabet)) bits at each
 * carrier site, so any carrier whose alphabet size isn't a power of two wastes
 * capacity — e.g. a 6-symbol zero-width set holds log2(6)=2.585 bits/char, not 2.
 *
 * This prototype implements a zero-dependency MIXED-radix packer: the whole payload
 * is one big integer, and the heterogeneous carrier sites (each with its own alphabet
 * r_i) are its digits. Capacity is log2(prod r_i) = sum log2(r_i) — the fractional
 * bits at every site are recovered. It round-trips and reports the gain vs. the naive
 * per-site floor. If it pays off, it graduates from here into the codec.
 *
 *   node r_and_d/basen.js            # self-check + capacity comparison table
 */
'use strict';

// ---------- zero-dep big-integer helpers on a big-endian byte array ----------
// number is stored as an array of bytes, most-significant first (like base 256).

// divide big number by a small int; returns { q: quotientBytes, r: remainder }.
function divmodSmall(bytes, div) {
  var q = [], rem = 0;
  for (var i = 0; i < bytes.length; i++) {
    var acc = rem * 256 + bytes[i];
    q.push(Math.floor(acc / div));
    rem = acc % div;
  }
  while (q.length > 1 && q[0] === 0) q.shift(); // trim leading zeros
  return { q: q, r: rem };
}
// multiply big number by small int and add small int, in place-ish (returns new bytes).
function mulAddSmall(bytes, mul, add) {
  var out = [], carry = add;
  for (var i = bytes.length - 1; i >= 0; i--) {
    var v = bytes[i] * mul + carry;
    out.unshift(v & 0xff);
    carry = Math.floor(v / 256);
  }
  while (carry > 0) { out.unshift(carry & 0xff); carry = Math.floor(carry / 256); }
  if (out.length === 0) out = [0];
  return out;
}
function isZero(bytes) { for (var i = 0; i < bytes.length; i++) if (bytes[i] !== 0) return false; return true; }

// ---------- mixed-radix pack / unpack ----------
// alphabets[i] is the alphabet size of carrier site i (site 0 = least significant digit).
// Returns digits[i] in 0..alphabets[i]-1. Requires prod(alphabets) >= value (capacity).
function pack(bytes, alphabets) {
  var n = bytes.slice();
  var digits = new Array(alphabets.length);
  for (var i = 0; i < alphabets.length; i++) {
    var dm = divmodSmall(n, alphabets[i]);
    digits[i] = dm.r;
    n = dm.q;
  }
  if (!isZero(n)) throw new Error('overflow: payload exceeds carrier capacity');
  return digits;
}
// Inverse: reconstruct the byte array (left-padded to byteLen) from the digits.
function unpack(digits, alphabets, byteLen) {
  var n = [0];
  for (var i = alphabets.length - 1; i >= 0; i--) n = mulAddSmall(n, alphabets[i], digits[i]);
  while (n.length < byteLen) n.unshift(0);
  return n.slice(n.length - byteLen);
}

// ---------- capacity accounting ----------
function log2(x) { return Math.log(x) / Math.LN2; }
function naiveBits(alphabets) { return alphabets.reduce(function (s, r) { return s + Math.floor(log2(r)); }, 0); }
function mixedBits(alphabets) { return alphabets.reduce(function (s, r) { return s + log2(r); }, 0); }

module.exports = { pack: pack, unpack: unpack, naiveBits: naiveBits, mixedBits: mixedBits };

// ---------- demo / self-check ----------
if (require.main === module) {
  // 1) round-trip self-check over random payloads and random heterogeneous alphabets.
  function rint(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
  var ALPHABETS = [2, 3, 4, 5, 6, 7, 8, 10, 16];
  var fails = 0, trials = 4000;
  for (var t = 0; t < trials; t++) {
    var nSites = rint(40, 200);
    var alphabets = []; for (var s = 0; s < nSites; s++) alphabets.push(ALPHABETS[rint(0, ALPHABETS.length - 1)]);
    var capBits = Math.floor(mixedBits(alphabets));
    var byteLen = Math.max(1, Math.floor((capBits - 8) / 8)); // leave headroom so it fits
    var bytes = []; for (var b = 0; b < byteLen; b++) bytes.push(rint(0, 255));
    if (bytes[0] === 0) bytes[0] = 1; // keep byteLen well-defined for the check
    try {
      var digits = pack(bytes, alphabets);
      var back = unpack(digits, alphabets, byteLen);
      if (back.join(',') !== bytes.join(',')) { fails++; if (fails <= 3) console.error('  mismatch @trial ' + t); }
    } catch (e) { fails++; if (fails <= 3) console.error('  ' + e.message); }
  }
  console.log('round-trip: ' + (trials - fails) + '/' + trials + ' ok' + (fails ? '  (' + fails + ' FAILED)' : ''));

  // 2) capacity gain: mixed-radix vs. naive per-site floor(log2), for realistic carrier mixes.
  var CASES = [
    ['ws only (4)                 ', rep(4, 100)],
    ['wsdense (8)                 ', rep(8, 100)],
    ['zwsp 4-sym                  ', rep(4, 100)],
    ['zwsp 6-sym (330k-style)     ', rep(6, 100)],
    ['3 whitespace variants       ', rep(3, 100)],
    ['ws(4)+apos(2)+hyphen(2) mix ', mix([[4, 60], [2, 20], [2, 20]])],
    ['mixed 6+5+4+3 alphabets     ', mix([[6, 25], [5, 25], [4, 25], [3, 25]])]
  ];
  function rep(r, n) { var a = []; for (var i = 0; i < n; i++) a.push(r); return a; }
  function mix(pairs) { var a = []; pairs.forEach(function (p) { for (var i = 0; i < p[1]; i++) a.push(p[0]); }); return a; }

  console.log('\ncarrier mix (100 sites)          naive bits   mixed-radix   gain');
  console.log('------------------------------------------------------------------');
  CASES.forEach(function (c) {
    var nb = naiveBits(c[1]), mb = mixedBits(c[1]);
    var gain = nb > 0 ? (100 * (mb - nb) / nb) : 0;
    console.log('  ' + c[0] + '  ' + String(nb).padStart(6) + '     ' +
      mb.toFixed(1).padStart(8) + '     ' + (gain > 0 ? '+' : '') + gain.toFixed(1) + '%');
  });
  console.log('\nTakeaway: mixed-radix recovers the fractional bits whenever a carrier\'s');
  console.log('alphabet size is not a power of two (zero gain for pure 2/4/8, real gain otherwise).');
}
