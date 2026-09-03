#!/usr/bin/env node
/*
 * release.js — run every gate locally, then open the PR and let CI finish.
 *
 * WHERE THE AUTHORITY LIVES
 *
 * This script does NOT merge anything, and it cannot push to main — branch
 * protection on main requires a pull request with four green checks, and it
 * applies to admins too. That is deliberate. The server-side rule is the real
 * gate; this script exists so you find out on your laptop in thirty seconds
 * instead of in Actions five minutes later.
 *
 * So the pipeline is:
 *
 *   npm run release  ─┬─ identity, preflight, every gate (blocking)
 *                     ├─ push the branch
 *                     ├─ open a PR
 *                     └─ enable auto-merge (squash)
 *                              │
 *   GitHub Actions ────────────┴─ CI runs on the PR
 *                                 auto-merge lands it when checks are green
 *                                 release-on-bump.yml tags + releases if the
 *                                 merged commit carried a version bump
 *
 * RELEASE MODE vs ORDINARY PR
 *
 * The script notices whether the branch changes the version relative to
 * origin/main. If it does, this PR will ship a release the moment it merges, so
 * the extra release-only gates apply (CHANGELOG section must exist and be
 * non-empty, tag must be free, version must not already be on npm). If it does
 * not, it is an ordinary PR and those gates are skipped.
 *
 * USAGE
 *   npm run release                 gates, push, PR, auto-merge
 *   npm run release:dry             every gate, zero mutations
 *   npm run release -- --no-auto    open the PR but do not enable auto-merge
 *   npm run release -- --yes        no prompts (for scripted runs)
 *   npm run release -- --help
 *
 * Fuzz and coverage run BLOCKING here even though ci.yml still runs them
 * report-only. Locally they are cheap and deterministic, so there is no reason
 * to let a regression through; in CI they stay advisory until they have proven
 * stable across the matrix. Strict where it is free, lenient where it is not.
 */
'use strict';

const c = require('./release-common.js');
const { requireIdentity } = require('./gh-identity.js');

const argv = process.argv.slice(2);
const DRY_RUN = argv.indexOf('--dry-run') !== -1 || argv.indexOf('-n') !== -1;
const NO_AUTO = argv.indexOf('--no-auto') !== -1;
const YES = argv.indexOf('--yes') !== -1 || argv.indexOf('-y') !== -1;

// Explicit PR title. The derived title is fine for a release (it comes from the
// CHANGELOG) but weak for an ordinary PR, where all it has to work with is the
// branch name — "ci/setup-and-ci" becomes "ci: setup and ci", which tells a
// reader nothing. Accept both `--title X` and `--title=X`.
const TITLE_ARG = (function () {
  const eq = argv.find(function (a) { return a.indexOf('--title=') === 0; });
  if (eq) return eq.slice('--title='.length).trim();
  const i = argv.indexOf('--title');
  if (i !== -1 && argv[i + 1]) return argv[i + 1].trim();
  return '';
})();

if (argv.indexOf('--help') !== -1 || argv.indexOf('-h') !== -1) {
  console.log([
    '',
    'release.js — run all gates, push the branch, open the PR.',
    '',
    'Usage:',
    '  npm run release                gates, push, PR, enable auto-merge',
    '  npm run release:dry            run every gate, mutate nothing',
    '  npm run release -- --no-auto   open the PR without auto-merge',
    '  npm run release -- --yes       skip confirmation prompts',
    '  npm run release -- --title "…"  set the PR title explicitly',
    '',
    'Gates (all blocking):',
    '  identity      gh + git + ssh must all be the maintainer',
    '  clean tree    no uncommitted changes',
    '  not on main   main is protected; work happens on a branch',
    '  versions      package.json / src/js/package.json / spab.js agree',
    '  lint          npm run lint',
    '  tests         npm test  (roundtrip + branches)',
    '  smokes        harness + symbol-survival',
    '  fuzz          npm run fuzz',
    '  coverage      npm run coverage:strict  (100% branches)',
    '',
    'Extra gates when the branch bumps the version (release mode):',
    '  CHANGELOG has a non-empty section for the version',
    '  the git tag for that version does not exist yet',
    '  that version is not already published to npm',
    '',
    'This script never pushes to main and never merges. Branch protection',
    'and CI decide; auto-merge lands the PR when the checks go green.',
    ''
  ].join('\n'));
  process.exit(0);
}

