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
var SPAB = require(path.join(__dirname, '..', 'src', 'js', 'spab.js'));
var C = require(path.join(__dirname, 'corpora.js'));
var K = require(path.join(__dirname, 'corruptions.js'));
var GENSRC = require(path.join(__dirname, 'corpus-gen.js'));
var FS = require(path.join(__dirname, 'corpus-fs.js'));
var PROFILES = require(path.join(__dirname, 'payloads.js'));

// --- args ---
var args = process.argv.slice(2);
function argVal(flag, def) { var i = args.indexOf(flag); return i >= 0 && args[i + 1] ? args[i + 1] : def; }
var TRIALS = parseInt(argVal('--trials', '40'), 10);
var CSV = argVal('--csv', null);
var MODEL_FILTER = argVal('--model', null);
var PAYLOAD = argVal('--payload', 'SPAB-7Q2');
var GEN = parseInt(argVal('--gen', '0'), 10);   // sweep N generated docs instead of builtin corpora
var GEN_OFFSET = parseInt(argVal('--offset', '0'), 10);
var PAYSWEEP = argVal('--paysweep', null);      // comma list of payload sizes in bytes, e.g. 4,8,16,32
var CORPUS_DIR = argVal('--corpus-dir', null);  // sweep documents loaded from a directory
var LIMIT = parseInt(argVal('--limit', '0'), 10) || Infinity;
var CLASSES = argVal('--classes', null);         // e.g. "ws" (default) or "ws,punct"
var ECC = argVal('--ecc', null);                 // "repetition" (default) or "rlnc"
var CODEC_PARAMS = {};
if (CLASSES) CODEC_PARAMS.classes = CLASSES.split(',');
if (ECC) CODEC_PARAMS.ecc = ECC;
var PROFILE_BENCH = args.indexOf('--profile-bench') >= 0;  // sweep named payload profiles
var BY_SIZE = args.indexOf('--by-size') >= 0;              // add a recovery-by-text-size table
var NOTE = argVal('--note', null);              // human label for this run
var LOG_DIR = argVal('--log-dir', path.join(__dirname, 'reports'));
var NO_LOG = args.indexOf('--no-log') >= 0;     // skip JSONL logging
var PROV = require(path.join(__dirname, 'provenance.js'));

function logRun(mode, cells) {
  if (NO_LOG) return null;
  var meta = PROV.makeRunMeta({
    spab: SPAB, note: NOTE,
    config: { mode: mode, payload: PAYLOAD, payloadBytes: PAYLOAD.length,
              classes: (CLASSES || 'ws'), ecc: (ECC || 'repetition'), models: modelNames, gen: GEN, genOffset: GEN_OFFSET, trials: TRIALS }
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
  var enc = SPAB.encode(corpus.text, PAYLOAD, CODEC_PARAMS);
  var reps = enc.metadata.reps;
  var recovered = 0, confSum = 0, agreeSum = 0, detected = 0;
  for (var t = 0; t < TRIALS; t++) {
    var rng = K.makeRng((corpus.id.length * 2654435761 + t * 40503 + Math.floor(intensity * 1000)) >>> 0);
    var damaged = K.MODELS[model].fn(enc.text, intensity, rng);
    var d = SPAB.decode(damaged, CODEC_PARAMS);
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
      var d = SPAB.decode(v, CODEC_PARAMS);
      if (d.metadata.crcOk) fp++; // decoder claims a CRC-valid payload from noise
    });
  });
  return { falsePositive: fp / n, samples: n };
}

