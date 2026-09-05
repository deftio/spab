#!/usr/bin/env node
/*
 * fuzz.test.js — property-based fuzzing of the spab codec (zero deps).
 *
 * Deterministic: a fixed seed makes every run identical and reproducible. Each
 * iteration builds a random cover text + random message + random params and checks
 * three invariants:
 *
 *   1. round-trip     — if the passage has capacity, decode(encode(x)) == x.
 *   2. no false alarm — decoding UN-marked random text never yields a valid payload.
 *   3. never throws   — decode() on arbitrary/garbage input returns cleanly.
 *
 * On failure it prints the exact seed + iteration so the case can be replayed:
 *   node tests/fuzz.test.js --seed 12345 --iterations 1
 *
 * Flags: --iterations N (default 2000), --seed S (default 0xC0FFEE).
 */
'use strict';
const SPAB = require('../src/js/spab.js');

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : def; }
const ITERS = +arg('iterations', 2000);
const SEED0 = +arg('seed', 0xC0FFEE);

// mulberry32 — small deterministic PRNG.
function rng(seed) { let a = seed >>> 0; return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const WORDS = ('the of and to in is it you that he was for on are with as his they at be this from have or by ' +
  'one had not but what all were when we there can an your which their said if do will each about how up out them ' +
  'don\'t can\'t it\'s well-known state-of-the-art mother-in-law user\'s time-out follow-up').split(' ');
const CLASS_SETS = [undefined, ['ws'], ['ws', 'punct'], ['apos'], ['hyphen'], ['ws', 'apos', 'hyphen'], ['punct'], ['wsdense'], ['zwsp']];
const ECCS = ['repetition', 'rlnc'];
// Two fixed 32-byte keys, so an encrypted round trip uses the same key both ways and
// any failure stays reproducible from the seed alone.
const FUZZ_KEYS = [
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
  'f0e1d2c3b4a596870f1e2d3c4b5a69780f1e2d3c4b5a69780f1e2d3c4b5a6978'
];
const MSG_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.: /#@'.split('')
  .concat(['é', 'ü', 'ñ', '—', '…', '你', '好', '🙂', '\'', '"']);

function randInt(r, lo, hi) { return lo + Math.floor(r() * (hi - lo + 1)); }
function pick(r, arr) { return arr[Math.floor(r() * arr.length)]; }

function makeCover(r) {
  // Wide range: small passages exercise the too-short paths; large ones give RLNC
  // (which needs ~32 bits/packet × K packets) enough capacity to round-trip.
  const n = randInt(r, 8, 420);
  const w = [];
  for (let i = 0; i < n; i++) w.push(pick(r, WORDS));
  let s = w.join(' ');
  if (r() < 0.5) s = s + '.\n' + w.slice(0, randInt(r, 1, Math.max(1, n >> 1))).join(' ') + '.';
  return s;
}
function makeMessage(r) {
  // Mostly short ASCII (fits typical capacity); occasional unicode to fuzz utf8.
  const n = randInt(r, 1, 14);
  const ascii = MSG_ALPHABET.filter(function (c) { return c.charCodeAt(0) < 128; });
  let s = '';
  for (let i = 0; i < n; i++) s += (r() < 0.85) ? pick(r, ascii) : pick(r, MSG_ALPHABET);
  return s;
}
function makeGarbage(r) {
  const n = randInt(r, 0, 200);
  let s = '';
  for (let i = 0; i < n; i++) {
    const roll = r();
    if (roll < 0.25) s += String.fromCharCode(SPAB.SPACE_MAP[randInt(r, 0, 3)].charCodeAt(0));
    else if (roll < 0.4) s += String.fromCharCode(pick(r, [0x27, 0x2019, 0x2D, 0x2010]));
    else if (roll < 0.5) s += '\n';
    else s += String.fromCharCode(randInt(r, 0x20, 0x2fff));
  }
  return s;
}

let fails = 0, checked = 0, skippedShort = 0;
function fail(seed, i, msg, extra) {
  fails++;
  console.error('  FAIL  seed=' + seed + ' iter=' + i + '  ' + msg);
  if (extra) console.error('        ' + JSON.stringify(extra).slice(0, 300));
}

for (let i = 0; i < ITERS; i++) {
  const seed = (SEED0 + i * 2654435761) >>> 0;
  const r = rng(seed);
  const cover = makeCover(r);
  const message = makeMessage(r);
  const params = { classes: pick(r, CLASS_SETS), ecc: pick(r, ECCS) };
  if (r() < 0.3) params.key = 'k' + randInt(r, 0, 9999);      // exercise keyed scramble (same key both ways)
  if (r() < 0.15) params.block = randInt(r, 3, 20);           // exercise the block-size knob
  if (r() < 0.25) params.autoGrow = true;                     // exercise growing to fit an oversized payload
  if (params.autoGrow && r() < 0.5) params.redundancy = randInt(r, 1, 5);
  // Wire-format v2 knobs. encKey and cksum change the packet's size and shape, so
  // they interact with capacity, auto-grow and the block grid — which is exactly the
  // interaction a permutation fuzzer is for.
  if (r() < 0.2) params.encKey = FUZZ_KEYS[randInt(r, 0, FUZZ_KEYS.length - 1)];
  if (r() < 0.2) params.cksum = randInt(r, 0, 5);
  if (r() < 0.15) params.compress = false;

  // --- invariant 1: round-trip when capacity allows ---
  let enc;
  try { enc = SPAB.encode(cover, message, params); }
  catch (e) { fail(seed, i, 'encode threw: ' + e.message, { cover: cover.slice(0, 40), message, params }); continue; }
  const tooShort = enc.metadata.issues.some(function (s) { return /too short/i.test(s); });
  if (tooShort) { skippedShort++; }
  else {
    let dec;
    try { dec = SPAB.decode(enc.text, params); }
    catch (e) { fail(seed, i, 'decode threw: ' + e.message, { message, params }); continue; }
    checked++;
    if (dec.message !== message) fail(seed, i, 'round-trip mismatch', { got: dec.message, want: message, params, status: dec.metadata.status });
    // The visible text must be identical no matter which carriers ran — that is the
    // universal contract. Length preservation is narrower: it holds only when the
    // encoder used substitution carriers alone, so ask the metadata what it
    // actually used rather than inferring it from the request. auto-grow may add
    // an insert carrier the caller never listed, and that is allowed.
    const used = enc.metadata.classes || [];
    const usedInsert = used.indexOf('zwsp') !== -1;
    const usedSub = used.some(function (c) { return c !== 'zwsp'; });
    const stripped = enc.text.replace(/[​‌‍⁠]/g, '');

    // Universal: the VISIBLE text is never lengthened or shortened. Substitution
    // carriers swap a character for an equivalent one, insert carriers add only
    // zero-width characters, so stripping those must return to the cover's length.
    if (stripped.length !== cover.length) fail(seed, i, 'visible length changed by encode', { params });

    // Insert-only runs change nothing else, so the stripped text must be identical.
    // (With substitution carriers it will not be — that is the point of them.)
    if (!usedSub && stripped !== cover) fail(seed, i, 'insert-only encode altered visible text', { params });

    // Byte length is preserved only when no insert carrier ran. Read that from what
    // the encoder used, not from what was requested: auto-grow may legitimately add
    // an insert carrier the caller never listed.
    if (!usedInsert && enc.text.length !== cover.length) fail(seed, i, 'length changed by substitution-only encode', { params });
  }

  // --- invariant 2: no false alarm on unmarked text ---
  try {
    const d0 = SPAB.decode(cover, params);
    if (d0.metadata.crcOk === true && d0.message) fail(seed, i, 'false positive on clean text', { got: d0.message, params });
  } catch (e) { fail(seed, i, 'decode(clean) threw: ' + e.message, { params }); }

  // --- invariant 3: never throws on garbage ---
  try {
    const g = makeGarbage(r);
    SPAB.decode(g, params);
    SPAB.decode(g, { ecc: 'rlnc' });
    SPAB.decode(g, { classes: ['ws', 'apos', 'hyphen'] });
    SPAB.encode(g, message, params); // encoding arbitrary text must also be safe
  } catch (e) { fail(seed, i, 'garbage handling threw: ' + e.message, { params }); }
}

console.log('fuzz: ' + ITERS + ' iterations, seed0=' + SEED0 +
  ' — round-trips checked=' + checked + ', skipped(short)=' + skippedShort + ', failures=' + fails);
if (fails > 0) { console.error('FAIL (' + fails + ')'); process.exit(1); }
console.log('PASS (fuzz)');
