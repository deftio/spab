#!/usr/bin/env node
/*
 * harness.js — spab robustness benchmark.
 *
 * For each corpus x payload x corruption model x intensity, runs N seeded trials:
 * encode the payload, damage the watermarked text, decode, and score recovery.
 * Also runs a clean-control pass (never-encoded text) to measure false positives.
 *
 * Usage:
 *   node bench/harness.js                 # run full matrix, print summary
 *   node bench/harness.js --trials 50     # more trials per cell
 *   node bench/harness.js --csv out.csv   # also write per-cell CSV
 *   node bench/harness.js --model normalize,blockErasure   # subset of models
 */
'use strict';

var path = require('path');
var fs = require('fs');
var SPAB = require(path.join(__dirname, '..', 'web', 'spab.js'));
var C = require(path.join(__dirname, 'corpora.js'));
var K = require(path.join(__dirname, 'corruptions.js'));
var GENSRC = require(path.join(__dirname, 'corpus-gen.js'));

// --- args ---
var args = process.argv.slice(2);
function argVal(flag, def) { var i = args.indexOf(flag); return i >= 0 && args[i + 1] ? args[i + 1] : def; }
var TRIALS = parseInt(argVal('--trials', '40'), 10);
var CSV = argVal('--csv', null);
var MODEL_FILTER = argVal('--model', null);
var PAYLOAD = argVal('--payload', 'SPAB-7Q2');
var GEN = parseInt(argVal('--gen', '0'), 10);   // sweep N generated docs instead of builtin corpora
var GEN_OFFSET = parseInt(argVal('--offset', '0'), 10);
var NOTE = argVal('--note', null);              // human label for this run
var LOG_DIR = argVal('--log-dir', path.join(__dirname, 'runs'));
var NO_LOG = args.indexOf('--no-log') >= 0;     // skip JSONL logging
var PROV = require(path.join(__dirname, 'provenance.js'));

function logRun(mode, cells) {
  if (NO_LOG) return null;
  var meta = PROV.makeRunMeta({
    spab: SPAB, note: NOTE,
    config: { mode: mode, payload: PAYLOAD, payloadBytes: PAYLOAD.length,
              models: modelNames, gen: GEN, genOffset: GEN_OFFSET, trials: TRIALS }
  });
  var w = PROV.writeRun(LOG_DIR, meta, cells);
  console.log('\nlogged run ' + meta.runId + '  (spab ' + meta.spab.version +
              ' / ' + meta.spab.sourceHash + ') -> ' + w.cells + ' cells in ' + LOG_DIR);
  return meta;
}

var modelNames = Object.keys(K.MODELS).filter(function (m) {
  return !MODEL_FILTER || MODEL_FILTER.split(',').indexOf(m) >= 0;
});

// --- helpers ---
function pct(x) { return (100 * x).toFixed(0) + '%'; }
function pad(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); }

function runCell(corpus, model, intensity) {
  var enc = SPAB.encode(corpus.text, PAYLOAD, {});
  var reps = enc.metadata.reps;
  var recovered = 0, confSum = 0, agreeSum = 0, detected = 0;
  for (var t = 0; t < TRIALS; t++) {
    var rng = K.makeRng((corpus.id.length * 2654435761 + t * 40503 + Math.floor(intensity * 1000)) >>> 0);
    var damaged = K.MODELS[model].fn(enc.text, intensity, rng);
    var d = SPAB.decode(damaged, {});
    if (d.metadata.status !== 'not-detected' && d.metadata.status !== 'failed') detected++;
    if (d.message === PAYLOAD) recovered++;
    confSum += d.metadata.confidence || 0;
    agreeSum += d.metadata.agreement || 0;
  }
  return {
    corpus: corpus.id, kind: corpus.kind, model: model, intensity: intensity,
    slots: enc.metadata.slots, reps: reps,
    recovery: recovered / TRIALS, detect: detected / TRIALS,
    conf: confSum / TRIALS, agree: agreeSum / TRIALS
  };
}

// Clean control: decode never-encoded text; any "valid payload" is a false positive.
function runControl() {
  var fp = 0, n = 0;
  C.CONTROL.forEach(function (txt) {
    // include the raw text and a few whitespace-normalized variants
    var variants = [txt, txt.replace(/ /g, '  '), K.MODELS.reflow.fn(txt)];
    variants.forEach(function (v) {
      n++;
      var d = SPAB.decode(v, {});
      if (d.metadata.crcOk) fp++; // decoder claims a CRC-valid payload from noise
    });
  });
  return { falsePositive: fp / n, samples: n };
}

