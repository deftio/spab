<!-- Keep PRs small and focused. Branch name: type/short-description (feat/…, fix/…, docs/…). -->

## What & why

<!-- What does this change and why? Link the issue: Closes #NNN -->

## Type

<!-- Conventional-commit type of the squash-merge commit: -->
- [ ] feat  · [ ] fix  · [ ] docs  · [ ] test  · [ ] refactor  · [ ] perf  · [ ] ci  · [ ] chore

## Checklist

- [ ] `npm run ci` is green locally (lint + conformance + branch tests + smokes)
- [ ] `npm run fuzz` and `npm run coverage` pass (branch coverage stays 100%)
- [ ] Tests added/updated for the change
- [ ] `CHANGELOG.md` updated under `[Unreleased]` (for any user-facing change)
- [ ] Zero-dependency invariant preserved (no runtime/dev deps added)
- [ ] If the codec/wire format changed: versions bumped in all three files, or noted as pre-release
- [ ] Docs updated (README / CONTRIBUTING / pages) where relevant

<!-- Reviewer will squash-merge into main (linear history); the branch is deleted after merge. -->
