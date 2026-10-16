**What changed** — one sentence per item.

**selftest** — paste the summary line and confirm the shape (`passed/failed/skipped`
three numbers; SKIP only for documented-missing backends/docs/samples):

```bat
node dockit.js selftest
```

**Version bits and tracked files** — did this PR touch a version carrier
(`dockit.js` VERSION, header comment, `package.json`, `package-lock.json`,
README version line) or add/remove tracked files? If yes, state old → new
for each location, decided one occurrence at a time (no bulk replacement).
If not, write "untouched".

**README editions** — if a command row or structural section changed, confirm
the same change landed in both `README.md` and `README.en.md` in this PR
(no machine gate yet — pair them by hand).

**Checklist**

- [ ] selftest: `0 failed` (SKIP only where documented)
- [ ] installer tests: `node test/installers-args.js` green (if installers touched)
- [ ] no absolute paths or usernames in pasted outputs (placeholders only)
- [ ] version carriers consistent (or explicitly untouched)
- [ ] both README editions updated together (or explicitly untouched)
- [ ] no new runtime dependencies beyond `package.json` (or reason stated)
