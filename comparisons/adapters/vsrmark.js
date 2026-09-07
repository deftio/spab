/*
 * VSRMark — maps each payload byte to one Unicode variation selector appended after
 * a visible character. Exceptional raw density: about one payload byte per carrier,
 * with framing and a CRC but no error correction.
 *
 * Not on npm. It publishes C, Go, Java, Rust, Swift and TypeScript implementations,
 * so this adapter shells out to a local build rather than vendoring one. Point
 * VSRMARK_BIN at an executable that reads the cover on stdin:
 *
 *   VSRMARK_BIN=/path/to/vsrmark node run.js
 *
 * Until then it reports unavailable, which prints as a skipped row.
 */
'use strict';
const { execFileSync } = require('child_process');
const BIN = process.env.VSRMARK_BIN || null;

function run(args, input) {
  return execFileSync(BIN, args, { input: input, encoding: 'utf8', timeout: 10000 }).replace(/\n$/, '');
}
module.exports = {
  name: 'VSRMark',
  family: 'insertion',
  lengthPreserving: false,
  integrity: false,
  bestFor: 'very high density with damage detection but no repair',
  vendor: 'VSRMark project',
  technique: 'Unicode variation selectors, ~1 payload byte per carrier; framing + CRC, no ECC',
  url: 'https://github.com/vsrmark',
  install: 'build from source, then set VSRMARK_BIN',
  limits: 'CRC detects damage but cannot repair it',
  get source() { return BIN ? 'bin:' + BIN : 'not configured (set VSRMARK_BIN)'; },
  available() {
    if (!BIN) return false;
    try { return run(['decode'], run(['encode', 'probe'], 'a probe cover text')) === 'probe'; }
    catch (e) { return false; }
  },
  encode(cover, msg) { try { return run(['encode', msg], cover); } catch (e) { return null; } },
  decode(text) { try { return run(['decode'], text) || null; } catch (e) { return null; } }
};
