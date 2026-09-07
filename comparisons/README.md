# comparisons — spab measured against other libraries

Separate from the rest of the repo on purpose. Everything here needs **third-party
packages**, and spab itself has zero runtime dependencies. Nothing in this folder is
published to npm, run in CI, or required to build or test spab.

```bash
cd comparisons
npm install          # optional deps; each adapter skips itself if absent
node run.js          # benchmark every library that is installed
node run.js --md ../r_and_d/reports/comparisons.md
```

## What this is, and what `r_and_d/compare.js` is

Two different things, and conflating them would misrepresent both:

| | what it runs | what it isolates |
|---|---|---|
| `r_and_d/compare.js` | **reimplementations** of each technique, written here | a design decision — payload placement, presence of ECC — with everything else held equal |
| `comparisons/run.js` | **the actual published libraries** | how the real implementations behave on the same channel |

The reimplementations are the fair way to compare *ideas*; this folder is the honest
way to compare *software*. A library can beat its own technique's reference model by
doing something clever, or lose to it by doing something expensive for reasons that
have nothing to do with watermarking.

## Adapters

Each adapter declares what it is, where it came from, and how to install it, and
reports itself unavailable rather than failing when its dependency is absent — the
same pattern `tests/lint.js` uses for port toolchains. A missing library is a skipped
row, never a zero.

| adapter | technique | source | status |
|---|---|---|---|
| `spab` | multi-carrier substitution + ECC | this repo | always available |
| `stegcloak` | zero-width insertion at one point, compressed + encrypted | `npm:stegcloak` | installable |
| `zero-width` | zero-width insertion, no framing | `npm:zero-width-lib` | installable |
| `vsrmark` | Unicode variation selectors, one byte per carrier | GitHub, not on npm | see below |
| `innamark` | whitespace substitution, JVM | GitHub, JVM toolchain | see below |

### Not wired up, and why

**Name collisions on the public registries.** `drift` on PyPI is a CMS editing tool,
and `stegmark` on PyPI is a steganalysis detector — **neither is the project of that
name in the literature**. Wiring them up would produce numbers attributed to projects
that did not produce them, which is worse than an empty row. If you have the real
ones from their repositories, add an adapter pointing at your checkout.

**VSRMark** publishes C, Go, Java, Rust, Swift and TypeScript implementations but no
npm package. An adapter can shell out to a local build; `adapters/vsrmark.js` has the
interface and the detection, and skips until `VSRMARK_BIN` points at one.

**Innamark** is JVM and its repository states that **patent licensing is required in
addition to the software licence**. That is a decision for whoever runs the
comparison, not something this repo should make by vendoring it.

## Reading the output

The same corpus, payloads and corruption models as `r_and_d/benchmark.js`, so rows
are directly comparable. Three caveats before quoting anything:

1. **Capacity and robustness are not one axis.** A library with no error correction
   is not "worse"; it is a different operating point. The tables report both.
2. **Not every library takes an arbitrary payload.** Where one is restricted, the
   adapter says so and the row is marked rather than silently truncated.
3. **Versions are recorded in the output.** These are moving targets and a table
   without versions goes stale silently — the same failure this repo has already had
   with its own capability matrix.
