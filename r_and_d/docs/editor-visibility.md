# Editor / renderer visibility of carrier characters (defaults)

How common editors treat spab's candidate carrier characters **out of the box** (no plugins, no
opt-in settings). They all *can* reveal these characters — the interesting part is the default.
Both **prose** (`.txt`/`.md`) and **source code** are fair game for spab, and editors frequently
default *differently* for the two (notably VS Code: highlighting on for code, off for
Markdown/PlainText). The table separates those columns so each target is covered.

Confidence: ✅ verified (docs or direct observation) · ~ inferred/font-dependent · see Sources.

## Carrier classes

- **WS-var** — visible-width special spaces spab uses (U+2004–U+200A, e.g. U+2006/2009/200A).
- **ZW** — zero-width / invisible-operator chars (U+200B/C/D, U+2061–2064) — StegCloak's carriers.
- **Punct-confusable** — legitimate typography look-alikes spab uses (curly `'`↔`'`, hyphen
  U+002D↔U+2010, `...`↔`…`).
- **Homoglyph-letter** — cross-script look-alike *letters* (Latin `a` vs Cyrillic `а`) — spab's
  risky, default-off class.

## Default behavior

Each cell is what the viewer shows **by default**, using three states — the first two both mean
"a reader wouldn't notice"; the third is the stealth-breaker:

- **not shown** — no visible mark at all: a zero-width char (no glyph), or a special space that
  renders like an ordinary space. You see nothing.
- **looks normal** — the character *is* drawn, but as an ordinary-looking glyph with no
  highlight, so you wouldn't notice it's unusual without inspecting.
- **FLAGGED** — the viewer deliberately draws attention to it (a `<hex>` box or a highlight/border);
  it stands out.

For spab stealth, *not shown* and *looks normal* are both fine; *FLAGGED* is the bad outcome.

| Carrier | Browser / renderer | Windows Notepad | Notepad++ | Sublime Text 4 | VS Code — `.txt`/`.md` | VS Code — code file |
|---------|--------------------|-----------------|-----------|----------------|------------------------|---------------------|
| **WS-var** | not shown (renders as space) ✅ | not shown ~ | not shown ~ | **FLAGGED (`<2006>` box)** ✅ | not shown ✅ | **FLAGGED (invisible-char)** ✅ |
| **ZW** | not shown ✅ | not shown ~ | not shown (even in "show all") ✅ | not shown ✅ | not shown ✅ | **FLAGGED (invisible-char)** ✅ |
| **Punct-confusable** | looks normal ✅ | looks normal ✅ | looks normal ✅ | looks normal ✅ | looks normal ✅ | looks normal ~ |
| **Homoglyph-letter** | looks normal ✅ | looks normal ~ | looks normal ~ | looks normal ~ | looks normal ✅ | **FLAGGED (ambiguous)** ✅ |

## What this means for spab

- **Punctuation confusables are the stealthiest carrier by default** — they render as normal
  typography everywhere and aren't flagged (they *are* legitimate characters). Strong argument for
  the confusables class as the default-on complement to whitespace.
- **Whitespace variants are quiet except in Sublime** (which draws them as `<2006>` boxes by
  default) and in VS Code *code files* (invisible-char highlight). In `.txt`/`.md`, VS Code leaves
  them alone. So spab's whitespace channel is invisible on the surfaces that matter (web/doc/chat,
  plain-text editors) but visible to a Sublime user eyeballing the raw file.
- **Zero-width is the most default-invisible** (even Notepad++'s "show all" misses it) — *except*
  VS Code code files. This is why StegCloak looks clean in Sublime. But zero-width is also the most
  auto-stripped by sanitizers/plain-text fields — the stealth↔fragility trade.
- **The code vs. prose split is the key subtlety.** VS Code enables invisible/ambiguous highlight
  **by default for source code**, but those settings are **false by default for Markdown and
  PlainText**. So the same carrier is quiet in a `.md` file and flagged in a `.py` file. Both are
  valid spab targets — pick the column that matches where the watermarked text will live (and note
  that watermarking source code means the carriers may be visible to the developer editing it).

## Caveats & how to make this authoritative

- Several cells are font-dependent (Notepad/Notepad++ may render an unknown-width space as a
  `.notdef` box in some fonts, blank in others) or version-dependent. Marked ~ above.
- Every editor has a mode/plugin to reveal these; this table is **defaults only**.
- **Do our own measurement.** Build a tiny fixture file containing each carrier class with labels,
  open it in each editor at default settings, screenshot, and fill this table from observation.
  That converts ~ cells to ✅ and future-proofs it against version changes. (Ties to the
  "carrier visibility is an empirical, per-codepoint-class question" note in the plan.)

## Sources

- VS Code 1.63 (Nov 2021) — Unicode highlighting of invisible/ambiguous characters, default on for
  code, off for Markdown/PlainText: https://code.visualstudio.com/updates/v1_63 and
  https://github.com/microsoft/vscode/pull/137508
- Sublime Text — default shows no nonprintable Unicode; `draw_unicode_white_space` / plugins to
  reveal: https://packagecontrol.io/packages/VisualizeZeroWidthChars ,
  https://github.com/redoPop/SublimeGremlins ,
  https://forum.sublimetext.com/t/v-4152-draw-unicode-white-space-problem/68982
- Notepad++ — zero-width (U+200B) invisible even in "Show All Characters":
  https://community.notepad-plus-plus.org/topic/22091/option-to-display-all-zero-width-characters ,
  https://github.com/notepad-plus-plus/notepad-plus-plus/issues/4731
