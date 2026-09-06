#!/usr/bin/env node
/*
 * compare.js — spab against reference models of the other approaches, through the
 * same channel.
 *
 * Read the header of baselines.js before quoting any number from this: the other
 * rows are reimplementations of each TECHNIQUE, not the libraries. What this
 * isolates is the effect of two design decisions — where the payload is placed,
 * and whether there is error correction — with everything else held equal.
 *
 *   node r_and_d/compare.js              # summary
 *   node r_and_d/compare.js --by-model   # per corruption model
 */
'use strict';

var SPAB = require('../src/js/spab.js');
var SAMPLES = require('./samples.js').SAMPLES;
var BASELINES = require('./baselines.js').BASELINES;
var CORRUPT = require('./corruptions.js');
var MODELS = CORRUPT.MODELS || CORRUPT;

var argv = process.argv.slice(2);
var byModel = argv.indexOf('--by-model') !== -1;

function rng(seed) {
  var a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

var PAYLOADS = ['SPAB', 'SPAB-001', 'a94a8fe5ccb19ba61c4c'];

// spab as one more entry, so the loop treats every scheme identically.
var SPAB_ENTRY = {
  name: 'spab (default)',
  note: 'multi-carrier substitution, repetition ECC, framed + CRC',
  encode: function (cover, message) {
    var p = { classes: ['ws', 'apos', 'hyphen'], ecc: 'repetition' };
    var e = SPAB.encode(cover, message, p);
    if ((e.metadata.issues || []).some(function (s) { return /too short/i.test(s); })) return null;
    return e.text;
  },
  decode: function (text) {
    try { return SPAB.decode(text, { classes: ['ws', 'apos', 'hyphen'], ecc: 'repetition' }).message; }
    catch (e) { return null; }
  }
};
var SCHEMES = [SPAB_ENTRY].concat(BASELINES);

var rows = [];
SAMPLES.forEach(function (sample) {
  PAYLOADS.forEach(function (payload) {
    SCHEMES.forEach(function (scheme) {
      var enc;
      try { enc = scheme.encode(sample.text, payload); } catch (e) { enc = null; }
      if (enc === null) { rows.push({ scheme: scheme.name, model: '(did not fit)', ok: false, fit: false }); return; }
      if (scheme.decode(enc) !== payload) { rows.push({ scheme: scheme.name, model: '(clean fail)', ok: false, fit: true }); return; }
      Object.keys(MODELS).forEach(function (mname) {
        var model = MODELS[mname];
        model.intensities.forEach(function (inten) {
          var damaged;
          try { damaged = model.fn(enc, inten, rng(0xC0FFEE)); } catch (e) { return; }
          var got = null;
          try { got = scheme.decode(damaged); } catch (e) { got = null; }
          rows.push({ scheme: scheme.name, model: mname, intensity: inten, real: !!model.real,
            ok: got === payload, wrong: got !== null && got !== payload, fit: true });
        });
      });
    });
  });
});

// Only compare cells every scheme could encode. Without this the schemes with more
// capacity are scored on a different (and easier) population — spab declines the
// smallest samples, so an unpaired table credits the others for cases spab never
// attempted.
var cellKey = function (r) { return [r.sample, r.payload, r.model, r.intensity].join('|'); };
var byCell = {};
rows.forEach(function (r) {
  if (r.model === '(did not fit)' || r.model === '(clean fail)') return;
  (byCell[cellKey(r)] = byCell[cellKey(r)] || {})[r.scheme] = r;
});
var comparable = {};
Object.keys(byCell).forEach(function (k) {
  var c = byCell[k];
  for (var i = 0; i < SCHEMES.length; i++) if (!(SCHEMES[i].name in c)) return;
  comparable[k] = c;
});

function summarize(filter) {
  var acc = {};
  SCHEMES.forEach(function (s) { acc[s.name] = { ok: 0, n: 0, wrong: 0, nofit: 0 }; });
  rows.forEach(function (r) { if (r.model === '(did not fit)') acc[r.scheme].nofit++; });
  Object.keys(comparable).forEach(function (k) {
    var c = comparable[k];
    var any = c[SCHEMES[0].name];
    if (filter && !filter(any)) return;
    SCHEMES.forEach(function (s) {
      var r = c[s.name], a = acc[s.name];
      a.n++; if (r.ok) a.ok++; if (r.wrong) a.wrong++;
    });
  });
  return acc;
}

function show(title, acc) {
  console.log('\n' + title);
  console.log('  ' + 'scheme'.padEnd(20) + 'recovered'.padStart(10) + 'wrong'.padStart(8) + '  cases   couldn\'t encode');
  SCHEMES.forEach(function (s) {
    var a = acc[s.name];
    var pct = a.n ? Math.round(100 * a.ok / a.n) + '%' : '-';
    console.log('  ' + s.name.padEnd(20) + String(pct).padStart(10) + String(a.wrong).padStart(8) +
      String(a.n).padStart(8) + String(a.nofit).padStart(12));
  });
}

console.log('=== technique comparison ===');
console.log('These are reimplementations of each TECHNIQUE, not the libraries. See baselines.js.');
console.log(SAMPLES.length + ' samples x ' + PAYLOADS.length + ' payloads x ' + Object.keys(MODELS).length + ' corruption models');
console.log('Paired: only cells every scheme could encode are scored.');

show('all corruption models', summarize(null));
show('real-world channels only', summarize(function (r) { return r.real; }));
show('desync: word insert / delete',
  summarize(function (r) { return ['wordDelete', 'wordInsert'].indexOf(r.model) >= 0; }));
show('excerpting: head, tail and middle slices (placement-fair)',
  summarize(function (r) { return ['truncate', 'truncTail', 'midExcerpt', 'cutPaste'].indexOf(r.model) >= 0; }));
show('zero-width sanitisation (strip / noise) — the other channel',
  summarize(function (r) { return r.model === 'stripZw' || r.model === 'zwNoise'; }));

if (byModel) {
  console.log('\nper corruption model (recovery %):');
  var names = Object.keys(MODELS);
  console.log('  ' + 'model'.padEnd(16) + SCHEMES.map(function (s) { return s.name.slice(0, 14).padStart(15); }).join(''));
  names.forEach(function (m) {
    var line = '  ' + m.padEnd(16);
    SCHEMES.forEach(function (s) {
      var sub = rows.filter(function (r) { return r.scheme === s.name && r.model === m; });
      var ok = sub.filter(function (r) { return r.ok; }).length;
      line += (sub.length ? Math.round(100 * ok / sub.length) + '%' : '-').padStart(15);
    });
    console.log(line);
  });
}

var wrongTotal = rows.filter(function (r) { return r.wrong; }).length;
console.log('\nwrong-payload events across every scheme and model: ' + wrongTotal +
  (wrongTotal ? '  <-- a scheme returned a payload that was not the one encoded' : '  (none — every failure was a clean miss)'));
