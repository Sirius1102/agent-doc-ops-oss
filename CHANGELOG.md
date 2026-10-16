# Changelog

All notable changes to this project are documented in this file.
The public tree started at v3.0.1; entries below describe public releases only.
`vX.Y.Z` feature work raises the Y bit, fixes raise the Z bit (X only on owner order).

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
