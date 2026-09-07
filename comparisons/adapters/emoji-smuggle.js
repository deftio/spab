/*
 * emoji-smuggle-sdk — hides a payload in invisible characters attached to an emoji.
 *
 * The closest installable thing to VSRMark's technique: payload rides variation
 * selectors and zero-width characters carried by a single visible glyph, at very high
 * density and with no error correction.
 *
 * SHAPE MISMATCH, stated because it affects every number in its row. This library
 * does not mark a cover text; it produces a carrier emoji that holds the payload. The
 * adapter appends that emoji to the cover, which is how such a tool is actually used
 * (paste an innocuous emoji into a message). The consequence is that its payload sits
 * at ONE point rather than spread across the document, so any damage that reaches
 * that point removes everything and any damage that misses it removes nothing.
 */
'use strict';
let E = null;
try { E = require('emoji-smuggle-sdk'); } catch (e) { E = null; }
const CARRIER = '\u{1F600}';

module.exports = {
  name: 'emoji-smuggle',
  family: 'insertion',
  lengthPreserving: false,
  integrity: false,
  bestFor: 'maximum payload in the smallest visible footprint, in a channel you trust',
  vendor: 'paulgb / community',
  technique: 'payload in invisible characters attached to one emoji; very high density, no ECC',
  url: 'https://www.npmjs.com/package/emoji-smuggle-sdk',
  install: 'npm i emoji-smuggle-sdk',
  limits: 'payload sits at a single point appended to the text, not spread through it',
  get source() {
    if (!E) return 'not installed';
    try { return 'npm:emoji-smuggle-sdk@' + require('emoji-smuggle-sdk/package.json').version; }
    catch (e) { return 'npm:emoji-smuggle-sdk'; }
  },
  available() {
    if (!E || typeof E.encodeMessage !== 'function') return false;
    try { return E.decodeMessage('some cover text ' + E.encodeMessage('probe', CARRIER)) === 'probe'; }
    catch (e) { return false; }
  },
  encode(cover, msg) {
    try { return cover + ' ' + E.encodeMessage(msg, CARRIER); } catch (e) { return null; }
  },
  decode(text) {
    try { const r = E.decodeMessage(text); return (typeof r === 'string' && r.length) ? r : null; }
    catch (e) { return null; }
  }
};
