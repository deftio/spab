#!/usr/bin/env node
/*
 * corpus-curate.js — download a curated, license-free real-text corpus.
 *
 * Builds corpuses/curated/ from a manifest of public-domain and permissively
 * licensed sources: public-domain books (Project Gutenberg), CC BY-SA Wikipedia
 * articles (fetched as plain text), permissive Markdown, and open CSV data. It
 * cleans each source, writes files by category, and records provenance + licenses
 * in MANIFEST.md / LICENSES.md so attribution requirements (CC BY-SA, CC BY) are met.
 *
 *   node r_and_d/corpus-curate.js                 # download everything in the manifest
 *   node r_and_d/corpus-curate.js --only books    # one category
 *   node r_and_d/corpus-curate.js --out-dir corpus/curated
 *
 * This script performs network downloads when YOU run it. It is intentionally a
 * standalone tool — nothing else in the repo hits the network. Review the manifest
 * and licenses before redistributing any downloaded text.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var https = require('https');

// ---- curated, license-free manifest (extend freely) ----
// license: SPDX-ish tag; attribution: required credit line for CC-BY* sources.
var MANIFEST = [
  // Public domain (Project Gutenberg). US public domain; strip PG boilerplate.
  { cat: 'books', name: 'austen-pride-and-prejudice', ext: 'txt', license: 'PD-US (Project Gutenberg)',
    url: 'https://www.gutenberg.org/cache/epub/1342/pg1342.txt', clean: 'gutenberg' },
  { cat: 'books', name: 'doyle-sherlock-holmes', ext: 'txt', license: 'PD-US (Project Gutenberg)',
    url: 'https://www.gutenberg.org/cache/epub/1661/pg1661.txt', clean: 'gutenberg' },
  { cat: 'books', name: 'shelley-frankenstein', ext: 'txt', license: 'PD-US (Project Gutenberg)',
    url: 'https://www.gutenberg.org/cache/epub/84/pg84.txt', clean: 'gutenberg' },
  { cat: 'books', name: 'melville-moby-dick', ext: 'txt', license: 'PD-US (Project Gutenberg)',
    url: 'https://www.gutenberg.org/cache/epub/2701/pg2701.txt', clean: 'gutenberg' },
  { cat: 'books', name: 'twain-huckleberry-finn', ext: 'txt', license: 'PD-US (Project Gutenberg)',
    url: 'https://www.gutenberg.org/cache/epub/76/pg76.txt', clean: 'gutenberg' },

  // Wikipedia article plain-text extracts. CC BY-SA 4.0 — attribution required.
  { cat: 'wikipedia', name: 'Signal_processing', ext: 'txt', license: 'CC BY-SA 4.0',
    attribution: 'Wikipedia contributors, "Signal processing", CC BY-SA 4.0',
    url: wikiExtract('Signal processing'), clean: 'trim' },
  { cat: 'wikipedia', name: 'Reed-Solomon_error_correction', ext: 'txt', license: 'CC BY-SA 4.0',
    attribution: 'Wikipedia contributors, "Reed–Solomon error correction", CC BY-SA 4.0',
    url: wikiExtract('Reed–Solomon error correction'), clean: 'trim' },
  { cat: 'wikipedia', name: 'Steganography', ext: 'txt', license: 'CC BY-SA 4.0',
    attribution: 'Wikipedia contributors, "Steganography", CC BY-SA 4.0',
    url: wikiExtract('Steganography'), clean: 'trim' },
  { cat: 'wikipedia', name: 'Spread_spectrum', ext: 'txt', license: 'CC BY-SA 4.0',
    attribution: 'Wikipedia contributors, "Spread spectrum", CC BY-SA 4.0',
    url: wikiExtract('Spread spectrum'), clean: 'trim' },

  // Open data (CSV). Public-domain / CC0 sample datasets.
  { cat: 'data', name: 'airtravel', ext: 'csv', license: 'PD (sample dataset)',
    url: 'https://people.sc.fsu.edu/~jburkardt/data/csv/airtravel.csv', clean: 'trim' },
  { cat: 'data', name: 'cities', ext: 'csv', license: 'PD (sample dataset)',
    url: 'https://people.sc.fsu.edu/~jburkardt/data/csv/cities.csv', clean: 'trim' }
];

function wikiExtract(title) {
  return 'https://en.wikipedia.org/w/api.php?action=query&format=json&prop=extracts' +
    '&explaintext=1&redirects=1&titles=' + encodeURIComponent(title);
}

// ---- download with redirect handling ----
function fetch(url, redirects) {
  redirects = redirects || 0;
  return new Promise(function (resolve, reject) {
    https.get(url, { headers: { 'User-Agent': 'spab-corpus-curate/0.1 (research; contact via repo)' } }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 6) {
        res.resume();
        var next = res.headers.location.startsWith('http') ? res.headers.location
          : new URL(res.headers.location, url).toString();
        return resolve(fetch(next, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' for ' + url)); }
      var data = [];
      res.on('data', function (c) { data.push(c); });
      res.on('end', function () { resolve(Buffer.concat(data).toString('utf8')); });
    }).on('error', reject);
  });
}

// ---- cleaners ----
function cleanGutenberg(text) {
  var s = text.replace(/\r\n/g, '\n');
  var start = s.search(/\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG.*?\*\*\*/i);
  var end = s.search(/\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG.*?\*\*\*/i);
  if (start >= 0) s = s.slice(s.indexOf('\n', start) + 1);
  if (end >= 0) { var e = s.search(/\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG.*?\*\*\*/i); if (e >= 0) s = s.slice(0, e); }
  return s.trim() + '\n';
}
function cleanWikiJson(text) {
  try {
    var obj = JSON.parse(text);
    var pages = obj.query && obj.query.pages;
    var key = pages && Object.keys(pages)[0];
    var extract = key && pages[key].extract;
    return (extract || '').trim() + '\n';
  } catch (e) { return text.trim() + '\n'; }
}
function applyClean(kind, item, text) {
  if (kind === 'gutenberg') return cleanGutenberg(text);
  if (item.cat === 'wikipedia') return cleanWikiJson(text);
  return text.replace(/\r\n/g, '\n').trim() + '\n';
}

