# Dogfooding bitwrench for the spab GUI — notes

> **bitwrench is a dev-only choice — not a dependency.** The GUI page loads it from the jsDelivr CDN
> (`<script src=...>`), and `npm run gui` fetches `bwcli` on demand via `npx`. It is **not** in
> `dependencies` or `devDependencies` anywhere, so spab's recorded dep list stays zero.


Built `pages/index.html` entirely with bitwrench (theme + components + TACO), per the "use
bitwrench for all GUI" direction. What worked cleanly, and the friction points worth your attention.

## Worked cleanly (almost no custom CSS/DOM)

- `bw.loadStyles({primary, secondary, radius, elevation})` — theme + palette/layout tokens.
- `bw.makeCard({title, content})`, `bw.makeButton({text, variant, size, onclick})` — structure & actions.
- `bw.DOM('#id', taco)` for the five dynamic regions (meta, marker, attacks, sliders, result) —
  mount-once shell + targeted re-mounts. Clean, no focus/scroll loss.
- `bw.s({...})` for the few inline styles; `bw.escapeHTML`, `bw.raw` for the carrier visualization.
- Only bespoke CSS: the carrier-cell colors (v0–v3 + punctuation mark) — genuine data-viz, injected
  once with `bw.css`/`bw.injectCSS` using palette tokens. Everything else is components/theme.

## Friction points (the useful feedback)

1. **Controlled form inputs are the main gap.** The `make*` form components (makeInput,
   makeTextarea, makeSelect, makeCheckbox, makeRange) read as *display*-oriented; for **controlled**
   inputs (bind `value` + `oninput`→state, read back later) I dropped to plain TACO
   `{t:'input', a:{class:'bw_form_control', oninput}}` / `{t:'textarea',...}` / `{t:'select',...}`.
   It wasn't clear from the docs whether these forward `oninput`/`onchange`/`id`, or how to read a
   component's current value. **Ask:** a short "controlled inputs / two-way binding" recipe, and a
   note on whether make-form components forward event handlers + `id`.

2. **Layout component child prop is undocumented.** `makeCol({xs,sm,md,lg,xl})` — but which key
   holds children (`c`? `content`? `children`?)? I avoided `makeRow`/`makeCol` and used a plain
   `display:flex; flex-wrap` div. Clarify the children prop for layout components.

3. **No toggle/segmented control.** For the attack chips (on/off toggles) I re-mount a row of
   `makeButton`s flipping `variant` on state. `makeChipInput` is tag-entry, not toggles. A
   `makeToggle` / `makeSegmented`, or a documented "toggle button group" pattern, would fit here.

4. **`makeBadge` signature not in the LLM guide.** I used `{t:'span', a:{class:'bw_badge bw_success'}}`
   (from a README example) for status pills and metric chips. Worked, but the guide's component
   table lists makeBadge without props — a signature would let me use the component.

5. **Palette: a "muted text" token would help.** I wanted secondary/muted text and there's no
   `p.muted`; fell back to `p.dark.base` + opacity. A named muted/subtle-text role would be cleaner.
   (Field discoverability generally leans on the one panel example — a palette-roles cheat sheet
   would help.)

## Verification

Couldn't screenshot via `bwcli` from the build sandbox — bwcli's `--allow-screenshot` /
`client.screenshot()` capture through a *connected browser*, and this sandbox has no browser
(no puppeteer/playwright, no display) and can't reach a localhost server. Instead verified two ways:

- **SSR (headless):** `bw.makeStyles`/`bw.makeCard`/`bw.makeButton` + `bw.html` render without
  error; every palette field the GUI uses exists (`p.primary.base`, `p.dark.base`, `p.light.border`,
  `p.secondary.base/.textOn`, `p.surface`, `L.radius.card`, `L.spacing.card`).
- **jsdom (headless, full runtime):** loaded real bitwrench UMD + `spab.js` + the page script into
  jsdom — `#app` mounts, encode runs (metadata badges render), carrier highlight populates, 8 attack
  chips render, decode shows `PERFECT · spab-2026 · via ws`; **clicking the "strip whitespace" chip
  re-decodes to `NOT-DETECTED`** → confirms the bitwrench components and event wiring work.

So the page is functionally validated end-to-end; only a pixel screenshot is missing (needs a real
browser — you can `bwcli serve pages && bwcli attach` locally, or just open it).

## Net

bitwrench carried theme, cards, buttons, layout, and styling with essentially zero custom CSS — the
carrier-cell colors are the only bespoke styling, and that's legitimately app-specific. All the
friction is concentrated in **controlled form inputs**; a two-way-binding recipe would remove the
one place I left the framework. No blockers.
