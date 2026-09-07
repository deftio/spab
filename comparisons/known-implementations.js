/*
 * Every text-watermarking implementation this project is aware of, whether or not it
 * can be benchmarked here.
 *
 * A comparison that silently omits the systems it could not run reads as a survey.
 * This file makes the absences visible and says why each one is absent, so the table
 * is understood as "what could be measured", not "what exists".
 */
'use strict';

module.exports = [
  { name: 'Innamark', vendor: 'Fraunhofer ISST', lang: 'JVM (Kotlin)',
    technique: 'whitespace substitution, length-preserving, repeated across the text',
    url: 'https://github.com/FraunhoferISST/Innamark',
    status: 'not run',
    why: 'JVM toolchain, and the repository states that PATENT LICENSING is required in addition ' +
         'to the software licence. Whether to accept that is a decision for whoever runs the ' +
         'comparison, not something this repo should make by vendoring it. It is also the ' +
         'strongest empirical reference in this space — a published million-document evaluation — ' +
         'so its absence is the biggest gap in the table.' },

  { name: 'VSRMark', vendor: 'VSRMark project', lang: 'C, Go, Java, Rust, Swift, TypeScript',
    technique: 'Unicode variation selectors, roughly one payload byte per carrier; framing + CRC, no ECC',
    url: 'https://github.com/vsrmark',
    status: 'adapter ready, not configured',
    why: 'No npm package. comparisons/adapters/vsrmark.js shells out to a local build — set ' +
         'VSRMARK_BIN and it joins the table. emoji-smuggle is the closest installable stand-in ' +
         'for the technique.' },

  { name: 'Drift', vendor: 'Drift project', lang: 'Python',
    technique: 'three independent channels — homoglyphs, zero-width characters, trailing whitespace',
    url: 'https://pypi.org/project/drift/',
    status: 'not run — name collision',
    why: 'The `drift` package on PyPI is a CMS editing tool, NOT this project. Wiring it up would ' +
         'attribute numbers to a project that did not produce them, which is worse than an empty ' +
         'row. Point an adapter at a checkout of the real one to include it.' },

  { name: 'stegmark', vendor: 'stegmark project', lang: 'Python',
    technique: 'zero-width channel plus a synonym-substitution channel',
    url: 'https://pypi.org/project/stegmark/',
    status: 'not run — name collision',
    why: 'The `stegmark` package on PyPI is a steganalysis detector, not the watermarker of that ' +
         'name. Same reasoning as Drift.' },

  { name: 'REMARK-LLM', vendor: 'USENIX Security 2024', lang: 'Python (research)',
    technique: 'learned generative watermarking — the model emits marked text',
    url: 'https://www.usenix.org/conference/usenixsecurity24',
    status: 'out of scope',
    why: 'Requires control of text GENERATION. It cannot mark an existing document, which is the ' +
         'problem every row in the table is solving. Different problem, not a weaker solution.' },

  { name: 'XMark', vendor: 'ACL 2026', lang: 'Python (research)',
    technique: 'biases token sampling so generated choices carry a multi-bit message',
    url: 'https://aclanthology.org/',
    status: 'out of scope',
    why: 'Generation-time, same as REMARK-LLM.' }
];