// --- generated-corpus sweep (--gen N) ---
// One trial per (doc, model, intensity); the corpus itself supplies the variance.
// Accumulates on the fly so 25k-100k docs stay memory-flat.
function runGenSweep(n, offset) {
  var acc = {};                // key model|intensity -> sums
  var tooShort = 0, encodable = 0;
  function key(m, x) { return m + '|' + x; }
  modelNames.forEach(function (m) {
    K.MODELS[m].intensities.forEach(function (x) {
      acc[key(m, x)] = { rec: 0, det: 0, conf: 0, count: 0, slots: 0, reps: 0 };
    });
  });
  for (var i = 0; i < n; i++) {
    var doc = GENSRC.getDoc(offset + i);
    var enc = SPAB.encode(doc.text, PAYLOAD, {});
    if (enc.metadata.issues && enc.metadata.issues.length &&
        /too short/i.test(enc.metadata.issues.join(' '))) tooShort++; else encodable++;
    for (var mi = 0; mi < modelNames.length; mi++) {
      var m = modelNames[mi], ints = K.MODELS[m].intensities;
      for (var xi = 0; xi < ints.length; xi++) {
        var x = ints[xi];
        var rng = K.makeRng(((offset + i) * 2654435761 + mi * 40503 + Math.floor(x * 1000)) >>> 0);
        var damaged = K.MODELS[m].fn(enc.text, x, rng);
        var d = SPAB.decode(damaged, {});
        var a = acc[key(m, x)];
        a.count++;
        a.slots += enc.metadata.slots; a.reps += enc.metadata.reps;
        if (d.message === PAYLOAD) a.rec++;
        if (d.metadata.status !== 'not-detected' && d.metadata.status !== 'failed') a.det++;
        a.conf += d.metadata.confidence || 0;
      }
    }
  }
  return { acc: acc, tooShort: tooShort, encodable: encodable, n: n };
}

function genFalsePositives(n, offset) {
  var fp = 0, tot = 0;
  for (var i = 0; i < n; i++) {
    tot++;
    var d = SPAB.decode(GENSRC.getDoc(offset + i).text, {});
    if (d.metadata.crcOk) fp++;
  }
  return { fp: fp, tot: tot };
}

