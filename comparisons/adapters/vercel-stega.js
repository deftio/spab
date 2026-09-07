/*
 * @vercel/stega — the invisible-metadata encoder behind Vercel's visual editing, used
 * in production by Contentful and Sanity to tie rendered text back to its CMS field.
 *
 * Not a watermarker by intent, which is exactly why it is a useful row: it is a
 * widely deployed zero-width payload channel with no error correction and no
 * integrity check, so it shows what the carrier alone gives you in real software.
 *
 * It carries structured data rather than a string, so the adapter wraps the payload
 * in an object and unwraps it on the way back. That is the library's shape, not a
 * handicap imposed here.
 */
'use strict';
let V = null;
try { V = require('@vercel/stega'); } catch (e) { V = null; }

module.exports = {
  name: '@vercel/stega',
  family: 'insertion',
  lengthPreserving: false,
  integrity: false,
  bestFor: 'round-tripping editor metadata through your own pipeline, not an adversarial channel',
  vendor: 'Vercel',
  technique: 'zero-width JSON payload appended to the text; no ECC, no integrity check',
  url: 'https://www.npmjs.com/package/@vercel/stega',
  install: 'npm i @vercel/stega',
  limits: 'designed for editor round-trips, not adversarial channels; no integrity check',
  get source() {
    if (!V) return 'not installed';
    try { return 'npm:@vercel/stega@' + require('@vercel/stega/package.json').version; }
    catch (e) { return 'npm:@vercel/stega'; }
  },
  available() {
    if (!V) return false;
    try {
      const m = V.vercelStegaCombine('a probe cover text with words', { s: 'probe' });
      const d = V.vercelStegaDecode(m);
      return !!d && d.s === 'probe';
    } catch (e) { return false; }
  },
  encode(cover, msg) {
    try { return V.vercelStegaCombine(cover, { s: msg }); } catch (e) { return null; }
  },
  decode(text) {
    try { const d = V.vercelStegaDecode(text); return (d && typeof d.s === 'string') ? d.s : null; }
    catch (e) { return null; }
  }
};
