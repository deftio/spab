#!/usr/bin/env node
/*
 * corpus-gen.js — deterministic synthetic corpus for the spab benchmark.
 *
 * getDoc(i) returns the SAME document for a given index i, every run. This lets
 * a training/R&D sweep cover 25k-100k varied passages without storing any files,
 * and lets a CI subset be a strict, fixed prefix of the same sequence.
 *
 * Variation spans length, punctuation density, and structure (prose / lists /
 * dialogue), which is what stresses the whitespace channel.
 *
 * CLI:
 *   node bench/corpus-gen.js --n 20 --print         # print 20 sample docs
 *   node bench/corpus-gen.js --n 5000 --out c.jsonl # write JSONL {id,kind,text}
 *   node bench/corpus-gen.js --n 5000 --stats       # length/kind distribution
 */
'use strict';

function makeRng(seed) {
  var a = (seed >>> 0) || 1;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

var NOUN = ('river valley bridge market harbor engine signal payload channel report ' +
  'garden lantern meadow printer contract village station monitor ledger circuit ' +
  'forest cabinet glacier compass anchor beacon tunnel archive kernel packet ' +
  'orchard turbine satchel meridian granary').split(' ');
var VERB = ('carries moves hides folds spreads shapes measures repeats scatters gathers ' +
  'crosses drifts anchors resolves recovers survives normalizes encodes decodes tracks ' +
  'bends holds returns collapses restores samples aligns clusters').split(' ');
var ADJ = ('quiet distant bright hidden fragile robust narrow ancient shifting subtle ' +
  'copper hollow steady random dense sparse woven careful stray uneven brittle ' +
  'orthogonal redundant').split(' ');
var ADV = ('slowly quietly barely often nearly clearly gently roughly rarely steadily ' +
  'suddenly cleanly').split(' ');
var CONN = ['and', 'but', 'so', 'yet', 'while', 'because', 'although', 'since', 'though'];
var PREP = ['across', 'beyond', 'under', 'near', 'through', 'along', 'between', 'without', 'toward'];
var NAME = ['Ada', 'Ravi', 'Mira', 'Jonas', 'Lena', 'Kofi', 'Sora', 'Ivan', 'Nadia', 'Theo'];

// Contractions (apostrophes) and hyphenated compounds — give real docs the
// punctuation-confusable carrier sites (apos/hyphen) that prose actually contains.
var CONTRACT = ["it's", "don't", "isn't", "won't", "we'll", "they're", "can't", "I'm", "that's"];
var HYPHEN = ['well-known', 'co-operative', 'old-fashioned', 'fox-trot', 'long-standing',
  'clear-eyed', 'far-off', 'time-worn', 'half-open', 'two-thirds'];

function pick(rng, arr) { return arr[(rng() * arr.length) | 0]; }
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function sentence(rng, punctDensity) {
  var subj = cap(pick(rng, ADJ) + ' ' + pick(rng, NOUN));
  var clause = subj + ' ' + pick(rng, VERB) + ' ' + pick(rng, PREP) + ' the ' +
               (rng() < 0.35 ? pick(rng, HYPHEN) : pick(rng, ADJ)) + ' ' + pick(rng, NOUN);
  // Optionally add a subordinate clause; more commas at higher punct density.
  if (rng() < 0.5 + punctDensity * 0.3) {
    var sep = rng() < punctDensity ? '; ' : ', ' + pick(rng, CONN) + ' ';
    clause += sep + (rng() < 0.4 ? cap(pick(rng, CONTRACT)) + ' ' : '') + 'the ' +
              pick(rng, NOUN) + ' ' + pick(rng, ADV) + ' ' + pick(rng, VERB) + ' ' + pick(rng, ADV);
  }
  var end = rng() < 0.08 ? '?' : (rng() < 0.05 ? '!' : '.');
  return clause + end;
}

function paragraph(rng, nSent, punctDensity) {
  var out = [];
  for (var i = 0; i < nSent; i++) out.push(sentence(rng, punctDensity));
  return out.join(' ');
}

function listDoc(rng, nItems) {
  var lines = [cap(pick(rng, NOUN)) + ' checklist for the ' + pick(rng, ADJ) + ' ' + pick(rng, NOUN) + ':'];
  for (var i = 0; i < nItems; i++) {
    lines.push('- ' + cap(pick(rng, VERB)) + ' the ' + pick(rng, ADJ) + ' ' + pick(rng, NOUN) +
               ' ' + pick(rng, PREP) + ' the ' + pick(rng, NOUN));
  }
  return lines.join('\n');
}

function dialogueDoc(rng, nTurns) {
  var lines = [];
  for (var i = 0; i < nTurns; i++) {
    var who = pick(rng, NAME);
    lines.push(who + ' said, "' + cap(pick(rng, ADV)) + ', we ' + pick(rng, VERB) + ' the ' +
               pick(rng, NOUN) + ' ' + pick(rng, PREP) + ' the ' + pick(rng, ADJ) + ' ' +
               pick(rng, NOUN) + '."');
  }
  return lines.join(' ');
}

// Length classes by target character count (roughly).
var CLASSES = [
  { kind: 'tiny',   minS: 1, maxS: 2,  weight: 0.18 },
  { kind: 'short',  minS: 2, maxS: 4,  weight: 0.25 },
  { kind: 'medium', minS: 4, maxS: 8,  weight: 0.30 },
  { kind: 'long',   minS: 8, maxS: 16, weight: 0.20 },
  { kind: 'xlong',  minS: 16, maxS: 34, weight: 0.07 }
];

function chooseClass(rng) {
  var r = rng(), acc = 0;
  for (var i = 0; i < CLASSES.length; i++) { acc += CLASSES[i].weight; if (r <= acc) return CLASSES[i]; }
  return CLASSES[CLASSES.length - 1];
}

// Deterministic: getDoc(i) always returns the same document.
function getDoc(i) {
  var rng = makeRng((i + 1) * 2654435761 >>> 0);
  var cls = chooseClass(rng);
  var structure = rng();
  var punctDensity = rng(); // 0..1
  var text, kind;

  if (structure < 0.12) {
    kind = cls.kind + '-list';
    text = listDoc(rng, Math.max(2, cls.minS));
  } else if (structure < 0.22) {
    kind = cls.kind + '-dialogue';
    text = dialogueDoc(rng, Math.max(2, Math.round((cls.minS + cls.maxS) / 3)));
  } else {
    kind = cls.kind + (punctDensity > 0.66 ? '-punct' : '-prose');
    var nParas = cls.maxS > 8 ? 1 + ((rng() * 3) | 0) : 1;
    var paras = [];
    for (var p = 0; p < nParas; p++) {
      var nSent = cls.minS + ((rng() * (cls.maxS - cls.minS + 1)) | 0);
      paras.push(paragraph(rng, Math.max(1, Math.round(nSent / nParas)), punctDensity));
    }
    text = paras.join('\n\n');
  }
  return { id: 'gen-' + i, kind: kind, text: text };
}

function* iterate(n, offset) {
  offset = offset || 0;
  for (var i = 0; i < n; i++) yield getDoc(offset + i);
}

// A fixed CI subset: first `n` generated docs (default 200).
function ciSubset(n) {
  n = n || 200;
  var out = [];
  for (var i = 0; i < n; i++) out.push(getDoc(i));
  return out;
}

module.exports = { getDoc: getDoc, iterate: iterate, ciSubset: ciSubset, makeRng: makeRng };

// --- CLI ---
if (require.main === module) {
  var args = process.argv.slice(2);
  function val(f, d) { var k = args.indexOf(f); return k >= 0 && args[k + 1] ? args[k + 1] : d; }
  var n = parseInt(val('--n', '20'), 10);
  var out = val('--out', null);

  if (args.indexOf('--stats') >= 0) {
    var byKind = {}, lens = [];
    for (var i = 0; i < n; i++) {
      var d = getDoc(i);
      var base = d.kind.split('-')[0];
      byKind[base] = (byKind[base] || 0) + 1;
      lens.push(d.text.length);
    }
    lens.sort(function (a, b) { return a - b; });
    console.log('n=' + n + '  length chars: min ' + lens[0] + '  median ' +
      lens[lens.length >> 1] + '  max ' + lens[lens.length - 1]);
    console.log('length-class distribution:', JSON.stringify(byKind));
  } else if (val('--out-dir', null)) {
    // Materialize the generated corpus to a directory (data on disk, not a .js file).
    //   --out-dir <dir> --n N [--as jsonl|txt] [--shard S] [--offset O]
    var fs = require('fs'), path = require('path');
    var dir = val('--out-dir', null);
    dir = path.isAbsolute(dir) ? dir : path.join(__dirname, dir);
    var as = val('--as', 'jsonl');
    var shard = parseInt(val('--shard', '2000'), 10);
    var offset = parseInt(val('--offset', '0'), 10);
    fs.mkdirSync(dir, { recursive: true });
    if (as === 'txt') {
      for (var j = 0; j < n; j++) {
        var d = getDoc(offset + j);
        var sub = path.join(dir, String(Math.floor(j / 1000)).padStart(4, '0'));
        fs.mkdirSync(sub, { recursive: true });
        fs.writeFileSync(path.join(sub, d.id + '.txt'), d.text);
      }
      console.log('wrote ' + n + ' .txt docs -> ' + dir + ' (bucketed by 1000)');
    } else {
      var parts = Math.ceil(n / shard);
      for (var s = 0; s < parts; s++) {
        var ws = fs.createWriteStream(path.join(dir, 'part-' + String(s).padStart(4, '0') + '.jsonl'));
        var start = s * shard, end = Math.min(n, start + shard);
        for (var k = start; k < end; k++) ws.write(JSON.stringify(getDoc(offset + k)) + '\n');
        ws.end();
      }
      console.log('wrote ' + n + ' docs -> ' + dir + ' in ' + parts + ' jsonl shard(s) of ' + shard);
    }
  } else if (out) {
    var fs2 = require('fs'), path2 = require('path');
    var p = path2.isAbsolute(out) ? out : path2.join(__dirname, out);
    var ws2 = fs2.createWriteStream(p);
    for (var j2 = 0; j2 < n; j2++) ws2.write(JSON.stringify(getDoc(j2)) + '\n');
    ws2.end();
    console.log('wrote ' + n + ' docs -> ' + p);
  } else {
    for (var m = 0; m < n; m++) {
      var doc = getDoc(m);
      console.log('\n--- ' + doc.id + ' [' + doc.kind + '] ' + doc.text.length + ' chars ---');
      console.log(doc.text);
    }
  }
}
