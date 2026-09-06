#!/usr/bin/env node
/*
 * wire.test.js — conformance suite for the v2 packet format (dev/wire-format.md).
 *
 * This drives the packet layer DIRECTLY through SPAB.wire, rather than inferring it
 * through the carrier and ECC layers, so a header bug shows up as a header failure
 * instead of a mysterious decode miss. The end-to-end section at the bottom then
 * checks the same properties survive the full pipeline.
 *
 * Sections:
 *   1  primitives against published vectors (SHA-256, HMAC, CRCs, AES, AES-GCM)
 *   2  bit I/O and varint
 *   3  the field escape mechanism
 *   4  packet geometry — header widths per size class
 *   5  types: all of them, fixed sizes, compaction, fallbacks, unassigned codes
 *   6  lengths: exhaustive sweep and every varint boundary
 *   7  compression: every code point, kept only when it wins
 *   8  encryption: every code point, key handling, tampering
 *   9  checksums: every width, and what each one catches
 *  10  the checksum-before-content property
 *  11  the sweep: false-accept rate with no magic number
 *  12  end-to-end through carriers and ECC
 *  13  the spec document matches the implementation
 */
'use strict';
const SPAB = require('../src/js/spab.js');
const W = SPAB.wire;
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ok  ' + msg); }
  else { failed++; console.log('  FAIL ' + msg); }
}
function eq(got, want, msg) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  ok(g === w, msg + (g === w ? '' : '\n        got  ' + g + '\n        want ' + w));
}
const hex = (b) => W.bytesToHex(b);
const bytesOf = (s) => Array.from(Buffer.from(s, 'utf8'));

// A deterministic non-repeating byte source. A cyclic pattern would be compressible
// by LZSS's 4 KB window, which is the opposite of what "incompressible" tests want.
function prng(seed) {
  let x = seed >>> 0;
  return function () { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x & 0xff; };
}
function randomBytes(n, seed) { const r = prng(seed), o = []; for (let i = 0; i < n; i++) o.push(r()); return o; }

// ============================================================ 1. primitives
console.log('\n-- 1. primitives against published vectors --');

