/*
 * corpora.js — varied text samples for the spab benchmark.
 * Each entry: { id, kind, text }. Kinds span length and character profile so the
 * harness can see how capacity/robustness change with the carrier text.
 */
'use strict';

var CORPORA = [
  {
    id: 'short-sms', kind: 'short',
    text: 'hey are we still on for lunch tomorrow around noon at the usual place near the park'
  },
  {
    id: 'short-headline', kind: 'short',
    text: 'Local library extends weekend hours after a sharp rise in student visits this term'
  },
  {
    id: 'medium-email', kind: 'medium',
    text: 'Hi team, quick update on the release. The build is green and staging looks stable ' +
          'after the caching fix. I moved the migration to Thursday so support has time to ' +
          'prepare the notes. Please review the changelog and flag anything that reads wrong ' +
          'before end of day. Thanks again for the fast turnaround on the regression tests.'
  },
  {
    id: 'medium-prose', kind: 'medium',
    text: 'The river moved slower here, curling around the old stone bridge where the children ' +
          'used to race paper boats after the summer rains. In the evening the light turned the ' +
          'water a soft copper, and the whole valley seemed to hold its breath before the wind ' +
          'came down from the hills carrying the smell of cut grass and distant woodsmoke.'
  },
  {
    id: 'long-article', kind: 'long',
    text: ('Whitespace watermarking hides information not in the letters of a text but in the ' +
           'spaces between them, choosing among characters that render almost identically so a ' +
           'reader sees nothing unusual. The appeal is that ordinary prose becomes a carrier ' +
           'without any visible change, and the mark travels wherever the text is copied. The ' +
           'difficulty is that text is a hostile channel: editors normalize spacing, formatters ' +
           'rewrite punctuation, and people delete or rearrange whole sentences without a second ' +
           'thought. A practical scheme therefore leans less on any single clever symbol and more ' +
           'on redundancy, spreading a small payload across the entire passage so that losing part ' +
           'of the text costs only part of the signal. ').repeat(3)
  },
  {
    id: 'punctuation-heavy', kind: 'punct',
    text: 'Well, here it is: lists, dashes, and quotes -- lots of them. "Ready?" she asked. ' +
          'Yes; absolutely, unquestionably, and (mostly) on time. Items: one, two, three; then ' +
          'four, five, six. Note: spacing between clauses varies, which is exactly the point.'
  },
  {
    id: 'markdown-ish', kind: 'markup',
    text: 'Setup notes for the service. Install the runtime, then clone the repository and copy ' +
          'the example config. Start the worker before the web process, and confirm the health ' +
          'check returns ok. If the queue backs up, scale the workers first and only then touch ' +
          'the database pool, since raising both at once tends to hide the real bottleneck.'
  }
];

// Clean control set: never encoded, used to measure the detector's false-positive rate.
var CONTROL = [
  'The committee will reconvene next week to finalize the seasonal schedule and budget.',
  'She packed the last box, checked the empty rooms twice, and locked the front door.',
  'Rainfall this month exceeded the seasonal average across most of the northern districts.',
  'Coffee first, then the standup, then the long slog through the code review backlog.',
  'A gentle wind pushed the small boats along the harbor as the market slowly opened.'
];

module.exports = { CORPORA: CORPORA, CONTROL: CONTROL };
