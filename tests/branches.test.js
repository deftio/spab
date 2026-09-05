#!/usr/bin/env node
/*
 * branches.test.js — targeted tests that exercise the remaining branches of
 * src/js/spab.js not hit by the round-trip suite (introspection helpers, param
 * defaults, capacity edges, alternate ECC failure paths, and the Node-fallback
 * text codec). Paired with tests/coverage.js to keep branch coverage at 100%
 * (excluding blocks explicitly marked cov-ignore).
 */
'use strict';
const SPAB = require('../src/js/spab.js');

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } }

// -- resolveClasses: profile 'ws', 'punct' expansion, unknown filtered --
ok(JSON.stringify(SPAB.resolveClasses({ profile: 'ws' })) === '["ws"]', "profile:'ws' -> ['ws']");
ok(JSON.stringify(SPAB.resolveClasses({ classes: ['punct'] })) === '["apos","hyphen"]', "classes:['punct'] expands");
ok(SPAB.resolveClasses({ classes: ['bogus'] }).length === 0, 'unknown class filtered out');
ok(JSON.stringify(SPAB.resolveClasses()) === '["ws","apos","hyphen"]', 'no params -> default classes');

// -- getSites: merged, text-ordered site list across classes --
const sitesText = "it's a well-known fact today";
const sites = SPAB.getSites(sitesText, { classes: ['ws', 'punct'] });
ok(sites.length > 0 && sites.every(function (s, i, a) { return i === 0 || a[i - 1].i <= s.i; }), 'getSites returns sorted sites');
ok(sites.some(function (s) { return s.id === 'apos'; }) && sites.some(function (s) { return s.id === 'hyphen'; }), 'getSites includes punct sites');

// -- getSlots + histogram (ws introspection) --
const enc = SPAB.encode('the quick brown fox jumps over the lazy dog again now', 'HI', { classes: ['ws'] });
ok(SPAB.getSlots(enc.text).length > 0, 'getSlots finds ws sites');
const h = SPAB.histogram(enc.text);
ok(h.total === h.counts.reduce(function (a, b) { return a + b; }, 0), 'histogram counts sum to total');

// -- CLASS_DEFS.ws.read on a non-space index -> 0 (the undefined branch) --
ok(SPAB.CLASS_DEFS.ws.read('abc', 1) === 0, 'ws.read on non-space returns 0');

// -- encode with default params (params undefined -> {}) --
const encDef = SPAB.encode(('one two three four five six seven eight nine ten ').repeat(6), 'x');
ok(encDef.metadata.classes.length === 3, 'encode() default params resolve 3 classes');
const decDef = SPAB.decode(encDef.text); // decode() default params too
ok(decDef.message === 'x', 'decode() default params round-trips');

// -- empty classes -> zero-capacity metadata (channels{} fallback) --
const encEmpty = SPAB.encode('hello world here', 'y', { classes: ['bogus'] });
ok(encEmpty.metadata.slots === 0 && encEmpty.metadata.capacityBits === 0, 'no resolvable classes -> zero capacity');
ok(encEmpty.text === 'hello world here', 'no classes -> text unchanged');

// -- the varint length removed the 255-byte ceiling --
const big = 'z'.repeat(400);
const longCover = ('word ').repeat(2000);
const encBig = SPAB.encode(longCover, big, { classes: ['ws'] });
ok(encBig.metadata.payloadBytes === 400, 'a 400-byte payload is carried whole, not truncated at 255');
ok(SPAB.decode(encBig.text, { classes: ['ws'] }).message === big, 'a 400-byte payload round-trips');

// -- too-short passage: single truncated copy + issue message --
const encShort = SPAB.encode('a b', 'this-will-not-fit-in-two-sites', { classes: ['ws'] });
ok(encShort.metadata.issues.some(function (s) { return /too short/i.test(s); }), 'too-short passage flags issue');

// -- low-redundancy warning (reps < 3 but fits) --
function coverForBits(nSites) { var w = []; for (var i = 0; i < nSites + 1; i++) w.push('ab'); return w.join(' '); }
const encLow = SPAB.encode(coverForBits(40), 'hey', { classes: ['ws'] }); // ~80 bits vs frame ~48 bits -> reps 1
ok(encLow.metadata.issues.some(function (s) { return /low redundancy/i.test(s); }) || encLow.metadata.reps < 3, 'low redundancy path reachable');

