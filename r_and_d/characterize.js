#!/usr/bin/env node
/*
 * characterize.js — where does spab actually work, and where does it not?
 *
 * The test suites answer "is it broken". This answers "what is it good for", which
 * is the question design decisions need. It sweeps fixed text samples x payload
 * sizes x carrier sets x ECC modes x corruption models and reports recovery,
 * grouped the way the design has to reason about it.
 *
 * The key grouping is REDUNDANCY, not text length. Recovery tracks how many copies
 * of the frame fit, and text length only matters because it buys copies — so a
 * table indexed by length hides the actual variable. Everything here is reported
 * per copies-bucket for that reason.
 *
 * Deterministic: fixed samples, fixed payloads, seeded RNG for the stochastic
 * models. Two runs of the same command produce the same numbers.
 *
 *   node r_and_d/characterize.js                 # summary tables
 *   node r_and_d/characterize.js --real-only     # only real-world channels
 *   node r_and_d/characterize.js --json out.json # machine-readable
 *   node r_and_d/characterize.js --by-sample     # per-sample breakdown
 */
'use strict';

var SPAB = require('../src/js/spab.js');
var SAMPLES = require('./samples.js').SAMPLES;
var CORRUPT = require('./corruptions.js');
var MODELS = CORRUPT.MODELS || CORRUPT;

var argv = process.argv.slice(2);
function flag(n) { return argv.indexOf('--' + n) !== -1; }
function opt(n, d) { var i = argv.indexOf('--' + n); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; }

