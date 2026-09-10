#!/usr/bin/env node
/*
 * start-release.js — open a release cycle: bump the version, promote the
 * CHANGELOG, and put both on a fresh branch.
 *
 * WHY THIS IS SEPARATE FROM ORDINARY WORK
 *
 * In spab a version bump IS the release trigger: release-on-bump.yml watches
 * main, and the moment CI goes green on a commit whose package.json version has
 * no matching tag, it tags that commit and cuts the GitHub Release. So bumping
 * the version is not bookkeeping you do alongside a feature — it is the act of
 * shipping, and it deserves its own branch and its own PR.
 *
 * That is the split this tool encodes:
 *
 *   feat/… fix/… ci/…     ordinary work. Never touches a version. Merging it
 *                         to main changes nothing about releases.
 *   release/vX.Y.Z        created here. Contains the bump and the CHANGELOG
 *                         promotion and nothing else. Merging it ships.
 *
 * You choose the level; this script never picks a version on its own.
 *
 * USAGE
 *   npm run start-release -- patch          # 0.4.0 -> 0.4.1
 *   npm run start-release -- minor          # 0.4.0 -> 0.5.0
 *   npm run start-release -- major          # 0.4.0 -> 1.0.0
 *   npm run start-release -- minor --dry-run
 *
 * WHAT IT DOES
 *   1. Verifies you are the maintainer (see tools/gh-identity.js)
 *   2. Refuses unless you are on a clean main, in sync with origin
 *   3. Writes the new version to all three version surfaces
 *   4. Rewrites CHANGELOG "## [Unreleased]" as "## [x.y.z] — <today>" and
 *      opens a fresh empty Unreleased above it
 *   5. Creates release/vX.Y.Z and commits the result
 *
 * Then: review the diff and run `npm run release`.
 */
'use strict';

const c = require('./release-common.js');
const { requireIdentity } = require('./gh-identity.js');

const argv = process.argv.slice(2);
const DRY_RUN = argv.indexOf('--dry-run') !== -1 || argv.indexOf('-n') !== -1;
const LEVELS = ['patch', 'minor', 'major'];

function usage() {
  console.log([
    '',
    'start-release.js — begin a release cycle (bump + CHANGELOG + branch).',
    '',
    'Usage:',
    '  npm run start-release -- <patch|minor|major> [--dry-run]',
    '',
    'Examples:',
    '  npm run start-release -- patch      bug fixes only',
    '  npm run start-release -- minor      new features, backward compatible',
    '  npm run start-release -- major      breaking wire-format or API change',
    '  npm run start-release -- minor -n   show what would happen, change nothing',
    '',
    'Creates release/vX.Y.Z off main with the version bumped in:',
    '  package.json, src/js/package.json, src/js/spab.js (VERSION)',
    'and the CHANGELOG [Unreleased] section promoted to [X.Y.Z].',
    '',
    'Next step: npm run release',
    ''
  ].join('\n'));
}

if (argv.length === 0 || argv.indexOf('--help') !== -1 || argv.indexOf('-h') !== -1) {
  usage();
  process.exit(argv.length === 0 ? 1 : 0);
}

const level = argv.find(function (a) { return LEVELS.indexOf(a) !== -1; });
if (!level) {
  console.error('\n✗ Missing bump level. Expected one of: ' + LEVELS.join(', ') + '\n');
  usage();
  process.exit(1);
}

// ── 1. Identity ─────────────────────────────────────────────────────────

c.step('1. Identity');
requireIdentity({});

// ── 2. Preflight ────────────────────────────────────────────────────────

c.step('2. Preflight');

if (DRY_RUN) console.log('  *** DRY RUN — nothing will be written, committed, or pushed ***');

const branch = c.currentBranch();
if (branch !== 'main') {
  c.fail('Release cycles start from main (you are on "' + branch + '").\n' +
    '  git checkout main && git pull --ff-only');
}
c.ok('on main');

c.requireCleanTree();
c.ok('working tree clean');

// Being behind origin means bumping from a stale base: the release would ship
// without commits that are already on main.
c.run('git fetch origin main --quiet');
const behind = c.runQuiet('git rev-list --count HEAD..origin/main');
if (behind !== '0') {
  c.fail('Local main is ' + behind + ' commit(s) behind origin/main.\n' +
    '  git pull --ff-only');
}
c.ok('in sync with origin/main');

const current = c.requireVersionsAgree();
c.ok('all three version surfaces agree at ' + current);

const next = c.bumpVersion(current, level);

// A tag for the target version means it already shipped — bumping into it would
// produce a release-on-bump run that finds an existing tag and silently does
// nothing, which looks like a broken pipeline rather than a repeated version.
if (c.tryQuiet('git rev-parse -q --verify refs/tags/v' + next) !== null) {
  c.fail('Tag v' + next + ' already exists — that version has shipped.');
}
c.ok('v' + next + ' is unused');

