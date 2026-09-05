/*
 * samples.js — fixed text samples spanning the shapes spab has to survive.
 *
 * The synthetic corpus (corpus-gen.js) varies length and structure at scale; this
 * is the opposite: a small, hand-written, never-changing set chosen so each entry
 * stresses something different about the carriers. Fixed text matters because a
 * regression in one shape is otherwise invisible in an average.
 *
 * `carrierNotes` says what each sample is FOR, so a result table can be read
 * without going back to the text.
 */
'use strict';

var SAMPLES = [
  {
    name: 'memo',
    note: 'ordinary business prose — the baseline case',
    text: 'The board reviewed the quarterly figures on Tuesday and asked for a re-forecast ' +
      'before the end of the month. Operating costs are down year-over-year, though the ' +
      "well-documented delays on the Hartley contract haven't yet worked through the numbers. " +
      "Finance will circulate a revised model on Friday; it isn't final, and the committee's " +
      'own estimate may differ once the half-year audit closes.'
  },
  {
    name: 'punctuation-rich',
    note: 'many apostrophes and hyphens — the NFKC-durable channels are large here',
    text: "It's a well-known, old-fashioned truth that the co-operative fox-trot isn't easily " +
      "forgotten. Don't let the well-meaning re-write of a half-hearted first-draft undo what's " +
      "been hand-crafted: it's the sort of self-evident, long-standing habit that's hard-won, " +
      "and one that's rarely re-examined once it's set."
  },
  {
    name: 'punctuation-poor',
    note: 'almost no apostrophes or hyphens — whitespace is effectively the only channel',
    text: 'The river valley opened out below the ridge and the road ran down beside it for ' +
      'several miles. Farms stood at intervals along the water and beyond them the hills rose ' +
      'again in a long unbroken line. Nothing moved on the road that morning except a cart and ' +
      'the dust it raised behind it as it went.'
  },
  {
    name: 'short-lines',
    note: 'chat or dialogue — many newlines, short runs between them',
    text: 'Are you around?\nYes, just finishing the review.\nDid the numbers change?\n' +
      'Only the forecast.\nSend it when you can.\nWill do, give me ten minutes.\n' +
      'Thanks, no rush.\nIt is already in the folder.'
  },
  {
    name: 'markdown',
    note: 'structural characters and indentation — renderers strip and rewrap these',
    text: '# Quarterly notes\n\nThe **forecast** was revised on Friday.\n\n' +
      '- Costs are down year-over-year\n- The Hartley delays are unresolved\n' +
      '- A revised model follows next week\n\nSee `reports/q3.md` for the detail.'
  },
  {
    name: 'code-ish',
    note: 'indentation and symbols — whitespace runs are structural, not decorative',
    text: 'function encode(cover, message) {\n  const frame = buildFrame(message);\n' +
      '  if (!frame.length) return null;\n  return spread(frame, sites(cover));\n}\n\n' +
      'The helper above is called once per document and is not re-entrant.'
  },
  {
    name: 'long-prose',
    note: 'a long passage — plenty of capacity, the comfortable case',
    text: ('Every document carries more than its words. The spacing between them, the shape of ' +
      'a quote, the kind of dash chosen - these are choices a reader never notices, and they ' +
      'can be made on purpose. A mark is only as good as the room the text gives it, and longer ' +
      'passages give it more room. ').repeat(4)
  },
  {
    name: 'tiny',
    note: 'below any useful capacity — must fail honestly rather than silently',
    text: 'A short note with very little room.'
  },
  {
    name: 'no-spaces',
    note: 'no inter-word gaps at all (CJK-like) — the whitespace channel does not exist',
    text: '文書には言葉以上のものが含まれている。単語の間隔や引用符の形、選ばれたダッシュの種類。'
  },
  {
    name: 'pre-marked',
    note: 'already contains unicode spaces and curly quotes — carriers are not virgin',
    text: 'The report was filed late, and the author’s note — added afterwards — ' +
      'said the delay was unavoidable. Nothing here was written with a plain keyboard, ' +
      'and the spacing was never uniform to begin with.'
  }
];

function byName(n) {
  for (var i = 0; i < SAMPLES.length; i++) if (SAMPLES[i].name === n) return SAMPLES[i];
  return null;
}

module.exports = { SAMPLES: SAMPLES, byName: byName };
