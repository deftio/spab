#!/usr/bin/env -S node --experimental-sqlite
/*
 * db.js — build/query a SQLite index from the append-only JSONL run logs.
 *
 * JSONL (runs.jsonl / results.jsonl) is the source of truth. This DB is a DERIVED
 * index: it is dropped and fully rebuilt from the logs on every import, so it can
 * be deleted and regenerated at any time and never diverges from the logs.
 *
 * Requires Node's built-in SQLite (Node >= 22.5), which is behind a flag:
 *   node --experimental-sqlite r_and_d/db.js import
 *   node --experimental-sqlite r_and_d/db.js runs
 *   node --experimental-sqlite r_and_d/db.js query
 *   node --experimental-sqlite r_and_d/db.js sql "SELECT ..."
 */
'use strict';

var fs = require('fs');
var path = require('path');

var DatabaseSync;
try { DatabaseSync = require('node:sqlite').DatabaseSync; }
catch (e) {
  console.error('node:sqlite unavailable. Run with:  node --experimental-sqlite r_and_d/db.js <cmd>');
  console.error('(needs Node >= 22.5). The JSONL logs are unaffected.');
  process.exit(1);
}

var LOG_DIR = path.join(__dirname, 'reports');
var DB_PATH = path.join(LOG_DIR, 'spab-bench.sqlite');

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(function (l) {
    try { return JSON.parse(l); } catch (e) { return null; }
  }).filter(Boolean);
}

function build() {
  var runs = readJsonl(path.join(LOG_DIR, 'runs.jsonl'));
  var results = readJsonl(path.join(LOG_DIR, 'results.jsonl'));
  var db = new DatabaseSync(DB_PATH);
  db.exec('DROP TABLE IF EXISTS runs; DROP TABLE IF EXISTS results;');
  db.exec(
    'CREATE TABLE runs (runId TEXT PRIMARY KEY, ts TEXT, note TEXT, spab_version TEXT, ' +
    'spab_name TEXT, source_hash TEXT, git_commit TEXT, git_branch TEXT, git_dirty INTEGER, ' +
    'node TEXT, algorithm_json TEXT, config_json TEXT);'
  );
  db.exec(
    'CREATE TABLE results (runId TEXT, spabVersion TEXT, mode TEXT, corpus TEXT, kind TEXT, ' +
    'model TEXT, intensity REAL, docs INTEGER, slots REAL, reps REAL, trials INTEGER, ' +
    'recovery REAL, detect REAL, confidence REAL, agreement REAL);'
  );
  var insRun = db.prepare(
    'INSERT OR REPLACE INTO runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
  );
  runs.forEach(function (r) {
    var s = r.spab || {}, g = r.git || {}, e = r.env || {};
    insRun.run(r.runId, r.timestamp, r.note, s.version, (s.algorithm || {}).name,
      s.sourceHash, g.commit, g.branch, g.dirty ? 1 : 0, e.node,
      JSON.stringify(s.algorithm || {}), JSON.stringify(r.config || {}));
  });
  var insRes = db.prepare(
    'INSERT INTO results VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  );
  results.forEach(function (c) {
    insRes.run(c.runId, c.spabVersion, c.mode, c.corpus || null, c.kind || null,
      c.model, c.intensity, c.docs != null ? c.docs : null, c.slots != null ? c.slots : null,
      c.reps != null ? c.reps : null, c.trials != null ? c.trials : null,
      c.recovery != null ? c.recovery : null, c.detect != null ? c.detect : null,
      c.confidence != null ? c.confidence : null, c.agreement != null ? c.agreement : null);
  });
  console.log('built ' + DB_PATH);
  console.log('  runs: ' + runs.length + '   result rows: ' + results.length);
  return db;
}

function openDb() { return new DatabaseSync(DB_PATH); }
function printRows(rows) {
  if (!rows.length) { console.log('(no rows)'); return; }
  var cols = Object.keys(rows[0]);
  console.log(cols.join('\t'));
  rows.forEach(function (r) { console.log(cols.map(function (c) { return r[c]; }).join('\t')); });
}

var cmd = process.argv[2] || 'import';
if (cmd === 'import') {
  build();
} else if (cmd === 'runs') {
  var db = openDb();
  printRows(db.prepare(
    'SELECT runId, ts, spab_version, source_hash, git_commit, note FROM runs ORDER BY ts DESC'
  ).all());
} else if (cmd === 'query') {
  // Recovery over time: latest-per-version comparison for the key stressors.
  var db2 = openDb();
  console.log('\n# Recovery by spab version x model x intensity (gen mode)\n');
  printRows(db2.prepare(
    "SELECT spabVersion AS ver, model, intensity, ROUND(AVG(recovery),3) AS recovery, " +
    "ROUND(AVG(detect),3) AS detect, COUNT(*) AS cells " +
    "FROM results WHERE mode='gen' AND model NOT LIKE 'control%' " +
    "GROUP BY spabVersion, model, intensity ORDER BY model, intensity, ver"
  ).all());
} else if (cmd === 'sql') {
  var db3 = openDb();
  var q = process.argv.slice(3).join(' ');
  if (!q) { console.error('usage: db.js sql "SELECT ..."'); process.exit(1); }
  printRows(db3.prepare(q).all());
} else {
  console.error('commands: import | runs | query | sql "<SELECT ...>"');
  process.exit(1);
}