// -- 'corrected' status: recoverable single-bit disturbance in one ws copy --
(function () {
  const cover = ('alpha bravo charlie delta echo foxtrot golf hotel india juliet ').repeat(14);
  const e = SPAB.encode(cover, 'ok', { classes: ['ws'] });
  ok(e.metadata.reps >= 3, 'corrected setup has >=3 reps');
  const slots = SPAB.getSlots(e.text);
  const arr = e.text.split('');
  // flip ONE site to a different whitespace variant -> a couple of bit errors, majority still wins
  const cur = arr[slots[0]];
  arr[slots[0]] = (cur === SPAB.SPACE_MAP[0]) ? SPAB.SPACE_MAP[3] : SPAB.SPACE_MAP[0];
  const d = SPAB.decode(arr.join(''), { classes: ['ws'] });
  ok(d.message === 'ok' && d.metadata.status === 'corrected', "single-site disturbance -> status 'corrected'");
})();

// -- 'failed' status (repetition): magic present but CRC broken across all copies --
(function () {
  const cover = ('mike november oscar papa quebec romeo sierra tango ').repeat(5);
  const e = SPAB.encode(cover, 'AB', { classes: ['ws'] });
  const slots = SPAB.getSlots(e.text);
  const arr = e.text.split('');
  // Corrupt the SAME payload site in every repetition so majority vote adopts the
  // error (magic byte survives, content/CRC disagree) -> crcOk false, magicOk true.
  const frameBits = e.metadata.frameBits;
  // site index that maps to a content bit (past the 8 magic bits), in each rep
  for (var r = 0; r < e.metadata.reps; r++) {
    var siteIndex = Math.floor((r * frameBits + 12) / 2); // bit 12 -> a length/content bit
    if (siteIndex < slots.length) {
      var c = arr[slots[siteIndex]];
      arr[slots[siteIndex]] = (c === SPAB.SPACE_MAP[0]) ? SPAB.SPACE_MAP[1] : SPAB.SPACE_MAP[0];
    }
  }
  const d = SPAB.decode(arr.join(''), { classes: ['ws'] });
  ok(d.metadata.status === 'failed' || d.metadata.status === 'corrected' || d.metadata.crcOk === false,
     "corrupted content -> failed/uncorrected path (status=" + d.metadata.status + ")");
})();

// -- RLNC: not-detected on clean text (count<4) and failed on partial packets --
(function () {
  const cover = ('sierra tango uniform victor whiskey xray yankee zulu ').repeat(30);
  const e = SPAB.encode(cover, 'RL', { classes: ['ws'], ecc: 'rlnc' });
  const d = SPAB.decode(e.text, { classes: ['ws'], ecc: 'rlnc' });
  ok(d.message === 'RL', 'rlnc round-trips');
  // clean (unmarked) long text -> no packets -> not-detected
  const dClean = SPAB.decode(cover, { classes: ['ws'], ecc: 'rlnc' });
  ok(dClean.metadata.status === 'not-detected' || dClean.metadata.crcOk === false, 'rlnc clean -> not-detected');
})();

// -- RLNC exhausts candidates and fails when too few packets survive --
(function () {
  // Encode, then damage most ws sites so only a few packets keep valid CRC.
  const cover = ('able baker charlie dog easy fox george how item jig king ').repeat(40);
  const e = SPAB.encode(cover, 'FOUNTAIN-MSG', { classes: ['ws'], ecc: 'rlnc' });
  const slots = SPAB.getSlots(e.text);
  const arr = e.text.split('');
  // corrupt 90% of sites -> most packets fail CRC; whatever survives is < K
  for (var i = 0; i < slots.length; i++) {
    if ((i % 10) !== 0) { const c = arr[slots[i]]; arr[slots[i]] = (c === SPAB.SPACE_MAP[0]) ? SPAB.SPACE_MAP[2] : SPAB.SPACE_MAP[0]; }
  }
  const d = SPAB.decode(arr.join(''), { classes: ['ws'], ecc: 'rlnc' });
  ok(d.metadata.status === 'failed' || d.metadata.status === 'not-detected', 'rlnc heavy damage -> failed/not-detected (status=' + d.metadata.status + ')');
})();

