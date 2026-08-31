#!/usr/bin/env node
/*
 * lint.js — zero-dependency lint gate. Fails (exit 1) on ANY finding.
 *
 * No ESLint / Prettier (they'd be dev dependencies). Instead this enforces the
 * project's own declared rules across ALL source files:
 *
 *   1. .editorconfig hygiene — utf-8 (no BOM), LF endings, final newline,
 *      no trailing whitespace, no hard tabs (space indent). Applied to every
 *      tracked source file, honoring the per-type exceptions in .editorconfig.
 *   2. JavaScript — every .js parses (node --check), no `debugger`, and the
 *      inline <script> in pages/*.html parses too.
 *   3. Shipping library (src/js/spab.js) — must be strict, quiet (no console.*),
 *      and free of TODO/FIXME/XXX left in shipped code.
 *   4. Ports — run the native linter with warnings-as-errors WHEN its toolchain
 *      is installed (cargo clippy, ruff, clang-tidy, ...); skipped, not failed,
 *      when absent so skeleton ports don't block CI.
 *
 * Warnings are errors: any finding fails the build. Usage: node tests/lint.js [--quiet]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const QUIET = process.argv.indexOf('--quiet') > 0;
const findings = [];
function add(file, line, msg) { findings.push({ file: path.relative(ROOT, file), line: line, msg: msg }); }

// ---- which files to lint ----
const SKIP_DIRS = new Set(['node_modules', '.git', 'corpuses', 'dist', 'build', 'target', '__pycache__', 'reports']);
const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.rs', '.c', '.h', '.cpp', '.hpp',
  '.py', '.java', '.kt', '.swift', '.html', '.css', '.yml', '.yaml', '.toml', '.md', '.sh']);
// editorconfig exceptions: markdown keeps trailing whitespace (hard line breaks) and
// often embeds tab-indented code samples, so relax those two checks for *.md.
function relaxTrailingWs(ext) { return ext === '.md'; }
function relaxTabs(ext) { return ext === '.md' || ext === '.go'; }

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (SOURCE_EXT.has(path.extname(name))) out.push(full);
  }
  return out;
}
const files = walk(ROOT, []);

// ---- 1. editorconfig hygiene ----
for (const file of files) {
  const ext = path.extname(file);
  const buf = fs.readFileSync(file);
  if (buf.length === 0) continue; // empty file: nothing to check
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) add(file, 1, 'UTF-8 BOM (charset=utf-8, no BOM)');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch (e) { add(file, 1, 'not valid UTF-8'); continue; }
  if (text.indexOf('\r') !== -1) add(file, lineOfIndex(text, text.indexOf('\r')), 'CRLF / CR line ending (end_of_line=lf)');
  if (text[text.length - 1] !== '\n') add(file, text.split('\n').length, 'missing final newline (insert_final_newline)');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!relaxTrailingWs(ext) && /[ \t]+$/.test(ln)) add(file, i + 1, 'trailing whitespace');
    const indent = ln.match(/^[ \t]*/)[0];
    if (!relaxTabs(ext) && indent.indexOf('\t') !== -1) add(file, i + 1, 'hard tab in indentation (indent_style=space)');
  }
}
function lineOfIndex(text, idx) { return text.slice(0, idx).split('\n').length; }

// ---- 2. JavaScript: parse + no debugger ----
const jsFiles = files.filter(function (f) { return ['.js', '.mjs', '.cjs'].indexOf(path.extname(f)) !== -1; });
for (const file of jsFiles) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) add(file, 0, 'syntax error: ' + (r.stderr || '').split('\n').filter(Boolean).slice(-2).join(' ').trim());
  const text = fs.readFileSync(file, 'utf8');
  text.split('\n').forEach(function (ln, i) {
    if (/(^|[^.\w])debugger\s*;?\s*$/.test(ln)) add(file, i + 1, "`debugger` statement");
  });
}

