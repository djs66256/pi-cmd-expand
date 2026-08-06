# Behaviour reference

Detailed semantics of each expansion. See [README.md](../README.md) for
the quick start, and [architecture.md](./architecture.md) for how it is
implemented.

## Wrap format

Every expansion is wrapped in `<cmd>…</cmd>` or `<file>…</file>`.
Provenance is in the attributes (`source` for commands, `path` for
files, optional `lang` for fenced commands). Outcome metadata
(`status="failed" exit-code="N"`,
`status="truncated" inline-size=… total-size=…`, `status="circular"`)
is added when something goes wrong; the body of the tag still contains
the human-readable `[command failed: …]` / `[file failed: …]` /
`[Output truncated …]` / `[file skipped: circular reference: …]` marker.

Single-line content wraps inline (`<cmd source="ls">AUTHORS</cmd>`);
multi-line content wraps multi-line with the tags on their own lines:

```
<cmd source="ls -1">
AUTHORS
LICENSE
README.md
</cmd>
```

## Failure handling

- A failing command becomes `[command failed: exit code N]` inside the
  wrap (with stdout/stderr above it when present).
- A missing file becomes
  `[file failed: ENOENT: no such file or directory, open '/abs/path']`.
- A circular `` @`path` `` chain becomes
  `[file skipped: circular reference: ./foo.md]`.

The expansion never throws, so a broken `` !`cmd` `` or `` @`path` ``
never aborts a turn.

## Truncation

Command output over 2 KB is tail-truncated in place; file content over
10 KB is tail-truncated in place. In both cases the full content is
written to `/tmp/pi-cmd-expand-*.log` and the temp file path is appended
inline as `[Output truncated ... Full output: <path>]`, inside the wrap,
so the LLM can read it on demand. Failed commands bypass truncation so
the diagnostic is preserved.

## Recursion

A file loaded via `` @`path` `` is run through the same expansion
pipeline as the top-level text, up to a depth cap of 10. Cycles are
short-circuited with a per-chain visited set. The depth cap is a safety
net; in normal use, depth 1–3 is plenty. Recursive expansion produces
nested `<file>` tags (the outer one is from the user's prompt; inner
ones are from inside the loaded file).

## Caching

Context-file expansions are cached by `path + mtime + size` within a
session, so multi-turn sessions don't re-run the same commands or
re-read the same referenced files every turn. Files loaded via
`` @`path` `` inside a context file are NOT individually cached —
they're cached as part of the containing file's expansion result, and
re-read whenever the containing file changes.

## Timeout

5 s per command. Slow commands are killed and reported as
`[command failed: timed out after 5000ms]` inside the wrap.

## Shell

Commands run through pi's built-in `createLocalBashOperations()`, so
shell resolution (Git Bash on Windows, WSL, `/bin/bash` on Unix, `sh` as
fallback), output sanitisation (ANSI strip, control-char filter, CR
normalisation), and process-tree cleanup on timeout are all inherited
from pi's native `bash` tool. `|`, `>`, `$VAR`, etc. work the way you'd
expect.

## Source truncation

The `source` attribute on `<cmd>` tags is truncated to ≤ 20 characters
(first line of fenced body, with `...` indicating further truncation).
Long commands stay executable; only the visible provenance is short.

## Email safety

The inline `` @`path` `` regex uses a `(?<!\w)` lookbehind so email-like
text such as `` user@`example.com` `` is NOT matched. `` @` `` after a
word character (alphanumeric / `_`) is left alone; `` @` `` at
start-of-string, after whitespace, or after punctuation still triggers
file loading.