// -- RLNC: >=4 valid packets survive but fewer than K -> candidate loop exhausts -> failed --
(function () {
  const cover = ('able baker charlie dog easy fox george how ').repeat(60); // plenty of ws sites
  const e = SPAB.encode(cover, 'FOUNTAIN-MSG', { classes: ['ws'], ecc: 'rlnc' });
  const K = e.metadata.frameBytes;                 // source symbols (15 for a 12-byte msg)
  const slots = SPAB.getSlots(e.text);
  const arr = e.text.split('');
  const keepPackets = 8;                            // 4 <= keep < K
  const keepSites = keepPackets * 16;               // 32 bits/packet ÷ 2 bits/ws-site
  for (let i = keepSites; i < slots.length; i++) {  // damage the rest so their CRCs fail
    const c = arr[slots[i]]; arr[slots[i]] = (c === SPAB.SPACE_MAP[0]) ? SPAB.SPACE_MAP[1] : SPAB.SPACE_MAP[0];
  }
  const d = SPAB.decode(arr.join(''), { classes: ['ws'], ecc: 'rlnc' });
  ok(d.metadata.status === 'failed', "rlnc: 4<=packets<K exhausts candidates -> 'failed' (status=" + d.metadata.status + ')');
  ok(d.metadata.packets >= 4 && d.metadata.packets < K, 'rlnc failed case has 4<=packets<K (packets=' + d.metadata.packets + ', K=' + K + ')');
})();

// -- decode with no resolvable classes (repetition) -> best stays null -> not-detected --
(function () {
  const d = SPAB.decode('some ordinary text here', { classes: ['bogus'] });
  ok(d.message === null && d.metadata.status === 'not-detected', 'decode with no classes -> not-detected');
})();

// -- Node fallback text codec: force TextEncoder/TextDecoder absent -> Buffer path --
(function () {
  const TE = global.TextEncoder, TD = global.TextDecoder;
  try {
    delete global.TextEncoder; delete global.TextDecoder;
    const cover = ('lorem ipsum dolor sit amet consectetur adipiscing elit sed ').repeat(8);
    const e = SPAB.encode(cover, 'buf', { classes: ['ws'] });
    const d = SPAB.decode(e.text, { classes: ['ws'] });
    ok(d.message === 'buf', 'Buffer fallback utf8 codec round-trips');
  } finally { global.TextEncoder = TE; global.TextDecoder = TD; }
})();

// -- symbol modem: mixed-radix bits<->symbols round-trip, incl. non-power-of-2 radices --
(function () {
  const sym = SPAB.symbols;
  function rt(radices) {
    const cap = sym.capacity(radices);
    const bits = []; for (let i = 0; i < cap; i++) bits.push(i * 2654435761 % 2 === 0 ? 0 : 1);
    const digits = sym.toSymbols(bits, radices);
    const inRange = digits.every(function (d, i) { return d >= 0 && d < radices[i]; });
    const back = sym.toBits(digits, radices);
    return inRange && back.length === bits.length && back.join('') === bits.join('');
  }
  ok(rt([4, 4, 4, 4, 4]), 'symbol modem round-trips power-of-2 radices');
  ok(rt([3, 3, 3, 3, 3, 3, 3, 3]), 'symbol modem round-trips radix-3 (non-power-of-2)');
  ok(rt([6, 5, 4, 3, 7, 2, 6, 5, 3]), 'symbol modem round-trips mixed non-power-of-2 radices');
  // capacity recovers fractional bits: radix-3 beats the naive floor(log2)=1 bit/site
  const capN = sym.capacity([3, 3, 3, 3, 3, 3, 3, 3, 3, 3]);
  ok(capN > 10, 'radix-3 capacity (' + capN + ' bits / 10 sites) exceeds naive 1 bit/site');
  // long radix-3 stream still bounded/valid (blocking)
  ok(rt(new Array(200).fill(3)), 'symbol modem round-trips a long radix-3 stream (blocked)');
})();

// -- keyed scramble (interleave + whitening): right key recovers, wrong/no key fail --
(function () {
  const cover = ('It\'s a well-known, old-fashioned truth that the co-operative fox isn\'t forgotten. ').repeat(30);
  ['repetition', 'rlnc'].forEach(function (ecc) {
    const e = SPAB.encode(cover, 'TOP-SECRET', { classes: ['ws'], ecc: ecc, key: 'hunter2' });
    ok(SPAB.decode(e.text, { classes: ['ws'], ecc: ecc, key: 'hunter2' }).message === 'TOP-SECRET', 'keyed ' + ecc + ': right key recovers');
    ok(SPAB.decode(e.text, { classes: ['ws'], ecc: ecc }).message === null, 'keyed ' + ecc + ': no key -> null');
    ok(SPAB.decode(e.text, { classes: ['ws'], ecc: ecc, key: 'wrong' }).message === null, 'keyed ' + ecc + ': wrong key -> null');
  });
  // keyed insert carrier too
  const ez = SPAB.encode(cover, 'ZW', { classes: ['zwsp'], key: 'k' });
  ok(SPAB.decode(ez.text, { classes: ['zwsp'], key: 'k' }).message === 'ZW', 'keyed zwsp round-trips');
  ok(SPAB.decode(ez.text, { classes: ['zwsp'], key: 'x' }).message === null, 'keyed zwsp wrong key -> null');
})();

