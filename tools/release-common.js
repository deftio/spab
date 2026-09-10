#!/usr/bin/env node
/*
 * release-common.js — shared plumbing for start-release.js and release.js.
 *
 * Both scripts read the same version surfaces, parse the same CHANGELOG, and ask
 * the same kinds of questions, so that logic lives here once. Zero dependencies,
 * like everything else in this repo — only node builtins.
 *
 * Nothing in this file mutates the repo. It reads, formats, and prompts; the two
 * callers decide what to actually do.
 */
'use strict';

const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ── Process plumbing ────────────────────────────────────────────────────

// Run a command, echoing it first, with output streaming straight to the
// terminal. Throws on non-zero exit, which is what we want everywhere: a failed
// gate must stop the release rather than be inspected and shrugged off.
function run(cmd, opts) {
  console.log('\n  → ' + cmd);
  execSync(cmd, Object.assign({ cwd: ROOT, stdio: 'inherit' }, opts || {}));
}

// Run a command with an ARGUMENT LIST rather than a shell string. Use this for
// anything whose arguments come from a file the repo edits — CHANGELOG prose, a
// branch name, a user-supplied --title.
//
// `run()` builds one string and hands it to /bin/sh, and JSON.stringify is not a
// shell quoter: inside double quotes the shell still expands backticks and $(…).
// A v0.5.0 title derived from a CHANGELOG line containing `dev/wire-format.md`
// was truncated mid-token, left an unbalanced backtick, and the shell tried to
// execute what followed. A CHANGELOG containing $(…) would have run it. There is
// no escaping scheme worth trusting here — do not build the string at all.
function runArgs(file, args, opts) {
  console.log('\n  → ' + file + ' ' + args.map(function (a) {
    return /[^\w@%+=:,./-]/.test(a) ? JSON.stringify(a) : a;
  }).join(' '));
  execFileSync(file, args, Object.assign({ cwd: ROOT, stdio: 'inherit' }, opts || {}));
}

// Run a command and capture its trimmed output. Throws on non-zero exit.
function runQuiet(cmd) {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim();
}

// Run a command and capture output, returning null on ANY failure. For probes
// where "the command failed" is a legitimate answer (tag does not exist, package
// is not published yet) rather than an error.
function tryQuiet(cmd) {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) {
    return null;
  }
}

function fail(msg) {
  console.error('\n✗ ABORTED: ' + msg + '\n');
  process.exit(1);
}

function step(label) {
  console.log('\n' + '─'.repeat(64) + '\n  ' + label + '\n' + '─'.repeat(64));
}

function ok(msg) {
  console.log('  ✓ ' + msg);
}

// Describe a mutation instead of performing it, for --dry-run.
function skipped(what) {
  console.log('  ⤷ DRY RUN — skipped: ' + what);
}

// ── Prompts ─────────────────────────────────────────────────────────────
//
// Read from the terminal via `sh -c read` rather than the readline module:
// readline wants an async event loop, and these scripts are a straight-line
// sequence of gates. Blocking here keeps the control flow readable.

function askLine(question) {
  try {
    return execFileSync('/bin/sh', ['-c', 'printf "%s" "$1" >&2 && read ans && printf "%s" "$ans"', 'sh', question], {
      stdio: ['inherit', 'pipe', 'inherit'],
      encoding: 'utf8'
    }).trim();
  } catch (e) {
    fail('An interactive terminal is required here. (Non-interactive? use --dry-run, or pass --yes.)');
  }
}

// Prompt until the answer is one of `choices` (single letters).
function askChoice(question, choices) {
  for (;;) {
    const a = askLine(question).toLowerCase();
    if (choices.indexOf(a) !== -1) return a;
    console.log('  Please answer one of: ' + choices.join(', '));
  }
}

function askYesNo(question) {
  return askChoice(question, ['y', 'n']) === 'y';
}

// ── Version surfaces ────────────────────────────────────────────────────
//
// spab keeps its version in three places that MUST agree. CI's version-consistency
// job and release-on-bump.yml both enforce this; checking it locally means you
// find out in two seconds instead of after a merge.
//
//   package.json              root workspace version
//   src/js/package.json       the published npm package
//   src/js/spab.js            the VERSION constant the library reports at runtime
const VERSION_FILES = {
  root: 'package.json',
  pkg: 'src/js/package.json',
  lib: 'src/js/spab.js'
};

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

