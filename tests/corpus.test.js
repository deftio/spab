#!/usr/bin/env node
/*
 * corpus.test.js — the whole codec against a structurally diverse corpus.
 *
 * tests/corpus.js holds 73 documents chosen so each stresses a different property
 * of the carriers: scripts without inter-word spaces, right-to-left text, emoji ZWJ
 * sequences that collide with a carrier variant, code and markup, documents that
 * already contain unicode spaces, and lengths from empty to twelve paragraphs.
 *
 * The assertions here are deliberately about BEHAVIOUR, not recovery percentages.
 * Recovery depends on how much spare capacity a document has and moves whenever the
 * codec does; what must never move is:
 *
 *   1. encode and decode never throw, on any document, with any parameters;
 *   2. a document that round-trips clean stays round-tripping;
 *   3. a document that cannot hold the payload SAYS SO rather than failing quietly;
 *   4. unmarked text never yields a payload;
 *   5. damage may lose the payload but must never produce a DIFFERENT one.
 *
 * (5) is the project's central safety invariant and most of this file exists for it.
 */
'use strict';
const SPAB = require('../src/js/spab.js');
const { CORPUS } = require('./corpus.js');

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; } else { fail++; console.error('  FAIL ' + name); } }
function section(t) { console.log('\n-- ' + t + ' --'); }

const KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const PARAM_SETS = [
  { label: 'default', p: {} },
  { label: 'ws only', p: { classes: ['ws'] } },
  { label: 'punct only', p: { classes: ['apos', 'hyphen'] } },
  { label: 'wsdense', p: { classes: ['wsdense'] } },
  { label: 'zero-width', p: { classes: ['zwsp'] } },
  { label: 'rlnc', p: { ecc: 'rlnc' } },
  { label: 'keyed', p: { key: 'shared-secret' } },
  { label: 'encrypted', p: { encKey: KEY } },
  { label: 'crc32', p: { cksum: 2 } },
  { label: 'no compress', p: { compress: false } },
  { label: 'autoGrow', p: { autoGrow: true } }
];
const PAYLOADS = [
  ['ascii id', 'acme-42'],
  ['json', '{"r":"j.smith","case":42}'],
  ['uuid', '3f2504e0-4f89-11d3-9a0c-0305e82c3301'],
  ['unicode', 'заказ-42 — naïve café'],
  ['emoji', 'case ✅ 42'],
  ['bytes', [0, 1, 254, 255, 65]]
];
const same = (got, want) => Array.isArray(want)
  ? (Array.isArray(got) && got.join(',') === want.join(','))
  : got === want;

// ---- 1. nothing throws, ever ------------------------------------------------
section('1. encode/decode never throw across the corpus');
let threw = 0, calls = 0;
for (const doc of CORPUS) {
  for (const { p } of PARAM_SETS) {
    for (const [, payload] of PAYLOADS) {
      calls++;
      try {
        const e = SPAB.encode(doc.text, payload, p);
        SPAB.decode(e.text, p);
        SPAB.decode(doc.text, p);          // unmarked
        SPAB.getSites(doc.text, p);
        SPAB.detect(doc.text, p);          // the soft layer must be equally safe
      } catch (err) {
        threw++; console.error('  THREW ' + doc.name + ' / ' + JSON.stringify(p) + ': ' + err.message);
      }
    }
  }
}
ok(threw === 0, 'no throw in ' + calls + ' encode/decode/detect calls');
console.log('  ' + calls + ' calls over ' + CORPUS.length + ' documents x ' + PARAM_SETS.length +
  ' parameter sets x ' + PAYLOADS.length + ' payloads');

// ---- 2. clean round trip, or an honest refusal ------------------------------
section('2. round-trip or an honest capacity warning');
let rt = 0, refused = 0, quiet = 0;
for (const doc of CORPUS) {
  for (const { label, p } of PARAM_SETS) {
    for (const [pname, payload] of PAYLOADS) {
      const e = SPAB.encode(doc.text, payload, p);
      const d = SPAB.decode(e.text, p);
      if (same(d.message, payload)) { rt++; continue; }
      // Did not round-trip: that is allowed only if encode said why.
      if ((e.metadata.issues || []).length > 0) { refused++; }
      else { quiet++; console.error('  QUIET FAILURE ' + doc.name + ' / ' + label + ' / ' + pname); }
    }
  }
}
ok(quiet === 0, 'every failure to round-trip carries a capacity warning (' + refused + ' refused, ' + rt + ' round-tripped)');
console.log('  round-tripped ' + rt + ', refused with a warning ' + refused);

// ---- 3. unmarked documents never yield a payload ----------------------------
section('3. no false positives on unmarked text');
let falsePos = 0, checks = 0;
for (const doc of CORPUS) {
  for (const { p } of PARAM_SETS) {
    checks++;
    const d = SPAB.decode(doc.text, p);
    if (d.message !== null) { falsePos++; console.error('  FALSE POSITIVE ' + doc.name + ': ' + JSON.stringify(d.message)); }
  }
}
ok(falsePos === 0, 'no payload reported from any of ' + checks + ' unmarked document/parameter pairs');

