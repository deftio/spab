#!/usr/bin/env node
/*
 * corpus.js — a diverse document corpus for robustness testing.
 *
 * The point is STRUCTURAL diversity, not volume. Carrier availability in spab is a
 * property of typography, not of meaning: what matters is how many inter-word gaps
 * a document has, how many apostrophes and hyphens, whether it already contains
 * unicode spaces or curly quotes, whether it is one long paragraph or many short
 * lines, and whether its "words" are separated by spaces at all. A thousand samples
 * of business prose would exercise one point in that space.
 *
 * Each entry declares:
 *   name     stable id, used in test output so a failure names itself
 *   source   'public-domain' with the work named, or 'synthetic'
 *   stresses what this document is FOR — the property it exercises
 *   text     the document
 *
 * On provenance: the public-domain entries are short excerpts from works long out
 * of copyright (pre-1929 literature, US federal documents), used here as fixtures.
 * Everything else is written for this suite and marked `synthetic`; where a
 * synthetic entry models a real genre, `stresses` says which. Nothing here is
 * attributed to a source it did not come from.
 *
 * Usage:
 *   const { CORPUS, byStress, stats } = require('./corpus.js');
 *   node tests/corpus.js            print the corpus profile
 */
'use strict';

const NBSP = '\u00A0', THIN = '\u2009', RSQUO = '\u2019', EMDASH = '\u2014';