// --- generated-corpus sweep (--gen N) ---
// One trial per (doc, model, intensity); the corpus itself supplies the variance.
// Accumulates on the fly so 25k-100k docs stay memory-flat.
// Generic sweep over a document source: docs = { count, get(i) -> {text} }.
// One trial per (doc, model, intensity); the corpus supplies the variance.
// Accumulates on the fly so 25k-100k docs stay memory-flat. seedBase keeps
// corruption RNG deterministic and disjoint across offsets.
function runSweep(docs, payload, seedBase) {
  payload = payload || PAYLOAD; seedBase = seedBase || 0;
  var acc = {}, tooShort = 0, encodable = 0;
  function key(m, x) { return m + '|' + x; }
  modelNames.forEach(function (m) {
    K.MODELS[m].intensities.forEach(function (x) {
      acc[key(m, x)] = { rec: 0, det: 0, conf: 0, count: 0, slots: 0, reps: 0 };
    });
  });
  for (var i = 0; i < docs.count; i++) {
    var doc = docs.get(i);
    var enc = SPAB.encode(doc.text, payload, CODEC_PARAMS);
    if (enc.metadata.issues && enc.metadata.issues.length &&
        /too short/i.test(enc.metadata.issues.join(' '))) tooShort++; else encodable++;
    for (var mi = 0; mi < modelNames.length; mi++) {
      var m = modelNames[mi], ints = K.MODELS[m].intensities;
      for (var xi = 0; xi < ints.length; xi++) {
        var x = ints[xi];
        var rng = K.makeRng(((seedBase + i) * 2654435761 + mi * 40503 + Math.floor(x * 1000)) >>> 0);
        var damaged = K.MODELS[m].fn(enc.text, x, rng);
        var d = SPAB.decode(damaged, CODEC_PARAMS);
        var a = acc[key(m, x)];
        a.count++;
        a.slots += enc.metadata.slots; a.reps += enc.metadata.reps;
        if (d.message === payload) a.rec++;
        if (d.metadata.status !== 'not-detected' && d.metadata.status !== 'failed') a.det++;
        a.conf += d.metadata.confidence || 0;
      }
    }
  }
  return { acc: acc, tooShort: tooShort, encodable: encodable, n: docs.count };
}

// Doc source backed by the deterministic generator.
function genDocs(count, offset) {
  return { count: count, get: function (i) { return GENSRC.getDoc(offset + i); } };
}

// Deterministic printable payload of exactly nBytes ASCII bytes.
function makePayload(nBytes) {
  var base = 'SPAB0123456789ABCDEFGHJKLMNPQRSTUVWXYZ', s = '';
  for (var i = 0; i < nBytes; i++) s += base[i % base.length];
  return s;
}

// Resolve the active document source: a directory (--corpus-dir) or the generator.
function resolveDocs() {
  if (CORPUS_DIR) {
    var dir = path.isAbsolute(CORPUS_DIR) ? CORPUS_DIR : path.join(process.cwd(), CORPUS_DIR);
    var c = FS.loadCorpus(dir, { limit: LIMIT });
    return { docs: c, seedBase: 0, label: 'dir ' + CORPUS_DIR + ' (' + c.count + ' docs)' };
  }
  var n = GEN > 0 ? GEN : 5000;
  return { docs: genDocs(n, GEN_OFFSET), seedBase: GEN_OFFSET, label: 'gen ' + n + ' docs' };
}

// Clean-control false positives: decode un-encoded docs from any source.
function falsePositives(docs, n) {
  var fp = 0, tot = 0, lim = Math.min(n, docs.count);
  for (var i = 0; i < lim; i++) {
    tot++;
    var d = SPAB.decode(docs.get(i).text, CODEC_PARAMS);
    if (d.metadata.crcOk) fp++;
  }
  return { fp: fp, tot: tot };
}

// --- payload-size sweep (--paysweep 4,8,16,32,64) ---
// Shows how message length trades against redundancy (reps) and recovery: shorter
// payloads fit more copies in the same text, so they should recover better.
if (PAYSWEEP) {
  var sizes = PAYSWEEP.split(',').map(function (s) { return parseInt(s, 10); }).filter(Boolean);
  var N = GEN > 0 ? GEN : 5000;
  // A few representative stressors to keep the table readable.
  var highlights = [['normalize', 0.1], ['saltPepper', 0.1], ['blockErasure', 0.25], ['cutPaste', 0.5]]
    .filter(function (h) { return modelNames.indexOf(h[0]) >= 0; });
  console.log('spab payload-size sweep — GENERATED corpus');
  console.log('docs/size: ' + N + '   sizes(bytes): ' + sizes.join(', '));
  var t0p = Date.now();
  var cellsP = [];
  console.log('\n' + pad('payloadB', 10) + pad('encodable', 11) + pad('avgReps', 9) +
    highlights.map(function (h) { return pad(h[0] + '@' + h[1], 18); }).join(''));
  sizes.forEach(function (sz) {
    var g = runSweep(genDocs(N, GEN_OFFSET), makePayload(sz), GEN_OFFSET);
    // avg reps is independent of model; read any cell.
    var anyKey = Object.keys(g.acc)[0];
    var avgReps = (g.acc[anyKey].reps / g.acc[anyKey].count).toFixed(2);
    var row = pad(sz, 10) + pad(pct(g.encodable / g.n), 11) + pad(avgReps, 9);
    highlights.forEach(function (h) {
      var a = g.acc[h[0] + '|' + h[1]];
      row += pad(pct(a.rec / a.count), 18);
      cellsP.push({ mode: 'paysweep', payloadBytes: sz, model: h[0], intensity: h[1],
        docs: a.count, recovery: +(a.rec / a.count).toFixed(4), detect: +(a.det / a.count).toFixed(4),
        confidence: +(a.conf / a.count).toFixed(4), avgReps: +avgReps,
        encodableFrac: +(g.encodable / g.n).toFixed(4) });
    });
    console.log(row);
  });
  logRun('paysweep', cellsP);
  console.log('done in ' + ((Date.now() - t0p) / 1000).toFixed(1) + 's');
  process.exit(0);
}