// The VERSION constant is read with a regex rather than by requiring the module:
// requiring it executes the library, and a syntax error mid-release would surface
// as a confusing stack trace from this helper instead of from the lint gate.
function readLibVersion() {
  const src = fs.readFileSync(path.join(ROOT, VERSION_FILES.lib), 'utf8');
  const m = /\bVERSION\s*=\s*'([^']+)'/.exec(src);
  return m ? m[1] : null;
}

function readVersions() {
  return {
    root: readJson(VERSION_FILES.root).version,
    pkg: readJson(VERSION_FILES.pkg).version,
    lib: readLibVersion()
  };
}

// The published package name, read rather than hardcoded so renaming or scoping
// the npm package never requires touching the release tooling.
function packageName() {
  return readJson(VERSION_FILES.pkg).name;
}

// Assert all three agree, and return the version. The error names every surface
// and its value, because "version mismatch" alone means opening three files.
function requireVersionsAgree() {
  const v = readVersions();
  if (v.root !== v.pkg || v.pkg !== v.lib) {
    fail(
      'Version mismatch across the three surfaces:\n' +
      '    ' + VERSION_FILES.root + ': ' + v.root + '\n' +
      '    ' + VERSION_FILES.pkg + ':  ' + v.pkg + '\n' +
      '    ' + VERSION_FILES.lib + ':     ' + v.lib + '\n' +
      '  All three must match before releasing.'
    );
  }
  return v.root;
}