function rng(seed) {
  var a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Payload sizes spanning the useful range: a tag, a serial, a fingerprint, a hash,
// a small JSON blob, and the frame's ceiling.
var PAYLOADS = [
  { name: '4B tag', text: 'SPAB' },
  { name: '8B serial', text: 'SPAB-001' },
  { name: '20B sha1', text: 'a94a8fe5ccb19ba61c4c' },
  { name: '32B sha256', text: '2cf24dba5fb0a30e26e83b2ac5b9e29e' },
  { name: '64B json', text: '{"src":"newsroom","id":"2026-11-0042","rev":3,"by":"j.smith x"}' },
  { name: '128B blob', text: 'x'.repeat(128) },
  { name: '255B max', text: 'y'.repeat(255) }
];

var CARRIERS = [
  { name: 'default', params: { classes: ['ws', 'apos', 'hyphen'] } },
  { name: 'ws only', params: { classes: ['ws'] } },
  { name: 'confusables', params: { classes: ['apos', 'hyphen'] } },
  { name: 'zero-width', params: { classes: ['zwsp'] } }
];
var ECCS = ['repetition', 'rlnc'];

// --- sweep ------------------------------------------------------------------
var rows = [];
var skippedTooShort = 0, encodeErrors = 0;

SAMPLES.forEach(function (sample) {
  PAYLOADS.forEach(function (payload) {
    CARRIERS.forEach(function (carrier) {
      ECCS.forEach(function (ecc) {
        var params = { classes: carrier.params.classes, ecc: ecc };
        var enc;
        try { enc = SPAB.encode(sample.text, payload.text, params); }
        catch (e) { encodeErrors++; return; }

        var tooShort = (enc.metadata.issues || []).some(function (s) { return /too short/i.test(s); });
        if (tooShort) { skippedTooShort++; return; }

        // Confirm the undamaged case before judging damaged ones; a codec that
        // cannot decode its own clean output tells us nothing about channels.
        var clean = safeDecode(enc.text, params);
        if (clean !== payload.text) {
          rows.push({ sample: sample.name, payload: payload.name, carrier: carrier.name,
            ecc: ecc, model: '(clean)', intensity: 0, reps: enc.metadata.reps, ok: false });
          return;
        }

        Object.keys(MODELS).forEach(function (mname) {
          var model = MODELS[mname];
          if (flag('real-only') && !model.real) return;
          model.intensities.forEach(function (inten) {
            var r = rng(0xC0FFEE);
            var damaged;
            try { damaged = model.fn(enc.text, inten, r); }
            catch (e) { return; }
            rows.push({
              sample: sample.name, payload: payload.name, carrier: carrier.name, ecc: ecc,
              model: mname, intensity: inten, reps: enc.metadata.reps, real: !!model.real,
              ok: safeDecode(damaged, params) === payload.text
            });
          });
        });
      });
    });
  });
});

function safeDecode(text, params) {
  try { return SPAB.decode(text, params).message; } catch (e) { return null; }
}

// --- reporting --------------------------------------------------------------
function pct(part, total) { return total === 0 ? '  -  ' : (Math.round(100 * part / total) + '%').padStart(5); }

function tally(rowsIn, keyFn) {
  var acc = {};
  rowsIn.forEach(function (r) {
    var k = keyFn(r);
    if (!acc[k]) acc[k] = { ok: 0, n: 0 };
    acc[k].n++; if (r.ok) acc[k].ok++;
  });
  return acc;
}

function table(title, acc, order) {
  console.log('\n' + title);
  var keys = order || Object.keys(acc).sort();
  keys.forEach(function (k) {
    if (!acc[k]) return;
    var a = acc[k];
    var bar = '#'.repeat(Math.round(20 * a.ok / (a.n || 1)));
    console.log('  ' + String(k).padEnd(28) + pct(a.ok, a.n) + '  ' + String(a.n).padStart(5) + ' cases  ' + bar);
  });
}

console.log('=== spab characterization ===');
console.log('samples ' + SAMPLES.length + ' x payloads ' + PAYLOADS.length + ' x carriers ' + CARRIERS.length +
  ' x ecc ' + ECCS.length + ' x models ' + Object.keys(MODELS).length);
console.log('rows ' + rows.length + '  |  combinations too short to encode: ' + skippedTooShort +
  '  |  encode errors: ' + encodeErrors);

// Redundancy is the variable that matters; bucket by it first.
function repBucket(r) {
  if (r.reps <= 1) return '1 copy (no margin)';
  if (r.reps <= 2) return '2 copies';
  if (r.reps <= 4) return '3-4 copies';
  if (r.reps <= 8) return '5-8 copies';
  return '9+ copies';
}
var repOrder = ['1 copy (no margin)', '2 copies', '3-4 copies', '5-8 copies', '9+ copies'];
table('recovery by redundancy — ALL rows (mixes carriers: zero-width reaches high copy counts easily)',
  tally(rows, repBucket), repOrder);

// The length-preserving carriers are the ones most callers use, and they reach
// high copy counts only in long text — so read redundancy within them, not across
// a population where the zero-width carrier dominates the upper buckets.
var lengthPreserving = rows.filter(function (r) { return r.carrier === 'default' || r.carrier === 'ws only'; });
table('recovery by redundancy — length-preserving carriers only',
  tally(lengthPreserving, repBucket), repOrder);

table('recovery by corruption model — real-world channels',
  tally(rows.filter(function (r) { return r.real; }), function (r) { return r.model; }));

table('recovery by corruption model — synthetic damage',
  tally(rows.filter(function (r) { return !r.real && r.model !== '(clean)'; }), function (r) { return r.model; }));

// Aggregates across arms are confounded: a carrier with more capacity encodes in
// more of the hard cases, so its average is taken over a different (easier or
// harder) population than a carrier that could only manage the roomy ones. The
// only fair comparison is paired — restrict to the cells where EVERY arm produced
// a result, then compare.
function paired(field, arms) {
  var cell = {};
  rows.forEach(function (r) {
    var k = [r.sample, r.payload, r.model, r.intensity, field === 'carrier' ? r.ecc : r.carrier].join('|');
    (cell[k] = cell[k] || {})[r[field]] = r.ok;
  });
  var acc = {}, complete = 0;
  arms.forEach(function (a) { acc[a] = { ok: 0, n: 0 }; });
  Object.keys(cell).forEach(function (k) {
    var c = cell[k];
    for (var i = 0; i < arms.length; i++) if (!(arms[i] in c)) return;   // not comparable
    complete++;
    arms.forEach(function (a) { acc[a].n++; if (c[a]) acc[a].ok++; });
  });
  return { acc: acc, complete: complete };
}

var carrierArms = CARRIERS.map(function (c) { return c.name; })
  .filter(function (n) { return rows.some(function (r) { return r.carrier === n; }); });
var missing = CARRIERS.map(function (c) { return c.name; })
  .filter(function (n) { return carrierArms.indexOf(n) < 0; });

table('recovery by carrier set — ALL rows (confounded: each arm encodes a different population)',
  tally(rows, function (r) { return r.carrier; }));
var pc = paired('carrier', carrierArms);
table('recovery by carrier set — PAIRED (' + pc.complete + ' cells every carrier could encode)', pc.acc, carrierArms);
if (missing.length) {
  console.log('\n  note: ' + missing.join(', ') + ' never had capacity to encode any combination —');
  console.log('        the confusable channels are ~1 bit per site and these samples do not have enough.');
}

table('recovery by ECC mode — ALL rows (confounded)', tally(rows, function (r) { return r.ecc; }));
var pe = paired('ecc', ECCS);
table('recovery by ECC mode — PAIRED (' + pe.complete + ' cells both modes could encode)', pe.acc, ECCS);
table('recovery by payload size', tally(rows, function (r) { return r.payload; }),
  PAYLOADS.map(function (p) { return p.name; }));

if (flag('by-sample')) table('recovery by text sample', tally(rows, function (r) { return r.sample; }));

var cleanFails = rows.filter(function (r) { return r.model === '(clean)'; });
if (cleanFails.length) {
  console.log('\n!! ' + cleanFails.length + ' combination(s) failed to decode their own undamaged output:');
  cleanFails.slice(0, 10).forEach(function (r) {
    console.log('   ' + r.sample + ' / ' + r.payload + ' / ' + r.carrier + ' / ' + r.ecc);
  });
}

var out = opt('json', null);
if (out) {
  require('fs').writeFileSync(out, JSON.stringify({ generated: 'deterministic', rows: rows }, null, 1));
  console.log('\nwrote ' + rows.length + ' rows to ' + out);
}
