#!/usr/bin/env node
/*
 * attacks.js — the documented catalogue of channel models.
 *
 * corruptions.js implements the damage; this says what each model MEANS. They are
 * separate because the meaning is what a reader needs and a one-line `note` next to
 * an implementation is not enough: "keepFrac = head kept" tells you the parameter,
 * not that the model stands in for someone quoting the first half of an email.
 *
 * Every model carries:
 *   what      what the transformation does to the text
 *   why       the real-world situation it stands in for
 *   kind      'channel'  — something that happens to documents in normal handling
 *             'attack'   — someone deliberately trying to remove a mark
 *             'control'  — must always survive; a failure here is a bug, not a result
 *   hits      which carrier families it damages, so a result is interpretable
 *
 * completeness() asserts every model in corruptions.js is documented here. A new
 * model without an entry fails the benchmark rather than appearing as an unlabelled
 * row, because an undocumented row in a published comparison is worse than no row.
 */
'use strict';
const { MODELS } = require('./corruptions.js');

const CATALOG = {
  // ---- controls -----------------------------------------------------------
  jsonTrip: { kind: 'control', hits: 'nothing',
    what: 'Serialises the text into a JSON string and parses it back.',
    why: 'Every API boundary does this. It must be lossless, so a failure here means the codec is broken, not that the channel is hostile.' },

  // ---- ordinary document handling ----------------------------------------
  trimLines: { kind: 'channel', hits: 'trailing whitespace only',
    what: 'Strips trailing whitespace from every line.',
    why: 'Most editors do this on save, and many linters enforce it. Harmless to spab because its carriers sit BETWEEN words, not at line ends — which is why the carrier was chosen there.' },
  emailQuote: { kind: 'channel', hits: 'nothing (adds a prefix per line)',
    what: 'Prefixes every line with "> ", as a reply quote does.',
    why: 'Replying to an email. Adds characters but leaves inter-word gaps intact.' },
  concat: { kind: 'channel', hits: 'carrier count (adds sites at both ends)',
    what: 'Pastes the marked text into the middle of a larger document.',
    why: 'A quoted passage inside a report. Carriers are gained rather than lost, which desynchronises any scheme that keys placement to the total.' },
  stripMd: { kind: 'channel', hits: 'nothing directly',
    what: 'Removes markdown emphasis markers.',
    why: 'A renderer or plain-text export. Changes character count without touching whitespace variants.' },
  findReplace: { kind: 'channel', hits: 'carriers inside replaced spans',
    what: 'Terminology find-and-replace across the document.',
    why: 'Rebranding, or a style guide applied late. Destroys carriers wherever it rewrites, leaves the rest.' },
  typos: { kind: 'channel', hits: 'carriers adjacent to edits',
    what: 'Per-word character typo — drop, double or transpose a letter.',
    why: 'Human editing. Local damage that leaves most of the document intact.' },
  reorder: { kind: 'channel', hits: 'carrier ORDER, not count',
    what: 'Swaps two sentences.',
    why: 'An editor moving a paragraph. Every character survives but the sequence changes, which is fatal to position-dependent schemes and survivable for self-locating ones.' },

  // ---- lossy pipelines ----------------------------------------------------
  collapseWs: { kind: 'channel', hits: 'the whitespace channel, completely',
    what: 'Collapses every run of whitespace to a single plain space.',
    why: 'Pasting into a plain-text field, an HTML renderer, or anything that normalises spacing. This is the single commonest way a whitespace watermark dies.' },
  extractText: { kind: 'channel', hits: 'the whitespace channel, completely',
    what: 'Collapses whitespace and flattens newlines.',
    why: 'Text extracted from a PDF or a rendered page. Same effect as collapseWs plus layout loss.' },
  tokenize: { kind: 'channel', hits: 'the whitespace channel, completely',
    what: 'Splits on whitespace and rejoins with single spaces.',
    why: 'A search index, or a naive normaliser in a data pipeline.' },
  reflow: { kind: 'channel', hits: 'the whitespace channel, completely',
    what: 'Re-wraps the text to a different line width.',
    why: 'A formatter or a narrower viewport. Total loss for whitespace carriers is the expected result, not a defect.' },
  nfkc: { kind: 'channel', hits: 'whitespace variants; confusables SURVIVE',
    what: 'Unicode NFKC normalisation.',
    why: 'Search, identifier handling and many security filters normalise. The reason spab runs apostrophe and hyphen channels at all: they are NFKC-durable where whitespace is not.' },
  smartQuotes: { kind: 'channel', hits: 'the apostrophe channel; ws and hyphen survive',
    what: 'Autocorrects straight quotes toward curly.',
    why: 'Word processors and some editors do it as you type. The mirror image of NFKC — it kills the channel NFKC spares.' },
  stripZw: { kind: 'attack', hits: 'zero-width carriers, completely',
    what: 'Removes all invisible characters.',
    why: 'A sanitiser, a paste filter, or an anti-steganography scrub. Total loss for zero-width schemes; substitution carriers are untouched.' },
  zwNoise: { kind: 'attack', hits: 'zero-width carriers, partially',
    what: 'Randomly substitutes zero-width characters for one another.',
    why: 'A filter that rewrites rather than removes invisibles.' },

  // ---- excerpting and truncation -----------------------------------------
  truncate: { kind: 'channel', hits: 'everything past the cut',
    what: 'Keeps a leading fraction of the document.',
    why: 'A preview, a snippet, or a length limit.' },
  truncTail: { kind: 'channel', hits: 'everything before the cut',
    what: 'Keeps a trailing fraction — the mirror of truncate.',
    why: 'Included because head-only truncation flatters any scheme that front-loads its payload. Measuring only one direction was a real bias in an earlier version of this suite.' },
  midExcerpt: { kind: 'channel', hits: 'both ends',
    what: 'Keeps a slice from the middle; neither end survives.',
    why: 'Someone quoting two paragraphs out of ten. The hardest excerpt case, because header-at-the-start schemes lose their header.' },
  cutPaste: { kind: 'channel', hits: 'everything outside the copied span',
    what: 'Copies a portion out to a new document.',
    why: 'Ordinary quoting. Differs from truncate in that the span can start anywhere.' },
  blockErasure: { kind: 'channel', hits: 'a contiguous run of carriers',
    what: 'Retypes a contiguous span, destroying its carriers.',
    why: 'A paragraph rewritten by hand. Burst damage rather than scattered.' },

  // ---- deliberate attacks -------------------------------------------------
  saltPepper: { kind: 'attack', hits: 'carriers at random',
    what: 'Randomly substitutes individual carrier characters.',
    why: 'Someone perturbing the document without knowing the scheme. Scattered damage, which repetition handles well and block-structured codes handle badly.' },
  normalize: { kind: 'attack', hits: 'a fraction of whitespace carriers',
    what: 'Collapses a fraction of carrier variants back to a plain space.',
    why: 'A partial or careless normaliser. Harder than full normalisation for a block-structured modem, because a little damage is spread across many blocks rather than destroying the channel outright.' },
  regexAttack: { kind: 'attack', hits: 'a targeted subset of variants',
    what: 'Targeted erasure of a chosen subset of carrier symbols.',
    why: 'An informed adversary who knows the alphabet. spab does not claim resistance to deliberate removal, and this model is here to measure the cost of that, not to pass.' },
  wordDelete: { kind: 'attack', hits: 'carrier COUNT (desynchronises)',
    what: 'Deletes words at random.',
    why: 'Editing, or an attacker shifting every downstream symbol. The classic insertion/deletion channel: redundancy alone does not help, because every copy shifts together.' },
  wordInsert: { kind: 'attack', hits: 'carrier COUNT (desynchronises)',
    what: 'Inserts words at random.',
    why: 'The mirror of wordDelete, and equally desynchronising.' },
  fullStrip: { kind: 'attack', hits: 'every substitution carrier',
    what: 'Replaces every carrier variant with its default form.',
    why: 'An adversary who knows the scheme. Total loss is the correct and expected outcome; it is listed so the table is honest about it rather than omitting the case.' }
};