// ---- 2b. inline <script> in pages/*.html parses ----
for (const file of files.filter(function (f) { return path.extname(f) === '.html'; })) {
  const html = fs.readFileSync(file, 'utf8');
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m, n = 0;
  while ((m = re.exec(html))) {
    const code = m[1];
    if (!code.trim()) continue;
    n++;
    const tmp = path.join(require('os').tmpdir(), 'spab-lint-' + process.pid + '-' + n + '.js');
    fs.writeFileSync(tmp, code);
    const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
    if (r.status !== 0) add(file, lineOfIndex(html, m.index), 'inline <script> #' + n + ' syntax error: ' +
      (r.stderr || '').split('\n').filter(Boolean).slice(-2).join(' ').trim());
    try { fs.unlinkSync(tmp); } catch (e) {}
  }
}

// ---- 3. shipping library quality (src/js/spab.js) ----
(function () {
  const lib = path.join(ROOT, 'src/js/spab.js');
  if (!fs.existsSync(lib)) return;
  const text = fs.readFileSync(lib, 'utf8');
  if (!/['"]use strict['"]/.test(text)) add(lib, 1, "shipping library missing 'use strict'");
  text.split('\n').forEach(function (ln, i) {
    if (/\bconsole\.\w+/.test(ln)) add(lib, i + 1, 'console.* in shipping library (must stay quiet)');
    if (/\b(TODO|FIXME|XXX|HACK)\b/.test(ln)) add(lib, i + 1, 'TODO/FIXME left in shipped code');
  });
})();

// ---- 4. port linters (warnings-as-errors) when the toolchain is present ----
function have(bin) { return spawnSync(bin, ['--version'], { encoding: 'utf8' }).status === 0; }
function runPort(label, cond, bin, args, cwd) {
  if (!cond) { if (!QUIET) console.log('  · ' + label + ': skipped (no source / not enabled)'); return; }
  if (!have(bin)) { if (!QUIET) console.log('  · ' + label + ': skipped (' + bin + ' not installed)'); return; }
  const r = spawnSync(bin, args, { cwd: cwd, encoding: 'utf8' });
  if (r.status !== 0) add(path.join(cwd, '.'), 0, label + ' reported issues:\n' + ((r.stdout || '') + (r.stderr || '')).trim().slice(0, 800));
  else if (!QUIET) console.log('  · ' + label + ': clean');
}
function portHasCode(rel, exts) {
  const dir = path.join(ROOT, rel);
  if (!fs.existsSync(dir)) return false;
  // "real" port = a source file with more than a trivial number of non-empty lines
  return walk(dir, []).some(function (f) {
    if (exts.indexOf(path.extname(f)) === -1) return false;
    return fs.readFileSync(f, 'utf8').split('\n').filter(function (l) { return l.trim(); }).length > 20;
  });
}
if (!QUIET) console.log('port linters (run only when a real port + its toolchain are present):');
runPort('rust (clippy -D warnings)', portHasCode('src/rust', ['.rs']), 'cargo',
  ['clippy', '--manifest-path', path.join(ROOT, 'src/rust/Cargo.toml'), '--', '-D', 'warnings'], path.join(ROOT, 'src/rust'));
runPort('python (ruff)', portHasCode('src/python', ['.py']), 'ruff', ['check', path.join(ROOT, 'src/python')], ROOT);
runPort('c/c++ (clang-tidy)', portHasCode('src/c_cpp', ['.c', '.h', '.cpp', '.hpp']), 'clang-tidy',
  ['--warnings-as-errors=*'].concat(walk(path.join(ROOT, 'src/c_cpp'), []).filter(function (f) { return /\.(c|cpp)$/.test(f); })), ROOT);

// ---- report ----
console.log('\n===== lint: ' + files.length + ' source files, ' + jsFiles.length + ' JS =====');
if (findings.length === 0) { console.log('PASS (no findings)'); process.exit(0); }
findings.sort(function (a, b) { return a.file.localeCompare(b.file) || a.line - b.line; });
let cur = null;
for (const f of findings) {
  if (f.file !== cur) { cur = f.file; console.log('\n  ' + cur); }
  console.log('    ' + (f.line ? String(f.line).padStart(4) : '   -') + '  ' + f.msg);
}
console.log('\nFAIL — ' + findings.length + ' finding(s). Warnings are errors.');
process.exit(1);
