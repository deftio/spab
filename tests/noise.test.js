#!/usr/bin/env node
/*
 * noise.test.js — recovery across a matrix of payload sizes, cover sizes, carriers,
 * ECC modes and channel damage.
 *
 * The point is not to pin exact recovery percentages: robustness depends on how
 * much spare capacity a passage has, and the numbers move whenever the codec does.
 * The point is that the matrix behaves the way the design says it should —
 *
 *   1. every combination survives a clean round trip, or reports honestly that the
 *      payload did not fit (never a silent wrong answer);
 *   2. damage that does not touch carriers is always recovered;
 *   3. damage that removes carriers degrades rather than falling off a cliff, and
 *      recovery improves with redundancy rather than staying flat;
 *   4. no combination ever reports a payload from text that carries none.
 *
 * Deterministic: fixed corpus, fixed damage, no RNG. Complements fuzz.test.js
 * (random permutations, invariant checks) and roundtrip.test.js (conformance).
 */
'use strict';
const SPAB = require('../src/js/spab.js');

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } }

// ---- corpus ----------------------------------------------------------------
const PARA = "The board reviewed the quarterly figures on Tuesday and asked for a re-forecast " +
  "before the end of the month. Operating costs are down year-over-year, though the well-documented " +
  "delays on the Hartley contract haven't yet worked through the numbers. Finance will circulate a " +
  "revised model on Friday; it isn't final, and the committee's own estimate may differ. ";
const COVERS = {
  tiny:   PARA.slice(0, 90),
  short:  PARA,
  medium: PARA + PARA,
  long:   Array(6).fill(PARA).join('')
};
const SECRETS = {
  tiny:   'a',
  short:  'acme-42',
  medium: 'contract-2026-11-draft',
  long:   'recipient=j.smith;case=2026-11-0042;issued=2026-09-04;rev=3'
};

