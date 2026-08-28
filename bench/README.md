# spab benchmark harness

Robustness test suite for the spab whitespace watermark codec. It encodes a payload
into varied cover text, pushes the watermarked text through a library of corruption
models, decodes, and scores recovery — plus a clean-control pass that measures how
often the decoder falsely claims a payload in un-watermarked text.

## Run

```bash
node bench/harness.js                       # full matrix, printed summary
node bench/harness.js --trials 100          # more trials per cell (default 40)
node bench/harness.js --csv results.csv     # also write per-cell CSV
node bench/harness.js --model normalize,blockErasure   # subset of corruption models
node bench/harness.js --payload MY-ID-123   # different payload
```

No dependencies — plain Node. The harness drives `../web/spab.js` directly, so the
web visualizer and the benchmark always test the same codec.

## Generated corpus (scale testing)

The handful of texts in `corpora.js` are for quick smoke tests. For statistically
meaningful numbers, sweep the **deterministic generated corpus** — `getDoc(i)` returns
the same document every run, so 25k–100k varied passages come from seeds, not files.

```bash
node bench/harness.js --gen 5000              # sweep 5k generated docs (~2s)
node bench/harness.js --gen 50000             # R&D tier (~7s)
node bench/harness.js --gen 200               # CI subset (fixed prefix)
node bench/harness.js --gen 5000 --csv gen.csv
node bench/harness.js --gen 5000 --offset 50000   # a disjoint slice

node bench/corpus-gen.js --n 20 --print       # inspect sample docs
node bench/corpus-gen.js --n 50000 --stats    # length/kind distribution
node bench/corpus-gen.js --n 5000 --out c.jsonl
```

In `--gen` mode each (doc, model, intensity) runs once — the corpus itself supplies the
variance — and results accumulate on the fly, so memory stays flat at any N.

**Two tiers, one generator:** the CI subset is a strict prefix of the R&D sweep, so a
fast per-commit run and a big nightly run test exactly the same documents.

## Run provenance & storage (comparing over time)

Every run records **which algorithm was tested** so results stay comparable as the
scheme evolves. `spab.js` exports `VERSION` and a machine-readable `ALGORITHM`
descriptor (channel, ECC, frame, coding flags); the harness stamps each run with that,
plus a content hash of `spab.js` (catches code changes even without a version bump),
git commit/branch/dirty, Node version, config, and a human `--note`.

**Storage model — JSONL is the source of truth, SQLite is a derived index:**

- `runs/runs.jsonl` — one line per run: the full manifest (version, algorithm, env, config).
- `runs/results.jsonl` — one line per (run, cell): metrics keyed by `runId`.
- `runs/spab-bench.sqlite` — rebuilt from the JSONL on demand for querying. Never edited
  by hand, safe to delete and regenerate; it can't diverge from the logs.

Why both: JSONL is append-only, diff-friendly, dependency-free, and survives schema
changes (old runs keep their old shape). SQLite gives fast cross-run queries/joins
("recovery over time for model X at intensity Y, grouped by algorithm version"). The
log is canonical; the DB is a convenience index.

```bash
node bench/harness.js --gen 5000 --note "baseline first real run"   # logs a run
node --experimental-sqlite bench/db.js import   # (re)build the SQLite index from JSONL
node --experimental-sqlite bench/db.js runs     # list runs (version, hash, note)
node --experimental-sqlite bench/db.js query    # recovery by version x model x intensity
node --experimental-sqlite bench/db.js sql "SELECT ..."   # ad-hoc SQL
node bench/harness.js --gen 5000 --no-log        # skip logging
```

When the algorithm changes, bump `SPAB.VERSION` and update `SPAB.ALGORITHM` in
`web/spab.js`; new runs log under the new version and the `query` view shows old vs. new
side by side. (Node's built-in SQLite needs `--experimental-sqlite`; the JSONL path needs
nothing.)

## Files

- `corpora.js` — hand-written cover texts (short/medium/long, prose, punctuation-heavy,
  markup) plus a never-encoded control set.
- `corpus-gen.js` — deterministic synthetic corpus generator + CLI (`getDoc`, `iterate`,
  `ciSubset`).
- `corruptions.js` — the "channel": seeded corruption models. Each is
  `(text, intensity, rng) => text`.
- `harness.js` — the matrix runner, metrics, summary, CSV writer, and run logger.
- `provenance.js` — run identity (version, algorithm, source hash, git, env) + JSONL writer.
- `db.js` — rebuilds a SQLite index from the JSONL logs and runs canned/ad-hoc queries.
- `runs/` — `runs.jsonl` + `results.jsonl` (tracked) and `spab-bench.sqlite` (derived).

## Corruption models

| Model | Simulates | Intensity means |
|-------|-----------|-----------------|
| `saltPepper` | subtle per-symbol substitution noise | per-carrier flip probability |
| `normalize` | spaces partially collapsed to U+0020 | per-carrier collapse probability |
| `blockErasure` | a rewritten/retyped paragraph | fraction of text retyped |
| `cutPaste` | someone copies only part of the doc | fraction kept (contiguous) |
| `truncate` | text cut off | head fraction kept |
| `wordDelete` | edits that drop words (desync) | per-word deletion probability |
| `wordInsert` | edits that add words (desync) | per-gap insertion probability |
| `reflow` | a formatter rewraps whitespace | total loss (baseline) |
| `fullStrip` | all variants normalized away | total loss (baseline) |

Runs are seeded (mulberry32), so results are reproducible.

## Metrics

- **recovery** — exact-payload match rate across trials.
- **detect** — fraction where the decoder reported a (non-failed) frame.
- **confidence** — mean reported confidence.
- **agreement** — mean bit-agreement across redundant copies (in the CSV).
- **false positives** — clean-control samples where the decoder claimed a CRC-valid payload.

## What the baseline currently shows

The v0 codec (2 bits/space, repetition + majority vote, CRC+magic frame) is
deliberately simple, and the numbers reflect it:

- **Redundancy is everything.** Only the long corpus fits several copies and survives
  moderate normalization; short/medium texts fit one copy and fall over fast. This is
  the passage-size vs. capacity tension from the plan, made concrete.
- **Desync is fatal.** `wordDelete` / `wordInsert` / `cutPaste` collapse recovery even
  at low intensity, because the slot stream shifts and repetition can't resync. This is
  the motivation for the sync-aware ECC stacks (markers/A-B framing, fountain, watermark
  codes) in `dev/spab-watermark-plan.md`.
- **Detection is now honest.** With the magic byte, `reflow`/`fullStrip` and the clean
  control read as `not-detected` / 0% false positives — earlier a zero-length payload
  trivially validated.

Use these as the baseline curve to beat as better ECC lands behind the same
`encode`/`decode` interface.