// Write a new version into all three surfaces at once. Targeted replacements,
// not a JSON round-trip: rewriting package.json through JSON.stringify would
// reformat the whole file and bury the one-line change in noise.
function writeVersion(next) {
  for (const rel of [VERSION_FILES.root, VERSION_FILES.pkg]) {
    const p = path.join(ROOT, rel);
    const text = fs.readFileSync(p, 'utf8');
    const updated = text.replace(/("version"\s*:\s*")[^"]+(")/, '$1' + next + '$2');
    if (updated === text) fail('Could not find a "version" field to update in ' + rel);
    fs.writeFileSync(p, updated);
  }

  const libPath = path.join(ROOT, VERSION_FILES.lib);
  const libText = fs.readFileSync(libPath, 'utf8');
  const libUpdated = libText.replace(/(\bVERSION\s*=\s*')[^']+(')/, '$1' + next + '$2');
  if (libUpdated === libText) fail('Could not find the VERSION constant in ' + VERSION_FILES.lib);
  fs.writeFileSync(libPath, libUpdated);
}

// ---------------------------------------------------------------------------
// Version surfaces this tool does NOT write
// ---------------------------------------------------------------------------
// VERSION_FILES above is the set writeVersion() updates. It is not the set the
// repo CONTAINS. v0.5.2 failed at the gates because src/js/README.md carries a
// `version: '0.5.1'` example that tests/wire.test.js asserts against, and six
// further files -- three of them generated reports -- still claimed 0.5.1 and
// would have shipped inside a release announcing itself as the previous version.
//
// A bare substring scan is useless for catching that: design docs legitimately
// discuss past releases, and `0.5.0` appears ~28 times in prose that is correct
// as written. What breaks a release is narrower -- a line that CLAIMS TO BE
// CURRENT while naming the wrong version. Those have recognisable shapes, and
// all ten stale files at the 0.5.2 cut match one of them:
//
//   version: '0.5.1'                          src/js/README.md   (the blocker)
//   Status: ... v0.5.1.                       dev/symbol-layers.md
//   ... (current: 0.5.1)                      dev/wire-format.md
//   Current for **spab 0.5.1, wire format**   docs/glossary.md
//   *Version-stamped: spab 0.5.1              r_and_d/docs/prior-art...
//   spab 0.5.1. Generated by ...              r_and_d/reports/*.md
//   local:0.5.1 (wire v2)                     r_and_d/reports/comparisons.md
function currencyClaimPatterns(v) {
  const V = v.replace(/\./g, '\\.');
  return [
    new RegExp("version\\s*[:=]\\s*['\"]?v?" + V + "\\b", 'i'),
    new RegExp("\\bcurrent[^\\n]{0,40}\\bv?" + V + "\\b", 'i'),
    new RegExp("\\bStatus:[^\\n]{0,80}\\bv?" + V + "\\b", 'i'),
    new RegExp("Version-stamped[^\\n]{0,40}" + V + "\\b", 'i'),
    new RegExp("\\bspab\\s+v?" + V + "\\b[^\\n]{0,60}Generated by", 'i'),
    new RegExp("\\blocal:\\s*v?" + V + "\\b", 'i')
  ];
}

// CHANGELOG names every past release by design; tests/ hold version strings as
// fixture data plus one deliberate assertion against a known-old value; a dated
// review is a snapshot, not a live doc; this file documents the patterns using
// real examples.
const STALE_VERSION_ALLOW = [
  /^CHANGELOG\.md$/,
  /^tests\//,
  /^tools\/release-common\.js$/,
  /^dev\/spab_[\d.]+_review\.md$/
];
const TEXT_FILE = /\.(js|mjs|cjs|md|json|html|css|ya?ml|txt|toml)$/;

// Two different kinds of stale, with two different consequences.
//
// RELEASE-CRITICAL surfaces are part of the shipped software and CI asserts
// against them -- src/js/README.md's version example is the one that failed the
// 0.5.2 gates. A release cannot proceed with these wrong.
//
// RESEARCH ARTIFACTS are benchmark output: they exist to measure spab during
// development, not to gate a release. Regenerating them costs ~15 minutes and
// they carry no CI assertion, so a stale report must never block shipping. The
// caller is offered the choice instead.
const RESEARCH_ARTIFACT = [/^r_and_d\/reports\//, /^pages\/data\//];

function isResearchArtifact(rel) {
  return RESEARCH_ARTIFACT.some(function (re) { return re.test(rel); });
}

// Split findStaleVersions() output into { blocking, research }.
function classifyStale(hits) {
  const blocking = [], research = [];
  for (const h of hits) (isResearchArtifact(h.file) ? research : blocking).push(h);
  return { blocking: blocking, research: research };
}

function findStaleVersions(oldVersion) {
  if (!oldVersion) return [];
  const pats = currencyClaimPatterns(oldVersion);
  const files = runQuiet('git ls-files').split('\n').filter(Boolean);
  const hits = [];
  for (const rel of files) {
    if (STALE_VERSION_ALLOW.some(function (re) { return re.test(rel); })) continue;
    // Text formats only. A chance byte match inside a PNG would block a release
    // for nothing, so binaries are never opened.
    if (!TEXT_FILE.test(rel)) continue;
    let text;
    try { text = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (e) { continue; }
    if (text.indexOf(oldVersion) === -1) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (pats.some(function (re) { return re.test(lines[i]); })) {
        hits.push({ file: rel, line: i + 1, text: lines[i].trim().slice(0, 96) });
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Squash-merge orphan guard
// ---------------------------------------------------------------------------
// This repo is squash-only, so a merged branch's commits are never ancestors of
// main. Keep working on that branch and the next PR proposes re-applying merged
// history, which conflicts against everything it touched. PR #17 and PR #19 both
// stalled on exactly this, each costing more time than the work it carried.
function mergedPrForBranch(branch) {
  const raw = tryQuiet('gh pr list --state merged --head ' + branch +
    ' --json number,mergeCommit,title --jq \'.[0] | "\\(.number)\\t\\(.mergeCommit.oid)\\t\\(.title)"\'');
  if (!raw) return null;
  const parts = raw.split('\t');
  // An empty result set renders as the literal string "null" through jq, not as
  // empty output. Without this, every branch looks like it has a merged PR #null.
  if (!parts[0] || parts[0] === 'null') return null;
  return { number: parts[0], mergeCommit: parts[1], title: parts[2] || '' };
}

// Arming auto-merge proves nothing. GitHub accepts the request on a PR that can
// never merge and then waits forever, raising no error -- release.js used to
// exit 0 in exactly that state. Same shape as the STATUS_RANK bug in the codec:
// a success path that never checked what determines the outcome.
//
// The subtlety: right after a push GitHub has not finished computing
// mergeability and reports UNKNOWN, so a single probe passes on a PR about to
// resolve to CONFLICTING. Poll for a real answer; treat persistent UNKNOWN as
// unverified rather than as success.
function prMergeState(number) {
  const raw = tryQuiet('gh pr view ' + number +
    ' --json mergeable,mergeStateStatus --jq \'"\\(.mergeable)/\\(.mergeStateStatus)"\'');
  return raw || 'UNKNOWN/UNKNOWN';
}

function waitForMergeState(number, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 60000);
  let state = prMergeState(number);
  while (state.indexOf('UNKNOWN') === 0 && Date.now() < deadline) {
    // execSync sleep: this file has no async plumbing, and adding it for one
    // poll loop would spread through every caller.
    try { require('child_process').execSync('sleep 3'); } catch (e) { break; }
    state = prMergeState(number);
  }
  return state;
}

// semver bump. Deliberately minimal — spab has no pre-release or build-metadata
// versions, so supporting them would be untested code guarding a case that
// cannot occur. A non-plain version is rejected loudly instead.
function bumpVersion(current, level) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!m) fail('Version "' + current + '" is not a plain x.y.z — bump it by hand.');
  let [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (level === 'major') { major += 1; minor = 0; patch = 0; }
  else if (level === 'minor') { minor += 1; patch = 0; }
  else if (level === 'patch') { patch += 1; }
  else fail('Unknown bump level "' + level + '" (expected patch, minor, or major).');
  return major + '.' + minor + '.' + patch;
}

// ── CHANGELOG ───────────────────────────────────────────────────────────
//
// Keep a Changelog format: "## [x.y.z] — date" sections, newest first, with an
// "## [Unreleased]" section on top collecting work in flight. The release
// workflows extract notes from these sections, so the shape matters.

const CHANGELOG = 'CHANGELOG.md';

function readChangelog() {
  return fs.readFileSync(path.join(ROOT, CHANGELOG), 'utf8');
}

// Everything under "## [x.y.z]" up to the next "## [" heading.
function changelogSection(version) {
  const lines = readChangelog().split('\n');
  const head = new RegExp('^## \\[' + version.replace(/\./g, '\\.') + '\\]');
  const start = lines.findIndex(function (l) { return head.test(l); });
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(function (l) { return /^## \[/.test(l); });
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
}

// Turn "## [Unreleased]" into "## [x.y.z] — YYYY-MM-DD" and open a fresh, empty
// Unreleased section above it. This is what makes a version bump also a release:
// release-on-bump.yml reads the [x.y.z] section for the GitHub Release body, and
// an empty section there produces a release with no notes.
function promoteUnreleased(version, dateStr) {
  const p = path.join(ROOT, CHANGELOG);
  const text = fs.readFileSync(p, 'utf8');
  if (!/^## \[Unreleased\]/m.test(text)) {
    fail('CHANGELOG.md has no "## [Unreleased]" section to promote.');
  }
  const updated = text.replace(
    /^## \[Unreleased\][^\n]*$/m,
    '## [Unreleased]\n\n## [' + version + '] — ' + dateStr
  );
  fs.writeFileSync(p, updated);
}

// A commit subject drawn from the version's CHANGELOG section: the first
// sentence of its first prose line. Headings, bullets, quotes, and code fences
// are skipped — they read as fragments when used as a git subject.
function subjectFromChangelog(section) {
  const isProse = function (l) {
    if (l === '' || /^\s/.test(l)) return false;
    return !/^[#\-*>|`]/.test(l) && l.charAt(0) !== '<';
  };
  const lines = section.split('\n');
  let i = lines.findIndex(isProse);
  if (i === -1) return '';

  // Take the whole paragraph: prose wraps across lines in this file, so a single
  // line usually stops mid-clause with no period to cut at.
  const block = [];
  while (i < lines.length && isProse(lines[i])) { block.push(lines[i].trim()); i += 1; }

  let s = block.join(' ').replace(/\s+/g, ' ');
  return trimSubject(firstSentence(s));
}

// spab's CHANGELOG sections are pure bullet lists under "### Added"/"### Changed"
// headings — there is usually no prose line at all, so the paragraph rule above
// finds nothing. Bullets here are written as "- **Short lead-in.** Detail...",
// and that bold lead-in is exactly the summary a subject wants. Falling back to
// it is what makes the derived subject useful in practice rather than always
// dropping through to the branch name.
function subjectFromFirstBullet(section) {
  const bullet = section.split('\n').find(function (l) { return /^[-*]\s+\S/.test(l); });
  if (!bullet) return '';
  const body = bullet.replace(/^[-*]\s+/, '').trim();
  const bold = /^\*\*(.+?)\*\*/.exec(body);
  const text = bold ? bold[1] : body;
  return trimSubject(firstSentence(text.replace(/\*\*/g, '')));
}

// First sentence: everything up to a period followed by whitespace or end.
// A markdown link's URL can contain a period, so strip markdown BEFORE looking
// for the sentence end — otherwise "(dev/wire-format.md)" ends the sentence.
function firstSentence(s) {
  const plain = stripMarkdown(s);
  const stop = plain.search(/\.(\s|$)/);
  return (stop === -1 ? plain : plain.slice(0, stop)).trim();
}

// A subject line is prose, not markup: a title reading "specified in [`dev/wire-
// format.md`](dev/wire-format.md)" is worse than useless, and the backticks are
// what made it dangerous when it was spliced into a shell. Reduce links to their
// text and drop the inline emphasis markers.
function stripMarkdown(s) {
  return s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')   // [text](url) -> text
    .replace(/`([^`]*)`/g, '$1')               // `code` -> code
    .replace(/\*\*|__|\*|_/g, '')               // emphasis markers
    .replace(/\s+/g, ' ')
    .trim();
}

// Keep a git subject to a length that displays in `git log --oneline`, cutting at
// a word boundary. Slicing mid-token produced "[`dev/wire-fo..." — unreadable, and
// with an unbalanced backtick that the shell then tried to interpret.
function trimSubject(s) {
  if (s.length <= 65) return s;
  const cut = s.slice(0, 62);
  const sp = cut.lastIndexOf(' ');
  return (sp > 20 ? cut.slice(0, sp) : cut).trimEnd() + '...';
}

// Best available subject for a version: prose first, then the first bullet's
// bold lead-in. Empty when the section has neither, and the caller falls back.
function subjectForVersion(version) {
  const section = changelogSection(version);
  if (!section) return '';
  return subjectFromChangelog(section) || subjectFromFirstBullet(section);
}

// ── Git state ───────────────────────────────────────────────────────────

function currentBranch() {
  return runQuiet('git rev-parse --abbrev-ref HEAD');
}

// Uncommitted changes, ignoring untracked files under r_and_d/ (scratch
// experiments live there and should never block a release).
function dirtyFiles() {
  return runQuiet('git status --porcelain')
    .split('\n')
    .filter(function (l) { return l.trim() !== ''; })
    .filter(function (l) { return !/^\?\? r_and_d\//.test(l.trim()); });
}

function requireCleanTree() {
  const dirty = dirtyFiles();
  if (dirty.length > 0) {
    fail('Working tree has uncommitted changes:\n    ' + dirty.join('\n    '));
  }
}

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

module.exports = {
  ROOT,
  VERSION_FILES,
  CHANGELOG,
  run,
  runArgs,
  runQuiet,
  tryQuiet,
  fail,
  step,
  ok,
  skipped,
  askLine,
  askChoice,
  askYesNo,
  readVersions,
  packageName,
  requireVersionsAgree,
  writeVersion,
  bumpVersion,
  findStaleVersions,
  classifyStale,
  isResearchArtifact,
  mergedPrForBranch,
  prMergeState,
  waitForMergeState,
  changelogSection,
  promoteUnreleased,
  subjectFromChangelog,
  subjectFromFirstBullet,
  subjectForVersion,
  currentBranch,
  dirtyFiles,
  requireCleanTree,
  slugify
};
