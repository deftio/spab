#!/usr/bin/env node
/*
 * capacity.js — how big a secret fits in how much text?
 *
 * The robustness benchmark holds payload size roughly fixed and varies the channel.
 * This does the opposite: it sweeps cover size from tens of characters to a megabyte
 * against secrets from a few bytes to megabytes, and reports where the wall is.
 *
 * Two operating points, and the difference between them is the whole story:
 *
 *   substitution   Length-preserving. Swaps existing characters for visually
 *                  equivalent ones, so the marked document has EXACTLY the same
 *                  character count. Capacity is therefore fixed by the text: a
 *                  passage has however many inter-word gaps it has, and no
 *                  parameter can create more.
 *
 *   auto-grow      Inserts zero-width characters, so capacity is set by density
 *                  rather than by the text. Fits far larger secrets into small
 *                  covers — the StegCloak trade — at the cost of a document that is
 *                  no longer the same length in bytes and is obvious in a hex dump.
 *
 * Guarded on time. Large cells are genuinely expensive, and a benchmark that hangs
 * gets killed and reports nothing. Each cell has a budget; a cell that exceeds it is
 * reported as `slow` rather than being silently dropped or waited on, and once a row
 * blows the budget the larger secrets in that row are skipped as unreachable.
 *
 *   node r_and_d/capacity.js                 print the tables
 *   node r_and_d/capacity.js --md FILE       also write markdown
 *   node r_and_d/capacity.js --max-cover N   cap the largest cover (default 1000000)
 */
'use strict';

const SPAB = require('../src/js/spab.js');
const fs = require('fs');
const path = require('path');

const ARGV = process.argv.slice(2);
const MD_AT = ARGV.indexOf('--md');
const MD_PATH = MD_AT >= 0 ? ARGV[MD_AT + 1] : null;
const MC_AT = ARGV.indexOf('--max-cover');
const MAX_COVER = MC_AT >= 0 ? parseInt(ARGV[MC_AT + 1], 10) : 1000000;
const CELL_BUDGET_MS = 4000;

const out = [];
function say(s) { console.log(s); out.push(s); }
function table(headers, rows, aligns) {
  const w = headers.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i]).length)));
  const pad = (s, i) => (aligns && aligns[i] === 'r') ? String(s).padStart(w[i]) : String(s).padEnd(w[i]);
  say('| ' + headers.map(pad).join(' | ') + ' |');
  say('|' + w.map((n, i) => (aligns && aligns[i] === 'r' ? '-'.repeat(n + 1) + ':' : '-'.repeat(n + 2))).join('|') + '|');
  rows.forEach(r => say('| ' + r.map(pad).join(' | ') + ' |'));
  say('');
}
function human(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n % 1e3 ? 1 : 0) + 'K';
  return String(n);
}

// Ordinary English prose, so gap density matches real documents rather than a
// synthetic best case. Built once and sliced, so every cover size is the same text.
const SEED = 'The board reviewed the quarterly figures on Tuesday and asked for a re-forecast ' +
  'before the end of the month. Operating costs are down year-over-year, though the ' +
  "well-documented delays on the Hartley contract haven't yet worked through the numbers. " +
  'Finance will circulate a revised model on Friday and the committee will meet again. ';
let POOL = SEED;
while (POOL.length < MAX_COVER + SEED.length) POOL += SEED;
const cover = n => POOL.slice(0, n);

// An incompressible secret, so the table measures CAPACITY and not how well LZSS
// does on a repetitive string. A run of 'a' would compress to almost nothing and
// make every number look far better than it is.
let rs = 0x2545F491;
function secret(nBytes) {
  let s = '';
  for (let i = 0; i < nBytes; i++) {
    rs ^= rs << 13; rs >>>= 0; rs ^= rs >>> 17; rs ^= rs << 5; rs >>>= 0;
    s += String.fromCharCode(33 + (rs % 90));
  }
  return s;
}
const SECRETS = {};
function getSecret(n) { if (!SECRETS[n]) { rs = 0x2545F491; SECRETS[n] = secret(n); } return SECRETS[n]; }

const COVERS = [50, 200, 1000, 5000, 20000, 100000, 500000, 1000000].filter(n => n <= MAX_COVER);
const PAYLOADS = [4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576];