const CORPUS = [
  // ---- public-domain prose: the ordinary case, in several registers ----
  { name: 'pd-pride-prejudice', source: 'public-domain (Austen, Pride and Prejudice, 1813)',
    stresses: 'canonical English prose; moderate punctuation',
    text: 'It is a truth universally acknowledged, that a single man in possession of a good ' +
      'fortune, must be in want of a wife. However little known the feelings or views of such a ' +
      'man may be on his first entering a neighbourhood, this truth is so well fixed in the minds ' +
      'of the surrounding families, that he is considered as the rightful property of some one or ' +
      'other of their daughters.' },
  { name: 'pd-moby-dick', source: 'public-domain (Melville, Moby-Dick, 1851)',
    stresses: 'long sentences, heavy comma use, semicolons',
    text: 'Call me Ishmael. Some years ago, never mind how long precisely, having little or no ' +
      'money in my purse, and nothing particular to interest me on shore, I thought I would sail ' +
      'about a little and see the watery part of the world. It is a way I have of driving off the ' +
      'spleen, and regulating the circulation.' },
  { name: 'pd-two-cities', source: 'public-domain (Dickens, A Tale of Two Cities, 1859)',
    stresses: 'repetitive parallel structure — highly compressible payload analogue',
    text: 'It was the best of times, it was the worst of times, it was the age of wisdom, it was ' +
      'the age of foolishness, it was the epoch of belief, it was the epoch of incredulity, it was ' +
      'the season of Light, it was the season of Darkness, it was the spring of hope, it was the ' +
      'winter of despair.' },
  { name: 'pd-us-preamble', source: 'public-domain (US Constitution, preamble, 1787)',
    stresses: 'formal legal register; one long sentence, no contractions',
    text: 'We the People of the United States, in Order to form a more perfect Union, establish ' +
      'Justice, insure domestic Tranquility, provide for the common defence, promote the general ' +
      'Welfare, and secure the Blessings of Liberty to ourselves and our Posterity, do ordain and ' +
      'establish this Constitution for the United States of America.' },
  { name: 'pd-gettysburg', source: 'public-domain (Lincoln, Gettysburg Address, 1863)',
    stresses: 'short public-address prose; dashes and hyphenation',
    text: 'Four score and seven years ago our fathers brought forth on this continent, a new ' +
      'nation, conceived in Liberty, and dedicated to the proposition that all men are created ' +
      'equal. Now we are engaged in a great civil war, testing whether that nation, or any nation ' +
      'so conceived and so dedicated, can long endure.' },
  { name: 'pd-alice', source: 'public-domain (Carroll, Alice in Wonderland, 1865)',
    stresses: 'dialogue with quotation marks and contractions',
    text: 'Alice was beginning to get very tired of sitting by her sister on the bank, and of ' +
      'having nothing to do: once or twice she had peeped into the book her sister was reading, ' +
      'but it had no pictures or conversations in it, and what is the use of a book, thought ' +
      'Alice, without pictures or conversations?' },
  { name: 'pd-frankenstein', source: 'public-domain (Shelley, Frankenstein, 1818)',
    stresses: 'epistolary register; long clauses',
    text: 'You will rejoice to hear that no disaster has accompanied the commencement of an ' +
      'enterprise which you have regarded with such evil forebodings. I arrived here yesterday, ' +
      'and my first task is to assure my dear sister of my welfare and increasing confidence in ' +
      'the success of my undertaking.' },
  { name: 'pd-sherlock', source: 'public-domain (Doyle, A Scandal in Bohemia, 1891)',
    stresses: 'narrative with proper nouns and mid-sentence dashes',
    text: 'To Sherlock Holmes she is always the woman. I have seldom heard him mention her under ' +
      'any other name. In his eyes she eclipses and predominates the whole of her sex. It was not ' +
      'that he felt any emotion akin to love for Irene Adler. All emotions, and that one ' +
      'particularly, were abhorrent to his cold, precise but admirably balanced mind.' },

  // ---- punctuation density: the NFKC-durable channels live here ----
  { name: 'punct-rich', source: 'synthetic', stresses: 'many apostrophes and hyphens — large apos/hyphen channels',
    text: "It's a well-known, old-fashioned truth that the co-operative fox-trot isn't easily " +
      "forgotten. Don't let the well-meaning re-write of a half-hearted first-draft undo what's " +
      "been hand-crafted: it's the sort of self-evident, long-standing habit that's hard-won." },
  { name: 'punct-poor', source: 'synthetic', stresses: 'no apostrophes or hyphens at all — ws is the only channel',
    text: 'The system reads a value from the sensor and writes it to the log. Each entry contains ' +
      'a timestamp, a channel number and a reading. The reader may open the file at any time. ' +
      'Nothing in the format requires the writer to flush before the process exits.' },
  { name: 'punct-only-apos', source: 'synthetic', stresses: 'apostrophes but no hyphens',
    text: "She'd said it wasn't hers, and he'd agreed it couldn't be, though neither of them " +
      "could say whose it was or why it'd been left there. They'd have asked, if there'd been " +
      "anyone to ask, but the office was empty and it wasn't worth waiting." },
  { name: 'punct-only-hyphen', source: 'synthetic', stresses: 'hyphens but no apostrophes',
    text: 'The state-of-the-art low-power sensor uses a well-tested twelve-bit converter with ' +
      'built-in self-calibration. A high-side switch drives the load through a current-limited ' +
      'path, and the fail-safe timer resets the micro-controller on a watch-dog event.' },

  // ---- whitespace structure ----
  { name: 'ws-single-space', source: 'synthetic', stresses: 'strictly one space between words — the ideal carrier case',
    text: 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen ' +
      'fifteen sixteen seventeen eighteen nineteen twenty twenty one twenty two twenty three' },
  { name: 'ws-double-spaced', source: 'synthetic', stresses: 'two spaces after each period — sites adjacent to punctuation',
    text: 'The first sentence ends here.  The second begins after two spaces.  A third follows ' +
      'the same rule.  Older typewriter convention puts two spaces after terminal punctuation.  ' +
      'The gaps between words inside a sentence stay single.' },
  { name: 'ws-newlines', source: 'synthetic', stresses: 'hard line breaks — gaps split across lines',
    text: 'The quarterly report is attached.\nPlease review the second section.\nThe figures on ' +
      'page four changed after the audit.\nLet me know before Friday.\nRegards,\nA. Chatterjee' },
  { name: 'ws-tabs', source: 'synthetic', stresses: 'tab-separated content — tabs are not carrier sites',
    text: 'name\tvalue\tunit\nvoltage\t3.30\tV\ncurrent\t0.45\tA\npower\t1.485\tW\n' +
      'the trailing prose explains the table above and does use ordinary spaces' },
  { name: 'ws-already-unicode', source: 'synthetic', stresses: 'cover already contains unicode spaces and curly quotes',
    text: 'The report' + RSQUO + 's summary used a' + THIN + 'thin space and a' + NBSP + 'no-break ' +
      'space before the unit. Typography like this arrives from word processors and the encoder ' +
      'must not assume every gap began life as U+0020.' },
  { name: 'ws-leading-trailing', source: 'synthetic', stresses: 'leading and trailing whitespace — not inter-word sites',
    text: '   The body of the message is indented on both sides.   ' },
  { name: 'ws-no-spaces', source: 'synthetic', stresses: 'no inter-word spaces at all — zero ws capacity',
    text: 'ThisEntireDocumentIsWrittenWithoutAnySpacesBetweenWordsWhichMeansThereAreNoWhitespace' +
      'CarrierSitesAvailableAndTheEncoderMustReportThatHonestlyRatherThanFailingQuietly' },
  { name: 'ws-single-word', source: 'synthetic', stresses: 'one word — degenerate, zero sites',
    text: 'watermark' },
  { name: 'ws-two-words', source: 'synthetic', stresses: 'exactly one carrier site',
    text: 'two words' },

  // ---- code and markup ----
  { name: 'code-js', source: 'synthetic', stresses: 'JavaScript — operators, braces, structural indentation',
    text: 'function encode(cover, message, params) {\n  const ids = resolveClasses(params);\n' +
      '  if (!ids.length) return { text: cover, metadata: {} };\n  const frame = buildFrame(message);\n' +
      '  return { text: apply(cover, frame), metadata: { bits: frame.length } };\n}' },
  { name: 'code-python', source: 'synthetic', stresses: 'Python — significant indentation, snake_case',
    text: 'def decode(text, params=None):\n    params = params or {}\n    ids = resolve_classes(params)\n' +
      '    for carrier_id in ids:\n        digits = read_class_bits(text, carrier_id)\n' +
      '        if digits:\n            return fold_parse(digits)\n    return None' },
  { name: 'code-c', source: 'synthetic', stresses: 'C — pointers, semicolons, preprocessor lines',
    text: '#include <stdint.h>\n\nsize_t spab_encode(const char *cover, const uint8_t *msg, size_t n)\n{\n' +
      '    if (cover == NULL || msg == NULL) return 0;\n    size_t sites = spab_count_sites(cover);\n' +
      '    return sites < n * 8 ? 0 : sites;\n}' },
  { name: 'code-sql', source: 'synthetic', stresses: 'SQL — uppercase keywords, quoted literals',
    text: "SELECT document_id, carrier_class, COUNT(*) AS sites\nFROM watermark_events\n" +
      "WHERE created_at >= '2026-01-01' AND status <> 'failed'\nGROUP BY document_id, carrier_class\n" +
      "HAVING COUNT(*) > 10\nORDER BY sites DESC;" },
  { name: 'markup-markdown', source: 'synthetic', stresses: 'Markdown — headings, lists, emphasis, code spans',
    text: '# Release notes\n\n## Added\n\n- **Typed payloads** so a decoder can say what it found.\n' +
      '- `compress` is attempted and kept only when it helps.\n\n## Fixed\n\n- The capacity warning ' +
      'quoted the wrong requirement in `rlnc` mode.\n\nSee [the spec](dev/wire-format.md) for detail.' },
  { name: 'markup-html', source: 'synthetic', stresses: 'HTML — tags, attributes, entities',
    text: '<article class="report">\n  <h1>Quarterly figures</h1>\n  <p>Operating costs are down ' +
      '&mdash; see <a href="/q3">the detail</a>.</p>\n  <ul><li>Revenue up 4%</li><li>Headcount flat</li></ul>\n' +
      '</article>' },
  { name: 'markup-json', source: 'synthetic', stresses: 'JSON — quoted keys, few natural word gaps',
    text: '{"document":"q3-report","carriers":["ws","apos","hyphen"],"ecc":"repetition",' +
      '"payload":{"type":"uuid","value":"3f2504e0-4f89-11d3-9a0c-0305e82c3301"},"copies":7}' },
  { name: 'markup-yaml', source: 'synthetic', stresses: 'YAML — indentation, colons, sparse prose',
    text: 'name: spab\nversion: 0.5.1\ncarriers:\n  - ws\n  - apos\n  - hyphen\nsettings:\n' +
      '  ecc: repetition\n  compress: true\n  description: watermark plain text without changing it' },
  { name: 'markup-csv', source: 'synthetic', stresses: 'CSV — commas, no inter-word spaces in fields',
    text: 'id,name,department,start_date\n1,Alice Nguyen,Engineering,2024-03-01\n' +
      '2,Bo Chen,Finance,2023-11-15\n3,Carla Diaz,Legal,2025-06-30' },
  { name: 'markup-latex', source: 'synthetic', stresses: 'LaTeX — backslash commands, braces, math',
    text: '\\section{Capacity}\nThe passage of $W$ words holds roughly $W/4 - 7$ payload bytes per ' +
      'copy, where the constant is packet overhead.\n\\begin{equation}\n  C_R(p) = \\frac{b_{rec}}{|T|}\n' +
      '\\end{equation}' },
  { name: 'markup-diff', source: 'synthetic', stresses: 'unified diff — leading +/- markers',
    text: '--- a/src/js/spab.js\n+++ b/src/js/spab.js\n@@ -201,7 +201,7 @@\n' +
      '-  function phaseCount(key, n) { return key ? 1 : Math.min(MAX_PHASE, n); }\n' +
      '+  function phaseCount(key, n) { return Math.min(MAX_PHASE, n); }' },

  // ---- non-Latin scripts ----
  { name: 'script-cjk-zh', source: 'synthetic', stresses: 'Chinese — no inter-word spaces, zero ws capacity',
    text: '\u6587\u672c\u6c34\u5370\u662f\u4e00\u4e2a\u56f0\u96be\u7684\u95ee\u9898\u3002' +
      '\u56e0\u4e3a\u6587\u5b57\u672c\u8eab\u5c31\u662f\u79bb\u6563\u7684\uff0c' +
      '\u6bcf\u4e00\u4e2a\u5b57\u7b26\u90fd\u53ef\u80fd\u88ab\u8bfb\u8005\u6216\u8f6f\u4ef6\u68c0\u67e5\u3002' },
  { name: 'script-cjk-ja', source: 'synthetic', stresses: 'Japanese — mixed kana and kanji, no spaces',
    text: '\u30c6\u30ad\u30b9\u30c8\u306e\u96fb\u5b50\u900f\u304b\u3057\u306f\u96e3\u3057\u3044' +
      '\u554f\u984c\u3067\u3059\u3002\u6587\u5b57\u306f\u96e2\u6563\u7684\u3067\u3042\u308a\u3001' +
      '\u7a7a\u767d\u306e\u7a2e\u985e\u3092\u5909\u3048\u308b\u4f59\u5730\u304c\u307b\u3068\u3093\u3069\u3042\u308a\u307e\u305b\u3093\u3002' },
  { name: 'script-korean', source: 'synthetic', stresses: 'Korean — hangul WITH inter-word spaces',
    text: '\ud14d\uc2a4\ud2b8 \uc6cc\ud130\ub9c8\ud06c\ub294 \uc5b4\ub824\uc6b4 \ubb38\uc81c\uc785\ub2c8\ub2e4. ' +
      '\ubb38\uc790\ub294 \uc774\uc0b0\uc801\uc774\uba70 \ub3c5\uc790\uc640 \uc18c\ud504\ud2b8\uc6e8\uc5b4\uac00 ' +
      '\ubaa8\ub4e0 \uae30\ud638\ub97c \uac80\uc0ac\ud560 \uc218 \uc788\uc2b5\ub2c8\ub2e4.' },
  { name: 'script-cyrillic', source: 'synthetic', stresses: 'Cyrillic — spaced words, homoglyph-adjacent characters',
    text: '\u0412\u043e\u0434\u044f\u043d\u043e\u0439 \u0437\u043d\u0430\u043a \u0432 \u0442\u0435\u043a\u0441\u0442\u0435 ' +
      '\u2014 \u044d\u0442\u043e \u0441\u043b\u043e\u0436\u043d\u0430\u044f \u0437\u0430\u0434\u0430\u0447\u0430, ' +
      '\u043f\u043e\u0442\u043e\u043c\u0443 \u0447\u0442\u043e \u0441\u0438\u043c\u0432\u043e\u043b\u044b ' +
      '\u0434\u0438\u0441\u043a\u0440\u0435\u0442\u043d\u044b \u0438 \u0432\u0438\u0434\u043d\u044b.' },
  { name: 'script-greek', source: 'synthetic', stresses: 'Greek — spaced words, final sigma',
    text: '\u03a4\u03bf \u03c5\u03b4\u03b1\u03c4\u03bf\u03b3\u03c1\u03ac\u03c6\u03b7\u03bc\u03b1 ' +
      '\u03c3\u03c4\u03bf \u03ba\u03b5\u03af\u03bc\u03b5\u03bd\u03bf \u03b5\u03af\u03bd\u03b1\u03b9 ' +
      '\u03b4\u03cd\u03c3\u03ba\u03bf\u03bb\u03bf \u03c0\u03c1\u03cc\u03b2\u03bb\u03b7\u03bc\u03b1.' },
  { name: 'script-arabic-rtl', source: 'synthetic', stresses: 'Arabic — right-to-left, spaced, joining forms',
    text: '\u0627\u0644\u0639\u0644\u0627\u0645\u0629 \u0627\u0644\u0645\u0627\u0626\u064a\u0629 ' +
      '\u0641\u064a \u0627\u0644\u0646\u0635 \u0645\u0634\u0643\u0644\u0629 \u0635\u0639\u0628\u0629 ' +
      '\u0644\u0623\u0646 \u0627\u0644\u0631\u0645\u0648\u0632 \u0645\u0646\u0641\u0635\u0644\u0629.' },
  { name: 'script-hebrew-rtl', source: 'synthetic', stresses: 'Hebrew — right-to-left, spaced',
    text: '\u05e1\u05d9\u05de\u05df \u05d4\u05de\u05d9\u05dd \u05d1\u05d8\u05e7\u05e1\u05d8 ' +
      '\u05d4\u05d5\u05d0 \u05d1\u05e2\u05d9\u05d4 \u05e7\u05e9\u05d4 \u05db\u05d9\u05d5\u05d5\u05df ' +
      '\u05e9\u05d4\u05ea\u05d5\u05d5\u05d9\u05dd \u05d1\u05d3\u05d9\u05d3\u05d9\u05dd.' },
  { name: 'script-devanagari', source: 'synthetic', stresses: 'Hindi — combining marks above and below the baseline',
    text: '\u092a\u093e\u0920 \u092e\u0947\u0902 \u0935\u0949\u091f\u0930\u092e\u093e\u0930\u094d\u0915 ' +
      '\u090f\u0915 \u0915\u0920\u093f\u0928 \u0938\u092e\u0938\u094d\u092f\u093e \u0939\u0948 ' +
      '\u0915\u094d\u092f\u094b\u0902\u0915\u093f \u0905\u0915\u094d\u0937\u0930 \u0905\u0932\u0917 \u0939\u0948\u0902.' },
  { name: 'script-thai', source: 'synthetic', stresses: 'Thai — no inter-word spaces, stacked diacritics',
    text: '\u0e25\u0e32\u0e22\u0e19\u0e49\u0e33\u0e43\u0e19\u0e02\u0e49\u0e2d\u0e04\u0e27\u0e32\u0e21' +
      '\u0e40\u0e1b\u0e47\u0e19\u0e1b\u0e31\u0e0d\u0e2b\u0e32\u0e17\u0e35\u0e48\u0e22\u0e32\u0e01' },
  { name: 'script-mixed', source: 'synthetic', stresses: 'Latin and CJK interleaved in one document',
    text: 'The API returns \u6587\u672c\u6c34\u5370 metadata for each request. ' +
      '\u30ec\u30b9\u30dd\u30f3\u30b9 includes a status field and a confidence score. ' +
      'Clients should treat \u672a\u691c\u51fa as a normal outcome rather than an error.' },
  { name: 'script-accents', source: 'synthetic', stresses: 'Latin with heavy diacritics — multi-byte UTF-8 words',
    text: 'La solution na\u00efve pour le probl\u00e8me du filigrane textuel n\u2019est pas ' +
      'satisfaisante \u00e0 cause des caract\u00e8res sp\u00e9ciaux. Il faut consid\u00e9rer ' +
      'les r\u00e8gles de normalisation avant de d\u00e9cider la strat\u00e9gie.' },
  { name: 'script-combining', source: 'synthetic', stresses: 'decomposed combining marks adjacent to carrier sites',
    text: 'cafe\u0301 nai\u0308ve re\u0301sume\u0301 the combining acute and diaeresis sit after ' +
      'their base letters and must not be mistaken for word characters when a gap is classified' },

  // ---- emoji and astral plane ----
  { name: 'emoji-simple', source: 'synthetic', stresses: 'astral-plane characters — surrogate pairs in UTF-16',
    text: 'The build passed \u2705 and the deploy finished \u{1F680} but the alert still fired ' +
      '\u{1F6A8} so the on-call engineer rolled it back \u{1F504} before the morning standup.' },
  { name: 'emoji-zwj', source: 'synthetic', stresses: 'ZWJ sequences — U+200D is ALSO a zwsp carrier variant',
    text: 'The family \u{1F468}\u200D\u{1F469}\u200D\u{1F467} photo and the flag ' +
      '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F} both use joiners that the ' +
      'zero-width carrier must not corrupt or misread as payload' },
  { name: 'emoji-skin-tone', source: 'synthetic', stresses: 'modifier sequences after base emoji',
    text: 'She waved \u{1F44B}\u{1F3FD} and he gave a thumbs up \u{1F44D}\u{1F3FF} while the ' +
      'reviewer left a comment \u{1F4DD} on the pull request before approving it' },

  // ---- messaging and short forms ----
  { name: 'chat-short-lines', source: 'synthetic', stresses: 'chat transcript — many short lines, few gaps each',
    text: 'alice: did you push it\nbob: yeah just now\nalice: ci is red\nbob: looking\n' +
      'bob: it was the lint gate\nalice: ok\nbob: fixed, rerunning\nalice: thanks' },
  { name: 'chat-sms', source: 'synthetic', stresses: 'SMS register — abbreviations, minimal punctuation',
    text: 'running late be there in 10 order without me if the table is ready ' +
      'ask for the corner one if they have it' },
  { name: 'email-quoted', source: 'synthetic', stresses: 'email with quote markers — > prefixes',
    text: 'Thanks, that works for me.\n\n> On Tuesday the committee asked for a re-forecast.\n' +
      '> Finance will circulate a revised model on Friday.\n\nI will review it before the call.' },
  { name: 'email-signature', source: 'synthetic', stresses: 'signature block — short lines, punctuation clusters',
    text: 'Best regards,\n\nA. Chatterjee\nPrincipal Engineer | Platform\n' +
      'deftio.com | +1 (555) 010-4417\n--\nThis message may contain confidential information.' },

  // ---- length extremes ----
  { name: 'len-tiny', source: 'synthetic', stresses: 'below any usable capacity — must warn, not fail quietly',
    text: 'a b c' },
  { name: 'len-tweet', source: 'synthetic', stresses: 'social-post length — capacity for a very small payload only',
    text: 'Shipped the new wire format today. Seventeen bits of header, checksum before content, ' +
      'and no magic number. Small things, but they add up.' },
  { name: 'len-long', source: 'synthetic', stresses: 'long document — many copies fit, high redundancy',
    text: ('Every document carries more than its words. The spacing between them, the shape of a ' +
      'quote, the kind of dash used in a compound - these are choices a reader never notices and ' +
      'a writer rarely makes deliberately. That is exactly where a mark can live without changing ' +
      'what the page says to the person reading it. ').repeat(12) },
  { name: 'len-one-long-line', source: 'synthetic', stresses: 'no line breaks at all in a long document',
    text: ('the quick brown fox jumps over the lazy dog and then continues running past the fence ' +
      'and down the lane without stopping for anything at all ').repeat(8) },

  // ---- adversarial and edge shapes ----
  { name: 'edge-empty', source: 'synthetic', stresses: 'empty document', text: '' },
  { name: 'edge-whitespace-only', source: 'synthetic', stresses: 'whitespace with no words', text: '     \n\t  \n   ' },
  { name: 'edge-punctuation-only', source: 'synthetic', stresses: 'punctuation with no word characters',
    text: '... --- !!! ??? ,,, ;;; ::: ((( ))) [[[ ]]] {{{ }}}' },
  { name: 'edge-numbers', source: 'synthetic', stresses: 'numeric content — digits are word characters',
    text: '3.14159 2.71828 1.41421 1.61803 0.57721 4.66920 1.30357 2.50290 1.20206 1.08232 ' +
      '299792458 6.02214076 1.380649 6.62607015' },
  { name: 'edge-urls', source: 'synthetic', stresses: 'URLs and paths — hyphens and slashes inside tokens',
    text: 'See https://github.com/deftio/spab/blob/main/dev/wire-format.md and the mirror at ' +
      'https://deftio.github.io/spab/pages/ for the current specification and the live demo.' },
  { name: 'edge-repeated-word', source: 'synthetic', stresses: 'maximally compressible — one word repeated',
    text: ('buffalo ').repeat(60).trim() },
  { name: 'edge-mixed-newlines', source: 'synthetic', stresses: 'CRLF and LF mixed in one document',
    text: 'The first line ends with CRLF.\r\nThe second ends with LF.\nThe third mixes them.\r\n' +
      'A parser that normalises line endings changes the byte count but not the word gaps.' },
  { name: 'edge-nbsp', source: 'synthetic', stresses: 'no-break spaces already present between words',
    text: 'The value is 3.3' + NBSP + 'V and the current is 450' + NBSP + 'mA, measured at 25' +
      NBSP + 'C over a 10' + NBSP + 'minute window with the load connected.' },
  { name: 'edge-emdash-prose', source: 'synthetic', stresses: 'em dashes rather than hyphens — hyphen channel is empty',
    text: 'The committee met on Tuesday ' + EMDASH + ' rather later than planned ' + EMDASH +
      ' and agreed to defer the decision. Nobody objected; the chair noted the delay and moved on.' },
  { name: 'edge-all-caps', source: 'synthetic', stresses: 'uppercase throughout',
    text: 'NOTICE: THIS DOCUMENT IS CLASSIFIED FOR INTERNAL DISTRIBUTION ONLY AND MUST NOT BE ' +
      'FORWARDED OUTSIDE THE ORGANISATION WITHOUT WRITTEN APPROVAL FROM THE LEGAL DEPARTMENT' },

  // ---- domain registers ----
  { name: 'domain-legal', source: 'synthetic', stresses: 'contract prose — numbered clauses, defined terms',
    text: '1.1 The Supplier shall deliver the Services in accordance with Schedule 2. 1.2 Where a ' +
      'conflict arises between this Agreement and any Statement of Work, this Agreement prevails. ' +
      '1.3 Notice under this clause must be given in writing to the address in Schedule 1.' },
  { name: 'domain-medical', source: 'synthetic', stresses: 'clinical note — abbreviations, units, slashes',
    text: 'Patient reports intermittent chest discomfort over 3 days. BP 128/82, HR 74, afebrile. ' +
      'No prior cardiac history. ECG shows normal sinus rhythm. Plan: outpatient stress test, ' +
      'follow-up in one week, return sooner if symptoms worsen.' },
  { name: 'domain-academic', source: 'synthetic', stresses: 'academic abstract — citations and hedged claims',
    text: 'We present a communications-oriented approach to text watermarking in which typographic ' +
      'variation is treated as a noisy insertion-deletion channel. Prior work (Davey and MacKay, ' +
      '2001) established soft resynchronisation for such channels; we adapt it to discrete ' +
      'carriers and report recovery under twenty-three corruption models.' },
  { name: 'domain-news', source: 'synthetic', stresses: 'news lede — dateline, attribution',
    text: 'BRUSSELS, Sept 6 - Regulators said on Friday they would review the proposed merger, ' +
      'citing concerns about market concentration. A spokesperson declined to give a timeline. ' +
      'Shares in both companies fell in early trading before recovering by the close.' },
  { name: 'domain-recipe', source: 'synthetic', stresses: 'instructions — imperative mood, fractions, units',
    text: 'Heat the oven to 200 C. Combine 250 g flour, 1/2 teaspoon salt and 2 tablespoons olive ' +
      'oil. Add water a little at a time until the dough comes together. Rest for 30 minutes, ' +
      'then roll out to 3 mm and bake for 12-14 minutes until golden.' },
  { name: 'domain-poetry', source: 'synthetic', stresses: 'verse — short lines, deliberate line breaks',
    text: 'the space between two words\nis wider than it looks\nand narrower than it reads\n\n' +
      'a mark can live in there\nunseen but not unmade\nuntil an editor arrives' },
  { name: 'domain-changelog', source: 'synthetic', stresses: 'changelog — version numbers, bullet lists, backticks',
    text: '## [0.5.1] - 2026-09-06\n\n### Added\n- Sliding histogram detector and the likelihood field.\n' +
      '- `SPAB.version()` reporting implemented capabilities.\n\n### Fixed\n- Keyed marks now resynchronise.' },
  { name: 'domain-transcript', source: 'synthetic', stresses: 'speech transcript — disfluency, timestamps',
    text: '[00:04:12] So the - the thing is, we never actually measured it, right? [00:04:18] ' +
      'Right. [00:04:19] And once we did, the numbers went the other way. Which, honestly, was ' +
      'not what any of us expected going in.' }
];