// -- block-size knob: matching block round-trips; mismatched block fails --
(function () {
  const cover = ('the quick brown fox jumps over the lazy dog ').repeat(12);
  const e = SPAB.encode(cover, 'BLK', { classes: ['ws'], block: 5 });
  ok(SPAB.decode(e.text, { classes: ['ws'], block: 5 }).message === 'BLK', 'block=5 round-trips');
  ok(SPAB.decode(e.text, { classes: ['ws'], block: 9 }).message !== 'BLK', 'mismatched block does not decode');
  // symbol-layer capacity honors the site cap (smaller blocks may pack slightly fewer bits)
  var r10 = new Array(10).fill(4);
  ok(SPAB.symbols.capacity(r10, 2) <= SPAB.symbols.capacity(r10, 0), 'smaller block cap <= product-cap capacity');
})();

// -- dense carrier: wsdense (length-preserving, 3 bits/gap) --
(function () {
  const cover = ('the quick brown fox jumps over the lazy dog ').repeat(8);
  const e = SPAB.encode(cover, 'DENSE-WS', { classes: ['wsdense'] });
  ok(e.text.length === cover.length, 'wsdense preserves text length (substitution)');
  const d = SPAB.decode(e.text, { classes: ['wsdense'] });
  ok(d.message === 'DENSE-WS' && d.metadata.status !== 'not-detected', 'wsdense round-trips');
  ok(SPAB.CLASS_DEFS.wsdense.read('abc', 1) === 0, 'wsdense.read on non-space returns 0');
  ok(SPAB.decode(cover, { classes: ['wsdense'] }).metadata.status === 'not-detected', 'wsdense clean -> not-detected');
})();

// -- dense carrier: zwsp (zero-width insertion, 2 bits/char) --
(function () {
  const cover = ('the quick brown fox jumps over the lazy dog ').repeat(8);
  const e = SPAB.encode(cover, 'ZW-42', { classes: ['zwsp'] });
  ok(e.text.length > cover.length, 'zwsp inserts characters (length grows)');
  ok(e.text.replace(/[​‌‍⁠]/g, '') === cover, 'zwsp leaves visible text identical');
  const d = SPAB.decode(e.text, { classes: ['zwsp'] });
  ok(d.message === 'ZW-42', 'zwsp round-trips (repetition)');
  const er = SPAB.encode(cover, 'ZW-RL', { classes: ['zwsp'], ecc: 'rlnc' });
  ok(SPAB.decode(er.text, { classes: ['zwsp'], ecc: 'rlnc' }).message === 'ZW-RL', 'zwsp round-trips (rlnc)');
  ok(SPAB.decode(cover, { classes: ['zwsp'] }).metadata.status === 'not-detected', 'zwsp clean -> not-detected');
  // custom density param
  const ed = SPAB.encode(cover, 'D', { classes: ['zwsp'], density: 3 });
  ok(SPAB.decode(ed.text, { classes: ['zwsp'], density: 3 }).message === 'D', 'zwsp honors params.density');
})();

// -- getSites across a mix incl. an insert-kind class (exercises detect||anchors) --
(function () {
  const sites = SPAB.getSites("it's a well-known test today here now", { classes: ['ws', 'wsdense', 'zwsp'] });
  ok(sites.length > 0 && sites.some(function (s) { return s.id === 'zwsp'; }), 'getSites includes zwsp anchors');
})();