// ── 1. Identity ─────────────────────────────────────────────────────────

c.step('1. Identity');
requireIdentity({});

// ── 2. Preflight ────────────────────────────────────────────────────────

c.step('2. Preflight');

if (DRY_RUN) console.log('  *** DRY RUN — every gate runs, nothing is pushed ***');

const branch = c.currentBranch();
if (branch === 'main' || branch === 'master') {
  c.fail('Cannot release from ' + branch + '.\n' +
    '  main is protected — work happens on a branch and lands by PR.\n' +
    '  For a release: npm run start-release -- <patch|minor|major>');
}
c.ok('on branch ' + branch);

c.requireCleanTree();
c.ok('working tree clean');

const version = c.requireVersionsAgree();
c.ok('version surfaces agree at ' + version);

// Is this a release? Compare against origin/main rather than a local ref: local
// main can be stale, and the question that matters is what merging this branch
// would change on the remote trunk.
c.run('git fetch origin main --quiet');
const mainVersion = (function () {
  const raw = c.tryQuiet('git show origin/main:package.json');
  if (raw === null) return null;
  try { return JSON.parse(raw).version; } catch (e) { return null; }
})();

const RELEASE_MODE = mainVersion !== null && mainVersion !== version;

if (RELEASE_MODE) {
  console.log('  release mode: merging this PR ships v' + version +
    ' (origin/main is at ' + mainVersion + ')');
} else {
  console.log('  ordinary PR: version unchanged at ' + version + ' — no release on merge');
}

// ── 3. Release-only gates ───────────────────────────────────────────────

if (RELEASE_MODE) {
  c.step('3. Release gates');

  const section = c.changelogSection(version);
  if (!section) {
    c.fail('CHANGELOG.md has no "## [' + version + ']" section.\n' +
      '  release-on-bump.yml uses it as the GitHub Release body.');
  }
  if (section.replace(/\s/g, '') === '') {
    c.fail('The CHANGELOG section for ' + version + ' is empty.\n' +
      '  The release would publish with no notes.');
  }
  c.ok('CHANGELOG [' + version + '] has ' + section.split('\n').length + ' lines');

  if (c.tryQuiet('git rev-parse -q --verify refs/tags/v' + version) !== null) {
    c.fail('Tag v' + version + ' already exists — that version shipped.');
  }
  c.ok('tag v' + version + ' is free');

  // npm is checked but never fatal on its own terms: publish.yml only publishes
  // when NPM_TOKEN is set, so an unpublished package is the normal state today.
  // A version that IS already on npm, though, means the bump is a repeat.
  const name = c.packageName();
  const published = c.tryQuiet('npm view ' + name + '@' + version + ' version');
  if (published === version) {
    c.fail(name + '@' + version + ' is already published on npm.\n' +
      '  Bump again: npm run start-release -- patch');
  }
  c.ok(name + '@' + version + ' is not on npm yet');
} else {
  c.step('3. Release gates (skipped — not a version bump)');
}

// ── 4. Gates ────────────────────────────────────────────────────────────
//
// Same commands CI runs, plus the two CI currently runs report-only. Running
// `npm run ci` rather than re-listing its parts keeps one definition of "the
// gate" — if ci.yml and this script drifted, the local run would stop meaning
// anything.

c.step('4. Lint, tests, smokes');
c.run('npm run ci');
c.ok('lint + conformance + branch tests + smokes');

c.step('5. Fuzz (blocking here, report-only in CI)');
c.run('npm run fuzz');
c.ok('fuzz clean');

c.step('6. Coverage (blocking here, report-only in CI)');
c.run('npm run coverage:strict');
c.ok('coverage thresholds met');

// ── 7. The PR ───────────────────────────────────────────────────────────

c.step('7. Pull request');

