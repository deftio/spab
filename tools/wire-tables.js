#!/usr/bin/env node
/*
 * wire-tables.js — regenerate the worked-example and overhead tables in
 * dev/wire-format.md from the implementation, so the specification's numbers are
 * measured rather than asserted.
 *
 *   node tools/wire-tables.js           rewrite the generated sections in place
 *   node tools/wire-tables.js --check   fail if the document is out of date
 *
 * The tables live between the BEGIN/END GENERATED markers; everything else in the
 * document is written by hand.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const SPAB = require('../src/js/spab.js');
const W = SPAB.wire;

const DOC = path.join(__dirname, '..', 'dev', 'wire-format.md');
const KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

// Capacity of a representative passage at one copy, in bits, per size class. These
// are the whitespace-carrier capacities measured in r_and_d, and they are what makes
// the "fits" column mean something.
const CAPACITY = { tweet: 36, memo: 64, page: 196, chapter: 790, novel: 7918 };

function rnd(n, seed) {
  let x = seed >>> 0, o = [];
  for (let i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; o.push(x & 0xff); }
  return o;
}

const CASES = [
  { cls: 'tiny',     fits: 'memo',    desc: '8-byte serial',        msg: 'SPAB-001', type: 'ser8', opts: {} },
  { cls: 'small',    fits: 'page',    desc: '16-byte uuid',         msg: '3f2504e0-4f89-11d3-9a0c-0305e82c3301', type: 'uuid', opts: {} },
  { cls: 'small+',   fits: 'page',    desc: '32-byte sha256',       msg: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', type: 'sha256', opts: {} },
  { cls: 'medium',   fits: 'chapter', desc: '40-byte json',         msg: '{"u":"alice","r":"editor","t":1730000}', type: 'json', opts: { compress: false } },
  { cls: 'medium-z', fits: 'chapter', desc: '200-byte json, deflated', msg: JSON.stringify({ role: 'editor', role2: 'editor', role3: 'editor', org: 'acme-corporation', org2: 'acme-corporation', org3: 'acme-corporation', note: 'repeated fields compress' }), type: 'json', opts: {} },
  { cls: 'large',    fits: 'novel',   desc: '200-byte blob',        msg: rnd(200, 7), type: 'bytes', opts: { compress: false } },
  { cls: 'xl',       fits: 'novel',   desc: '2 KB blob',            msg: rnd(2048, 11), type: 'bytes', opts: { compress: false } },
  { cls: 'enc-tiny', fits: 'page',    desc: '8-byte serial, AES-GCM', msg: 'SPAB-001', type: 'ser8', opts: { encKey: KEY } },
  { cls: 'enc-med',  fits: 'chapter', desc: '40-byte json, AES-GCM', msg: '{"u":"alice","r":"editor","t":1730000}', type: 'json', opts: { encKey: KEY, compress: false } },
  { cls: 'enc-xl',   fits: 'novel',   desc: '2 KB blob, AES-GCM',   msg: rnd(2048, 11), type: 'bytes', opts: { encKey: KEY, compress: false, cksum: 5 } }
];

function row(c) {
  const p = W.build(c.msg, c.type, c.opts);
  const f = W.parse(p.bits, 0);
  const varintBits = p.headerBits - 17 - W.cksumBits(p.cksum);
  return {
    cls: c.cls, desc: c.desc,
    ver: 3, type: 5, comp: 3, enc: 3, ck: 3,
    len: varintBits, cksum: W.cksumBits(p.cksum),
    header: p.headerBits, content: p.len * 8, pad: p.padBits,
    total: p.bits.length, original: p.messageBytes * 8,
    compName: SPAB.algorithm.frame.compression && Object.keys(SPAB.COMP).find(k => SPAB.COMP[k] === p.comp),
    encName: Object.keys(SPAB.ENC).find(k => SPAB.ENC[k] === p.enc),
    fits: c.fits, cap: CAPACITY[c.fits], ok: !!f
  };
}

const rows = CASES.map(row);
const bad = rows.filter(r => !r.ok);
if (bad.length) { console.error('packets did not parse: ' + bad.map(r => r.cls).join(', ')); process.exit(2); }

// One decimal below 10%, so a 0.4% overhead does not print as 0%.
function fmtPct(v) { return (v < 10 ? v.toFixed(1) : Math.round(v)) + '%'; }

let examples = '';
examples += 'Bit-exact layouts, generated from the implementation by `npm run wire:tables`.\n';
examples += '`hdr` is everything before the content; `total` includes the pad to a byte boundary.\n\n';
examples += '| class | payload | ver | type | comp | enc | cksum | len | checksum | hdr | content | pad | total |\n';
examples += '|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|\n';
for (const r of rows) {
  examples += '| `' + r.cls + '` | ' + r.desc + ' | 3 | 5 | 3 | 3 | 3 | ' + r.len + ' | ' + r.cksum +
    ' | **' + r.header + '** | ' + r.content + ' | ' + r.pad + ' | ' + r.total + ' |\n';
}
examples += '\nEvery row has the same 17 bits of fixed header. What varies is the length field\n';
examples += '(absent for a fixed type stored plain, one varint byte to 127, two beyond) and the\n';
examples += 'checksum, which the encoder widens as the payload grows.\n';

let overhead = '';
overhead += '| class | payload | original | stored | header | overhead | vs payload | fits one copy |\n';
overhead += '|---|---|--:|--:|--:|--:|--:|---|\n';
for (const r of rows) {
  const ovhd = r.header + r.pad;
  const fits = r.total <= r.cap ? 'yes' : 'no';
  overhead += '| `' + r.cls + '` | ' + r.desc + ' | ' + r.original + ' | ' + r.content + ' | ' + r.header +
    ' | ' + ovhd + ' | ' + fmtPct(100 * ovhd / r.content) + ' | ' + fits +
    ' (' + r.fits + ' = ' + r.cap + 'b) |\n';
}
overhead += '\nAll figures in bits. `original` is what the caller handed over; `stored` is what went\n';
overhead += 'on the wire after compression and encryption. The two compressed rows are the ones\n';
overhead += 'where they differ, and the `enc-*` rows pay 224 bits for the nonce and tag.\n';

const doc = fs.readFileSync(DOC, 'utf8');
function splice(text, name, body) {
  const b = '<!-- BEGIN GENERATED ' + name + ' -->', e = '<!-- END GENERATED ' + name + ' -->';
  const i = text.indexOf(b), j = text.indexOf(e);
  if (i < 0 || j < 0) { console.error('missing markers for ' + name); process.exit(2); }
  return text.slice(0, i + b.length) + '\n' + body + text.slice(j);
}
let out = splice(doc, 'EXAMPLES', examples);
out = splice(out, 'OVERHEAD', overhead);

if (process.argv.indexOf('--check') > 0) {
  if (out !== doc) { console.error('dev/wire-format.md is out of date — run `npm run wire:tables`'); process.exit(1); }
  console.log('dev/wire-format.md tables are up to date');
} else {
  fs.writeFileSync(DOC, out);
  console.log('dev/wire-format.md: regenerated ' + rows.length + ' example rows');
}
