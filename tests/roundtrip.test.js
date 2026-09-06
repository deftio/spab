#!/usr/bin/env node
/*
 * roundtrip.test.js — CI/CD conformance smoke test for the JS reference implementation.
 * Not research (that lives in r_and_d/). Plain Node, no framework, no dependencies.
 * Exits non-zero on any failure.
 */
'use strict';

var path = require('path');
var SPAB = require(path.join(__dirname, '..', 'src', 'js', 'spab.js'));

var fails = 0;
function ok(cond, msg) { if (cond) { console.log('  ok  ' + msg); } else { console.log('  FAIL ' + msg); fails++; } }

var cover = ('The quick brown fox jumps over the lazy dog near the calm river ' +
             'while an old owl quietly watches the bright autumn morning unfold. ').repeat(6);

// 1. round-trip exact recovery
var msg = 'SPAB-CI-001';
var enc = SPAB.encode(cover, msg, {});
var dec = SPAB.decode(enc.text, {});
ok(dec.message === msg, 'round-trip recovers the message exactly');
ok(dec.metadata.status === 'perfect', 'clean decode status is "perfect"');

// 2. whitespace-only encoding leaves the visible glyphs unchanged (only spaces differ)
var encWs = SPAB.encode(cover, msg, { classes: ['ws'] });
ok(cover.replace(/\s/g, ' ') === encWs.text.replace(/\s/g, ' '), 'ws-only: visible text unchanged (only whitespace variants differ)');

// 3. clean (un-encoded) text is not falsely detected
var d2 = SPAB.decode('just some ordinary text with absolutely no watermark here at all', {});
ok(d2.metadata.status === 'not-detected' && d2.message === null, 'clean text -> not-detected (no false positive)');

// 4. fully stripped watermark is not falsely decoded
var stripped = enc.text.replace(/[\u2006\u2009\u200A]/g, " ");
var d3 = SPAB.decode(stripped, {});
ok(d3.message === null, 'stripped watermark -> no false payload');

// 5. version / algorithm descriptor is present (provenance contract)
ok(typeof SPAB.VERSION === 'string' && SPAB.algorithm && SPAB.algorithm.name, 'exports VERSION and algorithm descriptor');

// 6. confusables channel: round-trip with ws+punct classes enabled
var apos = String.fromCharCode(0x27);
// 48 repeats, not 40: the RLNC check below needs K 32-bit packets to fit in the
// NFKC-SURVIVING channels alone (apos + hyphen), and 40 repeats leaves 240 bits
// against the 256 an 8-byte packet needs — a knife edge that says nothing about the
// property being demonstrated.
var punctCover = ("It" + apos + "s a co-operative, well-known, old-fashioned fox-trot, isn" + apos + "t it, dear friend. ").repeat(48);
var pp = { classes: ['ws', 'punct'] };
var pe = SPAB.encode(punctCover, 'Hi', pp);
ok(SPAB.decode(pe.text, pp).message === 'Hi', 'ws+punct round-trip recovers the message');

// 7. confusables SURVIVE a whitespace-only strip that defeats the ws channel
var wsClass = new RegExp('[' + String.fromCharCode(0x2006) + String.fromCharCode(0x2009) + String.fromCharCode(0x200A) + ']', 'g');
var wsStripped = pe.text.replace(wsClass, ' ');
ok(SPAB.decode(wsStripped, { classes: ['ws'] }).message === null, 'ws-only channel is defeated by whitespace strip (as expected)');
ok(SPAB.decode(wsStripped, pp).message === 'Hi', 'ws+punct still recovers via the confusable channel after whitespace strip');

// 8. NFKC normalization: kills whitespace, but the confusable channels survive it
var deSpaced = pe.text.normalize('NFKC');           // NFKC collapses all whitespace variants -> U+0020
ok(SPAB.decode(deSpaced, { classes: ['ws'] }).message === null, 'ws-only channel is defeated by NFKC (as expected)');
ok(SPAB.decode(deSpaced, pp).message === 'Hi', 'default (ws+punct) survives NFKC via confusables');

// 9. Orthogonal failure: smart-quote autocorrect kills apostrophes but ws/hyphen survive
var curlyAll = pe.text.replace(new RegExp(apos, 'g'), String.fromCharCode(0x2019)); // standardize to curly
ok(SPAB.decode(curlyAll, pp).message === 'Hi', 'smart-quote autocorrect: still recovers via ws/hyphen channels');

// 10. RLNC fountain ECC: round-trip, clean-control, and cross-channel recovery under NFKC
var rp = { ecc: 'rlnc' };
var re = SPAB.encode(punctCover, 'Hi', rp);
ok(SPAB.decode(re.text, rp).message === 'Hi', 'rlnc: round-trip recovers the message');
ok(SPAB.decode('ordinary unmarked text with nothing hidden inside of it', rp).message === null, 'rlnc: clean text -> no false positive');
ok(SPAB.decode(re.text.normalize('NFKC'), rp).message === 'Hi', 'rlnc: survives NFKC by pooling packets from surviving confusable channels');

console.log(fails === 0 ? '\nPASS (all checks)' : '\nFAIL (' + fails + ' check(s))');
process.exit(fails === 0 ? 0 : 1);
