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

- **`` !`cmd` ``** anywhere in your typed message → the command runs in the
  agent's current working directory, and the output is wrapped in
  `<cmd source="…">…</cmd>` before the agent sees the message.
- **`` @`path` ``** anywhere in your typed message → the file's UTF-8
  contents are wrapped in `<file path="…">…</file>` and inlined. The
  path is resolved against the agent's cwd; absolute paths are used
  verbatim.
- **`` !`cmd` ``** / **`` @`path` ``** inside `AGENTS.md` / `CLAUDE.md` →
  the same expansion happens at session start, so project-context files
  can include live filesystem snapshots, package lists, diffs, **and
  inlined source files**.
- **Recursion** — a file loaded via `` @`path` `` is itself run through
  the same expansion rules, so any further `` @`path` `` or `` !`cmd` ``
  inside it is also resolved (depth-capped at 10; cycles short-circuited
  inline). This means a single `` @`./README.md` `` can pull in a whole
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
expanded if it itself contains `` @`path` `` / `` !`cmd` ``), and both
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

## Configuration

Both kinds of expansion can be turned on or off independently via a
JSON config file — `~/.pi/agent/pi-cmd-expand.json` (global) and
`./.pi/pi-cmd-expand.json` (project, overrides global per key):

```json
{
  "enableCmd": true,
  "enableFile": true
}
```

Setting either to `false` leaves that syntax as literal text at every
expansion level. The file is read on session start (and again on
`/reload`); parse errors are logged and ignored. Full schema, precedence
rules, and use cases: **[docs/configuration.md](./docs/configuration.md)**.

## Scope

The expansion rule is intentionally narrow:

| Source                                            | Expanded?            |
| ------------------------------------------------- | -------------------- |
|  `` !`cmd` ``  / `` @`path` ``  in a directly-typed message   | ✅ `message_end` (LLM only — the on-screen chat bubble shows the raw form because pi does not re-render the user message on `message_end`) |
|  `` !`cmd` ``  / `` @`path` ``  inside a prompt template (`/foo`) or skill body | ✅ `message_end` (post-template expansion) |
|  `` !`cmd` ``  / `` @`path` ``  in `AGENTS.md` / `CLAUDE.md`             | ✅ `before_agent_start` |
| `` @`path` ``  chained inside a file loaded via `` @`path` `` | ✅ recursive expansion (depth-capped at 10) |
| `!cmd` at the start of a line                     | ❌ pi's native `!bash` |
| Commands the LLM runs via its `bash` tool         | ❌ untouched         |
| Files the agent reads with `read`                 | ❌ only files explicitly referenced via `` @`path` `` |

The `input` / `user_bash` / `tool_call` / `tool_result` hooks are
deliberately left unregistered so pi's native `!bash` and the agent's
own `bash` tool keep working untouched, and so typed and
template-sourced input share a single in-place rewrite path in
`message_end` (which fires *after* template / skill expansion but
*before* the LLM call). Full rationale:
**[docs/architecture.md](./docs/architecture.md#the-scope-contract-do-not-break-this)**.

## Behaviour

- **Wrap format** — `<cmd source="…">` / `<file path="…">`, plus
  `status` / `exit-code` / `error` / `inline-size` / `total-size` when
  something goes wrong. Single-line content wraps inline, multi-line
  content puts the tags on their own lines.
- **Failure handling** — failures become `[command failed: …]` /
  `[file failed: …]` / `[file skipped: circular reference: …]` inside
  the wrap. The expansion never throws, so a broken reference never
  aborts a turn.
- **Truncation** — command output over 2 KB and file content over 10 KB
  are tail-truncated; the full text is written to
  `/tmp/pi-cmd-expand-*.log` and the path is appended inline.
- **Recursion** — depth-capped at 10, cycles short-circuited.
- **Caching** — context-file expansions are cached by
  `path + mtime + size` within a session.
- **Timeout** — 5 s per command.
- **Shell** — pi's built-in `createLocalBashOperations()`, so `|`, `>`,
  `$VAR` and cross-platform shell resolution work as expected.
- **Email safety** — `` user@`example.com` `` is not matched as a file
  reference.

Full details for each of these: **[docs/behaviour.md](./docs/behaviour.md)**.

## Develop

```bash
npm test                         # node --test, jiti-loaded TS
npm test -- --test-reporter=spec # prettier output
```

See **[AGENTS.md](./AGENTS.md)** for the developer / agent guide, and
**[docs/](./docs)** for architecture, internals, configuration, and
behaviour references.

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
