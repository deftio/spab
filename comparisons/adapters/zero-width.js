/*
 * zero-width-lib — a plain zero-width encoder: map the payload to invisible
 * characters, insert them, read them back. No framing, no integrity check, no error
 * correction.
 *
 * This is the CONTROL ROW, and it is here to answer a specific question: how much of
 * a library's robustness comes from its carrier, and how much from the machinery
 * built on top? Everything else in this table adds something — compression,
 * encryption, an HMAC, a checksum, ECC. This adds nothing. Whatever it scores is
 * what the zero-width carrier gives you for free, and every other row should be read
 * as a delta against it.
 */
'use strict';
let ZW = null;
try { ZW = require('zero-width-lib'); } catch (e) { ZW = null; }

module.exports = {
  name: 'zero-width-lib',
  family: 'insertion',
  lengthPreserving: false,
  integrity: false,
  bestFor: 'nothing — it is the control row, showing what the bare carrier gives you',
  vendor: 'community (zero-width-lib)',
  technique: 'CONTROL: raw zero-width insertion — no framing, no integrity, no ECC. What the carrier alone gives you.',
  url: 'https://www.npmjs.com/package/zero-width-lib',
  install: 'npm i zero-width-lib',
  limits: 'no integrity check, so a damaged mark can decode to a WRONG payload rather than none',
  get source() {
    if (!ZW) return 'not installed';
    try { return 'npm:zero-width-lib@' + require('zero-width-lib/package.json').version; }
    catch (e) { return 'npm:zero-width-lib'; }
  },
  available() {
    if (!ZW) return false;
    try {
      const enc = (ZW.addHiddenText || ZW.encode);
      const dec = (ZW.getHiddenText || ZW.decode);
      if (typeof enc !== 'function' || typeof dec !== 'function') return false;
      return dec(enc('a probe cover text', 'probe')) === 'probe';
    } catch (e) { return false; }
  },
  encode(cover, msg) { try { return (ZW.addHiddenText || ZW.encode)(cover, msg); } catch (e) { return null; } },
  decode(text) { try { return (ZW.getHiddenText || ZW.decode)(text) || null; } catch (e) { return null; } }
};