// --- payload-profile benchmark (--profile-bench) ---
// Sweep the named profiles (magic / sha1 / sha256 / json / program) so users can see
// capacity vs. robustness at a glance: tiny payloads fit everywhere and survive; hash
// and long payloads need bigger passages and degrade sooner.
if (PROFILE_BENCH) {
  var src = resolveDocs();
  var hl = [['normalize', 0.1], ['saltPepper', 0.1], ['blockErasure', 0.25], ['cutPaste', 0.5], ['regexAttack', 0.34]]
    .filter(function (h) { return modelNames.indexOf(h[0]) >= 0 || Object.keys(K.MODELS).indexOf(h[0]) >= 0; });
  console.log('spab payload-profile benchmark — ' + src.label);
  console.log('\n' + pad('profile', 10) + pad('bytes', 7) + pad('encodable', 11) + pad('avgReps', 9) +
    hl.map(function (h) { return pad(h[0] + '@' + h[1], 17); }).join(''));
  var t0pb = Date.now(), cellsPB = [];
  // Ensure all highlight models are computed even if --model wasn't passed.
  var savedModels = modelNames;
  modelNames = Array.from(new Set(hl.map(function (h) { return h[0]; })));
  PROFILES.PROFILES.forEach(function (pr) {
    var g = runSweep(src.docs, pr.text, src.seedBase);
    var anyKey = Object.keys(g.acc)[0];
    var avgReps = (g.acc[anyKey].reps / g.acc[anyKey].count).toFixed(2);
    var row = pad(pr.name, 10) + pad(pr.bytes, 7) + pad(pct(g.encodable / g.n), 11) + pad(avgReps, 9);
    hl.forEach(function (h) {
      var a = g.acc[h[0] + '|' + h[1]];
      row += pad(a ? pct(a.rec / a.count) : '-', 17);
      if (a) cellsPB.push({ mode: 'profile-bench', profile: pr.name, profileBytes: pr.bytes,
        model: h[0], intensity: h[1], docs: a.count, recovery: +(a.rec / a.count).toFixed(4),
        detect: +(a.det / a.count).toFixed(4), avgReps: +avgReps,
        encodableFrac: +(g.encodable / g.n).toFixed(4) });
    });
    console.log(row);
  });
  modelNames = savedModels;
  console.log('\n(encodable = fraction of docs long enough to hold it; avgReps = redundancy achieved)');
  logRun('profile-bench', cellsPB);
  console.log('done in ' + ((Date.now() - t0pb) / 1000).toFixed(1) + 's');
  process.exit(0);
}

