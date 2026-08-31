/*
 * payloads.js — named payload profiles spanning the capacity/robustness spectrum.
 *
 * These are the canonical "what are you hiding?" cases:
 *   magic    — a tiny magic word (4-10 bytes). Embed it ultra-redundantly. The
 *              "major magazine stamps every article" case: short text, high robustness.
 *   sha1     — a 160-bit / 20-byte formal fingerprint. Provenance / integrity.
 *   sha256   — a 256-bit / 32-byte hash. Stronger fingerprint, needs more room.
 *   json     — structured metadata (author, id, rights...). Needs a real passage.
 *   program  — a long payload (a mini program / URL / easter egg). The "ship a novel
 *              with a hidden game" case: lots of text, lots of capacity.
 *
 * byteLen() reports the exact UTF-8 size so tools can show capacity math.
 */
'use strict';

function utf8Len(s) {
  return (typeof Buffer !== 'undefined') ? Buffer.byteLength(s, 'utf8')
    : new TextEncoder().encode(s).length;
}

// Representative content for each profile (deterministic, ASCII where size matters).
var PROFILES = [
  { name: 'magic',   note: 'tiny magic word (embed ultra-redundantly)',
    text: 'SPAB' },
  { name: 'magic8',  note: '8-byte tag / short serial',
    text: 'SPAB-001' },
  { name: 'sha1',    note: '160-bit fingerprint (20 bytes)',
    text: 'a94a8fe5ccb19ba61c4c' },                         // 20 chars = 20 bytes
  { name: 'sha256',  note: '256-bit hash (32 bytes)',
    text: '2c26b46b68ffc68ff99b453c1d30413d' },             // 32 chars = 32 bytes
  { name: 'json',    note: 'structured metadata',
    text: '{"src":"spab","id":4821,"by":"m.chatterjee","rights":"CC-BY","v":1}' },
  { name: 'program', note: 'long payload / easter egg (mini program)',
    text: 'PRG1;print("hello from spab");for(i=0..9){emit(i*i)};goto end;' +
          'label end;checksum=0x5a3c;note="hidden in the whitespace of a novel"' }
];

var BY_NAME = {};
PROFILES.forEach(function (p) { p.bytes = utf8Len(p.text); BY_NAME[p.name] = p; });

module.exports = { PROFILES: PROFILES, BY_NAME: BY_NAME, utf8Len: utf8Len };
