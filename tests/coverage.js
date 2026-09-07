#!/usr/bin/env node
/*
 * coverage.js — zero-dependency coverage for the shipping library.
 *
 * Uses V8's built-in coverage (NODE_V8_COVERAGE): spawns each test file in its
 * own Node process with coverage dumping on, merges the block ranges, and reports
 * function / line / branch(block) coverage for src/js/spab.js. No c8, no istanbul.
 *
 *   node tests/coverage.js                 # report only (never fails the build)
 *   node tests/coverage.js --strict        # exit 1 if below thresholds
 *   node tests/coverage.js --branches 100 --functions 100 --lines 95
 *   node tests/coverage.js --show-uncovered=8   # print up to N uncovered blocks
 *
 * "Branch" here = V8 block coverage (each conditional block V8 emits), the same
 * signal c8 reports as branches. 100% block coverage ⇒ every reachable branch ran.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.resolve(ROOT, 'src/js/spab.js');

// Test files whose execution counts toward coverage (each run in its own process).
const SUITES = [
  ['tests/roundtrip.test.js', []],
  ['tests/branches.test.js', []],
  ['tests/wire.test.js', []],
  ['tests/noise.test.js', []],
  ['tests/corpus.test.js', []],
  ['tests/fuzz.test.js', ['--iterations', '400']]
].filter(function (s) { return fs.existsSync(path.resolve(ROOT, s[0])); });

// ---- args ----
function argVal(name, def) { var i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : def; }
function argFlag(name) { return process.argv.indexOf('--' + name) > 0; }
const thr = {
  branches: +argVal('branches', 100),
  functions: +argVal('functions', 100),
  lines: +argVal('lines', 90)
};
const STRICT = argFlag('strict');
let showN = 12;
const su = process.argv.find(function (a) { return a.indexOf('--show-uncovered') === 0; });
if (su) showN = su.indexOf('=') > 0 ? +su.split('=')[1] : 12;

// ---- run suites under V8 coverage ----
const covDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spab-cov-'));
let anyFail = false;
for (const [rel, extra] of SUITES) {
  const r = spawnSync(process.execPath, [path.resolve(ROOT, rel)].concat(extra), {
    cwd: ROOT, stdio: 'inherit',
    env: Object.assign({}, process.env, { NODE_V8_COVERAGE: covDir, SPAB_COV: '1' })
  });
  if (r.status !== 0) { anyFail = true; console.error('  ! suite failed: ' + rel); }
}

// ---- merge block ranges for the target across all processes ----
const src = fs.readFileSync(TARGET, 'utf8');
// line index (offset -> 1-based line), used by cov-ignore and line coverage below
const lineStart = [0];
for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStart.push(i + 1);
function lineOf(off) { let lo = 0, hi = lineStart.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (lineStart[m] <= off) lo = m; else hi = m - 1; } return lo + 1; }
const blocks = new Map();   // "start:end" -> { s, e, count }
let funcTotal = 0, funcCov = 0;
const files = fs.readdirSync(covDir).filter(function (f) { return f.endsWith('.json'); });
for (const f of files) {
  let j; try { j = JSON.parse(fs.readFileSync(path.join(covDir, f), 'utf8')); } catch (e) { continue; }
  for (const entry of (j.result || [])) {
    if (!entry.url || !entry.url.endsWith('src/js/spab.js')) continue;
    for (const fn of entry.functions) {
      for (let ri = 0; ri < fn.ranges.length; ri++) {
        const rg = fn.ranges[ri];
        const key = rg.startOffset + ':' + rg.endOffset;
        const cur = blocks.get(key);
        if (cur) cur.count += rg.count;
        else blocks.set(key, { s: rg.startOffset, e: rg.endOffset, count: rg.count, fn: fn.functionName, top: ri === 0 });
      }
    }
  }
}
// function coverage = top (whole-function) range per named function
const seenFn = new Set();
for (const b of blocks.values()) {
  if (b.top) { const k = b.s + ':' + b.e; if (seenFn.has(k)) continue; seenFn.add(k); funcTotal++; if (b.count > 0) funcCov++; }
}

// ---- cov-ignore: exclude explicitly-marked defensive/unreachable blocks ----
// A block is ignored if the source line at its start (or the line just above)
// contains "cov-ignore". Mirrors c8's "/* c8 ignore */" convention. Every use
// must carry a reason so the exclusions are auditable.
const lines = src.split('\n');
function offsetLine(off) { return lineOf(off) - 1; } // 0-based
function isIgnored(b) {
  const l = offsetLine(b.s);
  const here = lines[l] || '', above = lines[l - 1] || '';
  return /cov-ignore/.test(here) || /cov-ignore/.test(above);
}

