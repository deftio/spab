# spab benchmark harness

Robustness test suite for the spab whitespace watermark codec. It encodes a payload
into varied cover text, pushes the watermarked text through a library of corruption
models, decodes, and scores recovery — plus a clean-control pass that measures how
often the decoder falsely claims a payload in un-watermarked text.

## Run

```bash
node r_and_d/harness.js                       # full matrix, printed summary
node r_and_d/harness.js --trials 100          # more trials per cell (default 40)
node r_and_d/harness.js --csv results.csv     # also write per-cell CSV
node r_and_d/harness.js --model normalize,blockErasure   # subset of corruption models
node r_and_d/harness.js --payload MY-ID-123   # different payload
```

No dependencies — plain Node. The harness drives `../web/spab.js` directly, so the
web visualizer and the benchmark always test the same codec.

## Generated corpus (scale testing)

The handful of texts in `corpora.js` are for quick smoke tests. For statistically
meaningful numbers, sweep the **deterministic generated corpus** — `getDoc(i)` returns
the same document every run, so 25k–100k varied passages come from seeds, not files.

```bash
node r_and_d/harness.js --gen 5000              # sweep 5k generated docs (~2s)
node r_and_d/harness.js --gen 50000             # R&D tier (~7s)
node r_and_d/harness.js --gen 200               # CI subset (fixed prefix)
node r_and_d/harness.js --gen 5000 --csv gen.csv
node r_and_d/harness.js --gen 5000 --offset 50000   # a disjoint slice

node r_and_d/corpus-gen.js --n 20 --print       # inspect sample docs
node r_and_d/corpus-gen.js --n 50000 --stats    # length/kind distribution
node r_and_d/corpus-gen.js --n 5000 --out c.jsonl
```

In `--gen` mode each (doc, model, intensity) runs once — the corpus itself supplies the
variance — and results accumulate on the fly, so memory stays flat at any N.

### Payload size matters (redundancy)

`--payload` sets the message (default `SPAB-7Q2`, 8 bytes, type `string`). Because the
encoder auto-fills spare capacity with repeated copies, a **short** payload in a **long**
passage gets more redundancy and recovers better. Measure the tradeoff with a size sweep:

```bash
node r_and_d/harness.js --paysweep 4,8,16,32,64 --gen 5000
```

It reports, per payload size: the encodable fraction (docs long enough to hold it), the
average number of copies (`reps`), and recovery at a few representative stressors. Shorter
payloads fit in far more docs and survive more corruption — quantify it before picking a
default payload size for headline numbers.

**Two tiers, one generator:** the CI subset is a strict prefix of the R&D sweep, so a
fast per-commit run and a big nightly run test exactly the same documents.

### On-disk corpus (a directory, not a .js file)

For a large corpus that lives as data on disk and can hold real text alongside
generated docs, materialize it to a directory and sweep it with `--corpus-dir`:

```bash
# Write a big generated corpus to disk (JSONL shards; fast, compact)
node r_and_d/corpus-gen.js --out-dir corpus/train --n 50000 --as jsonl --shard 5000

# Or as individual .txt files (human-browsable, bucketed by 1000)
node r_and_d/corpus-gen.js --out-dir corpus/ci --n 200 --as txt

# Sweep documents loaded from the directory (recursively; .txt/.md and .jsonl)
node r_and_d/harness.js --corpus-dir corpuses/train
node r_and_d/harness.js --corpus-dir corpuses/ci --limit 500 --model normalize,cutPaste
```

The loader (`corpus-fs.js`) walks the directory recursively and sorted (deterministic):
each `.txt`/`.md` file is one document; each line of a `.jsonl` file is one document
(a bare string, or `{id?, text}`). So you can **drop your own real text** into the
directory and it's swept the same way. `--limit N` caps how many docs are read.

The `corpus/` directory is gitignored (large, and regenerable from seeds); commit a
specific curated corpus deliberately if you want it versioned.

### Curated real-text corpus (license-free)

