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
  var f = {}, alias = { m: 'message', i: 'in', o: 'out', c: 'classes', h: 'help', j: 'json' };
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
    '  spab decode --in <file> [--classes ws,apos,hyphen] [--json]',
    '  spab capacity --in <file>',
    '  spab inspect --in <file>            full report as JSON',
    '  spab help',
    '',
    'Carrier classes: ws, apos, hyphen (on by default), wsdense, zwsp (opt-in).',
    'Input: --in <file> ("-" = stdin) or piped stdin. Output: stdout or --out <file>.'
  ].join('\n'));
}

// What was read, and how much to trust it. Everything here is derived from the
// decode metadata rather than guessed: `status` and `confidence` say how clean the
// read was, `channel` which carrier survived, `reps`/`packets` how much redundancy
// was present, and the payload is reported in bytes because the frame is sized in
// bytes, not characters.
function report(text, d) {
  var m = d.metadata, bits = [];
  bits.push('status ' + m.status);
  if (m.confidence !== undefined) bits.push('confidence ' + Math.round((m.confidence || 0) * 100) + '%');
  if (m.channel) bits.push('via ' + m.channel);
  bits.push('ecc ' + (m.ecc || 'repetition'));
  if (m.reps !== undefined) bits.push(m.reps + ' copies');
  if (m.packets !== undefined) bits.push(m.packets + ' packets');
  if (m.payloadBytes !== undefined) bits.push(m.payloadBytes + ' bytes');
  bits.push(m.crcOk ? 'crc ok' : 'crc FAILED');
  console.error('  ' + bits.join('  ·  '));

  var zw = (text.match(/[\u200B\u200C\u200D\u2060]/g) || []).length;
  if (zw) console.error('  carries ' + zw + ' zero-width characters (insert carrier; visible in a hex dump)');
  // There is no type or encryption field in the frame yet: the payload is opaque
  // UTF-8 bytes. Say so rather than let the absence read as "not encrypted".
  if (d.message !== null) {
    var looksJson = /^[\s]*[[{]/.test(d.message);
    console.error('  payload: UTF-8 text' + (looksJson ? ' (parses as JSON-shaped)' : '') +
      ' — the frame carries no type or encryption field, so this is the raw payload as written');
  }
}

var cmd = process.argv[2], f = parse(process.argv.slice(3));
if (!cmd || cmd === 'help' || f.help) { help(); process.exit(0); }

if (cmd === 'encode') {
  if (f.message === undefined || f.message === true) { console.error('error: --message is required'); process.exit(1); }
  var res = SPAB.encode(input(f, 'cover text'), String(f.message), params(f));
  if (f.out) fs.writeFileSync(f.out, res.text); else process.stdout.write(res.text + (res.text.endsWith('\n') ? '' : '\n'));
  if (res.metadata.issues && res.metadata.issues.length) console.error('note: ' + res.metadata.issues.join(' '));
} else if (cmd === 'decode') {
  var text = input(f, 'encoded text');
  var d = SPAB.decode(text, params(f));
  // The payload goes to stdout so it can be piped; everything about HOW it was
  // read goes to stderr, so `spab decode ... > id.txt` stays clean.
  if (d.message !== null) console.log(d.message);
  if (f.json) console.error(JSON.stringify({ message: d.message, metadata: d.metadata }, null, 2));
  else report(text, d);
  if (d.message === null) process.exit(1);
} else if (cmd === 'inspect') {
  var itext = input(f, 'text');
  var idec = SPAB.decode(itext, params(f));
  console.log(JSON.stringify({
    chars: itext.length,
    zeroWidthChars: (itext.match(/[\u200B\u200C\u200D\u2060]/g) || []).length,
    sites: SPAB.getSites(itext, params(f)).length,
    capacityBytesPerCopy: Math.max(0, Math.floor(SPAB.getSlots(itext).length * 2 / 8) - 3),
    decoded: idec.message,
    metadata: idec.metadata,
    algorithm: { version: SPAB.VERSION, name: SPAB.algorithm.name }
  }, null, 2));
} else if (cmd === 'capacity') {
  var slots = SPAB.getSlots(input(f, 'text')).length;
  console.log('whitespace slots: ' + slots + '  (~' + Math.max(0, Math.floor(slots * 2 / 8) - 3) + ' bytes per copy)');
} else { console.error('unknown command: ' + cmd); help(); process.exit(1); }