// ---- per-offset execution across all processes ----
//
// A block's own count is not enough to decide it never ran. V8 emits COARSE ranges
// in a process where a region was skipped and FINER nested ranges in a process
// where parts of it executed, so the same code yields different [start,end) keys
// per process and the two can never cancel by key. Merging on the key alone left
// a coarse zero-range from one test file standing even though another test file
// executed every statement inside it — reporting covered code as uncovered.
//
// So resolve execution per source offset instead. Within one profile, ranges nest
// and the innermost wins, which is exactly what applying them in order gives;
// summing those per-offset maps across processes yields "did any run execute this
// byte". A block is uncovered only when no byte in its span ever ran.
const execCount = new Int32Array(src.length);
for (const f of files) {
  let j; try { j = JSON.parse(fs.readFileSync(path.join(covDir, f), 'utf8')); } catch (e) { continue; }
  const local = new Int32Array(src.length);
  for (const entry of (j.result || [])) {
    if (!entry.url || !entry.url.endsWith('src/js/spab.js')) continue;
    for (const fn of entry.functions) {
      for (const rg of fn.ranges) {
        const end = Math.min(rg.endOffset, src.length);
        for (let i = rg.startOffset; i < end; i++) local[i] = rg.count;   // nested ranges come later and override
      }
    }
  }
  for (let i = 0; i < src.length; i++) if (local[i] > 0) execCount[i] += local[i];
}
function ranAnywhere(b) {
  const end = Math.min(b.e, src.length);
  for (let i = b.s; i < end; i++) if (execCount[i] > 0) return true;
  return b.s >= end && b.count > 0;   // zero-width range: fall back to its own count
}

// ---- compute block (branch) coverage ----
// Only genuinely-uncovered blocks on cov-ignore lines are excluded; every COVERED
// block still counts toward the total (keeps the denominator honest — a marker can
// never inflate coverage by hiding a branch that actually ran).
const allRaw = Array.from(blocks.values());
allRaw.forEach(function (b) { if (b.count === 0 && ranAnywhere(b)) b.count = 1; });
const ignored = allRaw.filter(function (b) { return isIgnored(b) && b.count === 0; });
const all = allRaw.filter(function (b) { return !(isIgnored(b) && b.count === 0); });
const branchTotal = all.length;
const uncovered = all.filter(function (b) { return b.count === 0; });
const branchCov = branchTotal - uncovered.length;
const ignoredUncovered = ignored.length;

// ---- line coverage: a line is covered if any covered block overlaps it ----
const covLines = new Set(), allLines = new Set();
for (const b of all) {
  const l0 = lineOf(b.s), l1 = lineOf(Math.max(b.s, b.e - 1));
  for (let l = l0; l <= l1; l++) { allLines.add(l); if (b.count > 0) covLines.add(l); }
}
const lineTotal = allLines.size, lineCov = covLines.size;

function pct(a, b) { return b === 0 ? 100 : +(100 * a / b).toFixed(2); }
const report = {
  functions: { covered: funcCov, total: funcTotal, pct: pct(funcCov, funcTotal) },
  lines: { covered: lineCov, total: lineTotal, pct: pct(lineCov, lineTotal) },
  branches: { covered: branchCov, total: branchTotal, pct: pct(branchCov, branchTotal) }
};

console.log('\n===== coverage: src/js/spab.js =====');
console.log('  functions : ' + report.functions.pct + '%  (' + funcCov + '/' + funcTotal + ')');
console.log('  lines     : ' + report.lines.pct + '%  (' + lineCov + '/' + lineTotal + ')');
console.log('  branches  : ' + report.branches.pct + '%  (' + branchCov + '/' + branchTotal + ')  [V8 block coverage, excl. cov-ignore]');
console.log('  cov-ignore: ' + ignored.length + ' uncovered defensive blocks excluded (annotated in source)');

if (uncovered.length && showN > 0) {
  console.log('\n  uncovered blocks (first ' + Math.min(showN, uncovered.length) + '):');
  uncovered.slice(0, showN).forEach(function (b) {
    const ln = lineOf(b.s);
    let snip = src.slice(b.s, Math.min(b.e, b.s + 72)).replace(/\n/g, '\\n').replace(/\s+/g, ' ').trim();
    console.log('    line ' + String(ln).padStart(3) + '  [' + b.s + '..' + b.e + ']  ' + snip);
  });
}

// JSON artifact for CI/badges
const outDir = path.resolve(ROOT, 'r_and_d/reports');
try { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, 'coverage.json'), JSON.stringify(report, null, 2)); } catch (e) {}

try { fs.rmSync(covDir, { recursive: true, force: true }); } catch (e) {}

// ---- gating ----
const below = [];
if (report.branches.pct < thr.branches) below.push('branches ' + report.branches.pct + '% < ' + thr.branches + '%');
if (report.functions.pct < thr.functions) below.push('functions ' + report.functions.pct + '% < ' + thr.functions + '%');
if (report.lines.pct < thr.lines) below.push('lines ' + report.lines.pct + '% < ' + thr.lines + '%');

if (below.length) {
  console.log('\n  thresholds not met: ' + below.join('; '));
  if (STRICT) { console.log('  (--strict) FAIL'); process.exit(1); }
  console.log('  (reporting only — not gating; add --strict to enforce)');
} else {
  console.log('\n  all thresholds met.');
}
if (anyFail && STRICT) process.exit(1);
