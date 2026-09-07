/*
 * A plain zero-width encoder with no framing, no integrity and no ECC — the
 * technique at its most basic. Useful as the floor: it shows what the carrier alone
 * gives you before any communications engineering is added.
 */
'use strict';
let ZW = null;
try { ZW = require('zero-width-lib'); } catch (e) { ZW = null; }

module.exports = {
  name: 'zero-width (bare)',
  technique: 'zero-width insertion, no framing, no integrity, no ECC',
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
