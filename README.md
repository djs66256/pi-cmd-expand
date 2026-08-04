# pi-cmd-expand

A [pi](https://pi.dev) extension that expands inline shell commands in
your prompts and project context files **before** the agent sees them.

Two forms are supported (Claude Code–compatible):

````text
!`ls -la`
````

`````text
!```sh
ls -la
```
`````

## What it does

- **`` `!`cmd` ``** anywhere in your typed message → the command runs in the
  agent's current working directory, and the output is spliced in
  before the agent sees the message.
- **`` `!`cmd` ``** inside `AGENTS.md` / `CLAUDE.md` → the same expansion
  happens at session start, so project-context files can include live
  filesystem snapshots, package lists, diffs, etc.

All commands run in the **agent's cwd** (`ctx.cwd`) — never the
directory of the prompt or the context file.

## Install

### Project-local

```bash
pi install /absolute/path/to/pi-cmd-expand
# or
pi install ./pi-cmd-expand
```

### User-global

```bash
pi install /absolute/path/to/pi-cmd-expand -l
```

### Quick try without installing

```bash
pi -e /absolute/path/to/pi-cmd-expand/src/index.ts
```

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
`````

…when pi loads it, the agent sees the real filesystem snapshot, taken
in the agent's cwd.

## Scope

The expansion rule is intentionally narrow:

| Source                                            | Expanded?            |
| ------------------------------------------------- | -------------------- |
|  `` `!`cmd` ``  in a typed message                       | ✅ `input` event     |
|  `` `!`cmd` ``  in `AGENTS.md` / `CLAUDE.md`             | ✅ `before_agent_start` |
| `!cmd` at the start of a line                     | ❌ pi's native `!bash` |
| Commands the LLM runs via its `bash` tool         | ❌ untouched         |
| Files the agent reads with `read`                 | ❌ only project-context files |

The `user_bash` / `tool_call` / `tool_result` hooks are deliberately
left unregistered so pi's native `!bash` (with its `!!`,
cancellation, and live-streaming semantics) and the agent's own
`bash` tool keep working untouched.

## Behaviour

- **Failure handling** — a failing command becomes
  `[command failed: exit code N]` inline (with stdout/stderr above it
  when present). The expansion never throws, so a broken  `` `!`cmd` `` 
  never aborts a turn.
- **Truncation** — command output over 2 KB is tail-truncated in
  place, the full output is written to `/tmp/pi-cmd-expand-*.log`,
  and the temp file path is appended inline as
  `[Output truncated ... Full output: <path>]`, so the LLM can read
  it on demand. Failed commands bypass truncation so the diagnostic
  is preserved.
- **Caching** — context-file expansions are cached by
  `path + mtime + size` within a session, so multi-turn sessions
  don't re-run the same commands every turn.
- **Timeout** — 5 s per command. Slow commands are killed and
  reported as `[command failed: timed out after 5000ms]`.
- **Shell** — commands run through pi's built-in
  `createLocalBashOperations()`, so shell resolution (Git Bash on
  Windows, WSL, `/bin/bash` on Unix, `sh` as fallback), output
  sanitisation (ANSI strip, control-char filter, CR normalisation),
  and process-tree cleanup on timeout are all inherited from pi's
  native `bash` tool. `|`, `>`, `$VAR`, etc. work the way you'd
  expect.

## Develop

```bash
npm test                         # node --test, jiti-loaded TS
npm test -- --test-reporter=spec # prettier output
```

See **[AGENTS.md](./AGENTS.md)** for the full developer / agent guide
(architecture, event hooks, the scope contract, configuration
knobs, and common gotchas).

## Manual smoke tests

`.pi/prompts/` ships 10 slash-commands (`/test-inline`,
`/test-truncation`, `/test-scope`, …) for manually exercising each
behaviour path against a real LLM turn. The `demo-*` ones are
practical usage examples (git diff review, project layout snapshot).
They are for humans running pi interactively — they are **not** run
by `npm test`.

## License

[MIT](./LICENSE)

[中文文档](./README.zh.md)
