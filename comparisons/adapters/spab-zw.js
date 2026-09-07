/*
 * spab, zero-width insertion — the like-for-like row.
 *
 * WHY THIS EXISTS. Every other library in this comparison inserts invisible
 * characters. spab's default does not: it swaps existing characters so the document
 * stays exactly as long. Running only that row against insertion-based libraries
 * compares two different operating points and reads as spab losing badly to
 * StegCloak on whitespace normalisation — which it does, because normalising
 * whitespace destroys a whitespace carrier and leaves zero-width characters
 * untouched. That is a property of the CARRIER, not of the codec around it.
 *
 * This row puts spab on the same carrier as its comparators, so the remaining
 * difference is the communications machinery: framing, checksum, ECC, resync.
 */
'use strict';
const SPAB = require('../../src/js/spab.js');
const PARAMS = { classes: ['zwsp'] };
module.exports = {
  name: 'spab (zero-width)',
  family: 'insertion',
  lengthPreserving: false,
  integrity: true,
  bestFor: 'capacity matters more than length, and you still want ECC and an integrity check',
  vendor: 'deftio',
  technique: 'zero-width insertion carriers, with the same framing, checksum and ECC as the default',
  url: 'https://github.com/deftio/spab',
  install: '(this repo)',
  limits: 'inserts characters, so the document grows and an invisible-character sanitiser removes the mark',
  get source() { return 'local:' + SPAB.VERSION + ' (wire v' + SPAB.algorithm.frame.version + ')'; },
  available() { return true; },
  encode(cover, msg) {
    const e = SPAB.encode(cover, msg, PARAMS);
    const tooShort = (e.metadata.issues || []).some(s => /too short/.test(s));
    return tooShort ? null : e.text;
  },
  decode(text) { return SPAB.decode(text, PARAMS).message; }
};