Synthetic docs are bland; real text has the whitespace/punctuation statistics that
matter for calibrating the detector and finding the real false-positive floor. Build a
curated, license-free corpus with `corpus-curate.js`:

```bash
node r_and_d/corpus-curate.js                 # download the manifest (public-domain + CC)
node r_and_d/corpus-curate.js --only books    # just one category
node r_and_d/harness.js --corpus-dir corpuses/curated
```

It pulls a mix into `corpus/curated/<category>/`:

- **books/** — public-domain classics (Project Gutenberg), PG boilerplate stripped;
- **wikipedia/** — article plain-text extracts (CC BY-SA 4.0, attribution required);
- **data/** — open CSV datasets (space-poor tabular text — a good low-capacity stress case).

It writes `MANIFEST.md` (per-file source + license + attribution) and `LICENSES.md`, so
CC BY-SA / CC BY attribution obligations are recorded. **This is the only script that
touches the network, and only when you run it** — review the manifest and licenses
before redistributing any downloaded text. Extend the `MANIFEST` array to add sources
(Markdown, more datasets, other authors). The loader also reads `.csv`/`.tsv` now, so a
curated tree of books + Wikipedia + spreadsheets is swept as one corpus.

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
node r_and_d/harness.js --gen 5000 --note "baseline first real run"   # logs a run
node --experimental-sqlite r_and_d/db.js import   # (re)build the SQLite index from JSONL
node --experimental-sqlite r_and_d/db.js runs     # list runs (version, hash, note)
node --experimental-sqlite r_and_d/db.js query    # recovery by version x model x intensity
node --experimental-sqlite r_and_d/db.js sql "SELECT ..."   # ad-hoc SQL
node r_and_d/harness.js --gen 5000 --no-log        # skip logging
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

The v0 codec (2 bits/space, repetition + majority vote, CRC+magic frame — the 0.1.x
format, retired in 0.5.0; see `dev/wire-format.md` for what ships now) is
deliberately simple, and the numbers reflect it:

- **Redundancy is everything.** Only the long corpus fits several copies and survives
  moderate normalization; short/medium texts fit one copy and fall over fast. This is
  the passage-size vs. capacity tension from the plan, made concrete.
- **Desync is fatal.** `wordDelete` / `wordInsert` / `cutPaste` collapse recovery even
  at low intensity, because the slot stream shifts and repetition can't resync. This is
  the motivation for the sync-aware ECC stacks (markers/A-B framing, fountain, watermark
  codes) in `dev/spab-watermark-plan.md`.
- **Detection is now honest.** With the frame checksum, `reflow`/`fullStrip` and the clean
  control read as `not-detected` / 0% false positives — earlier a zero-length payload
  trivially validated.

Use these as the baseline curve to beat as better ECC lands behind the same
`encode`/`decode` interface.

## The measurement surface

| command | what it answers |
|---|---|
| `npm run attacks` | What is being tested. All 27 channel models, what each does, and the real situation it stands in for. A model with no catalogue entry fails the benchmark rather than appearing as an unlabelled row. |
| `npm run benchmark` | How spab behaves: capacity, redundancy achieved, recovery per channel **split by redundancy**, the degradation curve, the safety invariants, and encode/decode cost. |
| `npm run capacity` | How big a secret fits in how much text, from 50 characters to a megabyte against payloads from 4 bytes to a megabyte, in both length-preserving and auto-grow modes. |
| `npm run comparisons` | The same channel, against other published libraries. Lives in `comparisons/` because it needs third-party packages. |

None of these are fast and none are meant to be. They run periodically, not in CI, and
a benchmark that samples its own matrix reports a number nobody can reproduce. Expect
minutes.

### Why recovery figures here differ from a headline number

Recovery depends far more on **redundancy** than on the channel. The same model reads
0% on a passage that fits one copy and 100% on one that fits eight, so any table that
averages across cover lengths describes neither case. The benchmark reports redundancy
bands as separate columns for that reason, and the capacity report exists so the
redundancy a given document affords is knowable in advance.