eq(hex(W.sha256([])), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'SHA-256 of the empty string (FIPS-180)');
eq(hex(W.sha256(bytesOf('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'SHA-256("abc") (FIPS-180)');
eq(hex(W.sha256(bytesOf('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))),
   '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1', 'SHA-256 of the 56-byte FIPS-180 case');
// Length handling is where hash implementations break: the padding boundary at 55/56
// bytes and the multi-block path. Sweep them all against Node's own SHA-256.
let shaMismatch = 0;
for (let n = 0; n <= 300; n++) {
  const b = randomBytes(n, 0x1234 + n);
  if (hex(W.sha256(b)) !== crypto.createHash('sha256').update(Buffer.from(b)).digest('hex')) shaMismatch++;
}
eq(shaMismatch, 0, 'SHA-256 matches Node for every length 0..300 (padding + multi-block boundaries)');

eq(hex(W.hmacSha256(new Array(20).fill(0x0b), bytesOf('Hi There'))),
   'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7', 'HMAC-SHA-256 RFC 4231 case 1');
eq(hex(W.hmacSha256(new Array(131).fill(0xaa), bytesOf('Test Using Larger Than Block-Size Key - Hash Key First'))),
   '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54', 'HMAC-SHA-256 RFC 4231 case 6 (key longer than the block)');
eq(hex(W.hmacSha256(bytesOf('key'), bytesOf('The quick brown fox jumps over the lazy dog'))),
   hex(Array.from(crypto.createHmac('sha256', 'key').update('The quick brown fox jumps over the lazy dog').digest())),
   'HMAC-SHA-256 matches Node');

const CHK = bytesOf('123456789');   // the standard CRC "check" string
eq(W.crc8(CHK), 0xf4, 'CRC-8/ATM check value is 0xF4');
eq(W.crc16(CHK), 0x29b1, 'CRC-16/CCITT-FALSE check value is 0x29B1');
eq(W.crc32(CHK) >>> 0, 0xcbf43926, 'CRC-32 check value is 0xCBF43926');
eq(W.crc32(bytesOf('')) >>> 0, 0, 'CRC-32 of the empty string is 0');

const FIPS_KEY = Array.from({ length: 32 }, (_, i) => i);
eq(hex(W.aesEncryptBlock(W.aesExpandKey(FIPS_KEY),
     [0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff])),
   '8ea2b7ca516745bfeafc49904b496089', 'AES-256 block matches FIPS-197 C.3');

// AES-GCM against Node, across the lengths that exercise the partial-block path.
const GK = W.hexToBytes('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
const NONCE = W.hexToBytes('cafebabefacedbaddecaf888');
let gcmMismatch = 0;
for (const plen of [0, 1, 15, 16, 17, 31, 32, 33, 63, 64, 65, 127, 200, 1000]) {
  const plain = randomBytes(plen, 0x777 + plen);
  const sealed = W.aesGcmSeal(GK, plain, NONCE);
  const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(GK), Buffer.from(NONCE));
  const ct = Buffer.concat([c.update(Buffer.from(plain)), c.final()]);
  if (hex(sealed) !== hex(NONCE) + ct.toString('hex') + c.getAuthTag().toString('hex')) gcmMismatch++;
  if (hex(W.aesGcmOpen(GK, sealed)) !== hex(plain)) gcmMismatch++;
}
eq(gcmMismatch, 0, 'AES-256-GCM matches Node byte-for-byte across 14 lengths, both directions');

// Every single-bit change anywhere in nonce, ciphertext or tag must be rejected.
const sealedRef = W.aesGcmSeal(GK, bytesOf('authenticate me'), NONCE);
let accepted = 0;
for (let i = 0; i < sealedRef.length; i++) {
  for (const bit of [1, 0x80]) {
    const t = sealedRef.slice(); t[i] ^= bit;
    if (W.aesGcmOpen(GK, t) !== null) accepted++;
  }
}
eq(accepted, 0, 'AES-GCM rejects every single-bit flip across the whole sealed blob (' + (sealedRef.length * 2) + ' mutations)');
ok(W.aesGcmOpen(GK, [1, 2, 3]) === null, 'AES-GCM rejects a blob too short to hold a nonce and tag');

eq(hex(SPAB.deriveKey('password', 'salt', 1, 32)),
   crypto.pbkdf2Sync('password', 'salt', 1, 32, 'sha256').toString('hex'), 'deriveKey matches PBKDF2-HMAC-SHA256 (1 iteration)');
eq(hex(SPAB.deriveKey('password', 'salt', 100, 32)),
   crypto.pbkdf2Sync('password', 'salt', 100, 32, 'sha256').toString('hex'), 'deriveKey matches PBKDF2 (100 iterations)');
eq(hex(SPAB.deriveKey(bytesOf('bytes-key'), bytesOf('bytes-salt'), 10, 48)),
   crypto.pbkdf2Sync(Buffer.from('bytes-key'), Buffer.from('bytes-salt'), 10, 48, 'sha256').toString('hex'),
   'deriveKey accepts byte arrays and spans multiple output blocks');
eq(SPAB.deriveKey('p', 's').length, 32, 'deriveKey defaults to a 32-byte key');

// ============================================================ 2. bit I/O and varint
console.log('\n-- 2. bit I/O and varint --');

let varintBad = 0;
for (const n of [0, 1, 126, 127, 128, 129, 255, 256, 16382, 16383, 16384, 16385, 65535, 1048576]) {
  const v = W.getVarint(W.putVarint(n), 0);
  if (!v || v.value !== n) varintBad++;
}
eq(varintBad, 0, 'varint round-trips across every continuation boundary (127/128, 16383/16384)');
eq(W.putVarint(127).length, 1, 'a length of 127 fits one varint byte');
eq(W.putVarint(128).length, 2, 'a length of 128 needs two');
eq(W.putVarint(16383).length, 2, 'a length of 16383 still fits two');
eq(W.putVarint(16384).length, 3, 'a length of 16384 needs three');
ok(W.getVarint([0x80, 0x80, 0x80, 0x80, 0x80, 0x80], 0) === null, 'an absurdly long varint is rejected, not looped on');
ok(W.getVarint([0x80], 0) === null, 'a varint that runs off the end is rejected');

let bitBad = 0;
for (let n = 0; n < 200; n++) {
  const b = randomBytes(n, 0x55 + n);
  if (hex(W.bitsToBytes(W.bytesToBits(b))) !== hex(b)) bitBad++;
}
eq(bitBad, 0, 'bytes -> bits -> bytes is the identity for every length 0..199');

// ============================================================ 3. the escape mechanism
console.log('\n-- 3. the field escape mechanism --');

// Extension is exercised through the packet builder, which is the only thing that
// writes one: a type code at or above 31 escapes into extension bytes.
function headerOf(bits) {
  return { ver: (bits[0] << 2) | (bits[1] << 1) | bits[2],
           type: (bits[3] << 4) | (bits[4] << 3) | (bits[5] << 2) | (bits[6] << 1) | bits[7] };
}
const plainType = W.build('x', 6, {});
const escType = W.build('x', 31, {});
eq(headerOf(escType.bits).type, 31, 'a type at the escape value writes all-ones in the fixed header');
eq(escType.headerBits - plainType.headerBits, 8, 'one escaped field costs exactly 8 bits');
eq(W.build('x', 285, {}).headerBits - plainType.headerBits, 8, 'type 285 still costs one extension byte');
eq(W.build('x', 286, {}).headerBits - plainType.headerBits, 16, 'type 286 rolls into a second extension byte');
eq(W.build('x', 540, {}).headerBits - plainType.headerBits, 16, 'type 540 fits two extension bytes');
eq(W.build('x', 541, {}).headerBits - plainType.headerBits, 24, 'type 541 needs a third');
// And the extended value reads back exactly, through the real parser.
let extBad = 0;
for (const t of [31, 32, 100, 254, 255, 256, 285, 286, 400, 540, 541]) {
  const p = W.build('extended-type-payload', t, {});
  const f = W.parse(p.bits, 0);
  if (!f || f.type !== t) extBad++;
}
eq(extBad, 0, 'every extended type code 31..541 round-trips through the escape chain');
eq(W.parse(W.build('x', 300, {}).bits, 0).type, 300, 'an extended type is reported as its real value, not the escape');
// An escape whose extension bytes never arrive must be refused, not read past the
// end of the stream. Build 17-bit headers by hand so each escaped field is the last
// thing in the window.
function header(ver, type, comp, enc, ck) {
  const bits = [];
  const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };
  put(ver, 3); put(type, 5); put(comp, 3); put(enc, 3); put(ck, 3);
  return bits;
}
ok(W.parse(header(7, 0, 0, 0, 0), 0) === null, 'a version escape with no extension byte is refused');
ok(W.parse(header(2, 31, 0, 0, 0), 0) === null, 'a type escape with no extension byte is refused');
ok(W.parse(header(2, 0, 7, 0, 0), 0) === null, 'a compression escape with no extension byte is refused');
ok(W.parse(header(2, 0, 0, 7, 0), 0) === null, 'an encryption escape with no extension byte is refused');
ok(W.parse(header(2, 0, 0, 0, 7), 0) === null, 'a checksum escape with no extension byte is refused');
ok(W.size(header(2, 31, 0, 0, 0), 0) === null, 'the same is true when only the size is being read');
ok(W.size(header(2, 0, 7, 0, 0), 0) === null, 'a truncated compression escape yields no size');
ok(W.size(header(2, 0, 0, 7, 0), 0) === null, 'a truncated encryption escape yields no size');
ok(W.size(header(2, 0, 0, 0, 7), 0) === null, 'a truncated checksum escape yields no size');
ok(W.parse(header(3, 0, 0, 0, 0).concat(new Array(200).fill(0)), 0) === null,
  'a version this build does not implement is refused rather than best-effort parsed');
ok(W.parse(header(2, 0, 0, 0, 0), 0) === null, 'a header with no length, checksum or content is not a packet');

// An extension chain long enough to be absurd is refused rather than accumulated.
(function () {
  const p = W.build('x', 66000, {});   // ~258 extension bytes of 0xFF
  ok(p.headerBits > 17 + 8 * 250, 'a type code of 66000 really does write a long extension chain');
  ok(W.parse(p.bits, 0) === null, 'an extension chain past 0xFFFF is refused, not accumulated');
})();

// A checksum exponent at the escape is well-formed but beyond what this codec
// implements, so it must be refused rather than guessed at.
ok(W.parse(W.build('x', 0, { cksum: 7 }).bits, 0) === null, 'an escaped checksum exponent is refused by this build');
ok(W.parse(W.build('x', 0, { cksum: 6 }).bits, 0) === null, 'the reserved 512-bit checksum is refused by this build');

// ============================================================ 4. packet geometry
console.log('\n-- 4. packet geometry --');

const FIXED_HEADER = 17;
function geom(msg, type, opts) { return W.build(msg, type, opts || {}); }
eq(geom('SN-12345', 'ser8', { cksum: 0 }).headerBits, FIXED_HEADER + 8, 'ser8 + crc8: 17 header bits, no length, 8 checksum = 25');
eq(geom('SN-12345', 'ser8').headerBits, FIXED_HEADER + 16, 'ser8 at the default crc16: 33 bits, still no length field');
eq(geom('f81d4fae-7dec-11d0-a765-00a0c91e6bf6', 'uuid').headerBits, FIXED_HEADER + 16,
  'uuid: no length field, because the type implies 16 bytes');
eq(geom('f81d4fae-7dec-11d0-a765-00a0c91e6bf6', 'uuid', { cksum: 1 }).headerBits, FIXED_HEADER + 16,
  'uuid + crc16: 33 bits, matching the spec table');
eq(geom('hello there', 'string', { cksum: 0 }).headerBits, FIXED_HEADER + 8 + 8, 'a short string: header + 1 varint byte + crc8');
eq(geom('hello there', 'string').headerBits, FIXED_HEADER + 8 + 16, 'and 41 bits at the default crc16');
eq(geom(randomBytes(200, 9), 'bytes', { cksum: 2 }).headerBits, FIXED_HEADER + 16 + 32,
  '200 bytes + crc32: 17 + 16 (2-byte varint) + 32 = 65');
eq(geom('SN-12345', 'ser8').bits.length % 8, 0, 'a packet is padded to a byte boundary');
ok(geom('SN-12345', 'ser8').padBits < 8, 'the pad is never a whole byte');
eq(geom('SN-12345', 'ser8', { cksum: 0 }).bits.length, 8 * Math.ceil((25 + 64) / 8), 'ser8 packet is 89 bits rounded up to 96');

// Content position is exactly where the header says it is.
const geomPkt = geom('hello there', 'string');
eq(geomPkt.bits.length - geomPkt.headerBits - geomPkt.padBits, geomPkt.len * 8,
  'header + content + pad accounts for every bit in the packet');

// ============================================================ 5. types
console.log('\n-- 5. types --');

const TYPE_CASES = [
  ['string', 'just some ordinary text', 'just some ordinary text'],
  ['json', '{"user":"alice","role":"editor"}', '{"user":"alice","role":"editor"}'],
  ['bytes', [0, 1, 254, 255, 65, 0], [0, 1, 254, 255, 65, 0]],
  ['ser8', 'SPAB-001', 'SPAB-001'],
  ['uuid', '3f2504e0-4f89-11d3-9a0c-0305e82c3301', '3f2504e0-4f89-11d3-9a0c-0305e82c3301'],
  ['sha256', '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
             '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'],
  ['program', '#!/bin/sh\necho hello', '#!/bin/sh\necho hello'],
  ['encrypted', 'opaque-bytes-from-elsewhere', 'opaque-bytes-from-elsewhere']
];
for (const [name, msg, want] of TYPE_CASES) {
  const p = W.build(msg, name, {});
  const f = W.parse(p.bits, 0);
  ok(!!f && f.type === SPAB.TYPES[name], 'type ' + name + ' is written and read back');
  const opened = f && W.open(f, {});
  eq(opened && opened.message, want, 'type ' + name + ' round-trips its payload');
}
eq(W.build('3f2504e0-4f89-11d3-9a0c-0305e82c3301', 'uuid').len, 16, 'a uuid is stored as 16 bytes, not 36 characters');
eq(W.build('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', 'sha256').len, 32,
  'a sha256 is stored as 32 bytes, not 64 characters');
eq(W.build('too short', 'uuid').type, SPAB.TYPES.string, 'a mis-sized payload falls back off its fixed type');
eq(W.build('acme', 'no-such-type-name').type, SPAB.TYPES.string, 'an unknown type NAME falls back to string');
eq(W.build('acme', -3).type, SPAB.TYPES.string, 'a negative type code falls back to string');
eq(W.build('acme', undefined).type, SPAB.TYPES.string, 'an absent type falls back to string');
eq(W.build('acme', null).type, SPAB.TYPES.string, 'a null type falls back to string');
eq(W.inferType(42), SPAB.TYPES.string, 'inference: a number is carried as text');
eq(W.inferType(true), SPAB.TYPES.string, 'inference: a boolean is carried as text');
// A payload past the 64 KB sanity bound is truncated rather than written with a
// length field that has silently wrapped.
(function () {
  const huge = randomBytes(70000, 0x99);
  const p = W.build(huge, 'bytes', { compress: false });
  eq(p.len, 65535, 'a payload past 64 KB is truncated at the sanity bound');
  ok(!!W.parse(p.bits, 0), 'and the truncated packet is still well-formed');
})();

// Unassigned codes are carried and reported by number. That is what lets a newer
// writer and an older reader disagree without losing the payload.
for (const code of [8, 15, 26, 30]) {
  const f = W.parse(W.build('payload-under-an-unassigned-type', code, {}).bits, 0);
  ok(!!f && f.type === code, 'unassigned type ' + code + ' is carried, not rejected');
  eq(W.fields(f).type, '0x' + code.toString(16), 'unassigned type ' + code + ' is reported by code');
}
eq(W.inferType('{"a":1}'), SPAB.TYPES.json, 'inference: valid JSON object -> json');
eq(W.inferType('[1,2,3]'), SPAB.TYPES.json, 'inference: valid JSON array -> json');
eq(W.inferType('{not json}'), SPAB.TYPES.string, 'inference: brace-shaped but invalid -> string');
eq(W.inferType('3f2504e0-4f89-11d3-9a0c-0305e82c3301'), SPAB.TYPES.uuid, 'inference: uuid shape -> uuid');
eq(W.inferType('a'.repeat(64).replace(/a/g, 'e')), SPAB.TYPES.sha256, 'inference: 64 hex characters -> sha256');
eq(W.inferType('SPAB-001'), SPAB.TYPES.ser8, 'inference: an 8-byte tag -> ser8');
eq(W.inferType([1, 2, 3]), SPAB.TYPES.bytes, 'inference: an array -> bytes');
eq(W.inferType(new Uint8Array([1, 2])), SPAB.TYPES.bytes, 'inference: a Uint8Array -> bytes');
eq(W.inferType('  SPAB-001  '), SPAB.TYPES.string, 'inference: a padded 8-byte tag is not ser8 (trim would change it)');

// ============================================================ 6. lengths
console.log('\n-- 6. lengths --');

// Exhaustive: every length from 1 byte up through both varint boundaries, with an
// incompressible payload so the stored length is the length under test.
let lenBad = [];
for (let n = 1; n <= 300; n++) {
  const body = randomBytes(n, 0xabc + n);
  const p = W.build(body, 'bytes', { compress: false });
  const f = W.parse(p.bits, 0);
  if (!f || f.len !== n || hex(W.open(f, {}).bytes) !== hex(body)) lenBad.push(n);
}
eq(lenBad.length, 0, 'every payload length 1..300 round-trips exactly (incompressible, so stored = actual)');
for (const n of [127, 128, 129, 16383, 16384]) {
  const body = randomBytes(n, 0xdef + n);
  const f = W.parse(W.build(body, 'bytes', { compress: false }).bits, 0);
  ok(!!f && f.len === n && hex(W.open(f, {}).bytes) === hex(body), 'length ' + n + ' round-trips across the varint boundary');
}
eq(W.build(randomBytes(127, 1), 'bytes', { compress: false, cksum: 0 }).headerBits, FIXED_HEADER + 8 + 8,
  'a 127-byte payload spends one varint byte');
eq(W.build(randomBytes(128, 1), 'bytes', { compress: false, cksum: 0 }).headerBits, FIXED_HEADER + 16 + 8,
  'a 128-byte payload spends two');

// ============================================================ 7. compression
console.log('\n-- 7. compression --');

const COMPRESSIBLE = [
  ['run of one byte', 'z'.repeat(400)],
  ['repeated word', 'na'.repeat(120) + ' batman'],
  ['repetitive JSON', JSON.stringify({ role: 'editor', role2: 'editor', role3: 'editor', org: 'acme', org2: 'acme' })],
  ['English prose', 'the quick brown fox jumps over the lazy dog. '.repeat(8)],
  ['long overlapping run', 'ab'.repeat(500)]
];
for (const [name, msg] of COMPRESSIBLE) {
  const p = W.build(msg, 'string', {});
  const f = W.parse(p.bits, 0);
  ok(p.comp === SPAB.COMP.lzss, 'compression kicks in: ' + name);
  ok(p.len < p.messageBytes, 'stored form is smaller: ' + name + ' (' + p.messageBytes + ' -> ' + p.len + ')');
  eq(W.open(f, {}).message, msg, 'compressed payload round-trips: ' + name);
}
const INCOMPRESSIBLE = [
  ['short string', 'hi'],
  ['8-byte tag', 'SPAB-001'],
  ['random 200 bytes', randomBytes(200, 0x31337)],
  ['random 2000 bytes', randomBytes(2000, 0x1337)]
];
for (const [name, msg] of INCOMPRESSIBLE) {
  const p = W.build(msg, Array.isArray(msg) ? 'bytes' : undefined, {});
  ok(p.comp === SPAB.COMP.none, 'compression is skipped when it would not help: ' + name);
  eq(p.len, p.messageBytes, 'stored size equals original when uncompressed: ' + name);
}
ok(W.build('z'.repeat(400), 'string', { compress: false }).comp === SPAB.COMP.none,
  'compress:false disables compression even on a payload that would compress');
eq(W.build('z'.repeat(400), 'string', { compress: false }).len, 400, 'compress:false stores the payload as-is');
// A fixed type that compresses regains its length field, because the stored size no
// longer matches what the type implies.
const compFixed = W.build('aaaaaaaaaaaaaaaa', 'uuid', {});
ok(compFixed.type === SPAB.TYPES.string, 'a 16-character string is not a uuid (hex decode would not match)');

// LZSS itself: round-trip everything, including the shapes that exercise overlapping
// matches, maximum match length, and the window edge.
let lzBad = [];
const LZ_CASES = [[], [0], bytesOf('a'), bytesOf('aaa'), bytesOf('aaaa'),
  bytesOf('a'.repeat(18)), bytesOf('a'.repeat(19)), bytesOf('a'.repeat(5000)),
  bytesOf('abcabcabcabcabc'), bytesOf('x' + 'y'.repeat(4100) + 'x')];
for (let i = 0; i < LZ_CASES.length; i++) {
  const d = W.lzssDecompress(W.lzssCompress(LZ_CASES[i]));
  if (!d || hex(d) !== hex(LZ_CASES[i])) lzBad.push(i);
}
for (let n = 0; n < 400; n++) {
  const b = randomBytes(n, 0x2468 + n);
  const d = W.lzssDecompress(W.lzssCompress(b));
  if (!d || hex(d) !== hex(b)) lzBad.push('rand' + n);
}
for (let n = 0; n < 100; n++) {
  // Low-entropy input: lots of matches, which is the branch random data never takes.
  const b = Array.from({ length: n }, (_, i) => (i * 3) % 4);
  const d = W.lzssDecompress(W.lzssCompress(b));
  if (!d || hex(d) !== hex(b)) lzBad.push('low' + n);
}
eq(lzBad.length, 0, 'LZSS round-trips 510 cases: empty, runs, overlaps, window edge, random, low-entropy');
ok(W.lzssDecompress([0x00, 0x00]) === null, 'LZSS rejects a match token that runs off the end of the stream');
ok(W.lzssDecompress([0x00, 0x00, 0x10]) === null, 'LZSS rejects a truncated match token');
ok(W.lzssDecompress([0x00, 0xff, 0xff]) === null, 'LZSS rejects a back-reference pointing before the output');

// A packet claiming a compression this build does not implement is located and
// reported, not silently dropped.
function withField(msg, field, value) {
  // Rebuild a packet with one header field overwritten, so unsupported-code paths
  // can be reached without the encoder being able to produce them.
  const p = W.build(msg, 'string', {});
  const bits = p.bits.slice();
  const at = { comp: 8, enc: 11 }[field];
  for (let i = 0; i < 3; i++) bits[at + i] = (value >> (2 - i)) & 1;
  // The checksum covers the header, so it has to be recomputed over the edit.
  const ckExp = (bits[14] << 2) | (bits[15] << 1) | bits[16];
  const preBits = p.headerBits - W.cksumBits(ckExp);
  const contentBits = bits.slice(p.headerBits, p.headerBits + p.len * 8);
  const ck = W.checksum(W.bitsToBytes(padTo8(bits.slice(0, preBits).concat(contentBits))), ckExp);
  const ckBits = W.bytesToBits(ck);
  for (let i = 0; i < ckBits.length; i++) bits[preBits + i] = ckBits[i];
  return bits;
}
function padTo8(b) { const c = b.slice(); while (c.length % 8) c.push(0); return c; }
for (const [code, name] of [[2, 'deflate-raw'], [3, 'gzip'], [4, 'brotli'], [5, 'zstd']]) {
  const f = W.parse(withField('some payload', 'comp', code), 0);
  ok(!!f && f.comp === code, 'a packet compressed with ' + name + ' is still located');
  eq(W.open(f, {}).fail, 'unsupported', 'and reported as unsupported rather than dropped: ' + name);
}
ok(W.parse(withField('some payload', 'comp', 6), 0) === null, 'an unassigned compression code is refused');
// A payload whose compressed stream is corrupt is reported as corrupt, not as absent.
(function () {
  const p = W.build('na'.repeat(120), 'string', {});
  const f = W.parse(p.bits, 0);
  f.content = [0x00, 0xff, 0xff];   // all-match flags, offset 4096 with nothing behind it
  eq(W.open(f, {}).fail, 'corrupt', 'a corrupt compressed stream is reported as corrupt');
})();

// ============================================================ 8. encryption
console.log('\n-- 8. encryption --');

const KEY_HEX = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const KEY_BYTES = W.hexToBytes(KEY_HEX);
for (const [name, key] of [['64-char hex', KEY_HEX], ['32-byte array', KEY_BYTES],
                           ['Uint8Array', new Uint8Array(KEY_BYTES)], ['uppercase hex', KEY_HEX.toUpperCase()]]) {
  const p = W.build('classified', 'string', { encKey: key });
  const f = W.parse(p.bits, 0);
  ok(p.enc === SPAB.ENC.aes256gcm, 'key accepted as ' + name);
  eq(W.open(f, { encKey: key }).message, 'classified', 'round-trips with a key given as ' + name);
}
for (const bad of ['', 'short', 'zz'.repeat(32), [1, 2, 3], new Uint8Array(31), null, undefined]) {
  eq(W.build('plain', 'string', { encKey: bad }).enc, SPAB.ENC.none,
    'a malformed key (' + JSON.stringify(bad) + ') encrypts nothing rather than half-encrypting');
}
// Every length, including empty and block boundaries.
let encBad = [];
for (const n of [1, 2, 15, 16, 17, 31, 32, 33, 64, 100, 255, 256, 500]) {
  const body = randomBytes(n, 0xfeed + n);
  const p = W.build(body, 'bytes', { encKey: KEY_HEX, compress: false });
  const f = W.parse(p.bits, 0);
  const o = W.open(f, { encKey: KEY_HEX });
  if (!f || o.fail || hex(o.bytes) !== hex(body)) encBad.push(n);
  if (p.len !== n + 28) encBad.push('len' + n);
}
eq(encBad.length, 0, 'AES-256-GCM round-trips every length, and costs exactly 28 bytes (12 nonce + 16 tag)');
(function () {
  const p = W.build('secret memo', 'string', { encKey: KEY_HEX });
  const f = W.parse(p.bits, 0);
  ok(!!f, 'an encrypted packet is LOCATABLE with no key at all — the plaintext checksum is what finds it');
  eq(W.open(f, {}).fail, 'encrypted', 'without a key it reports "encrypted", not "not detected"');
  eq(W.open(f, { encKey: KEY_HEX.replace(/^00/, '01') }).fail, 'auth-failed', 'a wrong key reports auth-failed');
  eq(W.fields(f).encrypted, true, 'metadata says the payload is encrypted');
  eq(W.fields(f).encryption, 'aes-256-gcm', 'metadata names the algorithm');
})();
// Tampering anywhere in the ciphertext is caught by the AEAD tag even when the
// packet checksum is repaired to match — which is exactly what the tag is for.
(function () {
  const p = W.build('secret memo', 'string', { encKey: KEY_HEX });
  const f = W.parse(p.bits, 0);
  f.content = f.content.slice(); f.content[20] ^= 0x01;
  eq(W.open(f, { encKey: KEY_HEX }).fail, 'auth-failed', 'altered ciphertext fails the AEAD tag');
})();
// Pipeline order: compress, then encrypt.
(function () {
  const msg = 'na'.repeat(150);
  const p = W.build(msg, 'string', { encKey: KEY_HEX });
  const f = W.parse(p.bits, 0);
  ok(f.comp === SPAB.COMP.lzss && f.enc === SPAB.ENC.aes256gcm, 'a compressible payload is compressed AND encrypted');
  ok(p.len < msg.length, 'compression happened before encryption, so the ciphertext is shorter than the plaintext');
  eq(W.open(f, { encKey: KEY_HEX }).message, msg, 'compress-then-encrypt round-trips');
})();
eq(W.build('same', 'string', { encKey: KEY_HEX, nonce: NONCE }).bits.join(''),
   W.build('same', 'string', { encKey: KEY_HEX, nonce: NONCE }).bits.join(''),
   'a supplied nonce makes encryption deterministic (for test vectors)');
ok(W.build('same', 'string', { encKey: KEY_HEX }).bits.join('') !==
   W.build('same', 'string', { encKey: KEY_HEX }).bits.join(''),
   'without a supplied nonce, two encryptions of the same payload differ');
// An algorithm this build knows of but does not implement.
(function () {
  const f = W.parse(withField('some payload', 'enc', SPAB.ENC.chacha20poly1305), 0);
  ok(!!f && f.enc === SPAB.ENC.chacha20poly1305, 'a chacha20-poly1305 packet is still located');
  eq(W.open(f, {}).fail, 'unsupported', 'and reported as unsupported');
  eq(W.fields(f).encryption, 'chacha20-poly1305', 'and named in metadata');
})();
for (const code of [3, 4, 5, 6]) {
  ok(W.parse(withField('some payload', 'enc', code), 0) === null, 'an unassigned encryption code ' + code + ' is refused');
}

// ============================================================ 9. checksums
console.log('\n-- 9. checksums --');

for (let exp = 0; exp <= 5; exp++) {
  const bits = W.cksumBits(exp);
  const p = W.build('checksum width under test', 'string', { cksum: exp });
  const f = W.parse(p.bits, 0);
  ok(!!f && f.cksum === exp, 'checksum exponent ' + exp + ' (' + bits + ' bits) round-trips');
  eq(p.headerBits, FIXED_HEADER + 8 + bits, 'exponent ' + exp + ' costs exactly ' + bits + ' checksum bits');
  eq(W.fields(f).checksumBits, bits, 'metadata reports ' + bits + ' checksum bits');
  // Every single-bit corruption of the content must be caught.
  let missed = 0;
  for (let i = 0; i < p.len * 8; i++) {
    const t = p.bits.slice(); t[p.headerBits + i] ^= 1;
    if (W.parse(t, 0)) missed++;
  }
  ok(missed === 0, 'exponent ' + exp + ' catches all ' + (p.len * 8) + ' single-bit content corruptions');
}
// Header corruption is caught too, which is why the checksum covers the header.
(function () {
  const p = W.build('header integrity', 'string', { cksum: 1 });
  let missed = 0;
  // Bits 0..16 are the fixed header; flipping any of them must not yield a packet
  // that parses AND claims the same payload.
  for (let i = 0; i < FIXED_HEADER; i++) {
    const t = p.bits.slice(); t[i] ^= 1;
    const f = W.parse(t, 0);
    if (f && f.type === p.type && f.comp === p.comp && f.enc === p.enc && f.cksum === p.cksum) missed++;
  }
  eq(missed, 0, 'flipping any fixed-header bit is caught — the checksum covers the header, not just the content');
})();
// The default FLOOR is crc16, not crc8. crc8 stays in the format and is reachable
// with an explicit cksum:0, but the blind sweep found a chance 32-byte `sha256`
// packet through 8 bits of CRC on a damaged mark, so it is not what callers get by
// default. See the note on defaultCksumExp in spab.js.
eq(W.build('x'.repeat(10), 'string', {}).cksum, 1, 'the default checksum floor is crc16, even for a tiny payload');
eq(W.build(randomBytes(100, 3), 'bytes', {}).cksum, 1, 'crc16 covers payloads to 512 stored bytes');
eq(W.build(randomBytes(900, 3), 'bytes', {}).cksum, 2, 'default rises to crc32 above 512 stored bytes');
eq(W.build('x'.repeat(10), 'string', { cksum: 0 }).cksum, 0, 'crc8 is still reachable when a caller asks for it');
eq(W.checksum(CHK, 0).length, 1, 'exponent 0 emits 1 byte');
eq(W.checksum(CHK, 3).length, 8, 'exponent 3 emits 8 bytes of truncated SHA-256');
eq(hex(W.checksum(CHK, 5)), hex(W.sha256(CHK)), 'exponent 5 is the full SHA-256');
eq(hex(W.checksum(CHK, 4)), hex(W.sha256(CHK)).slice(0, 32), 'exponent 4 is SHA-256 truncated to its leading 128 bits');

// ============================================================ 10. checksum before content
console.log('\n-- 10. the checksum precedes the content --');

(function () {
  const p = W.build(randomBytes(120, 7), 'bytes', { cksum: 2, compress: false });
  // Cut the packet off mid-content, as tail truncation does.
  const truncated = p.bits.slice(0, p.headerBits + 40);
  ok(W.parse(truncated, 0) === null, 'a truncated packet does not parse — the content is not all there');
  eq(W.size(truncated, 0), p.bits.length,
    'but the surviving header still states the full packet size, so truncation is DETECTED rather than mis-parsed');
  // And the header fields are all readable from the surviving prefix.
  const probe = W.parse(p.bits, 0);
  eq(probe.len, 120, 'the header states the length the missing bytes should have had');
  ok(p.headerBits < 60, 'the whole descriptor — type, length, checksum — fits in the first ' + p.headerBits + ' bits');
})();
eq(W.size([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0), null,
  'an all-zero window is not a packet (version 0 is reserved and never emitted)');
ok(W.size([1, 0], 0) === null, 'a window too short to hold a fixed header yields no size');
ok(W.parse([1, 0, 1], 0) === null, 'a window too short to hold a fixed header does not parse');

// ============================================================ 11. the sweep
console.log('\n-- 11. finding packets without a magic number --');

(function () {
  // The discriminator is the header's plausibility plus the checksum. Measure what
  // that actually rejects, because dropping the magic byte was a deliberate trade
  // (dev/wire-format.md §7) and this is the number that justifies it.
  let hits = 0, windows = 0;
  for (let t = 0; t < 120; t++) {
    const r = prng(0x9e3779b9 + t * 7919), bits = [];
    for (let i = 0; i < 8000; i++) bits.push(r() & 1);
    for (let o = 0; o + 32 <= bits.length; o += 8) { windows++; if (W.parse(bits, o)) hits++; }
  }
  ok(hits <= windows / 20000, 'random bits yield at most 1 false packet per 20k windows (' + hits + ' in ' + windows + ')');
  console.log('       measured: ' + hits + ' false packets in ' + windows + ' windows' +
    (hits ? ' = 1 in ' + Math.round(windows / hits) : ' = none'));
})();
(function () {
  // A real packet must survive being surrounded by noise at every alignment.
  const p = W.build('find-me-anywhere', 'string', {});
  let found = 0;
  for (let pad = 0; pad < 8; pad++) {
    const r = prng(0x5eed + pad), pre = [], post = [];
    for (let i = 0; i < pad * 8 + 64; i++) pre.push(r() & 1);
    for (let i = 0; i < 200; i++) post.push(r() & 1);
    const stream = pre.concat(p.bits, post);
    for (let o = 0; o + 32 <= stream.length; o += 8) {
      const f = W.parse(stream, o);
      if (f && W.open(f, {}).message === 'find-me-anywhere') { found++; break; }
    }
  }
  eq(found, 8, 'a packet is found at every byte alignment when embedded in noise');
})();

// A single sighting under an 8-bit checksum is exactly what produced a wrong payload
// in the noise matrix, so the blind sweep now refuses it. The fold path, which knows
// where packets start and measures agreement, still accepts crc8.
(function () {
  const cover = ('Every document carries more than its words. The spacing between them, the shape ' +
    'of a quote, the kind of dash - these are choices a reader never notices. ').repeat(30);
  const e = SPAB.encode(cover, 'acme-42', { cksum: 0 });
  ok(SPAB.decode(e.text, {}).message === 'acme-42', 'a crc8 mark still decodes by folding, where position is known');
  const many = SPAB.encode(cover, 'acme-42', { cksum: 1 });
  ok(SPAB.decode(many.text.replace(' spacing', ''), {}).message === 'acme-42',
    'a crc16 mark is still recovered by the blind sweep after a deletion');

  // The rule biting: a crc8 mark thin enough to fit once, shifted so folding fails.
  // The sweep finds exactly one sighting under an 8-bit checksum and refuses it —
  // the recovery this costs (2.4% of thin marks, measured) is the price of never
  // returning a payload that was not written.
  const PARA = 'The board reviewed the quarterly figures on Tuesday and asked for a re-forecast ' +
    'before the end of the month. Operating costs are down year-over-year, though the well-documented ' +
    'delays on the Hartley contract have not yet worked through the numbers. Finance will circulate ' +
    'a revised model on Friday. ';
  const thin = SPAB.encode(PARA.repeat(2), 'acme-42', { cksum: 0 });
  eq(thin.metadata.reps, 1, 'the thin crc8 mark really does fit only one copy');
  const shifted = 'A line in front. ' + thin.text;
  eq(SPAB.decode(shifted, {}).message, null,
    'a single crc8 sighting found by blind sweep is refused rather than trusted');
  // The same mark at crc16 is recovered, which is what makes crc16 the default.
  const thin16 = SPAB.encode(PARA.repeat(2), 'acme-42', { cksum: 1 });
  eq(SPAB.decode('A line in front. ' + thin16.text, {}).message, 'acme-42',
    'the same shifted mark IS recovered at the default crc16');
})();

// ============================================================ 12. end to end
console.log('\n-- 12. end to end, through carriers and ECC --');

const COVER = ('Every document carries more than its words. The spacing between them, the shape ' +
  'of a quote, the kind of dash - these are choices a reader never notices, and they are ' +
  "exactly where a mark can live without changing what the page says. It's a quiet channel. ").repeat(14);

// RLNC spends a 32-bit self-checking packet per source byte, so an encrypted or
// wide-checksum packet needs roughly 32x its size in capacity. Give it a cover that
// has it, rather than testing a limit that is not the format's.
const BIG_COVER = COVER.repeat(4);
for (const ecc of ['repetition', 'rlnc']) {
  for (const [name, msg, params] of [
    ['plain string', 'acme-42', {}],
    ['json', '{"user":"alice","role":"editor"}', {}],
    ['uuid', '3f2504e0-4f89-11d3-9a0c-0305e82c3301', {}],
    ['compressed', 'na'.repeat(60), {}],
    ['encrypted', 'classified-payload', { encKey: KEY_HEX }],
    ['compressed + encrypted', 'na'.repeat(60), { encKey: KEY_HEX }],
    ['crc32', 'wide-checksum-payload', { cksum: 2 }],
    ['sha256 checksum', 'digest-checksum-payload', { cksum: 5 }]
  ]) {
    const p = Object.assign({ ecc: ecc }, params);
    const cover = ecc === 'rlnc' ? BIG_COVER : COVER;
    const e = SPAB.encode(cover, msg, p);
    const d = SPAB.decode(e.text, p);
    ok(d.message === msg, 'end to end (' + ecc + '): ' + name +
      (d.message === msg ? '' : ' [' + d.metadata.status + '; ' + (e.metadata.issues || []).join(' ') + ']'));
  }
}
// Metadata reports every wire field, both directions.
(function () {
  const e = SPAB.encode(COVER, 'na'.repeat(60), { encKey: KEY_HEX, cksum: 2 });
  const d = SPAB.decode(e.text, { encKey: KEY_HEX });
  eq(e.metadata.compression, 'lzss', 'encode metadata names the compression it used');
  eq(e.metadata.encryption, 'aes-256-gcm', 'encode metadata names the cipher it used');
  eq(e.metadata.checksum, 'crc32', 'encode metadata names the checksum width');
  eq(e.metadata.wireVersion, 2, 'encode metadata names the wire version');
  ok(e.metadata.headerBits === 17 + 8 + 32 || e.metadata.headerBits === 17 + 16 + 32,
    'encode metadata reports the header size in bits (' + e.metadata.headerBits + ')');
  eq(d.metadata.compression, 'lzss', 'decode metadata names the compression');
  eq(d.metadata.encryption, 'aes-256-gcm', 'decode metadata names the cipher');
  eq(d.metadata.encrypted, true, 'decode metadata flags the payload as encrypted');
  eq(d.metadata.checksum, 'crc32', 'decode metadata names the checksum');
  eq(d.metadata.messageBytes, 120, 'decode metadata reports the opened payload size');
  ok(d.metadata.payloadBytes !== d.metadata.messageBytes, 'stored and opened sizes are both reported and differ');
})();
// Decoding an encrypted mark without the key: found, named, not opened.
(function () {
  const e = SPAB.encode(COVER, 'classified', { encKey: KEY_HEX });
  const d = SPAB.decode(e.text, {});
  eq(d.message, null, 'an encrypted mark yields no message without the key');
  eq(d.metadata.status, 'encrypted', 'and the status says why');
  eq(d.metadata.encryption, 'aes-256-gcm', 'and still names the algorithm');
  ok(d.metadata.crcOk === true, 'the packet itself verified — it was located, just not opened');
  const wrong = SPAB.decode(e.text, { encKey: KEY_HEX.replace(/^00/, '01') });
  eq(wrong.metadata.status, 'auth-failed', 'a wrong key is reported as auth-failed, not as absent');
})();
// Encryption survives the resync path, which reads a packet independently.
(function () {
  const e = SPAB.encode(COVER + COVER, 'resync-me-encrypted', { encKey: KEY_HEX });
  const damaged = e.text.replace(' spacing', '');
  const d = SPAB.decode(damaged, { encKey: KEY_HEX });
  ok(d.message === 'resync-me-encrypted', 'an encrypted payload survives a deletion via the resync scan');
})();
// Every carrier class carries the new header. apos and hyphen are one bit per site,
// so they need a cover with enough of their own character to hold a packet at all —
// that is the carrier's capacity, not a property of the format.
const PUNCT_COVER = ("It's a well-known fact that a copy-editor's day-to-day work isn't glamorous - " +
  "it's the sort of long-running, detail-oriented job that doesn't get written up. ").repeat(40);
for (const cls of [['ws'], ['apos'], ['hyphen'], ['wsdense'], ['zwsp'], ['ws', 'apos', 'hyphen']]) {
  const cover = (cls[0] === 'apos' || cls[0] === 'hyphen') ? PUNCT_COVER : COVER;
  const e = SPAB.encode(cover, 'carrier-check', { classes: cls });
  const d = SPAB.decode(e.text, { classes: cls });
  ok(d.message === 'carrier-check', 'carriers [' + cls.join(',') + '] carry a v2 packet' +
    (d.message === 'carrier-check' ? '' : ' [' + d.metadata.status + '; sites=' + e.metadata.slots + ']'));
}
// And a keyed mark.
(function () {
  const e = SPAB.encode(COVER, 'keyed-payload', { key: 'sekrit' });
  ok(SPAB.decode(e.text, { key: 'sekrit' }).message === 'keyed-payload', 'a keyed mark round-trips');
  ok(SPAB.decode(e.text, {}).message !== 'keyed-payload', 'and does not decode without the key');
})();

// ============================================================ 12b. self-report
console.log('\n-- 12b. the build reports itself truthfully --');

(function () {
  const v = SPAB.version();
  eq(v.version, SPAB.VERSION, 'version() agrees with the VERSION string');
  eq(v.version, require('../src/js/package.json').version, 'and with the published package version');
  eq(v.wireFormat, SPAB.algorithm.frame.version, 'version() names the wire format the descriptor does');
  eq(v.algorithm, SPAB.algorithm.name, 'version() names the algorithm the descriptor does');

  // The point of the capability lists is that they are the IMPLEMENTED subset, not
  // the registered one — a caller reads them to predict an 'unsupported' result
  // before encoding. So assert them against what the codec actually does, rather
  // than against another table that could drift the same way.
  for (const name of Object.keys(SPAB.COMP)) {
    const code = SPAB.COMP[name];
    const f = W.parse(withField('a payload to compress', 'comp', code), 0);
    const works = !!f && W.open(f, {}).fail !== 'unsupported';
    const claimed = !!f && v.compression.indexOf(W.fields(f).compression) >= 0;
    ok(works === claimed, 'version() tells the truth about compression "' + name + '" (' +
      (works ? 'implemented' : 'not implemented') + ', ' + (claimed ? 'claimed' : 'not claimed') + ')');
  }
  for (const name of Object.keys(SPAB.ENC)) {
    const code = SPAB.ENC[name];
    if (code === SPAB.ENC.none) continue;   // exercised by every other test in this file
    const f = W.parse(withField('a payload to encrypt', 'enc', code), 0);
    const works = !!f && W.open(f, { encKey: KEY_HEX }).fail !== 'unsupported';
    const claimed = !!f && v.encryption.indexOf(W.fields(f).encryption) >= 0;
    ok(works === claimed, 'version() tells the truth about encryption "' + name + '" (' +
      (works ? 'implemented' : 'not implemented') + ', ' + (claimed ? 'claimed' : 'not claimed') + ')');
  }
  // Every checksum width it claims must actually round-trip.
  let ckBad = 0;
  v.checksumBits.forEach(function (bits, exp) {
    const p = W.build('checksum claim', 'string', { cksum: exp });
    const f = W.parse(p.bits, 0);
    if (!f || W.cksumBits(f.cksum) !== bits) ckBad++;
  });
  eq(ckBad, 0, 'every checksum width version() claims actually round-trips');
  // Every carrier it names must resolve, and every default must be in the full list.
  eq(v.carriers.filter(function (c) { return !SPAB.CLASS_DEFS[c]; }), [], 'every carrier version() names exists');
  eq(v.defaultCarriers.filter(function (c) { return v.carriers.indexOf(c) < 0; }), [],
    'every default carrier is one of the carriers');
  eq(SPAB.resolveClasses({}), v.defaultCarriers, 'defaultCarriers is what resolveClasses actually picks');
  // Every ECC mode it names must encode and decode.
  for (const ecc of v.ecc) {
    const e = SPAB.encode(COVER, 'ecc-claim', { ecc: ecc });
    ok(SPAB.decode(e.text, { ecc: ecc }).message === 'ecc-claim', 'ecc mode "' + ecc + '" works as claimed');
  }
  eq(v.types.filter(function (t) { return SPAB.TYPES[t] === undefined; }), [], 'every type version() names is in TYPES');
  // It must be a snapshot, not a live handle onto internal state.
  const before = SPAB.version().carriers.length;
  SPAB.version().carriers.push('bogus');
  eq(SPAB.version().carriers.length, before, 'version() returns a fresh object each call, not shared state');
})();

// ============================================================ 12c. the soft layer
console.log('\n-- 12c. sliding histogram detector and the soft layer --');

(function () {
  const prose = ('Every document carries more than its words. The spacing between them, the shape ' +
    'of a quote, the kind of dash - these are choices a reader never notices. ').repeat(6);

  // Channel estimation from the carrier histogram alone. An unmarked passage is all
  // default glyphs, so it looks fully collapsed; marking spreads the mass; NFKC
  // folds it all back and the estimate returns to where it started.
  const clean = SPAB.detect(prose, { classes: ['ws'] }).ws;
  const marked = SPAB.detect(SPAB.encode(prose, 'acme-42', { classes: ['ws'] }).text, { classes: ['ws'] }).ws;
  const flat = SPAB.detect(SPAB.encode(prose, 'acme-42', { classes: ['ws'] }).text.normalize('NFKC'), { classes: ['ws'] }).ws;
  ok(clean.collapse > 0.9, 'unmarked prose estimates as fully collapsed (' + clean.collapse + ')');
  ok(marked.collapse < clean.collapse - 0.3, 'marking lowers the collapse estimate (' + marked.collapse + ')');
  ok(flat.collapse > 0.9, 'NFKC returns the estimate to unmarked (' + flat.collapse + ')');
  ok(marked.meanConfidence > clean.meanConfidence,
    'a marked passage reads with higher mean site confidence (' + marked.meanConfidence + ' vs ' + clean.meanConfidence + ')');

  // The likelihood field is a field: one entry per window position.
  eq(marked.field.length, marked.sites - marked.window + 1, 'the field has one entry per window position');
  ok(marked.field.every(f => f.counts.reduce((a, b) => a + b, 0) === marked.window),
    'every window histogram sums to the window size');
  ok(marked.field.some(f => f.marked > 0.5) && clean.field.every(f => f.marked < 0.2),
    'the marked score separates a marked passage from an unmarked one');
  // Explicit window size, and a window larger than the site count.
  eq(SPAB.detect(prose, { classes: ['ws'], window: 8 }).ws.window, 8, 'the window size is caller-settable');
  eq(SPAB.detect('a b', { classes: ['ws'], window: 500 }).ws.field.length, 0,
    'a window wider than the document yields an empty field rather than throwing');
  ok(SPAB.detect(prose).ws !== undefined, 'detect() with no params uses the default carriers');
  eq(SPAB.detect('').ws.sites, 0, 'detect() on empty text reports no sites');

  // Posteriors: a non-default observation is near-certain; the default is ambiguous
  // in proportion to how much collapse the histogram implies.
  const p1 = SPAB.soft.softDigit(2, 4, 0.5);
  ok(p1[2] > 0.9, 'a non-default observation is read with high confidence');
  const p0lo = SPAB.soft.softDigit(0, 4, 0.0), p0hi = SPAB.soft.softDigit(0, 4, 1.0);
  eq(p0lo[0], 1, 'with no collapse, the default glyph is certain');
  ok(Math.abs(p0hi[0] - 0.25) < 1e-9, 'with total collapse, the default glyph is uninformative');
  ok(p0hi[0] < p0lo[0], 'more estimated collapse means less trust in a default glyph');
  eq(SPAB.soft.estimateCollapse([], 4), 0, 'an empty stream estimates no collapse');
  eq(SPAB.soft.estimateCollapse([0, 1, 2, 3], 4), 0, 'a uniform stream estimates no collapse');
  ok(SPAB.soft.estimateCollapse([0, 0, 0, 0], 4) > 0.9, 'an all-default stream estimates near-total collapse');
  eq(SPAB.soft.siteConfidence([0.1, 0.7, 0.1, 0.1]), 0.7, 'site confidence is the posterior maximum');
  // A window of 0 means "choose one": the field falls back to min(32, sites).
  eq(SPAB.soft.likelihoodField('a b', 'ws', 0).window, 1, 'a zero window falls back to the site count');
  eq(SPAB.soft.likelihoodField('', 'ws', 4).field.length, 0, 'no sites yields an empty field');
  eq(SPAB.soft.likelihoodField('a b', 'ws', 9).field.length, 0, 'a window wider than the sites yields an empty field');
})();

// Emoji joiners are not payload. U+200D is both a zwsp carrier variant and the emoji
// ZWJ, and reading a cover's own joiners as data desynchronises everything after
// them — caught by the emoji document in tests/corpus.js.
(function () {
  const ZWJ = '\u200D';
  const family = '\u{1F468}' + ZWJ + '\u{1F469}' + ZWJ + '\u{1F467}';
  eq(SPAB.CLASS_DEFS.zwsp.extract('a ' + family + ' b'), [], 'an emoji ZWJ sequence yields no carrier digits');
  eq(SPAB.CLASS_DEFS.zwsp.extract('a' + ZWJ + 'b'), [2], 'a ZWJ between ordinary letters IS carrier data');
  // Every pictographic category the joiner test recognises.
  const CATS = [
    ['emoji block', '\u{1F600}'],
    ['dingbat', '\u2714'],
    ['regional indicator', '\u{1F1EC}'],
    ['tag character', '\u{E0067}'],
    ['variation selector', '\uFE0F']
  ];
  for (const [name, ch] of CATS) {
    eq(SPAB.CLASS_DEFS.zwsp.extract(ch + ZWJ + ch), [], 'a joiner between ' + name + ' pairs is not payload');
  }
  // A joiner at the very start or end has no neighbour on one side, so it is data.
  eq(SPAB.CLASS_DEFS.zwsp.extract(ZWJ + '\u{1F600}'), [2], 'a leading joiner has no left neighbour and is payload');
  eq(SPAB.CLASS_DEFS.zwsp.extract('\u{1F600}' + ZWJ), [2], 'a trailing joiner has no right neighbour and is payload');
  // The other three zero-width variants are always payload — none is an emoji joiner.
  eq(SPAB.CLASS_DEFS.zwsp.extract('\u{1F600}\u200B\u{1F600}'), [0], 'U+200B between emoji is still payload');
  // And the round trip survives an emoji-heavy cover.
  const cover = ('A release note with a rocket \u{1F680} and a family ' + family +
    ' and a flag \u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F} in the middle of it. ').repeat(6);
  const e = SPAB.encode(cover, 'emoji-safe', { classes: ['zwsp'] });
  eq(SPAB.decode(e.text, { classes: ['zwsp'] }).message, 'emoji-safe', 'an emoji-heavy cover round-trips through zwsp');
  ok(e.text.indexOf(family) >= 0, 'and the emoji clusters are left intact');
})();

// ============================================================ 13. the spec matches
console.log('\n-- 13. the specification matches the implementation --');

// The source header is normative documentation for anyone porting spab, and it went
// stale once already: through 0.5.0 it still described the 0.1.x codec — "magic
// 0xA5", a one-byte length, whitespace-only defaults — none of which had been true
// for two wire formats. A porting agent reading it would have faithfully implemented
// the wrong thing. So the header is checked against the descriptor here rather than
// trusted. (Review dev/spab_0.5_review.md 12.7.)
(function () {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'spab.js'), 'utf8');
  const header = src.slice(0, src.indexOf('(function (root) {'));
  const f = SPAB.algorithm.frame;
  ok(header.indexOf('wire format v2') > 0 || header.indexOf('Wire format v2') > 0,
    'the source header names the current wire format');
  ok(header.indexOf('magic') < 0 || header.indexOf('no magic number') > 0,
    'the source header does not claim a magic byte the format no longer has');
  ok(header.indexOf('0xA5') < 0, 'the retired magic constant is gone from the header');
  ok(header.indexOf('whitespace-only') < 0, 'the header does not claim the old whitespace-only default');
  for (const cls of SPAB.version().defaultCarriers) {
    ok(header.indexOf(cls) > 0, 'the header names default carrier ' + cls);
  }
  for (const ecc of SPAB.version().ecc) {
    ok(header.toLowerCase().indexOf(ecc) > 0, 'the header names ecc mode ' + ecc);
  }
  ok(header.indexOf('17-bit') > 0, 'the header states the fixed header width the descriptor does');
  ok(header.indexOf('nonce') > 0, 'the header states the determinism exception for encryption');
  ok(header.indexOf('dev/wire-format.md') > 0, 'the header points at the normative spec');
  eq(f.version, 2, 'and the descriptor agrees');
})();

const SPEC = fs.readFileSync(path.join(__dirname, '..', 'dev', 'wire-format.md'), 'utf8');
ok(/version\s*:\s*3/.test(SPEC) && /type\s*:\s*5/.test(SPEC) && /comp\s*:\s*3/.test(SPEC) &&
   /enc\s*:\s*3/.test(SPEC) && /cksum\s*:\s*3/.test(SPEC), 'the spec states the five fixed-header widths');
ok(SPEC.indexOf('17 bits') > 0, 'the spec states the fixed header is 17 bits');
ok(SPEC.indexOf('8 << cksum') > 0 || SPEC.indexOf('8 << n') > 0, 'the spec states the checksum exponent rule');
const f = SPAB.algorithm.frame;
eq(f.version, 2, 'the descriptor and the spec agree on the version');
eq(f.fixedHeaderBits, 17, 'the descriptor states the same 17-bit fixed header');
for (const name of Object.keys(SPAB.TYPES)) {
  ok(SPEC.indexOf('`' + name + '`') > 0 || name === 'extended', 'the spec documents type ' + name);
}
for (const name of ['lzss', 'deflate-raw', 'gzip', 'brotli', 'zstd']) {
  ok(SPEC.indexOf(name) > 0, 'the spec documents compression ' + name);
}
for (const name of ['aes-256-gcm', 'chacha20-poly1305']) {
  ok(SPEC.indexOf(name) > 0, 'the spec documents encryption ' + name);
}

console.log('\nwire: ' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAIL (wire)'); process.exit(1); }
console.log('PASS (wire)');
