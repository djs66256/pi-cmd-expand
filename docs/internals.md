# Internals

Function-level map of `src/index.ts`, the wrap format it emits, and the
non-obvious invariants. Read [architecture.md](./architecture.md) first
for how the pieces are called.

## Helpers

- `findAllMatches(text)` — finds `` !`cmd` ``, `` !```sh\ncmd\n``` ``,
  `` @`path` ``, `` @```\npaths\n``` ``. Fenced first, then inline;
  within each character class (`!` vs `@`), fenced wins; inline matches
  inside any fenced range (of either class) are skipped. The inline
  `` @`path` `` regex uses a `(?<!\w)` lookbehind to avoid false
  positives on email-like text.
- `runCommand(command, cwd, timeoutMs)` — wraps `bashOps.exec`, returns
  a `CommandOutcome` (output, exitCode, truncated, byte sizes). Failed
  commands bypass truncation.
- `loadFileRaw(relPath, cwd)` — reads a file with
  `fs.readFile(path, "utf-8")` and returns a `FileOutcome` (output,
  status `"ok" | "failed"`, error?, …). Never throws — the status field
  tells the caller whether to recurse.
- `formatCmdWrap(outcome, command, lang)` — builds
  `<cmd source="…" [lang="…"] [status="…" exit-code|inline-size|total-size]>…</cmd>`,
  picking single-line vs multi-line wrapping based on body line count.
- `formatFileWrap(outcome, path)` — builds
  `<file path="…" [status="…" error|inline-size|total-size]>…</file>`
  with the same wrapping rule.
- `quoteAttr(value)` — wraps a value in `"` (or `'` if it contains `"`).
- `truncateSource(source)` — collapses to first line and truncates to
  ≤ `SOURCE_MAX_CHARS` (20) with a trailing `...`.
- `wrapWithTag(tagName, attrs, content)` — applies the
  inline-vs-multi-line wrapping rule (trailing `\n` stripped).
- `expandFileReferences(match, cwd, …, visited)` — loads each path in a
  `FileMatch`, recursively expands the content (which itself produces
  wrapped output), applies the per-file cap, formats via
  `formatFileWrap`. Parallel reads.
- `expandText(text, cwd, …, depth, visited)` — the top-level splicer.
  Finds matches, walks right-to-left, dispatches to `runCommand`
  (commands) or `expandFileReferences` (files). The final splice of each
  match is the wrapped output, so the LLM sees `<cmd>…</cmd>` /
  `<file>…</file>` blocks in place of the original syntax.
- `expandFile(filePath, original, cwd, …)` — `expandText` plus the
  per-session `path + mtime + size` cache (module-level `Map`).
- `substituteInSystemPrompt(systemPrompt, filePath, original, expanded)`
  — swaps the `<project_instructions>` body iff it still matches the
  pre-expansion `originalContent`.
- `describeExecError(err, timeoutMs)` — maps `bashOps.exec` error shapes
  (`timeout:N`, `Working directory does not exist:…`) into the
  byte-compatible `[command failed: …]` format.
- `describeFileError(err)` — formats a Node FS error as
  `<CODE>: <message>` for `[file failed: …]`.
- `writeFullOutput(text)` — writes the full content to
  `/tmp/pi-cmd-expand-<hex>.log` for the truncation footer.

## Wrap format

Every match is replaced with a `<cmd>` or `<file>` wrap carrying
provenance (`source` for commands, `path` for files, optional `lang` for
fenced commands) and outcome metadata (`status` + relevant attribute).
Single-line content wraps inline; multi-line content wraps multi-line
with open / close tags on their own lines. The body still contains the
human-readable marker (`[command failed: …]`, `[file failed: …]`,
`[Output truncated …]`, `[file skipped: circular reference: …]`) so the
LLM can read both the structured attributes and the prose.

For fenced multi-file (`` @```\npaths\n``` ``), each path gets its own
`<file>` wrap; the wraps are joined with a blank line. There is no
enclosing `<files>` wrapper.

The `source` attribute on `<cmd>` is truncated to ≤ 20 characters (first
line of a fenced body, `...` indicating further truncation). Paths on
`<file>` are preserved verbatim.

## Common gotchas

- **Right-to-left splice.** `expandText` walks matches from the end so
  earlier byte offsets stay valid. If you change the iteration order,
  recompute `start`/`end` from the mutated `out` string instead.
- **Fenced has priority over inline.** `findAllMatches` collects fenced
  ranges first (of either class); inline matches whose `start`/`end`
  fall inside any fenced range are skipped. Outer / longer forms first —
  if you add a new form, follow the same priority.
- **`!` and `@` don't interfere.** An inline `` !`cmd` `` inside a
  fenced `` @`path` `` block is just text in the path list; an inline
  `` @`path` `` inside a fenced `` !```sh\ncmd\n``` `` block is just
  text in the shell script. Cross-character-class interaction only
  happens via the fenced-skip rule.
- **`(?<!\w)` lookbehind on inline `` @`path` ``.** This avoids false
  positives on email-like text (`` user@`example.com` `` — the `r`
  before `@` excludes it). If you remove it, emails get matched as file
  paths. `` @` `` at start-of-string, after whitespace, or after
  punctuation still triggers.
- **Failed commands bypass truncation.** Non-zero exit / thrown error
  returns the full partial output + a `[command failed: …]` note, no
  temp file. Truncation would only obscure the diagnostic.
- **File errors never throw.** `loadFileRaw` returns the error as a
  `[file failed: …]` string, so a missing or unreadable file always
  reaches the LLM inline rather than aborting the turn.
- **TUI does not re-render the user message on `message_end`.**
  `interactive-mode.js` adds the user message to the chat in
  `message_start` and `break`s for `message_end` on the user role. Our
  handler rewrites `event.message.content` in place for the LLM, but the
  on-screen chat bubble keeps showing the raw `` !`cmd` `` /
  `` @`path` ``. This is a pi design gap — not something the extension
  can paper over from inside `message_end`.
- **Recursive temp files can be large.** When `` @`A` `` loads a file
  whose expansion is large (or whose expansion pulls in more large
  files), the temp file written by `truncateOrKeep` contains the FULL
  expanded content (with all nested refs resolved). The per-file cap
  still bounds the inline view, but the temp file is unbounded by
  design — the user explicitly asked for these refs.
