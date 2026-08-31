/*
 * provenance.js — run identity + append-only logging for the benchmark.
 *
 * Every run records WHICH spab algorithm was tested (version + full descriptor +
 * a content hash of spab.js) plus the run config and environment, so results are
 * comparable across time. JSONL is the source of truth (append-only, diffable);
 * SQLite (see db.js) is a derived index rebuilt from these logs.
 *
 * Two logs:
 *   runs.jsonl     — one line per run: the manifest (version, algorithm, config, env).
 *   results.jsonl  — one line per (run, cell): metrics keyed by runId.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var cp = require('child_process');

function sha256File(p) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16); }
  catch (e) { return null; }
}

function gitInfo(repoDir) {
  function run(cmd) {
    try { return cp.execSync(cmd, { cwd: repoDir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
    catch (e) { return null; }
  }
  return {
    commit: run('git rev-parse --short HEAD'),
    branch: run('git rev-parse --abbrev-ref HEAD'),
    dirty: run('git status --porcelain') ? true : false
  };
}

function makeRunId() {
  var ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  var rnd = crypto.randomBytes(3).toString('hex');
  return 'run-' + ts + '-' + rnd;
}

// Build the run manifest. `spab` is the required spab module (has VERSION/ALGORITHM).
function makeRunMeta(opts) {
  var repoDir = path.join(__dirname, '..');
  var spabPath = path.join(repoDir, 'src', 'js', 'spab.js');
  return {
    runId: makeRunId(),
    timestamp: new Date().toISOString(),
    note: opts.note || null,
    spab: {
      version: opts.spab.VERSION,
      algorithm: opts.spab.ALGORITHM,
      sourceHash: sha256File(spabPath) // detects code changes even without a version bump
    },
    git: gitInfo(repoDir),
    env: { node: process.version, platform: process.platform },
    config: opts.config
  };
}

function appendJsonl(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

// Write the manifest to runs.jsonl and every cell to results.jsonl.
function writeRun(logDir, meta, cells) {
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  appendJsonl(path.join(logDir, 'runs.jsonl'), meta);
  var rf = path.join(logDir, 'results.jsonl');
  cells.forEach(function (c) {
    var row = Object.assign({ runId: meta.runId, spabVersion: meta.spab.version }, c);
    appendJsonl(rf, row);
  });
  return { runs: path.join(logDir, 'runs.jsonl'), results: rf, cells: cells.length };
}

module.exports = { makeRunMeta: makeRunMeta, writeRun: writeRun, appendJsonl: appendJsonl, sha256File: sha256File };
