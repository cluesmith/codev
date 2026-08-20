#!/usr/bin/env python3
"""Sanitize a real agy PTY capture for committing as a render-gate fixture (#1474).

Usage: python3 sanitize.py <raw-capture> <fixture-out>

agy's banner embeds the authenticated account email and the session cwd. Both are replaced
with **same-length** placeholders so column alignment — and therefore the rendered screen —
stays byte-for-byte equivalent to the real capture. Nothing else is touched: no SGR attribute
is retouched, because the attributes ARE the measurement.

`newline=""` on both handles is load-bearing. Python's universal-newline translation would
rewrite `\\r\\n` to `\\n` on read, and the carriage returns are what drive the TUI's cursor
back to column 0 — a translated capture renders as a garbled screen that classifies
`no-composer-marker` for reasons that have nothing to do with the classifier.
"""
import re
import sys

# Set to the account the capture was taken under.
EMAIL = "your-account@example.com"
PLACEHOLDER_EMAIL = "builder@example.invalid"

src, dst = sys.argv[1], sys.argv[2]
data = open(src, encoding="utf-8", newline="").read()

data = data.replace(EMAIL, PLACEHOLDER_EMAIL.ljust(len(EMAIL))[: len(EMAIL)])


PLACEHOLDER_PATH = "/home/agent/project"
PATH_RE = r"/tmp/[^\x1b\r\n ]*|/home/[^\x1b\r\n ]*"


def path_sub(m: "re.Match[str]") -> str:
    return PLACEHOLDER_PATH.ljust(len(m.group(0)))[: len(m.group(0))]


# Absolute cwd paths, stopping at ESC / CR / LF / space so the trailing SGR reset survives.
data = re.sub(PATH_RE, path_sub, data)

open(dst, "w", encoding="utf-8", newline="").write(data)

# Leak check. Match on what a leak actually looks like — a path that is NOT the placeholder —
# rather than on the bare prefixes, since PLACEHOLDER_PATH itself starts with `/home/` and
# would make a prefix check fire on every run (a check that always fires checks nothing).
leaks = [EMAIL] if EMAIL in data else []
leaks += [p for p in re.findall(PATH_RE, data) if not p.startswith(PLACEHOLDER_PATH)]
print(f"{dst}: {len(data)} chars, leaks={leaks}")
if leaks:
    raise SystemExit("REFUSING to sanitize: identifiers survived — do not commit this fixture")
