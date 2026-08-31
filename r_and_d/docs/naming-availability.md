# Name: "spab" — availability & branding

Decision: **keep the name spab** (SPace tAB origin; verbable — "we spab-encoded the document").
Treat it as a coined name with a nice etymology, paired with a plain descriptor tagline
("spab — robust text watermarking"), not a literal acronym to live up to.

## Registry collision check (2026-08)

| Registry | Bare `spab` | Status | Action |
|----------|-------------|--------|--------|
| **npm** | taken/reserved | Verified on `registry.npmjs.org/spab`: created 2019, **all 19 versions unpublished 2021-09-24**; hidden from site search but the name is held. Last owner `lanserdi`; upstream `github.com/lanserdi/spab-cli` now 404 (abandoned). | Publish **scoped**: `@deftio/spab` (set, with `bin.spab` so the command stays `spab`). Optional: reclaim the abandoned name — draft in `npm-name-reclaim-request.md`. |
| **PyPI** | available | `/pypi/spab/json` and simple index return 404 (no project). | Claim `spab` (reserve soon). |
| **apt / Debian** | clear | No Debian/Ubuntu package named `spab` (only unrelated hits: `spass`, the SPAB ETF ticker). | No collision; Debian packaging is a separate later effort. |
| **crates.io** | available | Search API returns 0 crates for `spab`. | Claim `spab` when the Rust port lands. |
| **Maven Central** | available | Search API returns 0 artifacts with artifactId `spab`. | Use groupId `com.deftio`, artifactId `spab`. |

**Summary:** bare `spab` is free on PyPI, apt, crates.io, and Maven; only **npm** requires scoping
(`@deftio/spab`) because of the unpublished-name placeholder. Grab PyPI/crates soon to reserve them.

## Non-software name uses (search/branding awareness, not blockers)

- **SPAB** — State Street SPDR Portfolio Aggregate Bond ETF (a heavily-indexed finance ticker).
- **SPAB** — Society for the Protection of Ancient Buildings (UK heritage charity).

Neither is software, so no package/trademark conflict for a dev library, but they dominate a bare
"spab" web search. The `@deftio/spab` scope and a consistent tagline keep the project distinct.

## Consistency

- npm package id: `@deftio/spab`. Python/PyPI: `spab`. Rust crate/Java: confirm at publish time.
- The library, CLI, and brand name remain **spab** everywhere in docs and code; only the npm
  *package identifier* is scoped.