// Try one cell. Returns a verdict plus the numbers behind it.
function attempt(coverLen, payloadLen, params) {
  const c = cover(coverLen), msg = getSecret(payloadLen);
  const t0 = Date.now();
  let enc;
  try { enc = SPAB.encode(c, msg, params); }
  catch (e) { return { verdict: 'error', ms: Date.now() - t0, detail: e.message.slice(0, 40) }; }
  const encMs = Date.now() - t0;
  if (encMs > CELL_BUDGET_MS) return { verdict: 'slow', ms: encMs };
  const tooShort = (enc.metadata.issues || []).some(s => /too short/.test(s));
  if (tooShort) return { verdict: 'no fit', ms: encMs, cap: enc.metadata.capacityBits };
  const t1 = Date.now();
  const back = SPAB.decode(enc.text, params);
  const decMs = Date.now() - t1;
  if (back.message !== msg) return { verdict: 'lost', ms: encMs + decMs };
  return { verdict: 'ok', ms: encMs + decMs, encMs: encMs, decMs: decMs,
    reps: enc.metadata.reps, grew: enc.text.length - c.length, stored: enc.metadata.payloadBytes };
}

say('# spab channel capacity');
say('');
say('spab ' + SPAB.VERSION + '. Generated by `node r_and_d/capacity.js`.');
say('');
say('Cover text is ordinary English prose (gap density matches real documents). The');
say('secret is an **incompressible** random string — a repetitive one would compress');
say('to almost nothing and make every figure below look far better than it is.');
say('');
say('Cell budget ' + CELL_BUDGET_MS + 'ms; `slow` means the cell exceeded it and was not');
say('waited on, not that it is impossible.');
say('');

// ------------------------------------------------------ 1. length-preserving
say('## 1. Substitution carriers (length-preserving)');
say('');
say('The marked document has exactly the same character count as the original.');
say('Capacity is fixed by the text: a passage has the inter-word gaps it has.');
say('Cells show the redundancy achieved — `3x` means the payload fits three times,');
say('and redundancy is what survives editing.');
say('');
{
  const rows = COVERS.map(cl => {
    let dead = false;
    const cells = PAYLOADS.map(pl => {
      if (dead) return '·';
      const r = attempt(cl, pl, {});
      if (r.verdict === 'ok') return r.reps + 'x';
      if (r.verdict === 'slow') { dead = true; return 'slow'; }
      dead = true;                       // larger secrets cannot fit if this one did not
      return r.verdict === 'no fit' ? '—' : r.verdict;
    });
    return [human(cl)].concat(cells);
  });
  table(['cover chars'].concat(PAYLOADS.map(human)), rows,
    [null].concat(PAYLOADS.map(() => 'r')));
  say('`—` does not fit even once (reported by `metadata.issues`, never silently).');
  say('`·` not attempted: a smaller secret already failed in the same row.');
  say('');
}

// ---------------------------------------------------------------- 2. auto-grow
say('## 2. Auto-grow (inserts zero-width characters)');
say('');
say('Capacity is set by insertion density rather than by the text, so far larger');
say('secrets fit. The document is no longer the same byte length, and the inserted');
say('characters are plainly visible in a hex dump or a show-invisibles view.');
say('');
{
  const rows = COVERS.map(cl => {
    let dead = false;
    const cells = PAYLOADS.map(pl => {
      if (dead) return '·';
      const r = attempt(cl, pl, { autoGrow: true });
      if (r.verdict === 'ok') return r.reps + 'x';
      if (r.verdict === 'slow') { dead = true; return 'slow'; }
      dead = true;
      return r.verdict === 'no fit' ? '—' : r.verdict;
    });
    return [human(cl)].concat(cells);
  });
  table(['cover chars'].concat(PAYLOADS.map(human)), rows,
    [null].concat(PAYLOADS.map(() => 'r')));
}

// ------------------------------------------------------------- 3. what it costs
say('## 3. What auto-grow costs');
say('');
say('Byte expansion and time for the largest secret each cover could hold. This is');
say('the number to weigh against the extra capacity in table 2.');
say('');
{
  const rows = [];
  for (const cl of COVERS) {
    let best = null;
    for (const pl of PAYLOADS) {
      const r = attempt(cl, pl, { autoGrow: true });
      if (r.verdict === 'ok') best = { pl: pl, r: r }; else break;
    }
    if (!best) { rows.push([human(cl), '—', '—', '—', '—', '—']); continue; }
    const growth = best.r.grew / cl;
    rows.push([human(cl), human(best.pl) + 'B', best.r.reps + 'x',
      '+' + human(best.r.grew) + ' chars', (growth * 100).toFixed(0) + '%',
      best.r.encMs + '/' + best.r.decMs + ' ms']);
  }
  table(['cover chars', 'largest secret', 'copies', 'characters added', 'growth', 'encode/decode'],
    rows, [null, 'r', 'r', 'r', 'r', 'r']);
}