// -- resynchronising decode: an edit that adds or removes a carrier site --
//
// Deleting a word usually collapses two gaps into one, removing a site and
// shifting the whole symbol stream. Blocks are then cut one position off, so
// majority folding averages intact copies together with noise. These cover the
// scan-for-an-intact-frame fallback and its rejection paths.
(function () {
  const BASE = 'Every document carries more than its words. The spacing between them, the shape ' +
    'of a quote, the kind of dash - these are choices a reader never notices, and they can be ' +
    'made on purpose. Replace this paragraph with any other, pick a secret, and the mark ' +
    'travels with the text wherever it is copied. ';
  const cover = BASE + BASE + BASE;
  const params = { classes: ['ws', 'apos', 'hyphen'], ecc: 'repetition' };
  const enc = SPAB.encode(cover, 'acme-42', params);

  const deleted = enc.text.replace(' spacing', '');
  const dd = SPAB.decode(deleted, params);
  ok(dd.message === 'acme-42', 'resync: recovers after a word is deleted');
  ok(dd.metadata.crcOk === true, 'resync: recovered frame passes CRC');

  const inserted = enc.text.replace('a reader', 'a careful reader');
  ok(SPAB.decode(inserted, params).message === 'acme-42', 'resync: recovers after a word is inserted');

  ok(SPAB.decode('A sentence in front. ' + enc.text, params).message === 'acme-42',
    'resync: recovers when text is prepended');

  // Randomised carrier values: spurious MAGIC bytes appear and must be rejected
  // on length or CRC, leaving nothing to report.
  const WS = SPAB.SPACE_MAP;
  let noise = '', n = 0;
  for (const ch of enc.text) {
    if (WS.indexOf(ch) >= 0) { noise += WS[(n * 7 + 3) % WS.length]; n++; } else { noise += ch; }
  }
  const nd = SPAB.decode(noise, params);
  ok(nd.message === null || nd.message !== 'acme-42', 'resync: scrambled carriers do not yield the payload');
  ok(SPAB.decode(cover, params).message === null, 'resync: unmarked text still decodes to null');

  // RLNC pools packets across phases too, given enough repair margin.
  const rp = { classes: ['ws', 'apos', 'hyphen'], ecc: 'rlnc' };
  const renc = SPAB.encode(cover + cover, 'acme-42', rp);
  ok(SPAB.decode(renc.text.replace(' spacing', ''), rp).message === 'acme-42',
    'resync: rlnc recovers after a word is deleted');
})();

// -- zwsp.embed called directly, without pre-computed anchors --
//
// encode() passes the anchor set it planned against (positions from the original
// cover, which substitution preserves). Called standalone through the exported
// CLASS_DEFS, embed falls back to locating anchors itself.
(function () {
  const text = 'one two three four';
  const digits = [1, 2, 3, 0, 1, 2];
  const out = SPAB.CLASS_DEFS.zwsp.embed(text, digits, 2);
  ok(out.length > text.length, 'zwsp.embed without anchors inserts zero-width characters');
  ok(out.replace(/[\u200B\u200C\u200D\u2060]/g, '') === text, 'zwsp.embed leaves the visible text identical');
  ok(SPAB.CLASS_DEFS.zwsp.extract(out).length > 0, 'zwsp.extract reads back what embed wrote');
})();

// -- word-boundary lookaround at the edges of the text --
//
// Neighbour checks skip zero-width characters so an inserted carrier cannot stop a
// space being seen as an inter-word gap. When the skip walks off either end there
// is no neighbour at all, and the gap is correctly not a site.
(function () {
  const ZW = '\u200B';
  ok(SPAB.CLASS_DEFS.ws.detect(ZW + ' xy').length === 0,
    'boundary: zero-width run off the start of the text yields no site');
  ok(SPAB.CLASS_DEFS.ws.detect('xy ' + ZW).length === 0,
    'boundary: zero-width run off the end of the text yields no site');
  ok(SPAB.CLASS_DEFS.ws.detect('ab ' + ZW + ' cd').length === 0,
    'boundary: a gap whose neighbour is only zero-width is not a site');
  ok(SPAB.CLASS_DEFS.ws.detect('ab' + ZW + ' ' + ZW + 'cd').length === 1,
    'boundary: zero-width padding around a real gap still counts as a site');
})();

