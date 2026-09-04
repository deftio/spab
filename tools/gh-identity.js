#!/usr/bin/env node
/*
 * gh-identity.js — refuse to run release tooling under the wrong identity.
 *
 * This machine has more than one GitHub account authenticated at once, and `gh`
 * has a single "active" one that is easy to leave switched after working on an
 * unrelated repo. Every mutating step in the release pipeline (push, PR, merge)
 * inherits that identity silently, so the failure mode is not an error — it is a
 * PR that opens under the wrong name, or a commit attributed to the wrong person.
 * By the time you notice, it is on GitHub.
 *
 * So: before anything mutates, assert that all three identities the pipeline
 * touches resolve to the maintainer, and bail with the exact fix if not.
 *
 *   1. `gh` active account   — who opens the PR and drives the merge
 *   2. git user.name/.email  — who the commits are attributed to
 *   3. the SSH key GitHub sees — who the push is authenticated as
 *
 * These are genuinely independent. `gh auth switch` does not touch git config,
 * and neither of them touches which SSH key ssh-agent offers first, so any one
 * can drift on its own.
 *
 * Usage:
 *   node tools/gh-identity.js          # check and report (exit 1 on mismatch)
 *   node tools/gh-identity.js --quiet  # print only on failure
 *   npm run whoami                     # same thing, friendlier name
 *
 * Escape hatch: SPAB_SKIP_IDENTITY=1 skips every check. It exists for CI and for
 * the rare "I know exactly what I am doing" case; it is deliberately loud.
 */
'use strict';

const { execFileSync, spawnSync } = require('child_process');

// ── Who is allowed to release ───────────────────────────────────────────
//
// Hardcoded rather than derived from the remote URL. Deriving it would silently
// accept whatever owner the remote happens to point at, which is precisely the
// mistake this file exists to catch (a fork, a renamed remote, a wrong clone).
// One maintainer, named once, checked literally.
const MAINTAINER = {
  login: 'deftio',              // GitHub account: gh's active account and the SSH key's owner
  gitName: 'deftio',            // git config user.name
  gitEmail: 'deftio@deftio.com' // git config user.email
};

// ── Small helpers ───────────────────────────────────────────────────────

// Run a command and return trimmed stdout, or null if it fails for any reason.
// Every probe here is allowed to fail (gh missing, no network, no git config),
// and each caller turns null into its own specific, actionable message.
function probe(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) {
    return null;
  }
}

function have(cmd) {
  return probe('sh', ['-c', 'command -v ' + cmd]) !== null;
}

// ── The three probes ────────────────────────────────────────────────────

// The account `gh` will act as. `gh api user` resolves the ACTIVE account's
// token, which is exactly what `gh pr create` would use — asking the API is more
// truthful than parsing `gh auth status`, whose format is not a contract.
function ghActiveLogin() {
  return probe('gh', ['api', 'user', '--jq', '.login']);
}

function gitConfig(key) {
  return probe('git', ['config', '--get', key]);
}

// Which GitHub user the SSH key resolves to.
//
// GitHub answers "Hi <login>! You've successfully authenticated, but GitHub does
// not provide shell access." and then closes the connection with EXIT CODE 1.
// That is the success case — treating a non-zero exit as failure here would make
// the check fire on every correct setup. So the exit status is ignored entirely
// and the greeting is parsed instead. BatchMode stops it prompting for a
// passphrase and hanging the release; ConnectTimeout bounds a dead network.
function sshLogin() {
  const r = spawnSync('ssh', [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=8',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-T', 'git@github.com'
  ], { encoding: 'utf8' });
  const text = (r.stdout || '') + (r.stderr || '');
  const m = /^Hi ([A-Za-z0-9-]+)!/m.exec(text);
  return m ? m[1] : null;
}

// Is `origin` an SSH remote? If the remote is HTTPS the SSH probe is irrelevant
// (the push authenticates with the gh token instead), so it is skipped rather
// than reported as a failure.
function originIsSsh() {
  const url = probe('git', ['remote', 'get-url', 'origin']) || '';
  return url.startsWith('git@') || url.startsWith('ssh://');
}