if (GEN > 0) {
  console.log('spab robustness benchmark — GENERATED corpus');
  console.log('docs: ' + GEN + ' (offset ' + GEN_OFFSET + ')   payload: "' + PAYLOAD + '"');
  console.log('models: ' + modelNames.join(', '));
  var t0 = Date.now();
  var g = runGenSweep(GEN, GEN_OFFSET);
  console.log('encodable: ' + g.encodable + '/' + g.n + '   too short for payload: ' + g.tooShort);
  console.log('\n=== Recovery by model x intensity (avg over ' + GEN + ' docs) ===');
  modelNames.forEach(function (m) {
    console.log('\n' + m + '  (' + K.MODELS[m].note + ')');
    K.MODELS[m].intensities.forEach(function (x) {
      var a = g.acc[m + '|' + x];
      console.log('  ' + pad('intensity ' + x, 16) + 'recovery ' + pad(pct(a.rec / a.count), 6) +
                  'detect ' + pad(pct(a.det / a.count), 6) + 'conf ' + pct(a.conf / a.count));
    });
  });
  var gf = genFalsePositives(Math.min(GEN, 2000), GEN_OFFSET);
  console.log('\n=== Clean control (false positives on un-encoded generated docs) ===');
  console.log('  ' + gf.tot + ' decoded; CRC-valid payload claimed in ' + pct(gf.fp / gf.tot));

  // Collect cells for logging / CSV.
  var cells = [];
  modelNames.forEach(function (m) {
    K.MODELS[m].intensities.forEach(function (x) {
      var a = g.acc[m + '|' + x];
      cells.push({ mode: 'gen', model: m, intensity: x, docs: a.count,
        recovery: +(a.rec / a.count).toFixed(4), detect: +(a.det / a.count).toFixed(4),
        confidence: +(a.conf / a.count).toFixed(4),
        avgSlots: +(a.slots / a.count).toFixed(1), avgReps: +(a.reps / a.count).toFixed(2) });
    });
  });
  cells.push({ mode: 'gen', model: 'controlFalsePositive', intensity: 0, docs: gf.tot,
    recovery: 0, detect: +(gf.fp / gf.tot).toFixed(4), confidence: 0, avgSlots: 0, avgReps: 0 });

  if (CSV) {
    var out = 'model,intensity,docs,recovery,detect,confidence,avg_slots,avg_reps\n';
    cells.forEach(function (c) {
      out += [c.model, c.intensity, c.docs, c.recovery, c.detect, c.confidence, c.avgSlots, c.avgReps].join(',') + '\n';
    });
    var p = path.isAbsolute(CSV) ? CSV : path.join(__dirname, CSV);
    fs.writeFileSync(p, out);
    console.log('\nCSV written: ' + p);
  }
  logRun('gen', cells);
  console.log('done in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  process.exit(0);
}

// --- run (builtin corpora) ---
console.log('spab robustness benchmark');
console.log('trials/cell: ' + TRIALS + '   payload: "' + PAYLOAD + '" (' + PAYLOAD.length + ' bytes)');
console.log('models: ' + modelNames.join(', '));
console.log('');

var rows = [];
C.CORPORA.forEach(function (corpus) {
  modelNames.forEach(function (model) {
    K.MODELS[model].intensities.forEach(function (intensity) {
      rows.push(runCell(corpus, model, intensity));
    });
  });
});

// Summary grouped by model, averaged across corpora, per intensity.
console.log('=== Recovery by model x intensity (avg across corpora) ===');
modelNames.forEach(function (model) {
  console.log('\n' + model + '  (' + K.MODELS[model].note + ')');
  K.MODELS[model].intensities.forEach(function (intensity) {
    var cells = rows.filter(function (r) { return r.model === model && r.intensity === intensity; });
    var rec = cells.reduce(function (a, r) { return a + r.recovery; }, 0) / cells.length;
    var det = cells.reduce(function (a, r) { return a + r.detect; }, 0) / cells.length;
    var cf = cells.reduce(function (a, r) { return a + r.conf; }, 0) / cells.length;
    console.log('  ' + pad('intensity ' + intensity, 16) + 'recovery ' + pad(pct(rec), 6) +
                'detect ' + pad(pct(det), 6) + 'conf ' + pct(cf));
  });
});

// Per-corpus recovery snapshot at a moderate stressor (normalize @ 0.25 if present).
console.log('\n=== Per-corpus recovery @ normalize p=0.25 ===');
rows.filter(function (r) { return r.model === 'normalize' && r.intensity === 0.25; })
  .forEach(function (r) {
    console.log('  ' + pad(r.corpus, 20) + pad(r.kind, 8) + 'slots ' + pad(r.slots, 6) +
                'copies ' + pad(r.reps, 4) + 'recovery ' + pct(r.recovery));
  });

var ctrl = runControl();
console.log('\n=== Clean control (false positives) ===');
console.log('  ' + ctrl.samples + ' un-encoded samples decoded; CRC-valid payload claimed in ' +
            pct(ctrl.falsePositive) + ' (' + Math.round(ctrl.falsePositive * ctrl.samples) + ' of ' + ctrl.samples + ')');

if (CSV) {
  var out = 'corpus,kind,model,intensity,slots,reps,recovery,detect,confidence,agreement\n';
  rows.forEach(function (r) {
    out += [r.corpus, r.kind, r.model, r.intensity, r.slots, r.reps,
            r.recovery.toFixed(3), r.detect.toFixed(3), r.conf.toFixed(3), r.agree.toFixed(3)].join(',') + '\n';
  });
  var p = path.isAbsolute(CSV) ? CSV : path.join(__dirname, CSV);
  fs.writeFileSync(p, out);
  console.log('\nCSV written: ' + p + ' (' + rows.length + ' cells)');
}

// Log the run (per-corpus cells) with full provenance.
var builtinCells = rows.map(function (r) {
  return { mode: 'builtin', corpus: r.corpus, kind: r.kind, model: r.model, intensity: r.intensity,
    slots: r.slots, reps: r.reps, trials: TRIALS,
    recovery: +r.recovery.toFixed(4), detect: +r.detect.toFixed(4),
    confidence: +r.conf.toFixed(4), agreement: +r.agree.toFixed(4) };
});
builtinCells.push({ mode: 'builtin', model: 'controlFalsePositive', intensity: 0,
  detect: +ctrl.falsePositive.toFixed(4), docs: ctrl.samples });
logRun('builtin', builtinCells);
