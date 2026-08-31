# npm name reclaim — draft request for `spab`

Draft to send to npm support to release the abandoned, unpublished package name `spab`.
Low-priority / parallel effort — we ship as `@deftio/spab` regardless. Fill the bracketed fields.

**How to send:** open a ticket at https://www.npmjs.com/support (or email `support@npmjs.com`).
Reference npm's package-name-dispute policy: https://docs.npmjs.com/policies/disputes

---

**Subject:** Request to release abandoned/unpublished package name: `spab`

Hello npm Support,

I'd like to request that the package name **`spab`** be made available for publishing. Based on the
public registry it appears abandoned:

- The name `spab` exists in the registry but **all 19 versions were unpublished on 2021-09-24**
  (the `registry.npmjs.org/spab` document contains an `unpublished` tombstone; the package does not
  appear in site search).
- The last owner appears to be npm user **`lanserdi`**, and the package's upstream repository,
  `https://github.com/lanserdi/spab-cli`, now returns **404** (removed). There is no active project.
- There are no currently published versions under this name.

I maintain an active, open-source library also named **spab** (a dependency-free text-watermarking
codec; BSD-2-Clause). I'm currently publishing it as **`@deftio/spab`** and would like to also
publish under the bare name `spab` if the abandoned reservation can be released.

Could you let me know whether this name can be freed for me to publish, or advise on the required
process? Happy to provide any additional information.

Thank you,
[Your name] — npm username **[your-npm-username]** — [your email] — https://github.com/deftio

---

## Facts on file (for reference)

- Registry evidence: `curl -s https://registry.npmjs.org/spab` → `time.unpublished.time = 2021-09-24`,
  19 versions listed (0.0.1 … 4.0.0).
- Last owner: `lanserdi`; upstream `github.com/lanserdi/spab-cli` → HTTP 404.
- Our fallback (already live-ready): `@deftio/spab`, with `bin.spab` so users still type `spab`.
- If released, we can publish bare `spab` and keep `@deftio/spab` as an alias/scope.