// ── 3. Confirm ──────────────────────────────────────────────────────────

c.step('3. Confirm');

console.log('\n  ' + current + '  →  ' + next + '   (' + level + ')');
console.log('  branch: release/v' + next + '\n');

if (!DRY_RUN && argv.indexOf('--yes') === -1) {
  if (!c.askYesNo('  Start this release cycle? (y/n) ')) {
    console.log('\n  Stopped. Nothing changed.\n');
    process.exit(0);
  }
}

// ── 4. Apply ────────────────────────────────────────────────────────────

c.step('4. Bump and branch');

const branchName = 'release/v' + next;
// Local date, not UTC: the CHANGELOG is read by humans in the maintainer's
// timezone, and an entry dated "tomorrow" reads as a mistake.
const today = new Date();
const dateStr = today.getFullYear() + '-' +
  String(today.getMonth() + 1).padStart(2, '0') + '-' +
  String(today.getDate()).padStart(2, '0');

if (DRY_RUN) {
  c.skipped('write version ' + next + ' to the three version surfaces');
  c.skipped('promote CHANGELOG [Unreleased] -> [' + next + '] — ' + dateStr);
  c.skipped('git checkout -b ' + branchName);
  c.skipped('git commit -m "chore(release): v' + next + '"');
  console.log('\n  Dry run complete. Re-run without --dry-run to apply.\n');
  process.exit(0);
}

c.run('git checkout -b ' + branchName);

c.writeVersion(next);
c.ok('version written to all three surfaces');

// Every version surface the tooling does NOT write.
//
// writeVersion() updates three files; the repo contains more. v0.5.2 failed at
// the gates because src/js/README.md carries a version string inside a
// SPAB.version() example that tests/wire.test.js asserts against.
//
// Not all stale surfaces are equal, though. Research reports under
// r_and_d/reports/ and pages/data/ are benchmark output for spab DEVELOPMENT --
// no CI job asserts on them, and regenerating costs ~15 minutes. They must not
// block a release; they are offered instead.
const staleAll = c.findStaleVersions(current);
const split = c.classifyStale(staleAll);

if (split.blocking.length) {
  console.log('');
  console.log('  ' + split.blocking.length + ' release-critical file(s) still claim to be ' + current + ':');
  for (const h of split.blocking) console.log('    ' + h.file + ':' + h.line + '  ' + h.text);
  console.log('');
  c.fail(
    'Version surfaces left behind.\n' +
    '  These are currency claims, not history -- each says it describes the CURRENT\n' +
    '  release while naming ' + current + '. Update them to ' + next + ' and re-run.'
  );
}
c.ok('no release-critical file still claims to be ' + current);

if (split.research.length) {
  console.log('');
  console.log('  ' + split.research.length + ' research artifact(s) still stamped ' + current + ':');
  const seen = {};
  for (const h of split.research) {
    if (seen[h.file]) continue;
    seen[h.file] = 1;
    console.log('    ' + h.file);
  }
  console.log('');
  console.log('  These are development benchmarks, not release gates -- nothing in CI');
  console.log('  asserts on them, and the release ships either way.');
  console.log('');
  const regen = (!DRY_RUN && argv.indexOf('--yes') === -1)
    ? c.askYesNo('  Run full research report updates now? (~15 min) (y/n) ')
    : false;
  if (regen) {
    c.run('npm run benchmark');
    c.run('npm run capacity');
    c.run('npm run comparisons');
    c.ok('research reports regenerated');
  } else {
    c.skipped('research report regeneration -- reports still say ' + current);
    console.log('    Refresh later with: npm run benchmark && npm run capacity && npm run comparisons');
  }
}

c.promoteUnreleased(next, dateStr);
c.ok('CHANGELOG [Unreleased] promoted to [' + next + '] — ' + dateStr);

c.run('git add ' + c.VERSION_FILES.root + ' ' + c.VERSION_FILES.pkg + ' ' +
  c.VERSION_FILES.lib + ' ' + c.CHANGELOG);
c.run('git commit -m "chore(release): v' + next + '"');

// ── Done ────────────────────────────────────────────────────────────────

c.step('Ready');

console.log([
  '',
  '  Branch:  ' + branchName,
  '  Version: ' + current + ' -> ' + next,
  '',
  '  Next:',
  '    1. Check the CHANGELOG [' + next + '] section reads well — it becomes',
  '       the GitHub Release notes verbatim.',
  '    2. npm run release        run every gate, open the PR, auto-merge on green',
  '',
  '  Nothing has been pushed yet.',
  ''
].join('\n'));
