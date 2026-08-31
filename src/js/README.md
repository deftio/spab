# spab — JavaScript (reference implementation)

`spab.js` is the reference codec: works as a browser global (`window.SPAB`) and via CommonJS
`require`. Zero dependencies. This is the spec other ports follow.

```js
const SPAB = require('./spab.js');
const enc = SPAB.encode(coverText, "my-id", {});   // -> { text, metadata }
const dec = SPAB.decode(enc.text, {});             // -> { message, metadata }
```

Exports: `encode`, `decode`, `histogram`, `getSlots`, `VERSION`, `ALGORITHM`. The baseline
`0.1.0` encodes 2 bits per inter-word space over 4 whitespace variants with repetition+majority
ECC and a magic+CRC frame — see `r_and_d/docs/` for the target design.