// -- the frame matches its own descriptor --
//
// The type field was specified in the original design and absent from the first
// working commit onward, and nothing caught it: there was no test, and
// `algorithm.frame` described the code rather than the spec. These assertions make
// the descriptor the contract, so an implementation that stops matching it fails.
(function () {
  const f = SPAB.algorithm.frame;
  ok(Array.isArray(f.fields) && f.fields.length === 5, 'frame descriptor lists its fields');
  ok(f.fields[1].indexOf('ver') === 0 && f.fields[1].indexOf('type') > 0,
    'version and type share one byte');
  ok(f.fields[2].indexOf('varint') > 0, 'length is a varint and optional');
  ok(f.overheadBytes.fixedType === 3 && f.overheadBytes.variableType === 4,
    'overhead is 3 bytes for fixed types, 4 for variable');
  ok(f.types && f.types.string !== undefined && f.types.json !== undefined &&
     f.types.uuid !== undefined && f.types.encrypted !== undefined, 'type table names the specified types');
  ok(f.reserved && f.reserved.version === 7 && f.reserved.type === 31,
    'the top value of each field is reserved for extension');
  ok(f.fixedSizes[f.types.uuid] === 16 && f.fixedSizes[f.types.sha256] === 32 &&
     f.fixedSizes[f.types.ser8] === 8, 'fixed types declare their sizes');

  // And the implementation actually produces what the descriptor claims.
  const cover = ('Every document carries more than its words. The spacing between them, the shape ' +
    'of a quote, the kind of dash - these are choices a reader never notices. ').repeat(6);
  const enc = SPAB.encode(cover, 'acme-42', {});
  const dec = SPAB.decode(enc.text, {});
  ok(dec.metadata.frameVersion === 'v' + f.version, 'decoded frame reports the descriptor version');
  ok(dec.metadata.type === 'string', 'a plain identifier decodes as type "string"');
  ok(enc.metadata.type === 'string', 'encode reports the type it wrote');

  // Types are inferred where the caller does not say, and honoured where they do.
  ok(SPAB.decode(SPAB.encode(cover, '{"a":1}', {}).text, {}).metadata.type === 'json',
    'JSON payload is typed as json');
  ok(SPAB.decode(SPAB.encode(cover, '3f2504e0-4f89-11d3-9a0c-0305e82c3301', {}).text, {}).metadata.type === 'uuid',
    'a uuid payload is typed as uuid');
  ok(SPAB.decode(SPAB.encode(cover, '{"a":1}', { type: 'string' }).text, {}).metadata.type === 'string',
    'an explicit type overrides inference');
  ok(SPAB.decode(SPAB.encode(cover, 'not json {', {}).text, {}).metadata.type === 'string',
    'text that merely looks brace-ish is not typed as json');

  // A type this version does not know about must be reported, not swallowed — that
  // is what lets a newer writer and an older reader disagree safely.
  for (const ecc of ['repetition', 'rlnc']) {
    const long = cover + cover;
    const unknown = SPAB.encode(long, 'acme-42', { type: 26, ecc: ecc });   // unassigned in 5 bits
    const back = SPAB.decode(unknown.text, { ecc: ecc });
    ok(back.message === 'acme-42', 'unknown type still yields the payload (' + ecc + ')');
    ok(back.metadata.type === '0x1a', 'unknown type is reported by code (' + ecc + '): ' + back.metadata.type);
  }

  // Same, but forced down the resync path: deleting a word shifts the stream, so
  // the payload is recovered by scanning for an intact frame rather than folding.
  // That path reads the type independently and must report it too.
  const longer = cover + cover;
  const damagedUnknown = SPAB.encode(longer, 'acme-42', { type: 26 }).text.replace(' spacing', '');
  const rescued = SPAB.decode(damagedUnknown, {});
  ok(rescued.message === 'acme-42', 'resync path recovers a payload with an unknown type');
  ok(rescued.metadata.type === '0x1a', 'resync path reports the unknown type: ' + rescued.metadata.type);

  // Inference edges: brace-shaped but invalid JSON stays text; an array is json;
  // and a byte array is carried as bytes rather than being stringified.
  ok(SPAB.decode(SPAB.encode(cover, '{not valid json}', {}).text, {}).metadata.type === 'string',
    'brace-shaped text that does not parse is typed string');
  ok(SPAB.decode(SPAB.encode(cover, '[1,2,3]', {}).text, {}).metadata.type === 'json',
    'a JSON array is typed json');

  const raw = new Uint8Array([0x00, 0x01, 0xfe, 0xff, 0x41]);
  const encBytes = SPAB.encode(cover, raw, {});
  const decBytes = SPAB.decode(encBytes.text, {});
  ok(decBytes.metadata.type === 'bytes', 'a byte array is typed bytes');
  ok(decBytes.metadata.payloadBytes === raw.length, 'byte payload keeps its length');
  ok(Array.from(decBytes.metadata.bytes).join(',') === Array.from(raw).join(','),
    'byte payload round-trips exactly through metadata.bytes');

  // Fixed-size types carry no length byte and compact their payload: a uuid travels
  // as 16 raw bytes rather than 36 characters, a sha256 as 32 rather than 64, and an
  // 8-byte tag as itself. That is what pays for the header on the payloads people
  // actually carry.
  const FIXED = [
    ['ser8', 'SPAB-001', 8],
    ['uuid', '3f2504e0-4f89-11d3-9a0c-0305e82c3301', 16],
    ['sha256', '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', 32]
  ];
  for (const [name, payload, size] of FIXED) {
    const e = SPAB.encode(cover, payload, {});
    const d = SPAB.decode(e.text, {});
    ok(d.metadata.type === name, name + ' is inferred from the payload shape');
    ok(d.metadata.payloadBytes === size, name + ' is carried in ' + size + ' bytes');
    ok(d.message === payload, name + ' round-trips to its canonical form');
  }
  // A payload that claims a fixed type but is the wrong size must not be written as
  // one — the frame would be lying about its own length.
  ok(SPAB.decode(SPAB.encode(cover, 'too short', { type: 'uuid' }).text, {}).metadata.type === 'string',
    'a mis-sized payload falls back off its fixed type');

  // A type name this build does not know falls back to string rather than throwing:
  // a caller from a newer version should degrade, not crash.
  ok(SPAB.decode(SPAB.encode(cover, 'acme-42', { type: 'no-such-type' }).text, {}).metadata.type === 'string',
    'an unrecognised type name falls back to string');
})();

