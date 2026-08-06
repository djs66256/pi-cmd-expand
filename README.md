# pi-cmd-expand

A [pi](https://pi.dev) extension that expands inline shell commands and
file references in your prompts and project context files **before** the
agent sees them.

Four forms are supported (Claude Code–compatible):

````text
!`ls -la`
@`path/to/file.md`
````

`````text
!```sh
ls -la
```

@```
path/to/file_1
path/to/file_2
```
`````

The fenced forms accept an optional language tag. Common shell tags such as
`sh`, `bash`, `shell`, `zsh`, and `fish` are all recognized for commands;
the tag is only syntax metadata and does not select the shell used for
execution. For `@``` ` the tag is ignored entirely.

## What it does

- **`` `!`cmd` ``** anywhere in your typed message → the command runs in the
  agent's current working directory, and the output is wrapped in
  `<cmd source="…">…</cmd>` before the agent sees the message.
- **`` `@`path` ``** anywhere in your typed message → the file's UTF-8
  contents are wrapped in `<file path="…">…</file>` and inlined. The
  path is resolved against the agent's cwd; absolute paths are used
  verbatim.
- **`` `!`cmd` ``** / **`` `@`path` ``** inside `AGENTS.md` / `CLAUDE.md` →
  the same expansion happens at session start, so project-context files
  can include live filesystem snapshots, package lists, diffs, **and
  inlined source files**.
- **Recursion** — a file loaded via `` `@`path` `` is itself run through
  the same expansion rules, so any further `` `@`path` `` or `` `!`cmd` ``
  inside it is also resolved (depth-capped at 10; cycles short-circuited
  inline). This means a single `` `@`./README.md` `` can pull in a whole
  doc tree in one go.

Every expansion is wrapped in a semantic tag (`<cmd>` or `<file>`) with
attributes carrying provenance (`source`, `path`, `lang`) and outcome
metadata (`status`, `exit-code`, `error`, `inline-size`, `total-size`).
Single-line content uses inline wrapping; multi-line content uses
multi-line wrapping with the open / close tags on their own lines.

All commands run and all file paths resolve against the **agent's cwd**
(`ctx.cwd`) — never the directory of the prompt or the context file.

## Install

Install from the
[npm registry](https://www.npmjs.com/package/pi-cmd-expand).

### User-global (`~/.pi/agent/settings.json`)

```bash
pi install npm:pi-cmd-expand
```

### Project-local (`.pi/settings.json` — share with your team)

```bash
pi install npm:pi-cmd-expand -l
```

### Quick try without installing

```bash
pi -e npm:pi-cmd-expand
```

> To pin a version, append `@x.y.z`, e.g.
> `pi install npm:pi-cmd-expand@0.1.0`. Pinned installs are skipped
> by `pi update --extensions` and only change via an explicit
> `pi install npm:pi-cmd-expand@<new-version>`.

## Example

Given a `CLAUDE.md`:

`````markdown
# Project layout

Source files:
!`find src -maxdepth 2 -name '*.ts' | head -20`

Tests:
!```sh
ls tests/ | head -10
```

Entry point:
@`./src/index.ts`

Sibling docs:
@```
./README.md
./CHANGELOG.md
```
`````

…when pi loads it, the agent sees the real filesystem snapshot (taken in
the agent's cwd), the full contents of `src/index.ts` (recursively
expanded if it itself contains `` `@`path` `` / `` `!`cmd` ``), and both
`README.md` and `CHANGELOG.md` — each in its own `<file>` wrap.

Inline (one file):
```
…Entry point: <file path="./src/index.ts">…</file>…
```

Fenced (multi-file, one wrap per file):
```
…Sibling docs:
<file path="./README.md">…</file>

<file path="./CHANGELOG.md">…</file>
```

## Scope

The expansion rule is intentionally narrow:

| Source                                            | Expanded?            |
| ------------------------------------------------- | -------------------- |
|  `` `!`cmd` ``  / `` `@`path` ``  in a directly-typed message   | ✅ `message_end` (LLM only — the on-screen chat bubble shows the raw form because pi does not re-render the user message on `message_end`) |
|  `` `!`cmd` ``  / `` `@`path` ``  inside a prompt template (`/foo`) or skill body | ✅ `message_end` (post-template expansion) |
|  `` `!`cmd` ``  / `` `@`path` ``  in `AGENTS.md` / `CLAUDE.md`             | ✅ `before_agent_start` |
| `` `@`path` ``  chained inside a file loaded via `` `@`path` `` | ✅ recursive expansion (depth-capped at 10) |
| `!cmd` at the start of a line                     | ❌ pi's native `!bash` |
| Commands the LLM runs via its `bash` tool         | ❌ untouched         |
| Files the agent reads with `read`                 | ❌ only files explicitly referenced via `` `@`path` `` |

The `input` / `user_bash` / `tool_call` / `tool_result` hooks are
deliberately left unregistered: `input` because the on-screen TUI
cannot show the expanded text for the template-body case anyway, and
centralising everything in `message_end` keeps both the typed and
template paths on the same in-place rewrite contract; `user_bash` so
pi's native `!bash` (with its `!!`, cancellation, and live-streaming
semantics) keeps working untouched; `tool_call` / `tool_result` so
the agent's own `bash` tool is not pre- or post-processed.

