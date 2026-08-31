#!/usr/bin/env node
/*
 * spabdemo.js — "the story that carries a secret" — a small spab playground.
 *
 * Encode a message into the whitespace of any text, then decode it straight from
 * the plain text. The encoded output looks identical when read or printed — the
 * secret lives only in which kind of space sits between words. Uses the current
 * spab baseline codec (web/spab.js).  (hide/reveal remain as aliases.)
 *
 * Input (cover text for encode, encoded text for decode) comes from, in order:
 *   --use-demo-story  |  --text "..."  |  --in <file>  |  piped stdin
 * Output is stdout unless --out <file> is given. Add --verbose (-v) for stats.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var SPAB = require(path.join(__dirname, '..', 'src', 'js', 'spab.js'));

var SAMPLE = path.join(__dirname, 'sample-story.txt');

// --- tiny named-arg parser: --key value | --key=value | -k value | --flag ---
var ALIAS = { m: 'message', i: 'in', o: 'out', t: 'text', v: 'verbose', h: 'help' };
var BOOL = { verbose: true, help: true, 'use-demo-story': true };
function parseArgs(argv) {
  var flags = {}, extra = [];
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a[0] === '-' && a !== '-') {
      var key = a.replace(/^--?/, ''), val = null;
      var eq = key.indexOf('=');
      if (eq >= 0) { val = key.slice(eq + 1); key = key.slice(0, eq); }
      key = ALIAS[key] || key;
      if (BOOL[key]) flags[key] = true;
      else if (val !== null) flags[key] = val;
      else if (i + 1 < argv.length) flags[key] = argv[++i];
      else flags[key] = true;
    } else { extra.push(a); }
  }
  return { flags: flags, extra: extra };
}

// Robust synchronous stdin read (handles non-blocking pipes that throw EAGAIN).
function readStdin() {
  var chunks = [], buf = Buffer.alloc(65536);
  while (true) {
    var n;
    try { n = fs.readSync(0, buf, 0, buf.length, null); }
    catch (e) {
      if (e.code === 'EAGAIN') continue;       // not ready yet — retry
      if (e.code === 'EOF') break;             // some platforms signal EOF this way
      throw e;
    }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function readFileOrStdin(p) {
  if (p === '-' || p === '/dev/stdin') return readStdin();
  return fs.readFileSync(p, 'utf8');
}

// Resolve the input text from the allowed sources, or exit with guidance.
function resolveInput(flags, label) {
  if (flags['use-demo-story']) return readFileOrStdin(SAMPLE);
  if (flags.text !== undefined && flags.text !== true) return String(flags.text);
  if (flags['in']) return readFileOrStdin(flags['in']);
  if (!process.stdin.isTTY) return readStdin(); // piped
  console.error('error: no ' + label + ' provided.');
  console.error('       give one of:  --in <file>   --text "..."   (pipe via stdin)   --use-demo-story');
  process.exit(1);
}

function capacityInfo(text) {
  var slots = SPAB.getSlots(text).length;
  return { slots: slots, maxBytesOneCopy: Math.max(0, Math.floor(slots * 2 / 8) - 3) };
}

function dumpVerbose(label, obj) {
  console.error('--- ' + label + ' ---');
  Object.keys(obj).forEach(function (k) {
    var v = obj[k];
    console.error('  ' + k.padEnd(14) + (Array.isArray(v) ? (v.length ? v.join('; ') : '(none)') : v));
  });
}

function cmdEncode(flags) {
  if (flags.message === undefined || flags.message === true) {
    console.error('error: --message is required, e.g.  encode --message "your secret" --use-demo-story');
    console.error('       (quote the message so the shell keeps it as one value)');
    process.exit(1);
  }
  var secret = String(flags.message);
  var story = resolveInput(flags, 'cover text');
  var res = SPAB.encode(story, secret, {});
  var m = res.metadata;

  if (flags.out) fs.writeFileSync(flags.out, res.text);
  else { process.stdout.write(res.text); if (!res.text.endsWith('\n')) process.stdout.write('\n'); }

  if (m.issues && m.issues.length) console.error('note: ' + m.issues.join(' '));
  console.error('encoded "' + secret + '" (' + m.payloadBytes + ' bytes) across ' +
    m.slots + ' slots, ' + m.reps + ' cop' + (m.reps === 1 ? 'y' : 'ies') + '.');
  var d = SPAB.decode(res.text, {});
  console.error(d.message === secret
    ? 'verified: decodes back exactly (' + d.metadata.status + ').'
    : 'WARNING: round-trip mismatch — got ' + JSON.stringify(d.message) + ' (' + d.metadata.status + ').');
  if (flags.out) console.error('wrote ' + flags.out);

  if (flags.verbose) {
    var cap = capacityInfo(story);
    dumpVerbose('encode stats', {
      messageBytes: m.payloadBytes, messageHex: Buffer.from(secret, 'utf8').toString('hex'),
      slots: m.slots, capacityBits: m.capacityBits, frameBits: m.frameBits, frameBytes: m.frameBytes,
      copies: m.reps, maxBytes1Copy: cap.maxBytesOneCopy, issues: m.issues || []
    });
    var h = SPAB.histogram(res.text);
    dumpVerbose('carrier histogram (0/1/2/3)', { counts: h.counts.join(' / '), total: h.total });
  }
}

function cmdDecode(flags) {
  var d = SPAB.decode(resolveInput(flags, 'encoded text'), {});
  if (d.message === null) {
    console.log('No message found (' + d.metadata.status + ').');
    process.exitCode = 1;
  } else {
    console.log('Decoded message: "' + d.message + '"');
    console.log('(' + d.metadata.status + ', confidence ' +
      Math.round((d.metadata.confidence || 0) * 100) + '%)');
  }
  if (flags.verbose) dumpVerbose('decode metadata', d.metadata);
}

function capacity(flags) {
  var text = resolveInput(flags, 'text');
  var c = capacityInfo(text);
  console.log('slots (usable spaces): ' + c.slots);
  console.log('max payload for 1 copy: ~' + c.maxBytesOneCopy + ' bytes');
  console.log('(a B-byte message needs ~(B+3)*4 slots per copy; more copies = more robustness)');
  if (flags.verbose) {
    var h = SPAB.histogram(text);
    dumpVerbose('carrier histogram (0/1/2/3)', { counts: h.counts.join(' / '), total: h.total });
  }
}

function demo() {
  var secret = 'The treasure is buried beneath the third oak.';
  var story = readFileOrStdin(SAMPLE);
  var res = SPAB.encode(story, secret, {});
  console.log('--- Original story (first 240 chars) ---');
  console.log(story.slice(0, 240) + '...');
  console.log('\n--- Watermarked story looks identical (first 240 chars) ---');
  console.log(res.text.slice(0, 240) + '...');
  console.log('\nsame visible text? ' +
    (story.replace(/\s/g, ' ') === res.text.replace(/\s/g, ' ') ? 'yes — only the spaces differ' : 'no'));
  var d = SPAB.decode(res.text, {});
  console.log('\n--- Decoder recovers ---');
  console.log('"' + d.message + '"  (' + d.metadata.status +
    ', confidence ' + Math.round((d.metadata.confidence || 0) * 100) + '%)');
  console.log('\nNow try it yourself — see:  ./demo/spabdemo.js help');
}

function help() {
  console.log([
    'spabdemo — encode a secret message into the spaces of ordinary text, and decode it later.',
    'The encoded text looks identical to the original; the secret lives only in which',
    'kind of space sits between the words.',
    '',
    'USAGE',
    '  spabdemo.js <command> [options]',
    '',
    'COMMANDS',
    '  encode     Encode --message into some text. Prints the encoded text.',
    '  decode     Read encoded text and print the hidden message.',
    '  capacity   Report how many bytes a given text can hold.',
    '  demo       Run a self-contained example using the built-in story.',
    '  help       Show this help.',
    '',
    'CHOOSING THE TEXT  (encode = the cover text; decode/capacity = the text to read)',
    '  Give the text ONE of these ways:',
    '    --in <file>          read the text from a file',
    '    --text "..."         pass the text directly on the command line',
    '    --use-demo-story     use the built-in sample story',
    '    (or pipe it in)      e.g.  cat story.txt | spabdemo.js decode',
    '',
    'OPTIONS',
    '  --message, -m "<secret>"   the message to encode   (encode only, required)',
    '  --in, -i <file>            input text file  ("-" means stdin)',
    '  --text, -t "<text>"        input text given directly',
    '  --use-demo-story           use the bundled sample story as the input text',
    '  --out, -o <file>           write encoded text to a file (default: print to screen)',
    '  --verbose, -v              also print stats (capacity, copies, histogram, decode details)',
    '',
    'EXAMPLES',
    '  # Encode a message into a story file and save the result',
    '  spabdemo.js encode --message "meet at dawn" --in story.txt --out out.txt',
    '',
    '  # Decode it again',
    '  spabdemo.js decode --in out.txt',
    '',
    '  # Quick try with no files at all, using the built-in story',
    '  spabdemo.js encode -m "hello" --use-demo-story --out out.txt',
    '  spabdemo.js decode -i out.txt',
    '',
    '  # All in one line with a pipe',
    '  cat story.txt | spabdemo.js encode -m "psst" | spabdemo.js decode',
    '',
    '  # How much can this text hold?',
    '  spabdemo.js capacity --in story.txt',
    '',
    'NOTES',
    '  - Always put quotes around --message and --text so the shell keeps each as one value.',
    '  - encode prints the encoded text to the screen (or --out); the stats lines are printed',
    '    separately, so you can safely pipe or redirect the encoded text.',
    '  - A longer cover text holds a longer message and repeats it more times (more robust).',
    '  - Shortcut: if you pass --message with no command, "encode" is assumed.',
    '  - (hide/reveal still work as aliases for encode/decode.)'
  ].join('\n'));
}

var cmd = process.argv[2];
// encode/decode are the verbs; hide/reveal kept as hidden aliases.
var COMMANDS = { encode: cmdEncode, decode: cmdDecode, capacity: capacity, demo: demo,
                 hide: cmdEncode, reveal: cmdDecode };

// If the first token is a flag (no command given), parse everything and infer.
if (cmd !== undefined && cmd[0] === '-') {
  var p0 = parseArgs(process.argv.slice(2));
  var f0 = p0.flags; f0.extra = p0.extra;
  if (f0.help || cmd === '-h') help();
  else if (f0.message !== undefined) cmdEncode(f0);   // --message present -> assume "encode"
  else {
    console.error('no command given. Use one of: encode | decode | capacity | demo\n' +
      '  to encode a message:  spabdemo.js encode --message "your secret" --in file.txt\n' +
      '  to decode one:        spabdemo.js decode --in file.txt\n');
    process.exit(1);
  }
} else {
  var parsed = parseArgs(process.argv.slice(3));
  var flags = parsed.flags; flags.extra = parsed.extra;
  if (cmd === undefined || cmd === 'help' || flags.help) help();
  else if (COMMANDS[cmd]) COMMANDS[cmd](flags);
  else { console.error('unknown command: ' + cmd + '\n'); help(); process.exit(1); }
}
