---
name: Bug report
about: something the tool did (or refused to do) that contradicts its documentation
labels: bug
---

**Command** — the exact command line (strip input/output paths first if they
carry usernames — receipts echo them by design, see README distribution notes):

```
<paste the command here>
```

**Actual output** — stdout, unmodified except path stripping. The echoes are
the evidence: do not summarize them.

```
<paste output here>
```

**selftest result** — the summary line from your run (`passed/failed/skipped`
three numbers, no `--keep` needed for a bug report):

```bat
node dockit.js selftest
```

**Environment**

- Windows edition and build:
- Node version (`node --version`):
- backend present (OfficeCLI/Tesseract/Poppler/Pandoc — `doctor` says which):

**What you expected, and what the docs say** — link the README section you followed, so
a docs bug and a tool bug can be told apart.