// ---- args ----
var args = process.argv.slice(2);
function val(f, d) { var i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; }
var only = val('--only', null);
var outDir = val('--out-dir', '../corpuses/curated');
outDir = path.isAbsolute(outDir) ? outDir : path.join(__dirname, outDir);

function main() {
  var items = MANIFEST.filter(function (m) { return !only || m.cat === only; });
  fs.mkdirSync(outDir, { recursive: true });
  var manifestLines = ['# Curated corpus — provenance', '', 'Downloaded by corpus-curate.js. Do not redistribute without honoring each license.', ''];
  var licenseSet = {};
  var done = 0, failed = 0;

  (function next(i) {
    if (i >= items.length) return finish();
    var it = items[i];
    var dir = path.join(outDir, it.cat);
    fs.mkdirSync(dir, { recursive: true });
    var dest = path.join(dir, it.name + '.' + it.ext);
    process.stdout.write('fetching [' + it.cat + '] ' + it.name + ' ... ');
    fetch(it.url).then(function (raw) {
      var cleaned = applyClean(it.clean, it, raw);
      fs.writeFileSync(dest, cleaned);
      console.log('ok (' + cleaned.length + ' chars)');
      manifestLines.push('- **' + it.cat + '/' + it.name + '.' + it.ext + '** — ' + it.license +
        (it.attribution ? '  \n  attribution: ' + it.attribution : '') + '  \n  source: ' + it.url);
      licenseSet[it.license] = true;
      done++; next(i + 1);
    }).catch(function (err) {
      console.log('FAILED (' + err.message + ')');
      failed++; next(i + 1);
    });
  })(0);

  function finish() {
    fs.writeFileSync(path.join(outDir, 'MANIFEST.md'), manifestLines.join('\n') + '\n');
    fs.writeFileSync(path.join(outDir, 'LICENSES.md'),
      '# Licenses in this corpus\n\n' + Object.keys(licenseSet).map(function (l) { return '- ' + l; }).join('\n') +
      '\n\nPublic-domain (PD) text has no restrictions. CC BY-SA 4.0 and CC BY require attribution\n' +
      '(see MANIFEST.md) and, for CC BY-SA, share-alike on redistribution.\n');
    console.log('\ndone: ' + done + ' ok, ' + failed + ' failed -> ' + outDir);
    console.log('wrote MANIFEST.md and LICENSES.md. Sweep it with:');
    console.log('  node r_and_d/harness.js --corpus-dir ' + path.relative(path.join(__dirname, '..'), outDir));
  }
}

main();