// ---- derived helpers ----
function stats(SPAB) {
  return CORPUS.map(function (d) {
    const sites = SPAB ? SPAB.getSites(d.text, {}).length : null;
    return { name: d.name, chars: d.text.length, words: d.text.split(/\s+/).filter(Boolean).length, sites: sites };
  });
}
function byStress(re) { return CORPUS.filter(function (d) { return re.test(d.stresses); }); }

module.exports = { CORPUS, stats, byStress };

if (require.main === module) {
  const SPAB = require('../src/js/spab.js');
  const rows = stats(SPAB);
  console.log('corpus: ' + CORPUS.length + ' documents');
  console.log('  public-domain: ' + CORPUS.filter(function (d) { return /^public-domain/.test(d.source); }).length +
    '   synthetic: ' + CORPUS.filter(function (d) { return d.source === 'synthetic'; }).length);
  console.log('\n' + 'name'.padEnd(24) + 'chars'.padStart(7) + 'words'.padStart(7) + 'ws+punct sites'.padStart(16));
  rows.forEach(function (r) {
    console.log('  ' + r.name.padEnd(22) + String(r.chars).padStart(7) + String(r.words).padStart(7) + String(r.sites).padStart(16));
  });
  const withSites = rows.filter(function (r) { return r.sites > 0; });
  console.log('\n  documents with zero carrier sites: ' + (rows.length - withSites.length) +
    '  (expected: CJK/Thai without spaces, single words, empty, punctuation-only)');
}
