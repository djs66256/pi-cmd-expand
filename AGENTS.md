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

Single TypeScript file (`src/index.ts`), default-exports a factory,
registers two event handlers, nothing else.

## Repository layout

```
pi-cmd-expand/
├── src/index.ts                  # the extension
├── test/
│   ├── extension.test.mjs        # unit tests (node --test, jiti)
│   └── prompt-template-path.test.mjs  # end-to-end in-place-contract regression
├── .pi/prompts/                  # manual smoke-test slash-commands
├── package.json                  # pi-package manifest + scripts
├── README.md / README.zh.md
├── AGENTS.md
└── LICENSE
```

## Build / test

```bash
npm test                              # node --test, jiti-loaded TS
npm test -- --test-reporter=spec      # prettier output
```

Tests build a hand-rolled `ExtensionAPI` stub and call the
registered handlers directly — they do **not** spawn a real pi
session. `prompt-template-path.test.mjs` additionally replays the
full pi code path (processEvents → _handleAgentEvent →
_replaceMessageInPlace → streamAssistantResponse) to assert the
in-place replacement actually reaches the LLM context.

`npm run check` runs `biome check .`; biome is not a checked-in
dep, so invoke via `npx biome`.

## Architecture

### Event hooks

| Event                | What it does                                                                                                                                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `message_end`        | Rewrites `!`cmd`` in the final user message (post-template / post-skill expansion) in place before the LLM call. The same path covers both directly-typed and template-sourced input — there is no earlier hook that can see template bodies. |
| `before_agent_start` | Walks `event.systemPromptOptions.contextFiles`, expands each `AGENTS.md` / `CLAUDE.md` block, and substitutes the expanded content into the system prompt's `<project_instructions path="…">` block. This is the only pi event that exposes both the system prompt string AND the structured `contextFiles` list. |

### Data flow (per  `` `!`cmd` ``  occurrence)

```
extractUserText(event.message.content)
  → findCommandMatches(text)                 # fenced first, then inline
  → for each match, right-to-left:
      bashOps.exec(command, ctx.cwd, { onData, timeout })
      → on failure:    partial output + "[command failed: …]"
      → on success:    truncateTail(output, { maxBytes })
                         → on overflow: write full output to
                           /tmp/pi-cmd-expand-<hex>.log, append
                           "[Output truncated … Full output: <path>]"
  → return { message: { ...event.message, content: [expandedText] } }
  → agent-session._replaceMessageInPlace mutates event.message in place
  → LLM (via currentContext.messages) sees the expanded text
```

For context files, the same chain is wrapped in `expandFile()`
(per-session `path + mtime + size` cache) and
`substituteInSystemPrompt()` (regex-substitutes the
`<project_instructions>` body).

### Helpers (in `src/index.ts`)

- `findCommandMatches(text)` — fenced first, then inline; inline
  matches inside a fenced body are skipped.
- `runCommand(command, cwd, timeoutMs)` — wraps `bashOps.exec`,
  returns a `CommandResult`. Failed commands bypass truncation.
- `expandText(text, cwd, timeoutMs)` — finds all matches, executes
  right-to-left, splices outputs back.
- `expandFile(path, content, cwd, timeoutMs)` — `expandText` plus
  per-session `path + mtime + size` cache (module-level `Map`).
- `substituteInSystemPrompt(systemPrompt, filePath, original,
  expanded)` — swaps the `<project_instructions>` body iff it
  still matches the pre-expansion `originalContent`.
- `describeExecError(err, timeoutMs)` — maps `bashOps.exec` error
  shapes (`timeout:N`, `Working directory does not exist:…`) into
  the byte-compatible `[command failed: …]` format.
- `writeFullOutput(text)` — writes the full output to
  `/tmp/pi-cmd-expand-<hex>.log` for the truncation footer.

## The scope contract (do not break this)

Four hooks are deliberately NOT registered. Registering any of
them would be a regression:

| Event          | Why we don't hook it                                                                                                                                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `input`        | Would only see directly-typed text (templates expand *after* `input` runs) and would have to be paired with `message_end` for the template case. Centralising in `message_end` keeps both paths on the same in-place rewrite contract. The TUI still shows the raw `!`cmd`` form for both — see gotcha below. |
| `user_bash`    | Start-of-line `!cmd` belongs to pi's native `!bash` (with `!!` / cancellation / live-streaming semantics). Hooking here would double-handle and break those.                                                                                                                                        |
| `tool_call`    | The agent's own `bash` tool must run untouched. Any `!`cmd`` text the LLM happens to run lands in the shell literally.                                                                                                                                                                            |
| `tool_result`  | Symmetric to `tool_call`.                                                                                                                                                                                                                                                                         |

`test/extension.test.mjs` asserts all four are `undefined` after
the extension registers, so a regression is caught at `npm test`.

## Configuration knobs

Both are `const` at the top of `src/index.ts`:

| Constant                   | Default  | Effect                                                                                                                                                                                                                                            |
| -------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEFAULT_TIMEOUT_MS`       | `5_000`  | Per-command timeout. On expiry, partial output (if any) is reported inline followed by `[command failed: timed out after 5000ms]`.                                                                                                                |
| `DEFAULT_MAX_OUTPUT_BYTES` | `2_000`  | Soft cap on inline output. Above this, `truncateTail` keeps the last N bytes and the full output is written to a temp file whose path is appended inline so the LLM can `read` it on demand.                                                  |

Temp files are **not** auto-cleaned — they live in `os.tmpdir()`
and the OS reclaims them on reboot.

## Imports we use

From `@earendil-works/pi-coding-agent`:

- `ExtensionAPI` (type) — the API surface.
- `createLocalBashOperations()` — returns
  `{ exec(command, cwd, { onData, timeout }) → Promise<{ exitCode }> }`,
  the same backend pi's built-in `bash` tool uses.
- `truncateTail(text, { maxBytes })` — tail-truncates a string.
- `formatSize(bytes)` — human-readable byte size for the
  truncation footer.

## Common gotchas

- **Right-to-left splice.** `expandText` walks matches from the
  end so earlier byte offsets stay valid. If you change the
  iteration order, recompute `start`/`end` from the mutated `out`
  string instead.
- **Fenced has priority over inline.** `findCommandMatches`
  collects fenced ranges first; inline matches whose `start`/`end`
  fall inside a fenced range are skipped. Outer / longer forms
  first — if you add a new form, follow the same priority.
- **Failed commands bypass truncation.** Non-zero exit / thrown
  error returns the full partial output + a `[command failed: …]`
  note, no temp file. Truncation would only obscure the
  diagnostic.
- **TUI does not re-render the user message on `message_end`.**
  `interactive-mode.js` adds the user message to the chat in
  `message_start` and `break`s for `message_end` on the user
  role. Our handler rewrites `event.message.content` in place
  for the LLM, but the on-screen chat bubble keeps showing the
  raw `` !`cmd` ``. This is a pi design gap — not something the
  extension can paper over from inside `message_end`.

## Manual smoke tests

`.pi/prompts/*.md` are slash-commands (`/test-truncation`,
`/test-scope`, `/demo-review`, …) for manually exercising each
behaviour path against a real LLM turn. They are **not** run by
`npm test`.
