#!/usr/bin/env python3
"""Sanitize a real agy PTY capture for committing as a render-gate fixture (#1474).

Usage: python3 sanitize.py <raw-capture> <fixture-out>
       python3 sanitize.py --selftest

agy's banner embeds the authenticated account email and the session cwd. Both are replaced
with **same-length** placeholders so column alignment — and therefore the rendered screen —
stays byte-for-byte equivalent to the real capture. Nothing else is touched: no SGR attribute
is retouched, because the attributes ARE the measurement.

`newline=""` on both handles is load-bearing. Python's universal-newline translation would
rewrite `\\r\\n` to `\\n` on read, and the carriage returns are what drive the TUI's cursor
back to column 0 — a translated capture renders as a garbled screen that classifies
`no-composer-marker` for reasons that have nothing to do with the classifier.

**Every check runs before anything is written.** A leak means the output file is never
created, rather than created and then complained about — the earlier ordering wrote the
unsafe fixture to disk first, so `git add` could reach it in the window before anyone read
the error, and the "REFUSING" message was false by the time it printed. A guarantee that
depends on cleanup running is weaker than one that never creates the file.
"""
import re
import sys

# Set to the account the capture was taken under.
EMAIL = "your-account@example.com"
PLACEHOLDER_EMAIL = "builder@example.invalid"

PLACEHOLDER_PATH = "/home/agent/project"
# Absolute cwd paths, stopping at ESC / CR / LF / space so the trailing SGR reset survives.
# `/Users/` is here for macOS captures: without it a mac capture sanitizes "successfully"
# while leaking a username, since the leak check below only looks at what this same pattern
# finds. The prefixes the scrubber rewrites and the prefixes the check inspects must be the
# same set, or the check is narrower than the risk.
PATH_RE = r"/tmp/[^\x1b\r\n ]*|/home/[^\x1b\r\n ]*|/Users/[^\x1b\r\n ]*"


def path_sub(m: "re.Match[str]") -> str:
    return PLACEHOLDER_PATH.ljust(len(m.group(0)))[: len(m.group(0))]


def scrub(data: str) -> str:
    """The redaction itself — same-length replacements, no attribute retouching."""
    data = data.replace(EMAIL, PLACEHOLDER_EMAIL.ljust(len(EMAIL))[: len(EMAIL)])
    return re.sub(PATH_RE, path_sub, data)


def is_placeholder(path: str) -> bool:
    """True for anything `path_sub` can legitimately emit.

    Same-length substitution means a captured path SHORTER than PLACEHOLDER_PATH comes back
    truncated — a cwd of `/home/ab/x` becomes `/home/agent/p`. Those are prefixes of the
    placeholder, carry no identifier, and must not read as leaks; an earlier `startswith`
    check rejected every one of them, which would have made a short-cwd capture impossible
    to sanitize. Longer paths are placeholder + space padding, so `startswith` covers those.
    """
    return path.startswith(PLACEHOLDER_PATH) or PLACEHOLDER_PATH.startswith(path)


def find_leaks(data: str) -> "list[str]":
    """Identifiers that survived the scrub.

    Matches on what a leak actually looks like — a path that is not something the scrubber
    itself wrote — rather than on the bare prefixes, since PLACEHOLDER_PATH starts with
    `/home/` and would make a prefix check fire on every run (a check that always fires
    checks nothing).
    """
    leaks = [EMAIL] if EMAIL in data else []
    leaks += [p for p in re.findall(PATH_RE, data) if not is_placeholder(p)]
    return leaks


def sanitize_file(src: str, dst: str) -> "list[str]":
    data = scrub(open(src, encoding="utf-8", newline="").read())
    leaks = find_leaks(data)
    print(f"{dst}: {len(data)} chars, leaks={leaks}")
    if leaks:
        # Nothing has been written yet, so `dst` does not exist and cannot be committed.
        raise SystemExit("REFUSING to sanitize: identifiers survived — no fixture was written")
    open(dst, "w", encoding="utf-8", newline="").write(data)
    return leaks


def selftest() -> None:
    """Exercise the refusal path for real — a leak must leave NO file behind.

    The blocking review item on PR #1491 was that the write happened before the check, so a
    leaking capture landed on disk and the "REFUSING" message was false by the time it
    printed. Asserting the new ordering in a comment would be worth nothing; this runs it and
    stats the path.
    """
    import os
    import tempfile

    # The predicate, including the two cases that made the earlier versions wrong.
    assert find_leaks("cwd /home/agent/project ok") == [], "placeholder must not read as a leak"
    assert find_leaks("cwd /home/agent/p ok") == [], "a TRUNCATED placeholder is not a leak"
    assert find_leaks("cwd /home/realuser/thing") == ["/home/realuser/thing"]
    assert find_leaks("cwd /Users/realuser/thing") == ["/Users/realuser/thing"], "macOS paths"
    assert find_leaks(f"account {EMAIL}") == [EMAIL]

    d = tempfile.mkdtemp()
    src, dst = os.path.join(d, "raw"), os.path.join(d, "fixture.txt")

    # A capture the scrubber does not fully clean. `scrub` is stubbed out rather than fed a
    # cleverly-crafted input, because what is under test is the ORDERING — that a residual
    # identifier, however it arises, cannot reach the filesystem.
    open(src, "w", encoding="utf-8", newline="").write("cwd /home/realuser/secret\r\n")
    global scrub
    real_scrub, scrub = scrub, lambda data: data
    try:
        sanitize_file(src, dst)
    except SystemExit:
        pass
    else:
        raise AssertionError("sanitize_file accepted a leaking capture")
    finally:
        scrub = real_scrub
    assert not os.path.exists(dst), f"leaking capture left {dst} on disk"

    # And the clean path still writes, same-length and identifier-free.
    raw = f"account {EMAIL}\r\ncwd /home/realuser/some-project\r\n"
    open(src, "w", encoding="utf-8", newline="").write(raw)
    sanitize_file(src, dst)
    out = open(dst, encoding="utf-8", newline="").read()
    assert EMAIL not in out and "realuser" not in out, out
    assert len(out) == len(raw), "same-length redaction keeps column alignment"
    print("selftest: ok")


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "--selftest":
        selftest()
    elif len(sys.argv) == 3:
        sanitize_file(sys.argv[1], sys.argv[2])
    else:
        raise SystemExit(__doc__)
