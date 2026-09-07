/* spab itself — the reference row. Always available; this repo has no dependencies. */
'use strict';
const SPAB = require('../../src/js/spab.js');
module.exports = {
  name: 'spab',
  technique: 'multi-carrier substitution (whitespace + confusables) with repetition or RLNC ECC',
  url: 'https://github.com/deftio/spab',
  install: '(this repo)',
  limits: null,
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