// ── The check ───────────────────────────────────────────────────────────
//
// Returns { ok, problems, found }. Collects EVERY problem rather than stopping
// at the first: if two identities have drifted, one run should tell you both
// instead of making you fix, re-run, and discover the next.
function checkIdentity() {
  const problems = [];
  const found = {};

  if (process.env.SPAB_SKIP_IDENTITY === '1') {
    return { ok: true, skipped: true, problems, found };
  }

  // 1. gh installed and authenticated as the maintainer.
  if (!have('gh')) {
    problems.push([
      'GitHub CLI (gh) is not installed — the release opens a PR with it.',
      '  brew install gh   (then: gh auth login)'
    ].join('\n'));
  } else {
    const login = ghActiveLogin();
    found.gh = login;
    if (login === null) {
      problems.push([
        'gh is installed but not authenticated (or the network is down).',
        '  gh auth login'
      ].join('\n'));
    } else if (login !== MAINTAINER.login) {
      problems.push([
        'gh is active as "' + login + '", not "' + MAINTAINER.login + '".',
        '  The PR would be opened by the wrong account.',
        '  gh auth switch --user ' + MAINTAINER.login
      ].join('\n'));
    }
  }

  // 2. git commit authorship.
  const name = gitConfig('user.name');
  const email = gitConfig('user.email');
  found.gitName = name;
  found.gitEmail = email;

  if (name !== MAINTAINER.gitName) {
    problems.push([
      'git user.name is ' + (name === null ? '(unset)' : '"' + name + '"') +
        ', not "' + MAINTAINER.gitName + '".',
      '  git config user.name "' + MAINTAINER.gitName + '"'
    ].join('\n'));
  }
  if (email !== MAINTAINER.gitEmail) {
    problems.push([
      'git user.email is ' + (email === null ? '(unset)' : '"' + email + '"') +
        ', not "' + MAINTAINER.gitEmail + '".',
      '  git config user.email "' + MAINTAINER.gitEmail + '"'
    ].join('\n'));
  }

  // 3. The SSH key GitHub sees, when the remote is SSH.
  if (originIsSsh()) {
    const ssh = sshLogin();
    found.ssh = ssh;
    if (ssh === null) {
      problems.push([
        'Could not confirm the SSH identity for git@github.com.',
        '  The push may fail or authenticate as the wrong user.',
        '  ssh -T git@github.com'
      ].join('\n'));
    } else if (ssh !== MAINTAINER.login) {
      problems.push([
        'SSH authenticates to GitHub as "' + ssh + '", not "' + MAINTAINER.login + '".',
        '  The push would go up as the wrong account.',
        '  Check the host block for github.com in ~/.ssh/config (IdentityFile / IdentitiesOnly).'
      ].join('\n'));
    }
  }

  return { ok: problems.length === 0, skipped: false, problems, found };
}

// Assert-or-exit wrapper used by the release scripts. Nothing has mutated yet
// when this runs, so exiting here is always safe.
function requireIdentity(opts) {
  const quiet = opts && opts.quiet;
  const res = checkIdentity();

  if (res.skipped) {
    console.log('  ! identity check SKIPPED (SPAB_SKIP_IDENTITY=1)');
    return res;
  }

  if (res.ok) {
    if (!quiet) {
      console.log('  identity: ' + MAINTAINER.login +
        ' (gh + git + ssh all agree)');
    }
    return res;
  }

  console.error('\n✗ WRONG GITHUB IDENTITY — nothing was pushed.\n');
  for (const p of res.problems) console.error('  • ' + p.replace(/\n/g, '\n  ') + '\n');
  console.error('  Release tooling only runs as "' + MAINTAINER.login + '".');
  console.error('  Re-run once the above is fixed, or set SPAB_SKIP_IDENTITY=1 to override.\n');
  process.exit(1);
}

module.exports = { MAINTAINER, checkIdentity, requireIdentity };

// ── Standalone ──────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log([
      '',
      'gh-identity.js — verify the active GitHub identity before releasing.',
      '',
      'Usage:',
      '  node tools/gh-identity.js           check and report',
      '  node tools/gh-identity.js --quiet   print only on failure',
      '  npm run whoami                      same, friendlier name',
      '',
      'Checks that all three of these resolve to "' + MAINTAINER.login + '":',
      '  gh active account   (who opens the PR)',
      '  git user.name/email (who the commits are from)',
      '  ssh key identity    (who the push is as)',
      '',
      'Exit code: 0 if every identity matches, 1 otherwise.',
      'SPAB_SKIP_IDENTITY=1 bypasses all checks.',
      ''
    ].join('\n'));
    process.exit(0);
  }

  const quiet = argv.includes('--quiet') || argv.includes('-q');
  const res = checkIdentity();

  if (res.ok) {
    if (!quiet) {
      console.log('');
      console.log('  gh   : ' + (res.found.gh || '(skipped)'));
      console.log('  git  : ' + res.found.gitName + ' <' + res.found.gitEmail + '>');
      console.log('  ssh  : ' + (res.found.ssh || '(not an ssh remote)'));
      console.log('');
      console.log('  ✓ identity is ' + MAINTAINER.login + ' — clear to release.');
      console.log('');
    }
    process.exit(0);
  }

  console.error('\n✗ identity mismatch:\n');
  for (const p of res.problems) console.error('  • ' + p.replace(/\n/g, '\n  ') + '\n');
  process.exit(1);
}