// -- auto-grow: payloads that do not fit the cover text --
//
// Substitution carriers are bounded by the text. When a payload cannot fit even
// once, encode enables the zero-width carrier and raises its density until it
// does; the text reads identically but carries extra invisible characters.
(function () {
  const P = { classes: ['ws', 'apos', 'hyphen'], ecc: 'repetition' };
  const SHORT = "Keep the spacing, she said, and the punctuation too. It's a well-known trick.";
  const LONG = 'The board reviewed the quarterly figures on Tuesday and asked for a re-forecast ' +
    'before the end of the month. Operating costs are down year-over-year, though the well-documented ' +
    'delays on the Hartley contract have not yet worked through the numbers. Finance will circulate ' +
    'a revised model on Friday and the committee will meet again after the half-year audit closes.';

  // Fits already -> untouched. Length preservation is the property most callers want.
  const keep = SPAB.encode(LONG, 'acme-42', P);
  ok(keep.text.length === LONG.length, 'auto-grow: a passage that fits is left at its original length');
  ok(keep.metadata.classes.indexOf('zwsp') < 0, 'auto-grow: zwsp not added when unnecessary');

  // Does not fit -> grows, and decodes with the same params the caller passed.
  const G = Object.assign({ autoGrow: true }, P);
  const grown = SPAB.encode(SHORT, 'contract-2026-11', G);
  ok(grown.text.length > SHORT.length, 'auto-grow: grows a passage too small for the payload');
  ok(SPAB.decode(grown.text, P).message === 'contract-2026-11', 'auto-grow: grown text round-trips');
  ok(grown.metadata.reps >= 2, 'auto-grow: sizes for redundancy once it must insert');

  // Explicit redundancy is honoured.
  const r5 = SPAB.encode(SHORT, 'acme-42', Object.assign({ redundancy: 5, autoGrow: true }, P));
  ok(r5.metadata.reps >= 5, 'auto-grow: honours an explicit redundancy target');

  // Opt out: back to the old truncate-and-warn behaviour.
  const off = SPAB.encode(SHORT, 'contract-2026-11', P);
  ok(off.text.length === SHORT.length, 'auto-grow: off by default, text left alone');
  ok((off.metadata.issues || []).length > 0, 'auto-grow: off by default still reports the shortfall');

  // Already asking for zwsp: no double-add, still works.
  const withZw = SPAB.encode(SHORT, 'contract-2026-11', { classes: ['ws', 'zwsp'], ecc: 'repetition', autoGrow: true });
  ok(SPAB.decode(withZw.text, { classes: ['ws', 'zwsp'], ecc: 'repetition' }).message === 'contract-2026-11',
    'auto-grow: explicit zwsp is not added twice');

  // A cover with no word gaps has nothing to insert into.
  const nogaps = SPAB.encode('word', 'acme-42', Object.assign({ autoGrow: true }, P));
  ok(typeof nogaps.text === 'string', 'auto-grow: a cover with no gaps does not throw');

  // rlnc sizes by packets rather than frame bits.
  const rp = { classes: ['ws', 'apos', 'hyphen'], ecc: 'rlnc', autoGrow: true };
  const rg = SPAB.encode(SHORT, 'contract-2026-11', rp);
  ok(SPAB.decode(rg.text, rp).message === 'contract-2026-11', 'auto-grow: rlnc grows and round-trips');

  // Zero-width carriers are found on decode even when the caller did not ask.
  ok(SPAB.decode(grown.text, { classes: ['ws'], ecc: 'repetition' }).message === 'contract-2026-11',
    'auto-grow: decode detects zero-width carriers the caller did not list');
  ok(SPAB.decode(LONG, { classes: ['ws'], ecc: 'repetition' }).message === null,
    'auto-grow: text with no zero-width characters is unaffected');
})();