// --- recovery by text size (--by-size) ---
// Bins recovery by carrier-slot count (a proxy for passage length) at one stressor,
// so you can see how robustness scales with how much text you have.
if (BY_SIZE) {
  var srcs = resolveDocs();
  var model = (MODEL_FILTER ? modelNames[0] : 'normalize');
  var inten = K.MODELS[model].intensities[0];
  var edges = [0, 20, 50, 100, 200, 500, Infinity];
  var bins = edges.slice(0, -1).map(function (lo, i) {
    return { lo: lo, hi: edges[i + 1], n: 0, rec: 0, enc: 0 };
  });
  for (var i = 0; i < srcs.docs.count; i++) {
    var doc = srcs.docs.get(i);
    var enc = SPAB.encode(doc.text, PAYLOAD, CODEC_PARAMS);
    var slots = enc.metadata.slots;
    var b = bins.find(function (bb) { return slots >= bb.lo && slots < bb.hi; });
    if (!b) continue;
    b.n++;
    if (!(enc.metadata.issues || []).join(' ').match(/too short/i)) b.enc++;
    var rng = K.makeRng(((srcs.seedBase + i) * 2654435761) >>> 0);
    var d = SPAB.decode(K.MODELS[model].fn(enc.text, inten, rng), CODEC_PARAMS);
    if (d.message === PAYLOAD) b.rec++;
  }
  console.log('spab recovery by text size — ' + srcs.label + '   payload "' + PAYLOAD + '" (' + PAYLOAD.length +
    'B)   stressor ' + model + '@' + inten);
  console.log('\n' + pad('slots', 14) + pad('docs', 8) + pad('encodable', 11) + 'recovery');
  var cellsBS = [];
  bins.forEach(function (b) {
    var label = b.hi === Infinity ? (b.lo + '+') : (b.lo + '-' + (b.hi - 1));
    console.log('  ' + pad(label, 12) + pad(b.n, 8) + pad(b.n ? pct(b.enc / b.n) : '-', 11) +
      (b.n ? pct(b.rec / b.n) : '-'));
    cellsBS.push({ mode: 'by-size', model: model, intensity: inten, sizeBin: label, docs: b.n,
      recovery: b.n ? +(b.rec / b.n).toFixed(4) : 0, encodableFrac: b.n ? +(b.enc / b.n).toFixed(4) : 0 });
  });
  logRun('by-size', cellsBS);
  process.exit(0);
}

// --- directory-corpus sweep (--corpus-dir <dir>) ---
if (CORPUS_DIR) {
  var corpus = FS.loadCorpus(path.isAbsolute(CORPUS_DIR) ? CORPUS_DIR : path.join(process.cwd(), CORPUS_DIR),
    { limit: LIMIT });
  if (corpus.count === 0) { console.error('no documents found under ' + CORPUS_DIR + ' (.txt/.md or .jsonl).'); process.exit(1); }
  console.log('spab robustness benchmark — DIRECTORY corpus');
  console.log('dir: ' + CORPUS_DIR + '   docs: ' + corpus.count + '   payload: "' + PAYLOAD + '"');
  console.log('models: ' + modelNames.join(', '));
  var t0d = Date.now();
  var gd = runSweep(corpus, PAYLOAD, 0);
  console.log('encodable: ' + gd.encodable + '/' + gd.n + '   too short for payload: ' + gd.tooShort);
  console.log('\n=== Recovery by model x intensity (avg over ' + gd.n + ' docs) ===');
  var cellsD = [];
  modelNames.forEach(function (m) {
    console.log('\n' + m + '  (' + K.MODELS[m].note + ')');
    K.MODELS[m].intensities.forEach(function (x) {
      var a = gd.acc[m + '|' + x];
      console.log('  ' + pad('intensity ' + x, 16) + 'recovery ' + pad(pct(a.rec / a.count), 6) +
                  'detect ' + pad(pct(a.det / a.count), 6) + 'conf ' + pct(a.conf / a.count));
      cellsD.push({ mode: 'dir', corpusDir: CORPUS_DIR, model: m, intensity: x, docs: a.count,
        recovery: +(a.rec / a.count).toFixed(4), detect: +(a.det / a.count).toFixed(4),
        confidence: +(a.conf / a.count).toFixed(4),
        avgSlots: +(a.slots / a.count).toFixed(1), avgReps: +(a.reps / a.count).toFixed(2) });
    });
  });
  var fpd = falsePositives(corpus, 2000);
  console.log('\n=== Clean control (false positives on un-encoded corpus docs) ===');
  console.log('  ' + fpd.tot + ' decoded; CRC-valid payload claimed in ' + pct(fpd.fp / fpd.tot));
  cellsD.push({ mode: 'dir', corpusDir: CORPUS_DIR, model: 'controlFalsePositive', intensity: 0,
    docs: fpd.tot, detect: +(fpd.fp / fpd.tot).toFixed(4) });
  logRun('dir', cellsD);
  console.log('done in ' + ((Date.now() - t0d) / 1000).toFixed(1) + 's');
  process.exit(0);
}

if (GEN > 0) {
  console.log('spab robustness benchmark — GENERATED corpus');
  console.log('docs: ' + GEN + ' (offset ' + GEN_OFFSET + ')   payload: "' + PAYLOAD + '"');
  console.log('models: ' + modelNames.join(', '));
  var t0 = Date.now();
  var g = runSweep(genDocs(GEN, GEN_OFFSET), PAYLOAD, GEN_OFFSET);
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
  var gf = falsePositives(genDocs(GEN, GEN_OFFSET), 2000);
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
