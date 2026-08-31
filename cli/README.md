# spab CLI

`spabdemo.js` — the reference command-line tool (Node). Encode a message into text and decode it back.

```bash
./spabdemo.js encode --message "meet at dawn" --in story.txt --out out.txt
./spabdemo.js decode --in out.txt
./spabdemo.js capacity --in story.txt
./spabdemo.js help
```

Reads input from `--in <file>`, `--text "..."`, `--use-demo-story`, or stdin; writes to stdout or
`--out`. `hide`/`reveal` remain as aliases for `encode`/`decode`.

A compiled **C++17** CLI (for maximum portability, no Node required) is planned under `cli/cpp/`,
built against the C/C++ library port.
