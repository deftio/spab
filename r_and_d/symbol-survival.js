#!/usr/bin/env node
/*
 * symbol-survival.js — raw channel characterization (no message, no ECC).
 *
 * For each candidate carrier class, stamp a RANDOM symbol at every available site in
 * the cover text, apply each channel-noise attack, read the symbols back, and report
 * what fraction survive (correct value at the same position). This measures the raw
 * per-symbol channel each carrier sees — the input you need to design ECC — separated
 * from any coding. High survival = robust carrier for that attack; 0 = that attack
 * erases the carrier.
 *
 *   node r_and_d/symbol-survival.js [--gen N] [--corpus-dir <dir>] [--limit N]
 */
'use strict';

var path = require('path');
var K = require(path.join(__dirname, 'corruptions.js'));
var GEN = require(path.join(__dirname, 'corpus-gen.js'));
var FS = require(path.join(__dirname, 'corpus-fs.js'));

// --- candidate carrier classes (a superset — more than spab ships) ---
// detect(text) -> [indices]; read(text,i) -> value; glyph(v) -> char.
function mk(variants, detectCodes) {
  var set = {}; variants.forEach(function (c, i) { set[c] = i; });
  var det = {}; detectCodes.forEach(function (c) { det[c] = true; });
  return {
    n: variants.length,
    detect: function (text) { var o = []; for (var i = 0; i < text.length; i++) if (det[text.charCodeAt(i)]) o.push(i); return o; },
    read: function (text, i) { var v = set[text.charCodeAt(i)]; return v === undefined ? 0 : v; },
    glyph: function (v) { return String.fromCharCode(variants[v % variants.length]); }
  };
}
// whitespace site = a space/variant between two non-space chars
function wsDetect(variants) {
  var set = {}; variants.forEach(function (c) { set[c] = true; });
  return function (text) {
    var o = [];
    for (var i = 1; i < text.length - 1; i++) {
      var c = text.charCodeAt(i);
      if (set[c] && !/\s/.test(text[i - 1]) && !/\s/.test(text[i + 1])) o.push(i);
    }
    return o;
  };
}
function wsClass(variants) { var m = mk(variants, variants); m.detect = wsDetect(variants); return m; }

var CLASSES = {
  'ws4      (2b)': wsClass([0x20, 0x2006, 0x2009, 0x200A]),
  'ws8-wide (3b)': wsClass([0x20, 0x2006, 0x2009, 0x200A, 0x2004, 0x2005, 0x2008, 0x205F]),
  'nbsp     (1b)': wsClass([0x20, 0x00A0]),
  'apos     (1b)': mk([0x27, 0x2019], [0x27, 0x2019]),
  'dquote   (1b)': mk([0x22, 0x201C], [0x22, 0x201C, 0x201D]),
  'hyphen   (1b)': mk([0x2D, 0x2010], [0x2D, 0x2010])
};

// Attacks to characterize, split by whether they preserve character positions.
var INPLACE = ['nfkc', 'normalize', 'saltPepper', 'smartQuotes', 'regexAttack', 'fullStrip'];
var STRUCTURAL = ['reflow', 'cutPaste', 'truncate', 'wordDelete', 'wordInsert'];
function firstIntensity(m) { return K.MODELS[m] ? K.MODELS[m].intensities[K.MODELS[m].intensities.length - 1] : 1; }

// --- args / corpus ---
var args = process.argv.slice(2);
function val(f, d) { var i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; }
var LIMIT = parseInt(val('--limit', '0'), 10) || Infinity;
var CORPUS_DIR = val('--corpus-dir', null);
var N = parseInt(val('--gen', '3000'), 10);
var docs;
if (CORPUS_DIR) {
  var dir = path.isAbsolute(CORPUS_DIR) ? CORPUS_DIR : path.join(process.cwd(), CORPUS_DIR);
  var c = FS.loadCorpus(dir, { limit: LIMIT }); docs = { count: c.count, get: function (i) { return c.get(i); } };
} else { docs = { count: N, get: function (i) { return GEN.getDoc(i); } }; }

// Stamp class C's sites in `text` with random variants; return {text, sites:[{i,v}]}.
function stamp(text, C, rng) {
  var idx = C.detect(text), arr = text.split('');
  var sites = [];
  for (var s = 0; s < idx.length; s++) {
    var v = (rng() * C.n) | 0;
    arr[idx[s]] = C.glyph(v);
    sites.push({ i: idx[s], v: v });
  }
  return { text: arr.join(''), sites: sites };
}

// Survival: fraction of stamped sites whose value reads back unchanged at the same index.
function survival(damaged, C, sites) {
  var ok = 0;
  for (var s = 0; s < sites.length; s++) {
    var i = sites[s].i;
    if (i < damaged.length && C.read(damaged, i) === sites[s].v) ok++;
  }
  return { ok: ok, total: sites.length };
}

// --- run ---
var attacks = INPLACE.concat(STRUCTURAL).filter(function (m) { return K.MODELS[m]; });
var acc = {}; // class -> attack -> {ok,total}
Object.keys(CLASSES).forEach(function (cn) { acc[cn] = {}; attacks.forEach(function (a) { acc[cn][a] = { ok: 0, total: 0 }; }); });

for (var d = 0; d < docs.count; d++) {
  var text = docs.get(d).text;
  Object.keys(CLASSES).forEach(function (cn) {
    var C = CLASSES[cn];
    var rng = K.makeRng((d * 2654435761 + cn.length * 40503) >>> 0);
    var st = stamp(text, C, rng);
    attacks.forEach(function (a) {
      var arng = K.makeRng((d * 1000003 + a.length) >>> 0);
      var dm = K.MODELS[a].fn(st.text, firstIntensity(a), arng);
      var r = survival(dm, C, st.sites);
      acc[cn][a].ok += r.ok; acc[cn][a].total += r.total;
    });
  });
}

function pct(o) { return o.total ? (100 * o.ok / o.total).toFixed(0) + '%' : '-'; }
function pad(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); }

console.log('spab raw symbol-survival — ' + (CORPUS_DIR ? 'dir ' + CORPUS_DIR : 'gen ' + N + ' docs') +
  '   (random symbols, no ECC; % = symbols read back correctly)\n');
var header = pad('carrier', 15);
attacks.forEach(function (a) { header += pad(a.slice(0, 11), 12); });
console.log(header);
Object.keys(CLASSES).forEach(function (cn) {
  var row = pad(cn, 15);
  attacks.forEach(function (a) { row += pad(pct(acc[cn][a]), 12); });
  console.log(row);
});
console.log('\nNOTE: a k-symbol carrier has a chance floor of 1/k (a random symbol equal to the base');
console.log('      survives trivially). So ws4 ~25% and ws8 ~12% = DEAD; 1-bit carriers reading');
console.log('      ~100% are genuinely robust, ~50% = dead.');
console.log('\nin-place attacks (per-symbol channel): ' + INPLACE.join(', '));
console.log('structural attacks (positional/desync): ' + STRUCTURAL.join(', ') +
  '  — low % here reflects desync, not per-symbol loss (why we need self-locating symbols).');
console.log('total stamped sites per carrier:');
Object.keys(CLASSES).forEach(function (cn) {
  var any = acc[cn][attacks[0]];
  console.log('  ' + pad(cn, 15) + any.total + ' sites');
});
