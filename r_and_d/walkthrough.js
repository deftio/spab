// Regenerates the worked example in docs/encoding-walkthrough.md.
//   node r_and_d/walkthrough.js
// Every number in that document comes from this script. If the codec changes and
// the two disagree, the document is wrong, not the code.
const S = require('../src/js/spab.js');
const corpus = require('../tests/corpus.js');
const arr = Array.isArray(corpus) ? corpus : (corpus.CORPUS || corpus.docs || Object.values(corpus)[0]);
const pd = arr.filter(d => (d.id||d.name||'').startsWith('pd-'));
const cover = pd.map(d => d.text || d.body).join(' ');
const secret = 'ACCESS-KEY-7f3a91c4d8e02b6a';   // 27 chars
const B = a => a.join('');
const H = s => console.log('\n' + s + '\n' + '='.repeat(s.length));

H('STEP 0 - inputs');
const sites = S.CLASS_DEFS.ws.detect(cover);
console.log('cover  : ' + cover.length + ' chars, concatenation of ' + pd.length + ' public-domain excerpts');
console.log('         ' + pd.map(d=>d.id||d.name).join(', '));
console.log('ws sites: ' + sites.length + ' inter-word gaps');
console.log('secret : "' + secret + '"  = ' + Buffer.from(secret,'utf8').length + ' bytes');

H('STEP 1 - secret -> bytes');
const by = Array.from(Buffer.from(secret,'utf8'));
for (let i=0;i<by.length;i+=10) console.log('  [' + String(i).padStart(2) + '] ' + by.slice(i,i+10).map(b=>b.toString(16).padStart(2,'0')).join(' '));

H('STEP 2 - bytes -> WIRE PACKET v2');
const fr = S.wire.build(secret,'string',{});
const frame = fr.bits;
console.log('total ' + frame.length + ' bits (' + frame.length/8 + ' bytes)');
console.log('headerBits=' + fr.headerBits + '  len=' + fr.len + '  padBits=' + fr.padBits);
console.log(JSON.stringify(S.wire.fields(S.wire.parse(frame,0)),null,0));
console.log('\nbit map:');
console.log('  [ 0.. 2] ver   = ' + B(frame.slice(0,3)));
console.log('  [ 3.. 7] type  = ' + B(frame.slice(3,8)));
console.log('  [ 8..10] comp  = ' + B(frame.slice(8,11)));
console.log('  [11..13] enc   = ' + B(frame.slice(11,14)));
console.log('  [14..16] cksum = ' + B(frame.slice(14,17)));
console.log('  [17..' + (fr.headerBits-17-1+17) + '] varint len + checksum');
console.log('  [' + fr.headerBits + '..' + (frame.length-fr.padBits-1) + '] content (' + fr.len + ' bytes)');
console.log('  [' + (frame.length-fr.padBits) + '..' + (frame.length-1) + '] pad');
console.log('\nfull packet bits:');
for (let i=0;i<frame.length;i+=64) console.log('  ' + String(i).padStart(3) + ': ' + B(frame.slice(i,i+64)));

H('STEP 3 - REPETITION (default ECC)');
const rad = new Array(sites.length).fill(4);
const cap = S.symbols.capacity(rad,0);
const reps = Math.floor(cap/frame.length);
console.log('room       : ' + sites.length + ' sites x 2 bits = ' + cap + ' bits');
console.log('packet     : ' + frame.length + ' bits');
console.log('copies     : floor(' + cap + '/' + frame.length + ') = ' + reps);
console.log('used       : ' + reps*frame.length + ' bits, ' + (cap-reps*frame.length) + ' bits left over');
let ecc=[]; for(let r=0;r<reps;r++) ecc=ecc.concat(frame);
console.log('\ncopy layout across the stream:');
for(let r=0;r<reps;r++){const s0=r*frame.length; console.log('  copy '+r+': bits '+String(s0).padStart(4)+'..'+String(s0+frame.length-1).padStart(4)+'  -> ws sites '+Math.floor(s0/2)+'..'+Math.floor((s0+frame.length-1)/2));}

