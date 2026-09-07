/*
 * StegCloak (plain) — zero-width insertion at a single point, compressed, no
 * cryptography. The best-known library in this category.
 *
 * CONFIGURATION, because it decides the result.
 *
 * encrypt: OFF, integrity: OFF. This matches spab's default operating point on the
 * encryption axis, so the comparison is about the carrier rather than about AES.
 *
 * A caveat this adapter had to learn the hard way. StegCloak's constructor takes
 * (encrypt, integrity), and it is tempting to set integrity on while leaving
 * encryption off, to match spab's always-present checksum. That does nothing:
 * stegcloak.js line 73 reads
 *
 *     integrity && crypt ? toConcealHmac : crypt ? toConceal : noCrypt
 *
 * so the HMAC is only applied WHEN ENCRYPTION IS ALSO ON. An earlier revision of
 * this adapter set integrity:true, believed it, and would have reported StegCloak's
 * unprotected behaviour as its protected behaviour. The encrypted+HMAC mode is
 * measured separately in stegcloak-hmac.js so both operating points are visible and
 * neither is misattributed.
 */
'use strict';
const PASSWORD = 'spab-benchmark';   // not a secret: encryption is off by design
let StegCloak = null;
try { StegCloak = require('stegcloak'); } catch (e) { StegCloak = null; }

let inst = null;
function instance() {
  if (!inst) inst = new StegCloak(false, false);   // encrypt: off, integrity: off — see header
  return inst;
}
module.exports = {
  name: 'StegCloak (plain)',
  family: 'insertion',
  lengthPreserving: false,
  integrity: false,
  bestFor: 'a quick invisible payload where damage is unlikely',
  vendor: 'KuroLabs',
  technique: 'zero-width insertion at one point; compress + optional encrypt + HMAC',
  url: 'https://github.com/KuroLabs/stegcloak',
  install: 'npm i stegcloak',
  limits: 'one insertion point, so any edit removing it removes everything; NO integrity in this mode (HMAC needs encryption)',
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
