#!/usr/bin/env node
/*
 * cli.js — the `spab` command shipped with the npm package (@deftio/spab).
 * Minimal, self-contained (requires only ./spab.js). The richer exploration
 * playground lives in the repo at cli/spabdemo.js.
 *
 *   spab encode --message "secret" --in file.txt [--out out.txt] [--classes ws,apos,hyphen]
 *   spab decode --in file.txt [--classes ws,apos,hyphen]
 *   spab capacity --in file.txt
 *   spab help
 */
'use strict';

var fs = require('fs');
var SPAB = require('./spab.js');

function readStdin() {
  var chunks = [], buf = Buffer.alloc(65536);
  while (true) {
    var n;
    try { n = fs.readSync(0, buf, 0, buf.length, null); }
    catch (e) { if (e.code === 'EAGAIN') continue; if (e.code === 'EOF') break; throw e; }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parse(argv) {
  var f = {}, alias = { m: 'message', i: 'in', o: 'out', c: 'classes', h: 'help' };
  for (var k = 0; k < argv.length; k++) {
    var a = argv[k];
    if (a[0] === '-') {
      var key = a.replace(/^--?/, ''), val = null, eq = key.indexOf('=');
      if (eq >= 0) { val = key.slice(eq + 1); key = key.slice(0, eq); }
      key = alias[key] || key;
      if (key === 'help') f.help = true;
      else if (val !== null) f[key] = val;
      else if (k + 1 < argv.length) f[key] = argv[++k];
      else f[key] = true;
    }
  }
  return f;
}

function input(f, label) {
  if (f.in) return f.in === '-' ? readStdin() : fs.readFileSync(f.in, 'utf8');
  if (!process.stdin.isTTY) return readStdin();
  console.error('error: no ' + label + ' — use --in <file> or pipe via stdin'); process.exit(1);
}
function params(f) { return f.classes ? { classes: String(f.classes).split(',') } : {}; }

function help() {
  console.log([
    'spab — hide/reveal a message in the whitespace and punctuation of text',
    '',
    '  spab encode --message "<secret>" --in <file> [--out <file>] [--classes ws,apos,hyphen]',
    '  spab decode --in <file> [--classes ws,apos,hyphen]',
    '  spab capacity --in <file>',
    '  spab help',
    '',
    'Carrier classes: ws, apos, hyphen (on by default), wsdense, zwsp (opt-in).',
    'Input: --in <file> ("-" = stdin) or piped stdin. Output: stdout or --out <file>.'
  ].join('\n'));
}

var cmd = process.argv[2], f = parse(process.argv.slice(3));
if (!cmd || cmd === 'help' || f.help) { help(); process.exit(0); }

if (cmd === 'encode') {
  if (f.message === undefined || f.message === true) { console.error('error: --message is required'); process.exit(1); }
  var res = SPAB.encode(input(f, 'cover text'), String(f.message), params(f));
  if (f.out) fs.writeFileSync(f.out, res.text); else process.stdout.write(res.text + (res.text.endsWith('\n') ? '' : '\n'));
  if (res.metadata.issues && res.metadata.issues.length) console.error('note: ' + res.metadata.issues.join(' '));
} else if (cmd === 'decode') {
  var d = SPAB.decode(input(f, 'encoded text'), params(f));
  if (d.message === null) { console.log('No message found (' + d.metadata.status + ').'); process.exit(1); }
  console.log(d.message);
  console.error('(' + d.metadata.status + ', confidence ' + Math.round((d.metadata.confidence || 0) * 100) + '%)');
} else if (cmd === 'capacity') {
  var slots = SPAB.getSlots(input(f, 'text')).length;
  console.log('whitespace slots: ' + slots + '  (~' + Math.max(0, Math.floor(slots * 2 / 8) - 3) + ' bytes per copy)');
} else { console.error('unknown command: ' + cmd); help(); process.exit(1); }
