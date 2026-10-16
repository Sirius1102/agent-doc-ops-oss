---
name: agent-doc-ops
description: Convert, render, inspect, recalculate and metadata-scrub Office documents through the local dockit device. Use when asked to convert any supported format to PDF/PNG/CSV/TXT (or batch-convert a folder), render pages to images, count pages, check missing fonts, list worksheet names, recalculate formulas, extract a per-cell formula-error map, extract embedded media, combine/split/rotate/delete/reorder PDF pages, extract a PDF's embedded text layer directly (no OCR), cross-check a PDF's text layer against its rendered layer, detect tracked changes and comments in a Word file, chain convert→render→OCR, OCR pages, or clean document metadata before sharing a file.
---

# dockit — document operations device (pointer card, not a copy)

<!-- 判据条数=164 -->

This card does one thing: **point the session at the single source of truth.** The
command list, response fields, boundaries and report format all come from the device
itself — never memorize them, always read them back. Any copy made here will drift.

## Setup (once)

Clone the repo, install dependencies, verify:

```bat
git clone https://github.com/Sirius1102/agent-doc-ops-oss.git
cd agent-doc-ops-oss
npm install
npm run doctor
```

Let `<REPO>` denote the full path of the cloned directory (e.g. `D:\tools\agent-doc-ops-oss`).

## Mandatory three steps (every session that uses dockit)

1. Read the pointer master: `<REPO>\给其它agent-调用卡.md` if present, else this card.
2. Idempotent preflight — first thing before any work:
   ```bat
   node <REPO>\dockit.js doctor
   ```
   `ok=true` → continue. Any `FAIL` → paste that line verbatim and stop; do not patch
   the device source.
3. To see the command surface, read what the device reports (don't recite):
   ```bat
   node <REPO>\dockit.js help
   node <REPO>\dockit.js help to
   ```

## Boundaries (enforce per the pointer master, section 1)

- Input files read-only; outputs go to `_out/` or a path the task spec gives; never
  overwrite an existing file.
- Do not pull document body text, author names or company names into context — use the
  shape outputs of `inspect` / `check` / `dump`.
- Number-bearing deliverables: `recalc` before export; multi-sheet CSV needs
  `--sheet <exact name>`; run `scrub --verify` before sending anything out.
- Never send documents or screenshots into a live chat session.

## Notes

- `doctor`'s `ocr-lang-pack` check is WARN-only by design: a missing language pack is a
  machine fact, not a defect — a fresh clone must stay green.
- Where the project documentation lives (architecture, history): see `README.md` in the
  repo root.
- Public-tree note: `<REPO>\给其它agent-调用卡.md`, `项目总览.md` and
  `entry-points.json` exist only in the private tree. In a public clone they are
  absent — this card is then the whole usage master (judges SKIP on missing
  files by design, never claim coverage).
