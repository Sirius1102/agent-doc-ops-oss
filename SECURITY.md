# Security policy

## What this tool is (and is not)

A local CLI that reads and writes document files on the operator's own
machine: conversions, redaction, metadata scrubbing, media extraction. There
is no daemon, no telemetry, and dockit itself makes no network connections
(`npm install` fetches public packages; that is the operator's explicit act).
Two components reach the network on their own terms, both documented, neither
silent about it:

- The OfficeCLI backend self-updates (see `docs/adr/ADR-002`). It is
  operator-provided, never shipped, and every backend call fingerprints the
  binary before and after (`binaryBefore`/`binaryAfter`/`binaryDrift`).
- The optional system-dependency installer only downloads what the operator
  explicitly names (URL + SHA256 supplied per call), verifies the hash before
  executing anything, and never elevates silently.

Privacy posture, enforced by self-tests, not promises:

- Document body text, author names and company names never enter reports —
  inspection commands return field names, lengths and hashes (shape outputs).
- Diagnostic outputs (doctor, installers, charset baseline) fold machine paths
  to placeholders (`%USERPROFILE%`, `<REPO>`); a self-test judge asserts this
  with injected marker paths.
- Command receipts echo the input/output paths the caller explicitly gave
  (that echo is the contract — it tells you which file). Strip path lines
  before pasting any output into a public issue.

This is a trust-of-the-operator model: whoever can run the commands can read
and write the files. The guards exist to stop an *agent* (or a tired human)
from overwriting inputs, trusting an unverified product, or pasting machine
paths into public — not to contain a malicious operator.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open this repository's
**Security** tab and choose **Report a vulnerability**. If that flow is not
available, contact the maintainer (Sirius) directly instead of filing a public
issue. Please include:

- the exact command line (strip input/output paths first — they may carry
  usernames);
- the echoed output JSON (same path hygiene);
- the self-test summary line from your run.

Do not attach real documents, screenshots of your desktop, or font binaries.

## Scope

`dockit.js`, the installers (`setup.js`, `install-skill.js`,
`install-fonts.js`, `install-system-deps.js`), the skill pack, and the
documentation. Upstream engine issues (LibreOffice kit, Tesseract, Poppler,
OfficeCLI binaries) belong to their upstreams — but a reproducer showing this
tool mishandles their output is in scope. If a CI workflow ever runs untrusted
input, it must run the offline self-test only.
