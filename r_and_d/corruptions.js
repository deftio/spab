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

// Regex symbol attack (informed adversary). `known` = fraction of the carrier
// variant set the attacker guessed and strips. 1.0 == fullStrip; a partial value
// models an attacker who only caught some variants. Deterministic given `known`.
function regexAttack(text, known) {
  if (known <= 0) return text;
  var order = [0x2006, 0x2009, 0x200A];
  var nStrip = Math.max(1, Math.round(order.length * Math.min(1, known)));
  var cls = '';
  for (var i = 0; i < nStrip; i++) cls += '\\u' + order[i].toString(16).padStart(4, '0');
  return text.replace(new RegExp('[' + cls + ']', 'g'), ' ');
}

// NFKC normalization — a common, benign transform (databases, web forms, search
// indexers). Collapses ALL whitespace variants to U+0020 (kills the ws channel) but
// leaves the confusable carriers (U+0027/U+2019, U+002D/U+2010) intact. Full transform.
function nfkc(text) {
  return text.normalize('NFKC');
}

// Smart-quote autocorrect — Word/markdown "smartening": standardizes apostrophes/quotes
// toward curly. p = fraction of apostrophe sites flipped to curly (p=1 => channel dead).
// Kills the apos confusable channel but leaves whitespace and hyphen — orthogonal to NFKC.
function smartQuotes(text, p, rng) {
  if (p <= 0) return text;
  var out = text.split('');
  for (var i = 0; i < out.length; i++) {
    var c = out[i].charCodeAt(0);
    if ((c === 0x27 || c === 0x2019) && rng() < p) out[i] = String.fromCharCode(0x2019);
  }
  return out.join('');
}


// ---------------------------------------------------------------------------
// Real-world channels. The models above are synthetic damage; these are things
// that actually happen to text between writing it and reading it back, and they
// are the ones that decide whether a mark is useful in practice.
// ---------------------------------------------------------------------------

// Paste into a plain <textarea> / form field: runs of whitespace collapse to one
// plain space. This is the single most common way a mark dies — and it takes the
// whole whitespace channel with it while leaving the confusables intact.
function collapseWhitespace(text) {
  return text.replace(/[ \u2006\u2009\u200A\t]+/g, ' ');
}

// Extraction from PDF or a rendered page: whitespace collapses AND line breaks
// become spaces, so paragraph structure is flattened too.
function extractText(text) {
  return text.replace(/\s+/g, ' ').trim();
}

// Tokenise and rejoin — what a tokeniser, a search index, or a naive
// normalisation step does. Equivalent to collapse, but also drops leading and
// trailing whitespace on every line.
function tokenizeRejoin(text) {
  return text.split(/\s+/).filter(Boolean).join(' ');
}

// Quoted in an email reply: every line gains "> ", and many clients rewrap.
function emailQuote(text) {
  return text.split('\n').map(function (l) { return '> ' + l; }).join('\n');
}

// Trailing whitespace stripped per line — most editors and linters do this on
// save, and it silently removes carriers that sit at end of line.
function trimLineEnds(text) {
  return text.split('\n').map(function (l) { return l.replace(/[ \u2006\u2009\u200A\t]+$/, ''); }).join('\n');
}

// Character-level typos: with probability p per word, drop, double or transpose a
// character. Models a human editing pass rather than a machine transform.
function typos(text, p, rng) {
  if (p <= 0) return text;
  var words = text.split(/(\s+)/);
  for (var i = 0; i < words.length; i += 2) {
    var w = words[i];
    if (w.length < 3 || rng() >= p) continue;
    var at = 1 + Math.floor(rng() * (w.length - 2));
    var pick = rng();
    if (pick < 0.34) words[i] = w.slice(0, at) + w.slice(at + 1);                    // drop
    else if (pick < 0.67) words[i] = w.slice(0, at) + w[at] + w.slice(at);           // double
    else words[i] = w.slice(0, at - 1) + w[at] + w[at - 1] + w.slice(at + 1);        // transpose
  }
  return words.join('');
}

// Find-and-replace of a common word, the way an editor updates terminology. Does
// not change the carrier count when the replacement has the same shape, so it is
// a useful control against the desync models.
function findReplace(text, p, rng) {
  var pairs = [['the', 'this'], ['and', 'plus'], ['for', 'per'], ['with', 'via']];
  var out = text;
  for (var i = 0; i < pairs.length; i++) {
    if (rng() >= p) continue;
    out = out.split(' ' + pairs[i][0] + ' ').join(' ' + pairs[i][1] + ' ');
  }
  return out;
}

// Round trip through a JSON string: escaping and unescaping is lossless for our
// carriers, so this should always survive. It is here as a control — if it ever
// fails, something is wrong with the codec rather than with the channel.
function jsonRoundTrip(text) {
  return JSON.parse(JSON.stringify(text));
}

// Sentence reordering: a real edit that preserves every character but moves the
// carriers relative to each other.
function reorderSentences(text, p, rng) {
  var parts = text.split(/(?<=\. )/);
  if (parts.length < 3 || rng() >= p) return text;
  var i = Math.floor(rng() * (parts.length - 1));
  var t = parts[i]; parts[i] = parts[i + 1]; parts[i + 1] = t;
  return parts.join('');
}

