# Changelog

All notable changes to this project are documented in this file.
The public tree started at v3.0.1; entries below describe public releases only.
`vX.Y.Z` feature work raises the Y bit, fixes raise the Z bit (X only on owner order).

## v3.2.3 - 2026-11-06

Closes the remaining R1 gap in the `sheets` command.

- A 0–3 byte `.xlsx`/`.ods` (or any input shorter than the 4-byte ZIP
  signature) is now rejected inside `listSheets` before `readUInt32LE` runs.
  The command returns `code: "invalid-document"` with an executable `next`
  instead of the generic `failed` / "装置内部异常" wrapper, so a corrupt
  input is distinguishable from a device bug.
- `cmdSheets` now forwards the guard's `next` to the top-level error.
- Tests: new criterion for 0-byte and 3-byte fakes (must be
  `invalid-document` + `next`, never `RangeError`/内部异常), and mutant M282
  (guard disabled must go red).

## v3.2.2 - 2026-11-06

Backports the private tree's `scrub --core-dates` switch (v3.15.9). Default
behavior is unchanged: without the new switch, `scrub` keeps
`dcterms:created`/`dcterms:modified` in `docProps/core.xml` exactly as before.

- `scrub ... [--core-dates keep|now|clear]`: `keep` (default) preserves both
  timestamps byte-for-byte; `now` rewrites them to this run's W3CDTF time
  (milliseconds dropped); `clear` removes both elements. `coreDates.fields`
  reports each field's action (`kept`/`set`/`removed`/`absent`) with old and
  new values.
- `--verify` now rereads the product's `docProps/core.xml` and asserts each
  field against the requested mode instead of only reporting zero residue.
  PDF/ODF inputs with a non-`keep` mode are rejected up front.
- Tests: three mode criteria (keep/now/clear) and mutant M281 (clear
  implemented as "created only" must go red).

## v3.2.1 - 2026-11-06

Backports the private tree's OCR direction fix (v3.15.8). Default behavior is
unchanged: without the new switches `ocr` still runs at 0° and a rotated scan
can come back as `ok:true` with garbage text.

- `ocr [--rotate auto|90|180|270] [--osd]`: `auto` runs tesseract OSD
  (`--psm 0 -l osd`), reports `direction{orientationDegrees,
  detectedCorrectionDegrees, correctionDegrees, confidence, script, rotated,
  reason}`, and rotates the PNG clockwise before recognition when needed.
- Honest degradation: missing `osd.traineddata`/unsupported engine returns
  `unavailable` + `degraded:true`; OSD confidence below 3.0 returns `failed` +
  `degraded:true` with an executable `next` (install `osd.traineddata` or pass
  an explicit angle). No silent 0° success on rotated pages.
- Criteria 171 -> 174; mutants 276 -> 278 (M279/M280).

## v3.2.0 - 2026-10-16

First public feature round. It folds in the v3.1.0 redact expansion (never
released publicly on its own) plus a release-hygiene pass.

- `redact [--fill black|none]`: "删字留白" without black boxes (default stays
  black); same locate+delete+verify pipeline, needle must still read zero.
- `redact [--dry-run]`: preview only — locate + rotation check, no deletion,
  no boxes, no files written (not even parent dirs); refusals surface as
  `wouldSucceed=false` reasons instead of rejections.
- Over-deletion warnings: deleting whole BT…ET blocks that carry text outside
  the boxes is reported (`blocksWithOutsideText`), never silently swallowed.
- Pages with `/Rotate≠0` are refused up front (bbox-to-stream mapping drifts
  with rotation; observed deleting wrong text on rotated fixtures).
- BT…ET splitting is parenthesis-aware (string literals like `TARGET` no
  longer truncate block boundaries).
- `help --brief`: first-read index (name + one line + writes flag); `help --json`
  full structured spec.
- Non-ASCII output paths are rerouted through ASCII temp dirs for the poppler /
  browser backends (ANSI argv decoding), then moved back; reroutes are reported.
- Doctor verifies font hashes against the manifest (same-name-different-bytes
  now fails instead of passing silently).
- Skill installers are atomic (stage + verify + rename, rollback on failure),
  refuse to run without explicit flags, and fold machine paths to placeholders
  in every output line; a self-test judge asserts the placeholder rule.
- Explicit `--out` collisions uniformly return `invalid-output` (raw `EEXIST`
  no longer leaks through `to`).

## v3.0.1 - 2026-10-15

Initial open-source release: the device surface with PII generalized, MIT
LICENSE, one-command setup entry, font loader, skill pack and installers.
Behavioral reports (counts, receipts, failure codes) match the private tree;
machine-specific fixtures and internal account books stay out of this tree
(their absence is reported as SKIP, never claimed as coverage).