// ---- damage models ---------------------------------------------------------
// Split into two groups because they are judged differently: "preserving" damage
// leaves the carrier count intact and must always be recovered; "structural"
// damage removes or shifts carriers and is expected to degrade.
// "Preserving" means the CARRIER COUNT is unchanged — not merely that the existing
// carriers are untouched. Appending a sentence leaves every existing carrier alone
// but adds new ones, and that is enough to break a keyed mark: the interleave
// permutation is derived from the digit count, so a longer stream descrambles to
// noise. It therefore belongs with the structural cases, not here.
const PRESERVING = {
  'unchanged':            t => t,
  'smart-quote autocorrect': t => t.replace(/'/g, '’'),
  'trailing whitespace':  t => t + '   ',
  'swap a word (same length)': t => t.replace('Friday', 'Monday')
};
const STRUCTURAL = {
  'append a sentence':    t => t + ' One more line was added at the end.',
  'delete one word':      t => t.replace(' quarterly', ''),
  'delete two words':     t => t.replace(' quarterly', '').replace(' revised', ''),
  'insert a word':        t => t.replace('the board', 'the full board'),
  'prepend a sentence':   t => 'A line in front. ' + t,
  'delete a sentence':    t => t.replace(/Finance will circulate[^.]*\. /, ''),
  'excerpt: last two thirds': t => t.slice(Math.floor(t.length / 3)),
  'excerpt: first half':  t => t.slice(0, Math.floor(t.length / 2)),
  'NFKC normalize':       t => t.normalize('NFKC'),
  'strip all whitespace variants': t => t.replace(/[   ]/g, ' ')
};

const MODES = [
  { label: 'repetition', params: { classes: ['ws', 'apos', 'hyphen'], ecc: 'repetition' } },
  { label: 'rlnc',       params: { classes: ['ws', 'apos', 'hyphen'], ecc: 'rlnc' } },
  { label: 'ws only',    params: { classes: ['ws'], ecc: 'repetition' } },
  { label: 'keyed',      params: { classes: ['ws', 'apos', 'hyphen'], ecc: 'repetition', key: 'shared-key' } },
  { label: 'zero-width', params: { classes: ['zwsp'], ecc: 'repetition' } }
];

function tryDecode(text, params) {
  try { return SPAB.decode(text, params); } catch (e) { return { message: null, metadata: { status: 'threw:' + e.message } }; }
}

// ---- 1 + 2: clean round trip, and damage that leaves carriers alone ---------
let cleanChecked = 0, preservingChecked = 0, silentWrong = 0, threw = 0;
const capacityShort = [];
for (const mode of MODES) {
  for (const [cn, cover] of Object.entries(COVERS)) {
    for (const [sn, secret] of Object.entries(SECRETS)) {
      let enc;
      try { enc = SPAB.encode(cover, secret, mode.params); }
      catch (e) { threw++; continue; }
      const tooShort = (enc.metadata.issues || []).some(s => /too short/i.test(s));
      if (tooShort) { capacityShort.push(mode.label + '/' + cn + '/' + sn); continue; }

      cleanChecked++;
      const clean = tryDecode(enc.text, mode.params);
      if (clean.message !== secret) silentWrong++;

      for (const [dn, damage] of Object.entries(PRESERVING)) {
        preservingChecked++;
        const got = tryDecode(damage(enc.text), mode.params).message;
        if (got !== secret) {
          // NFKC is not in this group; anything here must survive.
          fail++; console.error('  FAIL preserving damage lost the payload: ' +
            mode.label + ' / cover ' + cn + ' / secret ' + sn + ' / ' + dn + ' -> ' + JSON.stringify(got));
        }
      }
    }
  }
}
ok(threw === 0, 'no combination throws during encode (' + threw + ' threw)');
ok(silentWrong === 0, 'clean round trip never returns a wrong payload (' + cleanChecked + ' combinations)');
ok(preservingChecked > 100, 'carrier-preserving damage exercised across the matrix (' + preservingChecked + ' checks)');
ok(capacityShort.length > 0, 'capacity limits are reported, not hidden (' + capacityShort.length + ' combinations too small)');

// ---- 3: structural damage degrades, and redundancy helps -------------------
function recoveryRate(params, cover, secret) {
  let enc;
  try { enc = SPAB.encode(cover, secret, params); } catch (e) { return null; }
  if ((enc.metadata.issues || []).some(s => /too short/i.test(s))) return null;
  let got = 0, total = 0;
  for (const damage of Object.values(STRUCTURAL)) {
    total++;
    if (tryDecode(damage(enc.text), params).message === secret) got++;
  }
  return { rate: got / total, reps: enc.metadata.reps };
}

const thin = recoveryRate(MODES[0].params, COVERS.short, SECRETS.short);
const thick = recoveryRate(MODES[0].params, COVERS.long, SECRETS.short);
ok(thin && thick, 'structural matrix ran at two redundancy levels');
if (thin && thick) {
  ok(thick.reps > thin.reps, 'a longer passage carries more copies (' + thin.reps + ' -> ' + thick.reps + ')');
  ok(thick.rate >= thin.rate, 'more redundancy does not decrease structural recovery (' +
    Math.round(thin.rate * 100) + '% -> ' + Math.round(thick.rate * 100) + '%)');
  ok(thick.rate > 0, 'structural damage is survivable at all with redundancy (' + Math.round(thick.rate * 100) + '%)');
}

// ---- 4: no false positives anywhere ---------------------------------------
let falsePositives = 0, cleanChecks = 0;
for (const mode of MODES) {
  for (const cover of Object.values(COVERS)) {
    for (const text of [cover, cover.normalize('NFKC'), cover.toUpperCase(), cover.replace(/ /g, '  ')]) {
      cleanChecks++;
      const d = tryDecode(text, mode.params);
      if (d.message !== null && d.metadata.crcOk === true) falsePositives++;
    }
  }
}
ok(falsePositives === 0, 'no payload is ever reported from unmarked text (' + cleanChecks + ' checks)');

// ---- payload shapes -------------------------------------------------------
// Anything that survives a UTF-8 round trip and fits the cover's capacity is a valid
// payload. These are the shapes documented as supported.
const cover = COVERS.long;
const P = { classes: ['ws', 'apos', 'hyphen'], ecc: 'repetition' };
const SHAPES = {
  'ascii id': 'invoice-4417',
  'json': '{"r":"j.smith","case":42}',
  'unicode': 'зака́з-42 — naïve café',
  'emoji': 'case ✅ 42',
  'base64-ish': 'aGVsbG8gd29ybGQ=',
  'whitespace-bearing': 'two words here',
  'single char': 'x'
};
for (const [label, payload] of Object.entries(SHAPES)) {
  const e = SPAB.encode(cover, payload, P);
  ok(SPAB.decode(e.text, P).message === payload, 'payload shape round-trips: ' + label);
}

// ---- 5: the wire-format dimensions, under damage ---------------------------
//
// Compression and encryption change the packet's size and shape, which changes how
// many copies fit and therefore how much damage the mark survives. Section 1 covers
// the clean round trip; this checks the same two rules hold with them on:
// carrier-preserving damage is always recovered, and structural damage never
// produces a silently wrong answer.
const ENC_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const WIRE_COVER = COVERS.long + COVERS.long;
const WIRE_MODES = [
  { label: 'compressed',        params: {} ,                          secret: 'na'.repeat(40) },
  { label: 'uncompressed',      params: { compress: false },          secret: 'na'.repeat(40) },
  { label: 'encrypted',         params: { encKey: ENC_KEY },          secret: 'classified-payload' },
  { label: 'compressed+encrypted', params: { encKey: ENC_KEY },       secret: 'na'.repeat(40) },
  { label: 'crc8',              params: { cksum: 0 },                 secret: 'acme-42' },
  { label: 'crc32',             params: { cksum: 2 },                 secret: 'acme-42' },
  { label: 'sha256 checksum',   params: { cksum: 5 },                 secret: 'acme-42' },
  { label: 'uuid payload',      params: {},                           secret: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' },
  { label: 'bytes payload',     params: { type: 'bytes' },            secret: [0, 1, 254, 255, 65, 7, 200] }
];
let wireClean = 0, wirePreserving = 0, wireWrong = 0, wireSkipped = 0;
for (const wm of WIRE_MODES) {
  const params = Object.assign({ classes: ['ws', 'apos', 'hyphen'], ecc: 'repetition' }, wm.params);
  const same = (got) => Array.isArray(wm.secret)
    ? (Array.isArray(got) && got.join(',') === wm.secret.join(','))
    : got === wm.secret;
  // Twice the long cover, so every combination has room: an 80-byte payload stored
  // uncompressed needs 688 bits and COVERS.long holds 670, which is a capacity fact
  // rather than anything about the wire format.
  const e = SPAB.encode(WIRE_COVER, wm.secret, params);
  const clean = tryDecode(e.text, params);
  if (!same(clean.message)) {
    // Did not fit is allowed; being WRONG or silent about it is not.
    wireSkipped++;
    if (clean.message !== null || !(e.metadata.issues || []).length) {
      wireWrong++; console.error('    ' + wm.label + ' failed to round-trip without saying why');
    }
    continue;
  }
  wireClean++;
  for (const [dn, dmg] of Object.entries(PRESERVING)) {
    const d = tryDecode(dmg(e.text), params);
    if (same(d.message)) wirePreserving++;
    else { wireWrong++; console.error('    ' + wm.label + ' / ' + dn + ' -> ' + d.metadata.status); }
  }
  for (const dmg of Object.values(STRUCTURAL)) {
    const d = tryDecode(dmg(e.text), params);
    // Recovery is not required; a WRONG answer is forbidden.
    if (d.message !== null && !same(d.message)) {
      wireWrong++; console.error('    ' + wm.label + ' returned a wrong payload after structural damage');
    }
  }
}
ok(wireClean + wireSkipped === WIRE_MODES.length && wireSkipped === 0,
  'every wire-format combination round-trips clean (' + wireClean + '/' + WIRE_MODES.length +
  (wireSkipped ? ', ' + wireSkipped + ' did not fit' : '') + ')');
ok(wirePreserving === wireClean * Object.keys(PRESERVING).length,
  'carrier-preserving damage is recovered with compression, encryption and every checksum width (' + wirePreserving + ' checks)');
ok(wireWrong === 0, 'no wire-format combination ever returns a wrong payload (' +
  (wireClean * Object.keys(STRUCTURAL).length) + ' structural checks)');

// An encrypted mark must never yield its plaintext to a decoder without the key,
// however the text is damaged.
let leaked = 0, located = 0;
const encMark = SPAB.encode(WIRE_COVER, 'classified-payload', { classes: ['ws', 'apos', 'hyphen'], encKey: ENC_KEY });
for (const dmg of [t => t].concat(Object.values(PRESERVING), Object.values(STRUCTURAL))) {
  const d = tryDecode(dmg(encMark.text), { classes: ['ws', 'apos', 'hyphen'] });
  if (d.message !== null) leaked++;
  if (d.metadata.status === 'encrypted') located++;
}
ok(leaked === 0, 'an encrypted mark never yields its plaintext without the key, under any damage model');
ok(located > 0, 'and is still located and reported as encrypted (' + located + ' of 15 damage models)');

// A wrong key is reported as a wrong key, not as an absent mark.
ok(tryDecode(encMark.text, { classes: ['ws', 'apos', 'hyphen'], encKey: ENC_KEY.replace(/^00/, '01') }).metadata.status === 'auth-failed',
  'a wrong key reports auth-failed rather than not-detected');

console.log('noise: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) { console.error('FAIL'); process.exit(1); }
console.log('PASS (noise)');