// Markdown emphasis stripped, as a renderer or a plain-text export would.
function stripMarkdown(text) {
  return text.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/[*_`]/g, '');
}

// Concatenation: the marked text is pasted into a larger document. Every carrier
// survives, but the stream gains sites at both ends.
function embedInDocument(text) {
  return 'Introduction paragraph added by someone else. ' + text +
    ' A closing paragraph, also added later, with its own spacing and punctuation.';
}


// Zero-width sanitisation. The corruption models above target whitespace VARIANTS
// (U+2006/2009/200A), which is fair to the substitution carriers and blind to the
// zero-width ones — a zero-width scheme sails through a suite written for
// whitespace. These two attack the other channel so a comparison can be even.
// Both are real: sanitisers, CMS paste filters and diff tools strip invisible
// characters routinely, and it is the best-known weakness of the whole
// zero-width family.
function stripZeroWidth(text) {
  return text.replace(/[\u200B\u200C\u200D\u2060\uFEFF\u202C]/g, '');
}
function zeroWidthNoise(text, p, rng) {
  if (p <= 0) return text;
  var ZWSET = '\u200B\u200C\u200D\u2060';
  var out = text.split('');
  for (var i = 0; i < out.length; i++) {
    if (ZWSET.indexOf(out[i]) >= 0 && rng() < p) out[i] = ZWSET[Math.floor(rng() * 4)];
  }
  return out.join('');
}


// Keep the TAIL rather than the head. `truncate` keeps the head, which quietly
// favours any scheme that puts its payload at the start of the document — a
// point-insertion scheme anchored at the first space can never lose to it. The
// mirror case is just as common in practice (quoting the end of a thread, taking
// the closing paragraphs) and is what makes a head/tail pair fair.
function truncateTail(text, keepFrac) {
  var n = Math.max(1, Math.floor(text.length * keepFrac));
  return text.slice(text.length - n);
}
function middleExcerpt(text, keepFrac) {
  var n = Math.max(1, Math.floor(text.length * keepFrac));
  var start = Math.floor((text.length - n) / 2);
  return text.slice(start, start + n);
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
  nfkc:        { fn: function (t) { return nfkc(t); }, intensities: [1],    note: 'NFKC normalization — kills whitespace variants, confusables survive' },
  smartQuotes: { fn: smartQuotes, intensities: [0.5, 1.0],                  note: 'quote autocorrect toward curly — kills apostrophe channel, ws/hyphen survive' },
  regexAttack: { fn: function (t, k) { return regexAttack(t, k); }, intensities: [0.34, 0.67, 1.0], note: 'channel noise: targeted partial erasure of a symbol subset (informed regex; 1.0 = full)' },
  fullStrip:   { fn: function (t) { return fullStrip(t); }, intensities: [1],note: 'strip all variants (total loss expected)' },

  // --- real-world channels (see notes above) ---
  collapseWs:  { fn: function (t) { return collapseWhitespace(t); }, intensities: [1], real: true,
    note: 'paste into a plain text field — whitespace runs collapse (kills ws channel)' },
  extractText: { fn: function (t) { return extractText(t); }, intensities: [1], real: true,
    note: 'PDF / rendered-page extraction — all whitespace collapses, newlines flatten' },
  tokenize:    { fn: function (t) { return tokenizeRejoin(t); }, intensities: [1], real: true,
    note: 'tokenise and rejoin (search index, naive normaliser)' },
  emailQuote:  { fn: function (t) { return emailQuote(t); }, intensities: [1], real: true,
    note: 'quoted in a reply — every line gains a prefix' },
  trimLines:   { fn: function (t) { return trimLineEnds(t); }, intensities: [1], real: true,
    note: 'editor strips trailing whitespace on save' },
  typos:       { fn: typos,       intensities: [0.05, 0.15, 0.3], real: true,
    note: 'p = per-word character typo (drop / double / transpose)' },
  findReplace: { fn: findReplace, intensities: [0.5, 1.0], real: true,
    note: 'terminology find-and-replace across the document' },
  jsonTrip:    { fn: function (t) { return jsonRoundTrip(t); }, intensities: [1], real: true,
    note: 'round trip through a JSON string (control: must always survive)' },
  reorder:     { fn: reorderSentences, intensities: [1], real: true,
    note: 'two sentences swapped — characters preserved, carriers move' },
  stripMd:     { fn: function (t) { return stripMarkdown(t); }, intensities: [1], real: true,
    note: 'markdown emphasis stripped by a renderer or plain-text export' },
  concat:      { fn: function (t) { return embedInDocument(t); }, intensities: [1], real: true,
    note: 'pasted into a larger document — carriers gained at both ends' },

  // --- zero-width channel (kept even with the whitespace models above) ---
  truncTail:   { fn: truncateTail, intensities: [0.75, 0.5, 0.25], real: true,
    note: 'keepFrac = TAIL kept (mirror of truncate; fair to payload placement)' },
  midExcerpt:  { fn: middleExcerpt, intensities: [0.5, 0.25], real: true,
    note: 'keepFrac = middle slice kept (neither end survives)' },
  stripZw:     { fn: function (t) { return stripZeroWidth(t); }, intensities: [1], real: true, zw: true,
    note: 'sanitiser strips invisible characters — total loss for zero-width schemes' },
  zwNoise:     { fn: zeroWidthNoise, intensities: [0.1, 0.3], zw: true,
    note: 'p = per-zero-width-char random substitution' }
};

module.exports = { MODELS: MODELS, makeRng: makeRng, isAnySpace: isAnySpace };
