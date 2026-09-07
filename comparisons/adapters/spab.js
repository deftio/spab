/*
 * spab, length-preserving (the default operating point).
 *
 * Substitution carriers only: whitespace variants plus apostrophe and hyphen
 * confusables. The marked document has EXACTLY the same character count as the
 * cover, and a diff shows nothing.
 *
 * This is the row to compare against a library that also preserves length. Every
 * other adapter here INSERTS invisible characters, which is a different operating
 * point and not a fairer or worse one — see adapters/spab-zw.js for spab's own
 * insertion mode, which is the like-for-like row against those.
 */
'use strict';
const SPAB = require('../../src/js/spab.js');
module.exports = {
  name: 'spab (length-preserving)',
  family: 'substitution',
  lengthPreserving: true,
  integrity: true,
  bestFor: 'the document must stay byte-identical in length and survive a diff',
  vendor: 'deftio',
  technique: 'substitution carriers: whitespace variants + apostrophe/hyphen confusables, with ECC',
  url: 'https://github.com/deftio/spab',
  install: '(this repo)',
  limits: 'length-preserving, so capacity is bounded by the text and whitespace normalisation destroys the main carrier',
  get source() { return 'local:' + SPAB.VERSION + ' (wire v' + SPAB.algorithm.frame.version + ')'; },
  available() { return true; },
  encode(cover, msg) {
    const e = SPAB.encode(cover, msg, {});
    // An honest refusal is not an encode: if the passage cannot hold the payload,
    // report that rather than emitting a truncated copy that decodes to nothing.
    const tooShort = (e.metadata.issues || []).some(s => /too short/.test(s));
    return tooShort ? null : e.text;
  },
  decode(text) { return SPAB.decode(text, {}).message; }
};