> **Why one hook for user input?** The `message_end` event fires
> *after* template / skill expansion but *before* the LLM call
> (see [docs/extensions.md](https://pi.dev/docs/extensions#message_end)),
> so the user message it sees already contains the
> `` `!`cmd` `` form whether the user typed it directly or it came
> from a prompt-template / skill body. Rewriting it in place inside
> `message_end` covers both cases with a single path. See
> [AGENTS.md](./AGENTS.md) for the full rationale.

## Behaviour

- **Wrap format** — every expansion is wrapped in `<cmd>…</cmd>` or
  `<file>…</file>`. Provenance is in the attributes (`source` for
  commands, `path` for files, optional `lang` for fenced commands).
  Outcome metadata (`status="failed" exit-code="N"`,
  `status="truncated" inline-size=… total-size=…`,
  `status="circular"`) is added when something goes wrong; the body
  of the tag still contains the human-readable
  `[command failed: …]` / `[file failed: …]` / `[Output truncated
  …]` / `[file skipped: circular reference: …]` marker.
  Single-line content wraps inline (`<cmd source="ls">AUTHORS</cmd>`);
  multi-line content wraps multi-line with the tags on their own lines:
  ```
  <cmd source="ls -1">
  AUTHORS
  LICENSE
  README.md
  </cmd>
  ```
- **Failure handling** — a failing command becomes
  `[command failed: exit code N]` inside the wrap (with stdout/stderr
  above it when present); a missing file becomes
  `[file failed: ENOENT: no such file or directory, open '/abs/path']`
  inside the wrap; a circular `` `@`path` `` chain becomes
  `[file skipped: circular reference: ./foo.md]` inside the wrap. The
  expansion never throws, so a broken  `` `!`cmd` ``  or  `` `@`path` ``
  never aborts a turn.
- **Truncation** — command output over 2 KB is tail-truncated in
  place; file content over 10 KB is tail-truncated in place. In both
  cases the full content is written to `/tmp/pi-cmd-expand-*.log`,
  and the temp file path is appended inline as
  `[Output truncated ... Full output: <path>]`, inside the wrap so
  the LLM can read it on demand. Failed commands bypass truncation
  so the diagnostic is preserved.
- **Recursion** — a file loaded via `` `@`path` `` is run through
  the same expansion pipeline as the top-level text, up to a depth
  cap of 10. Cycles are short-circuited with a per-chain visited
  set. The depth cap is a safety net; in normal use, depth 1–3 is
  plenty. Recursive expansion produces nested `<file>` tags (the
  outer one is from the user's prompt; inner ones are from inside
  the loaded file).
- **Caching** — context-file expansions are cached by
  `path + mtime + size` within a session, so multi-turn sessions
  don't re-run the same commands or re-read the same referenced
  files every turn. Files loaded via `` `@`path` `` inside a
  context file are NOT individually cached — they're cached as part
  of the containing file's expansion result, and re-read whenever
  the containing file changes.
- **Timeout** — 5 s per command. Slow commands are killed and
  reported as `[command failed: timed out after 5000ms]` inside the
  wrap.
- **Shell** — commands run through pi's built-in
  `createLocalBashOperations()`, so shell resolution (Git Bash on
  Windows, WSL, `/bin/bash` on Unix, `sh` as fallback), output
  sanitisation (ANSI strip, control-char filter, CR normalisation),
  and process-tree cleanup on timeout are all inherited from pi's
  native `bash` tool. `|`, `>`, `$VAR`, etc. work the way you'd
  expect.
- **Source truncation** — the `source` attribute on `<cmd>` tags is
  truncated to ≤ 20 characters (first line of fenced body, with
  `...` indicating further truncation). Long commands stay
  executable; only the visible provenance is short.
- **Email safety** — the inline `` `@`path` `` regex uses a
  `(?<!\w)` lookbehind so email-like text such as
  `user@`example.com`` is NOT matched. `` `@` `` after a word
  character (alphanumeric / `_`) is left alone; `` `@` `` at
  start-of-string, after whitespace, or after punctuation still
  triggers file loading.

## Develop

```bash
npm test                         # node --test, jiti-loaded TS
npm test -- --test-reporter=spec # prettier output
```

See **[AGENTS.md](./AGENTS.md)** for the full developer / agent guide
(architecture, event hooks, the scope contract, configuration
knobs, and common gotchas).

## Manual smoke tests

`.pi/prompts/` ships 15 slash-commands (`/test-inline`,
`/test-file-inline`, `/test-file-multi`, `/test-truncation`,
`/test-scope`, …) for manually exercising each behaviour path
against a real LLM turn. The `demo-*` ones are practical usage
examples (git diff review, project layout snapshot). They are for
humans running pi interactively — they are **not** run by
`npm test`.

## License

[MIT](./LICENSE)

[中文文档](./README.zh.md)