// ------------------------------------------------------------------- 4. the rate
say('## 4. The rate');
say('');
say('Bytes of secret per kilobyte of cover, at one copy, for each mode. This is the');
say('single number to quote when someone asks "how much can it hold".');
say('');
{
  // A row can stop for two very different reasons, and conflating them would put a
  // measurement artifact in the headline table: either the payload genuinely does
  // not fit, or the cell exceeded the time budget and was not waited on. The second
  // is a limit of this harness, not of the codec, and it is marked with * so nobody
  // reads a budget ceiling as a capacity ceiling. An earlier version of this table
  // did exactly that — it reported identical substitution and auto-grow maxima at
  // 100K and above, and a 500K row larger than its 100K row, both purely artifacts.
  let budgetHit = false;
  const rows = COVERS.map(cl => {
    const find = params => {
      let best = 0, stopped = 'fit';
      for (const pl of PAYLOADS) {
        const r = attempt(cl, pl, params);
        if (r.verdict === 'ok') { best = pl; continue; }
        stopped = (r.verdict === 'slow') ? 'budget' : 'fit';
        break;
      }
      if (stopped === 'budget') budgetHit = true;
      return { best: best, stopped: stopped };
    };
    const sub = find({}), grow = find({ autoGrow: true });
    const fmt = x => x.best ? human(x.best) + 'B' + (x.stopped === 'budget' ? '*' : '') : '—';
    const rate = x => x.best ? (x.best / (cl / 1024)).toFixed(1) + (x.stopped === 'budget' ? '*' : '') : '—';
    return [human(cl), fmt(sub), rate(sub), fmt(grow), rate(grow)];
  });
  table(['cover chars', 'substitution max', 'B per KB', 'auto-grow max', 'B per KB'],
    rows, [null, 'r', 'r', 'r', 'r']);
  if (budgetHit) {
    say('`*` the row stopped at the ' + CELL_BUDGET_MS + 'ms cell budget rather than at a real');
    say('ceiling — a limit of this harness, not of the codec. Raise the budget or run the');
    say('large covers alone to get the true figure. Rows carrying `*` are not comparable');
    say('with rows that do not, and a `*` row is a LOWER BOUND.');
    say('');
  }
}

say('## Notes');
say('');
say('**The substitution ceiling is a property of prose, not of the codec.** English');
say('averages roughly one inter-word gap per 5-6 characters, each carrying 2 bits, so');
say('a kilobyte of text holds on the order of 40 bytes at one copy before framing.');
say('No parameter changes that; only more text does.');
say('');
say('**Redundancy is worth more than payload.** A secret that fits once is fragile —');
say('measured recovery is around 29% for length-preserving carriers at one copy');
say('against 57% at five to eight. Reading these tables as "how much fits" rather');
say('than "how much fits several times over" will produce brittle marks.');
say('');
say('**Auto-grow trades away the property most callers came for.** Length-preserving');
say('substitution is what makes a marked document byte-identical in size and');
say('invisible to a diff. Auto-grow abandons that. It is the right choice when the');
say('mark only has to survive copy/paste between systems that preserve characters,');
say('and the wrong one when it has to go unnoticed.');
say('');
say('**Large secrets are not yet a designed mode.** The sensible strategy for a big');
say('payload is to mix carriers — dense zero-width insertion for bulk with');
say('substitution carriers for the parts that must survive a sanitiser — rather than');
say('pushing one carrier to its limit. That is tracked in `dev/roadmap.md`; today');
say('auto-grow simply raises zero-width density until the payload fits, which is the');
say('crude version of the same idea.');

if (MD_PATH) {
  fs.mkdirSync(path.dirname(MD_PATH), { recursive: true });
  fs.writeFileSync(MD_PATH, out.join('\n') + '\n');
  console.error('\nwrote ' + MD_PATH);
}