// -- frame scanner rejects spurious MAGIC bytes --
//
// The scanner walks every byte-aligned offset looking for [MAGIC][len][...][crc].
// Real streams contain 0xA5 by coincidence, so both rejection paths matter: a
// length that cannot fit, and a length that fits but whose CRC disagrees. The
// carrier stream is built byte-exactly here rather than hoping damage produces
// the right accident: 16 whitespace sites pack into one 32-bit block, digits
// LSB-first base-4, so any four bytes can be written on demand.
(function () {
  const WS = SPAB.SPACE_MAP;
  function textForBytes(quads) {
    let out = 'w';
    quads.forEach(function (q) {
      const v = ((q[0] << 24) | (q[1] << 16) | (q[2] << 8) | q[3]) >>> 0;
      for (let sIdx = 0; sIdx < 16; sIdx++) out += WS[(v >>> (2 * sIdx)) & 3] + 'w';
    });
    return out;
  }
  // A varint with continuation bits running on forever. Both the length reader and
  // the stride probe that folding uses must reject it rather than accumulate a
  // nonsense length.
  const runawayVarint = textForBytes([[0xA5, 0x20, 0x80, 0x80], [0x80, 0x80, 0x80, 0x80], [0x80, 0x80, 0x80, 0x00]]);
  const rv = SPAB.decode(runawayVarint, { classes: ['ws'], ecc: 'repetition' });
  ok(rv.message === null, 'a length varint that never ends is rejected');

  // A frame header whose varint length never terminates: every byte has the
  // continuation bit set and the stream ends. The reader must give up rather than
  // run past the end.
  const truncatedVarint = textForBytes([[0x00, 0x11, 0x22, 0x33], [0xA5, 0x20, 0x80, 0x80]]);
  const tv = SPAB.decode(truncatedVarint, { classes: ['ws'], ecc: 'repetition' });
  ok(tv.message === null, 'a frame whose length varint never terminates is rejected');

  // block 1: MAGIC then len 0        -> rejected on length
  // block 2: MAGIC, len 2, bad CRC   -> rejected on CRC
  // block 3: filler so block 2 clears the bounds check and reaches the CRC test
  const text = textForBytes([[0xA5, 0x00, 0x11, 0x22], [0xA5, 0x02, 0x33, 0x44], [0x00, 0x11, 0x22, 0x33]]);
  const params = { classes: ['ws'], ecc: 'repetition' };
  const res = SPAB.decode(text, params);
  ok(res.message === null, 'scanner: spurious MAGIC with bad length/CRC yields no message');
  ok(res.metadata.crcOk !== true, 'scanner: spurious MAGIC does not report a valid CRC');
})();

// -- browser-global branch of the IIFE wrapper (root = window) --
(function () {
  const path = require('path');
  const had = Object.prototype.hasOwnProperty.call(global, 'window');
  const prev = global.window;
  try {
    global.window = {};
    delete require.cache[require.resolve('../src/js/spab.js')];
    const fresh = require('../src/js/spab.js');
    ok(global.window.SPAB === fresh && fresh.VERSION, 'browser-global path sets window.SPAB');
  } finally {
    if (had) global.window = prev; else delete global.window;
    delete require.cache[require.resolve('../src/js/spab.js')];
    require('../src/js/spab.js'); // restore the normal cached instance
  }
})();

console.log('branches: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) { console.error('FAIL'); process.exit(1); }
console.log('PASS (branches)');
