# AGENTS.md

Developer / AI-agent guide for **pi-cmd-expand**.

> End users should read [README.md](./README.md) instead. This
> document is for agents and contributors working **on** the
> extension.

## What this project is

A [pi](https://pi.dev) extension that expands inline shell-command
syntax in prompts and project context files before the agent sees
them. Two forms are supported, both Claude Code–compatible:

-  `` `!`cmd` ``  (inline)
- `!```lang\ncmd\n```\n` (fenced; language tag is optional)

The extension is a single TypeScript file (`src/index.ts`) that
default-exports a factory. It registers two event handlers on pi
and nothing else.

## Repository layout

```
pi-cmd-expand/
├── src/
│   └── index.ts             # the extension (single file)
├── test/
│   └── extension.test.mjs   # end-to-end tests (node --test)
├── .pi/
│   ├── settings.json        # workspace settings: declares `..` as a
│   │                        # package so .pi/prompts/ are picked up
│   └── prompts/             # manual smoke-test slash-commands
│       ├── test-inline.md
│       ├── test-fenced.md
│       ├── test-start-of-line.md
│       ├── test-mixed.md
│       ├── test-truncation.md
│       ├── test-timeout.md
│       ├── test-no-expand.md
│       ├── test-scope.md
│       ├── demo-review.md
│       └── demo-snapshot.md
├── package.json             # pi-package manifest + scripts
├── README.md                # English — human-facing home page
├── README.zh.md             # 中文
├── AGENTS.md                # this file
└── LICENSE                  # MIT
```

## Build / test

```bash
npm test                              # node --test, jiti-loaded TS
npm test -- --test-reporter=spec      # prettier output
```

The test runner is the built-in `node:test` (Node 20+). The
extension is TypeScript, loaded through `jiti` (a devDep) so no
separate transpile step is needed. Tests build a hand-rolled
`ExtensionAPI` stub and exercise each event handler directly —
they do **not** spawn a real pi session.

`npm run check` is wired to `biome check .` but biome is not
checked in as a dep; run it via `npx biome` if you want lint.

## Architecture

### Event hooks

| Event                  | What it does                                                                                                                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `input`                | Transforms  `` `!`cmd` ``  inside the user's typed message (anywhere except the start of a line, which is pi's `!bash` domain). Returns `{ action: "transform", text }` to splice the command output in.                            |
| `before_agent_start`   | Walks the structured `contextFiles` list, expands each `AGENTS.md` / `CLAUDE.md` block, and substitutes the expanded content into the system prompt's `<project_instructions path="…">` block.                                  |

### Data flow (per  `` `!`cmd` ``  occurrence)

```
findCommandMatches(text)
  → [CommandMatch{start, end, command}]  (fenced first, then inline;
                                          inline inside fenced is skipped)
  → for each match, right-to-left:
      bashOps.exec(command, ctx.cwd, { onData, timeout })
        → exit code + accumulated chunks
      → on failure:    partial output + "[command failed: ...]"
      → on success:    truncateTail(output, { maxBytes })
                         → on overflow: write full output to
                           /tmp/pi-cmd-expand-<hex>.log, append
                           "[Output truncated ... Full output: <path>]"
      → splice output into the original text
  → return { action: "transform", text }
```

For context files, the same chain is wrapped in `expandFile()`
(which adds a per-session `path + mtime + size` cache) and
`substituteInSystemPrompt()` (which locates the
`<project_instructions>` block by absolute path and swaps its body).

### Helpers (all in `src/index.ts`)

- `findCommandMatches(text)` — regex over both forms. Fenced
  matches take priority; inline matches inside a fenced body are
  skipped. Result is sorted by `start`.
- `runCommand(command, cwd, timeoutMs)` — wraps
  `bashOps.exec(command, cwd, { onData, timeout })` and returns a
  `CommandResult` (output + optional truncation footer). Failed
  commands bypass truncation.
- `expandText(text, cwd, timeoutMs)` — finds all matches, executes
  right-to-left, splices outputs back into the original text.
- `expandFile(path, content, cwd, timeoutMs)` — `expandText` plus
  a per-session `path + mtime + size` cache. Cache lives in a
  module-level `Map`, so it survives across turns but not across
  sessions.
- `substituteInSystemPrompt(systemPrompt, filePath, original,
  expanded)` — regex-substitutes one `<project_instructions>`
  block. Only swaps if the current body still matches the
  pre-expansion `originalContent`; if a previous hook already
  mutated it, we leave it alone.
- `describeExecError(err, timeoutMs)` — maps `bashOps.exec` error
  shapes (`timeout:N`, `Working directory does not exist:…`) into
  inline text. Keeps the `[command failed: …]` format
  byte-compatible with the pre-refactor `child_process.exec`
  wrapper.

## The scope contract (do not break this)

The expansion rule is intentionally narrow. **Three hooks are
deliberately NOT registered**, and registering any of them would be
a regression:

| Event          | Why we don't hook it                                                                                                                                                                                                                                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user_bash`    | Start-of-line `!cmd` belongs to pi's native `!bash` handler. Backticks in `` !`cmd` `` are expanded by bash itself via command substitution, so the user sees the same output either way. Hooking `user_bash` here would double-handle the command and break pi's `!!` (excludeFromContext) / cancellation / live streaming semantics. |
| `tool_call`    | Commands the LLM runs through its built-in `bash` tool must land in the shell literally. If the LLM ever runs a command whose source happens to contain  `` `!`cmd` `` , that command goes to bash as-is (and fails as a real command); it is **not** pre-expanded.                                                                       |
| `tool_result`  | Symmetric to `tool_call`. We do not inspect bash outputs.                                                                                                                                                                                                                                                                          |

`test/extension.test.mjs` asserts all three are `undefined` after
the extension registers, so a regression is caught at `npm test`
time.

The `input` handler also short-circuits on `event.source !==
"interactive"`, so messages queued by RPC, by other extensions, or
by replay tools skip expansion — we don't accidentally run
commands on behalf of programmatic callers.

## Configuration knobs

Both are `const` at the top of `src/index.ts`:

| Constant                   | Default  | Effect                                                                                                                                                                                                                                                                                                  |
| -------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEFAULT_TIMEOUT_MS`       | `5_000`  | Per-command timeout, in ms. Passed to `bashOps.exec` as `timeout: Math.ceil(timeoutMs / 1000)` (it requires seconds, refuses `<= 0`). On expiry the partial output (if any) is reported inline followed by `[command failed: timed out after 5000ms]`.                                                |
| `DEFAULT_MAX_OUTPUT_BYTES` | `2_000`  | Soft cap on inline command output. Above this, `truncateTail` keeps the last N bytes and the full output is written to a temp file whose path is appended inline as `[Output truncated to last 2.0KB of 3.9KB. Full output: /tmp/pi-cmd-expand-*.log]`. The LLM can `read` the temp file on demand. |

The temp file is created via `writeFullOutput()` in `src/index.ts`,
using `randomBytes(8).toString("hex")` for the filename. Temp files
are **not** auto-cleaned — they live in `os.tmpdir()` and the OS
reclaims them on reboot.

## Pi extension mechanics

- The extension is wired up via `package.json` →
  `pi.extensions: ["./src/index.ts"]`. `pi install <path>`
  registers it the same way.
- During development, `pi -e <abs-path>/src/index.ts` loads it
  directly without installing.
- Pi extensions are TypeScript ESM modules. The default export is
  a factory `(pi: ExtensionAPI) => void`.
- Imports we use from `@earendil-works/pi-coding-agent`:
  - `ExtensionAPI` (type) — the API surface.
  - `createLocalBashOperations()` — returns
    `{ exec(command, cwd, { onData, timeout }) → Promise<{ exitCode }> }`,
    the same backend pi's built-in `bash` tool uses.
  - `truncateTail(text, { maxBytes })` — tail-truncates a string
    and returns `{ content, outputBytes, totalBytes, truncated }`.
  - `formatSize(bytes)` — human-readable byte size for the
    truncation footer.

## Common gotchas

- **`input` walks matches right-to-left.** Splicing from the end
  keeps earlier byte offsets valid, so we don't have to recompute
  them after each substitution. If you change the iteration
  order, recompute `start`/`end` from the (now-mutated) `out`
  string instead.
- **`findCommandMatches` priority.** Fenced first, then inline.
  Inline matches whose `start`/`end` are inside an already-
  collected fenced range are skipped. If you add a new form,
  follow the same priority order: outer / longer forms first.
- **Context-file caching is per-session and per-path.** If the
  user edits `AGENTS.md` mid-session, the mtime changes and the
  cache refreshes automatically. If the FS doesn't report a new
  mtime (rare, e.g. some network filesystems), the user will see
  the stale expansion until the next session.
- **Failed commands bypass truncation.** `truncateTail` would
  only obscure the diagnostic, so non-zero exit / thrown error
  returns the full partial output + a `[command failed: ...]`
  note, no temp file.
- **The truncation footer must include the temp file path.**
  Without it, the LLM has no way to retrieve the truncated
  portion. Don't refactor that footer away.
- **Error format is a contract.** The `[command failed: ...]`
  wording and the regex in `test/extension.test.mjs` are coupled
  — if you change one, update the other.
- **`event.source` matters.** The `input` handler only fires for
  `source === "interactive"`. Keep this guard if you refactor;
  the regression risk is silent (programmatic callers would start
  having commands run on their behalf).

## Manual smoke tests

`.pi/prompts/*.md` are slash-commands you can invoke from inside
pi (e.g. `/test-truncation`) to manually exercise each behaviour
path against a real LLM turn. They are **not** run by `npm test`.

| Prompt                  | Purpose                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `test-inline.md`        | Inline form in a typed message.                                                                        |
| `test-fenced.md`        | Fenced form in a typed message.                                                                        |
| `test-start-of-line.md` | SCOPE: start-of-line  `` `!`cmd` ``  must go to pi's native `!bash`, not the extension.                       |
| `test-mixed.md`         | Multiple inline + fenced + failing commands in one prompt.                                            |
| `test-truncation.md`    | Output > 2 KB is tail-truncated + temp-file footer.                                                    |
| `test-timeout.md`       | Slow command is killed and reported as `[command failed: timed out after 5000ms]`.                    |
| `test-no-expand.md`     | `!ls` (no backticks) is **not** expanded.                                                              |
| `test-scope.md`         | SCOPE: the LLM's own `bash` tool calls are not pre-expanded.                                           |
| `demo-review.md`        | Practical: inline a `git diff` and ask for review.                                                     |
| `demo-snapshot.md`      | Practical: snapshot the project layout into context.                                                   |

## Where the README / AGENTS.md / code disagree

The **code is the source of truth**; update the docs to match.
README is a user-facing summary and deliberately omits
implementation details; AGENTS.md is the authoritative developer
reference for this repo.
