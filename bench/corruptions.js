/*
 * corruptions.js — the "channel". Each model takes (text, intensity, rng) and
 * returns a damaged copy. rng is a seeded function returning [0,1) so runs are
 * reproducible. Intensity meaning is documented per model.
 *
 * Carrier variants live at U+2006 / U+2009 / U+200A (plus U+0020). "Normalizing"
 * a carrier means collapsing it back to a plain space, which destroys its bits.
 */
'use strict';

var VARIANTS = [0x20, 0x2006, 0x2009, 0x200A];
function isCarrier(code) { return code === 0x2006 || code === 0x2009 || code === 0x200A; }
function isAnySpace(ch) { var c = ch.charCodeAt(0); return /\s/.test(ch) || c === 0x2006 || c === 0x2009 || c === 0x200A; }

// Seedable RNG (mulberry32).
function makeRng(seed) {
  var a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Salt & pepper: each carrier, with prob p, flips to a RANDOM different variant.
// Models subtle per-symbol substitution noise (not just erasure toward space).
function saltPepper(text, p, rng) {
  if (p <= 0) return text;
  var out = text.split('');
  for (var i = 0; i < out.length; i++) {
    var code = out[i].charCodeAt(0);
    if (isCarrier(code) && rng() < p) {
      var v = VARIANTS[(rng() * 4) | 0];
      out[i] = String.fromCharCode(v);
    }
  }
  return out.join('');
}

// Normalize: each carrier, with prob p, collapses to a plain space (erasure).
function normalize(text, p, rng) {
  if (p <= 0) return text;
  var out = text.split('');
  for (var i = 0; i < out.length; i++) {
    if (isCarrier(out[i].charCodeAt(0)) && rng() < p) out[i] = ' ';
  }
  return out.join('');
}

// Full strip: every carrier -> plain space. Intensity ignored. Defeat baseline.
function fullStrip(text) {
  return text.replace(/[\u2006\u2009\u200A]/g, ' ');
}

// Block erasure: normalize one contiguous span covering `frac` of the text
// (a rewritten/retyped paragraph). Position is random.
function blockErasure(text, frac, rng) {
  if (frac <= 0) return text;
  frac = Math.min(1, frac);
  var span = Math.floor(text.length * frac);
  var start = Math.floor(rng() * Math.max(1, text.length - span));
  var head = text.slice(0, start);
  var mid = text.slice(start, start + span).replace(/[\u2006\u2009\u200A]/g, ' ');
  var tail = text.slice(start + span);
  return head + mid + tail;
}

// Cut & paste excerpt: keep a contiguous middle portion of `keepFrac`
// (someone copies only part of the document). Carriers preserved within.
function cutPaste(text, keepFrac, rng) {
  if (keepFrac >= 1) return text;
  keepFrac = Math.max(0.05, keepFrac);
  var span = Math.floor(text.length * keepFrac);
  var start = Math.floor(rng() * Math.max(1, text.length - span));
  return text.slice(start, start + span);
}

// Truncate: keep the first `keepFrac` of the text.
function truncate(text, keepFrac) {
  if (keepFrac >= 1) return text;
  return text.slice(0, Math.max(1, Math.floor(text.length * keepFrac)));
}

// Word deletion (desync): each word dropped with prob p, taking its separator.
function wordDelete(text, p, rng) {
  if (p <= 0) return text;
  var parts = text.split(/(\s+)/);
  var out = [];
  for (var i = 0; i < parts.length; i += 2) {
    if (rng() >= p) { out.push(parts[i]); if (parts[i + 1] !== undefined) out.push(parts[i + 1]); }
  }
  return out.join('');
}

// Word insertion (desync): after each separator, prob p, insert a filler word + space.
var FILLER = ['and', 'the', 'a', 'then', 'soon', 'very', 'often', 'here', 'there', 'also'];
function wordInsert(text, p, rng) {
  if (p <= 0) return text;
  var parts = text.split(/(\s+)/);
  var out = [];
  for (var i = 0; i < parts.length; i += 2) {
    out.push(parts[i]);
    if (parts[i + 1] !== undefined) {
      out.push(parts[i + 1]);
      if (rng() < p) { out.push(FILLER[(rng() * FILLER.length) | 0]); out.push(' '); }
    }
  }
  return out.join('');
}

// Reflow: collapse every run of whitespace (incl. carriers) to a single plain
// space. Aggressive normalizer — models a formatter that rewraps text.
function reflow(text) {
  return text.replace(/[\s\u2006\u2009\u200A]+/g, ' ');
}

// Registry: name -> { fn, intensities, note }. Intensity semantics per note.
var MODELS = {
  saltPepper:  { fn: saltPepper,  intensities: [0.05, 0.1, 0.2, 0.4],       note: 'p = per-carrier random substitution' },
  normalize:   { fn: normalize,   intensities: [0.1, 0.25, 0.5, 0.75],      note: 'p = per-carrier collapse to space' },
  blockErasure:{ fn: blockErasure,intensities: [0.1, 0.25, 0.5],            note: 'frac = size of retyped span' },
  cutPaste:    { fn: cutPaste,    intensities: [0.75, 0.5, 0.25],           note: 'keepFrac = portion copied' },
  truncate:    { fn: truncate,    intensities: [0.75, 0.5, 0.25],           note: 'keepFrac = head kept' },
  wordDelete:  { fn: wordDelete,  intensities: [0.05, 0.1, 0.2],            note: 'p = per-word deletion (desync)' },
  wordInsert:  { fn: wordInsert,  intensities: [0.05, 0.1, 0.2],            note: 'p = per-gap insertion (desync)' },
  reflow:      { fn: function (t) { return reflow(t); }, intensities: [1],  note: 'formatter rewrap (total loss expected)' },
  fullStrip:   { fn: function (t) { return fullStrip(t); }, intensities: [1],note: 'strip all variants (total loss expected)' }
};

module.exports = { MODELS: MODELS, makeRng: makeRng, isAnySpace: isAnySpace };