// ---- 4. damage may lose the payload; it must never change it ----------------
section('4. damaged marks never return a DIFFERENT payload');
const DAMAGE = {
  'nfkc': t => t.normalize('NFKC'),
  'smart quotes': t => t.replace(/'/g, '’'),
  'collapse spaces': t => t.replace(/[    ]+/g, ' '),
  'strip zero-width': t => t.replace(/[​‌‍⁠]/g, ''),
  'trim lines': t => t.split('\n').map(l => l.replace(/\s+$/, '')).join('\n'),
  'delete a word': t => t.replace(/\s\S+/, ''),
  'prepend': t => 'A new sentence in front. ' + t,
  'append': t => t + ' A new sentence at the end.',
  'first half': t => t.slice(0, Math.floor(t.length / 2)),
  'last two thirds': t => t.slice(Math.floor(t.length / 3)),
  'tokenize rejoin': t => t.split(/\s+/).join(' '),
  'double spaces': t => t.replace(/ /g, '  ')
};
let wrong = 0, recovered = 0, lost = 0, trials = 0;
for (const doc of CORPUS) {
  for (const { p } of PARAM_SETS) {
    const payload = 'acme-42';
    const e = SPAB.encode(doc.text, payload, p);
    if (SPAB.decode(e.text, p).message !== payload) continue;   // did not encode; section 2 covers it
    for (const [dname, f] of Object.entries(DAMAGE)) {
      trials++;
      let got;
      try { got = SPAB.decode(f(e.text), p).message; }
      catch (err) { wrong++; console.error('  THREW on damage ' + doc.name + '/' + dname); continue; }
      if (got === payload) recovered++;
      else if (got === null) lost++;
      else { wrong++; console.error('  WRONG PAYLOAD ' + doc.name + ' / ' + dname + ': ' + JSON.stringify(got)); }
    }
  }
}
ok(wrong === 0, 'no damaged mark ever returned a different payload (' + trials + ' damage trials)');
console.log('  recovered ' + recovered + ' / lost ' + lost + ' / wrong ' + wrong +
  '  (' + Math.round(100 * recovered / Math.max(trials, 1)) + '% recovery, which is reported not asserted)');

// ---- 5. length-preserving carriers really preserve length -------------------
section('5. carrier invariants hold on every document');
let lenBroken = 0, visBroken = 0;
for (const doc of CORPUS) {
  for (const cls of [['ws'], ['apos'], ['hyphen'], ['wsdense'], ['ws', 'apos', 'hyphen']]) {
    const e = SPAB.encode(doc.text, 'acme-42', { classes: cls });
    if (e.text.length !== doc.text.length) {
      lenBroken++; console.error('  LENGTH CHANGED ' + doc.name + ' / ' + cls.join('+'));
    }
  }
  // zwsp inserts, so length grows. Stripping every zero-width character to compare
  // is WRONG for a cover that legitimately contains them — the emoji document's own
  // joiners would be stripped too, and the comparison fails on text the encoder
  // never touched. The correct invariant is subsequence: every character of the
  // cover survives, in order, and everything added is zero-width.
  const z = SPAB.encode(doc.text, 'acme-42', { classes: ['zwsp'] });
  let ci = 0, added = '';
  for (let zi = 0; zi < z.text.length; zi++) {
    if (ci < doc.text.length && z.text[zi] === doc.text[ci]) { ci++; continue; }
    added += z.text[zi];
  }
  if (ci !== doc.text.length || /[^​‌‍⁠]/.test(added)) {
    visBroken++; console.error('  VISIBLE TEXT CHANGED ' + doc.name + ' / zwsp' +
      (ci !== doc.text.length ? ' (cover not a subsequence)' : ' (non-zero-width insertion)'));
  }
}
ok(lenBroken === 0, 'substitution carriers preserve character length on all ' + CORPUS.length + ' documents');
ok(visBroken === 0, 'the zero-width carrier leaves visible text byte-identical on all documents');

// ---- 6. the soft layer agrees with the hard layer ---------------------------
section('6. the sliding histogram detector');
let softBad = 0, fieldBad = 0;
for (const doc of CORPUS) {
  const d = SPAB.detect(doc.text, { classes: ['ws'] }).ws;
  if (!d) continue;
  // The posterior's argmax must be the hard read: the soft layer refines confidence,
  // it does not disagree about what was observed.
  const digits = SPAB.readClassBits ? null : null;
  const soft = SPAB.soft.classSoft(doc.text, 'ws');
  for (let i = 0; i < soft.digits.length; i++) {
    const p = soft.posteriors[i];
    let arg = 0; for (let v = 1; v < p.length; v++) if (p[v] > p[arg]) arg = v;
    // Only meaningful where the observation is not the ambiguous default value.
    if (soft.digits[i] !== 0 && arg !== soft.digits[i]) softBad++;
    const sum = p.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > 1e-9) softBad++;
  }
  if (d.field.length && d.field.length !== Math.max(0, soft.digits.length - d.window + 1)) fieldBad++;
}
ok(softBad === 0, 'posteriors are normalised and agree with the hard read on every unambiguous site');
ok(fieldBad === 0, 'the likelihood field has one entry per window position');

// An unmarked document should look unmarked; a marked one marked; a normalized one
// unmarked again. This is the detector doing its job, and it is also steganalysis:
// it is the statistic an adversary runs.
let sep = 0, sepTried = 0;
for (const doc of CORPUS) {
  const e = SPAB.encode(doc.text, 'acme-42', { classes: ['ws'] });
  const before = SPAB.detect(doc.text, { classes: ['ws'] }).ws;
  const after = SPAB.detect(e.text, { classes: ['ws'] }).ws;
  if (!before || before.sites < 40) continue;             // too few sites to be statistical
  if (SPAB.decode(e.text, { classes: ['ws'] }).message !== 'acme-42') continue;
  sepTried++;
  if (after.collapse < before.collapse) sep++;
}
ok(sepTried > 0 && sep === sepTried,
  'marking always lowers the estimated collapse (' + sep + '/' + sepTried + ' documents with enough sites)');

console.log('\ncorpus: ' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('FAIL (corpus)'); process.exit(1); }
console.log('PASS (corpus)');