H('STEP 4 - bits -> SYMBOLS (blocks)');
const blocks = S.symbols.blocks(rad,0);
console.log('block count: ' + blocks.length + '  (an alphabet of 4, so 16 sites = 32 bits each; last is short)');
console.log('\nfirst 6 blocks and which packet copy their bits come from:');
blocks.slice(0,6).forEach((b,i)=>{
  const bit0=i*32, bit1=bit0+b.bits-1;
  const c0=Math.floor(bit0/frame.length), c1=Math.floor(bit1/frame.length);
  console.log('  block '+String(i).padStart(2)+': sites '+String(b.start).padStart(3)+'..'+String(b.start+b.len-1).padStart(3)+'  bits '+String(bit0).padStart(4)+'..'+String(bit1).padStart(4)+'  <- copy '+(c0===c1?c0:c0+' and '+c1+'  <-- STRADDLES'));
});
const digits = S.symbols.toSymbols(ecc,rad,0);
const b0=blocks[0];
let v=0; for(let k=0;k<b0.bits;k++) v=v*2+(ecc[k]||0);
console.log('\nblock 0 in full:');
console.log('  bits   ' + B(ecc.slice(0,32)));
console.log('  v    = ' + v);
let vv=v,parts=[]; for(let s=0;s<b0.len;s++){parts.push(vv%4);vv=Math.floor(vv/4);}
console.log('  base4  ' + parts.join(' ') + '   (low digit first)');
console.log('  NOTE: an alphabet of 4 = 2^2, so digit s is exactly bits 2s,2s+1. No mixing.');

H('STEP 5 - digits -> GLYPHS');
S.SPACE_MAP.forEach((c,i)=>console.log('  ' + i + ' -> U+' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4,'0') + '  ' + S.SPACE_NAMES[i]));
const enc = S.encode(cover, secret);
console.log('\nmarked : ' + enc.text.length + ' chars (cover ' + cover.length + ')');
const outd = S.CLASS_DEFS.ws.detect(enc.text).map(i=>S.SPACE_MAP.indexOf(enc.text[i]));
console.log('digits written at first 32 sites: ' + outd.slice(0,32).join(','));
const hist=[0,0,0,0]; outd.forEach(d=>{if(d>=0)hist[d]++;});
console.log('histogram over all ' + outd.length + ' sites: ' + JSON.stringify(hist));
console.log('  (NOT uniform - see the channel-estimator finding in the walkthrough doc)');
console.log('\nfirst 120 chars, - marks a variant space:');
console.log('  "' + enc.text.slice(0,120).replace(/[ -  　]/g,'-') + '"');

H('STEP 6 - decode');
const d1=S.decode(enc.text);
console.log('recovered: "' + d1.message + '"  status=' + d1.metadata.status);

H('STEP 7 - RLNC mode: the spread');
const encR = S.encode(cover, secret, {ecc:'rlnc'});
const dR = S.decode(encR.text, {ecc:'rlnc'});
console.log('encode ecc=rlnc -> decode: "' + dR.message + '"  status=' + dR.metadata.status);
console.log('packets seen by decoder: ' + dR.metadata.packets);
console.log('payloadBytes=' + dR.metadata.payloadBytes + '  channel=' + dR.metadata.channel);
console.log('\ngeometry (default preset): 8-bit ESI | 16-bit data | 8-bit CRC = 32 bits/packet');
console.log('source symbols K = ceil(' + frame.length/8 + ' bytes / 2 bytes) = ' + Math.ceil((frame.length/8)/2));
console.log('room = ' + cap + ' bits -> ' + Math.floor(cap/32) + ' packets emitted');
console.log('so each of the K source symbols is covered many times over by distinct equations.');

H('STEP 8 - what damage does');
[['delete a 300-char span', t=>t.slice(0,600)+t.slice(900)],
 ['collapse ALL whitespace', t=>t.replace(/\s+/g,' ')],
 ['NFKC normalize', t=>t.normalize('NFKC')]].forEach(([name,f])=>{
  const dmg=f(enc.text);
  const r=S.decode(dmg);
  console.log('  ' + name.padEnd(26) + ' -> status=' + String(r.metadata.status).padEnd(14) + ' msg=' + (r.message===secret?'RECOVERED':JSON.stringify(r.message)));
});
const coll = S.decode(enc.text.replace(/\s+/g,' '));
console.log('\ncollapse case, soft layer view:');
const sf = S.soft.classSoft(enc.text.replace(/\s+/g,' '), 'ws');
console.log('  estimateCollapse = ' + sf.collapse.toFixed(4) + '  (0 = intact, ->1 = fully normalized)');
console.log('  posterior at a default-glyph site: [' + sf.posteriors[0].map(x=>x.toFixed(3)).join(', ') + ']');
const sf2 = S.soft.classSoft(enc.text, 'ws');
console.log('  intact stream collapse = ' + sf2.collapse.toFixed(4));
