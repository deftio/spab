/*
 * The adapter contract.
 *
 * Every adapter is an object with these fields. `available()` must never throw and
 * must not be optimistic: a library that is installed but cannot actually round-trip
 * should report itself unavailable rather than produce zeros that read as poor
 * robustness. A missing library is a SKIPPED row; a failing one is a bug.
 *
 *   name       display name
 *   source     where it came from, including version, resolved at run time
 *   technique  one line: what it does to the text
 *   url        project home
 *   install    the exact command that makes available() true
 *   limits     null, or a note about payload/cover restrictions that make the
 *              comparison unequal (printed next to the row, never hidden)
 *   available()          -> boolean
 *   encode(cover, msg)   -> marked text, or null if it cannot carry this payload
 *   decode(text)         -> recovered payload, or null
 *
 * encode/decode may be synchronous or return a promise; run.js awaits either.
 */
'use strict';
module.exports = {};