// A model with no entry here is a documentation bug, and one that would otherwise
// show up in a published table as an unexplained row.
function completeness() {
  const implemented = Object.keys(MODELS);
  const documented = Object.keys(CATALOG);
  return {
    missing: implemented.filter(m => documented.indexOf(m) < 0),
    orphaned: documented.filter(m => implemented.indexOf(m) < 0)
  };
}
function describe(name) {
  const c = CATALOG[name], m = MODELS[name];
  if (!c || !m) return null;
  return Object.assign({ name: name, intensities: m.intensities, note: m.note }, c);
}

module.exports = { CATALOG: CATALOG, completeness: completeness, describe: describe };

if (require.main === module) {
  const gaps = completeness();
  Object.keys(MODELS).forEach(function (m) {
    const d = describe(m);
    console.log('\n' + m + '  [' + d.kind + ']  intensities ' + JSON.stringify(d.intensities));
    console.log('  what: ' + d.what);
    console.log('  why : ' + d.why);
    console.log('  hits: ' + d.hits);
  });
  console.log('\n' + Object.keys(MODELS).length + ' models, ' +
    (gaps.missing.length ? 'UNDOCUMENTED: ' + gaps.missing.join(', ') : 'all documented') +
    (gaps.orphaned.length ? ', ORPHANED: ' + gaps.orphaned.join(', ') : ''));
  if (gaps.missing.length || gaps.orphaned.length) process.exit(1);
}
