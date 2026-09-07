/*
 * StegCloak (AES + HMAC) — the same library in its PROTECTED mode.
 *
 * encrypt: ON, integrity: ON. This is the only configuration in which StegCloak's
 * HMAC actually runs (see the note in stegcloak.js), so it is the only one that can
 * refuse a damaged mark rather than return whatever the bytes decode to.
 *
 * It is not a like-for-like comparison against spab's default on the encryption
 * axis — spab's default is unencrypted with a checksum, and its own AES-256-GCM mode
 * is measured in r_and_d/benchmark.js. Both StegCloak rows are shown so the reader
 * can see what its safety property costs: to get integrity you must also encrypt.
 */
'use strict';
const PASSWORD = 'spab-benchmark';   // published on purpose: this row measures integrity, not secrecy
let StegCloak = null;
try { StegCloak = require('stegcloak'); } catch (e) { StegCloak = null; }

let inst = null;
function instance() {
  if (!inst) inst = new StegCloak(true, true);   // encrypt: off, integrity: off — see header
  return inst;
}
module.exports = {
  name: 'StegCloak (AES+HMAC)',
  technique: 'zero-width insertion at one point; compress + optional encrypt + HMAC',
  url: 'https://github.com/KuroLabs/stegcloak',
  install: 'npm i stegcloak',
  limits: 'one insertion point; integrity available only together with encryption',
  get source() {
    if (!StegCloak) return 'not installed';
    try { return 'npm:stegcloak@' + require('stegcloak/package.json').version; }
    catch (e) { return 'npm:stegcloak'; }
  },
  available() {
    if (!StegCloak) return false;
    try {
      const s = instance();
      return s.reveal(s.hide('probe', PASSWORD, 'a probe cover text with several words'), PASSWORD) === 'probe';
    } catch (e) { return false; }
  },
  encode(cover, msg) { try { return instance().hide(msg, PASSWORD, cover); } catch (e) { return null; } },
  decode(text) { try { return instance().reveal(text, PASSWORD); } catch (e) { return null; } }
};