// Subject: the CHANGELOG's own words when there are any, else the branch name.
// The branch name is a poor summary, so it is the last resort rather than the
// default — a PR titled "ci setup and ci" tells a reader nothing.
const changelogSubject = RELEASE_MODE ? c.subjectForVersion(version) : '';
let title;
if (TITLE_ARG) {
  title = TITLE_ARG;
} else if (RELEASE_MODE) {
  title = 'release: v' + version + (changelogSubject ? ' — ' + changelogSubject : '');
} else {
  title = branch.replace(/^[a-z]+\//, '').replace(/[-_]/g, ' ');
  title = branch.split('/')[0] + ': ' + title;
}

const body = RELEASE_MODE
  ? ['Cuts **v' + version + '**.', '',
    'Merging this tags `v' + version + '` and publishes the GitHub Release from',
    'the CHANGELOG section below (via `release-on-bump.yml`).', '',
    '---', '', c.changelogSection(version)].join('\n')
  : ['Opened by `npm run release`.', '',
    'All local gates passed: lint, conformance + branch tests, smokes, fuzz,',
    'and strict coverage. No version change, so merging does not cut a release.'].join('\n');

console.log('\n  Title: ' + title);
console.log('  Mode:  ' + (RELEASE_MODE ? 'release (ships v' + version + ')' : 'ordinary PR'));
console.log('  Auto:  ' + (NO_AUTO ? 'off (merge by hand)' : 'on (squash when green)') + '\n');

if (DRY_RUN) {
  c.skipped('git push -u origin ' + branch);
  c.skipped('gh pr create --title "' + title + '"');
  if (!NO_AUTO) c.skipped('gh pr merge --squash --auto');
  c.step('Dry run complete');
  console.log('\n  Every gate passed. Nothing was pushed.\n' +
    '  When ready:  npm run release\n');
  process.exit(0);
}

if (!YES && !c.askYesNo('  Push and open the PR? (y/n) ')) {
  console.log('\n  Stopped. Nothing was pushed.\n');
  process.exit(0);
}

c.run('git push -u origin ' + branch);

// An existing PR for this branch is reused rather than treated as an error:
// re-running after a failed gate is the common case, and it should update the
// PR, not refuse.
const existing = c.tryQuiet('gh pr view --json number --jq .number');
if (existing) {
  console.log('  PR #' + existing + ' already exists for this branch — updated by the push.');
} else {
  // Body via a file: it contains backticks and newlines, which do not survive
  // being spliced into a shell argument intact.
  const fs = require('fs');
  const path = require('path');
  const bodyPath = path.join(c.ROOT, '.git', 'SPAB_PR_BODY.md');
  fs.writeFileSync(bodyPath, body + '\n');
  c.run('gh pr create --base main --title ' + JSON.stringify(title) +
    ' --body-file ' + JSON.stringify(bodyPath));
}

if (!NO_AUTO) {
  // Auto-merge is a queued instruction, not an immediate merge: GitHub holds it
  // until every required check passes. If the repo has auto-merge disabled this
  // call fails, and that should not look like the release itself failed.
  try {
    c.run('gh pr merge --squash --auto');
    c.ok('auto-merge armed — lands when CI is green');
  } catch (e) {
    console.log('\n  ! Could not enable auto-merge. The PR is open and CI is running;');
    console.log('    merge it by hand once green, or enable auto-merge in repo settings.');
  }
}

// ── Done ────────────────────────────────────────────────────────────────

c.step('Done');

const prUrl = c.tryQuiet('gh pr view --json url --jq .url') || '(see GitHub)';

console.log([
  '',
  '  PR:      ' + prUrl,
  '  Branch:  ' + branch,
  '  Version: ' + version + (RELEASE_MODE ? '  (ships on merge)' : '  (unchanged)'),
  '',
  '  CI is running. ' + (NO_AUTO ? 'Merge when green.' : 'Auto-merge lands it when green.'),
  RELEASE_MODE
    ? '  Then release-on-bump.yml tags v' + version + ' and cuts the Release.'
    : '  No release will be cut — this PR does not change the version.',
  '',
  '  Watch: https://github.com/deftio/spab/actions',
  ''
].join('\n'));
