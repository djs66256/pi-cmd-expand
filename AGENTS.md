# AGENTS.md

Developer / AI-agent guide for **pi-cmd-expand**.

> End users should read [README.md](./README.md) instead. This
> document is for agents and contributors working **on** the
> extension.

## What this project is

A [pi](https://pi.dev) extension that expands inline shell-command
and file-reference syntax in prompts and project context files
before the agent sees them. Four forms are supported, all Claude
Code–compatible:

-  `` !`cmd` ``  (inline command)
- `!```lang\ncmd\n```\n` (fenced command; language tag is optional)
- `` @`path/to/file` ``  (inline file reference; backtick-delimited
  so paths with spaces work)
- `@```lang\npath1\npath2\n```\n` (fenced file reference; one or
  more paths, language tag is optional and ignored)

Inline file references resolve to a single file's content; fenced
file references resolve to one or more files, each in its own
`<file path="…">…</file>` wrap. Both forms recursively expand any
further `` @`path` `` / `` !`cmd` `` / `!```...```` / `@```...````
found inside the loaded file, up to a depth cap of 10.

Single TypeScript file (`src/index.ts`), default-exports a factory,
registers three event handlers, nothing else.

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
| `message_end`        | Rewrites `!`cmd`` / `` @`path` `` / their fenced forms in the final user message (post-template / post-skill expansion) in place before the LLM call. The same path covers both directly-typed and template-sourced input — there is no earlier hook that can see template bodies. Honours `enableCmd` / `enableFile` from the config. |
| `before_agent_start` | Walks `event.systemPromptOptions.contextFiles`, expands each `AGENTS.md` / `CLAUDE.md` block (with both `!`cmd`` and `` @`path` `` resolved, recursively), and substitutes the expanded content into the system prompt's `<project_instructions path="…">` block. This is the only pi event that exposes both the system prompt string AND the structured `contextFiles` list. Honours `enableCmd` / `enableFile` from the config. |
| `session_start`      | Reads `pi-cmd-expand.json` from the agent dir (`~/.pi/agent/pi-cmd-expand.json`) and from the project dir (`./.pi/pi-cmd-expand.json`), merges them (project wins on a per-key basis), and stores the result in module-level `currentConfig`. Runs once per session start and again on `/reload`. Mid-session edits without `/reload` take effect on the next session. |

### Data flow (per  `` !`cmd` ``  /  `` @`path` ``  occurrence)

```
extractUserText(event.message.content)
  → findAllMatches(text)                  # fenced-first, then inline;
                                          # `!` and `@` handled separately,
                                          # fenced wins within each class
  → for each match, right-to-left:
      command:  bashOps.exec(command, ctx.cwd, { onData, timeout })
                  → CommandOutcome { output, exitCode, truncated, … }
                → formatCmdWrap(outcome, command, lang)
                   → <cmd source="<≤20-char source>" [lang="…"]
                            [status="failed|truncated" exit-code|inline-size|total-size]>
                      <output>
                      </cmd>
      file:     loadFileRaw(path, ctx.cwd)
                  → FileOutcome { output, status, error?, … }
                if status === "ok":
                  newVisited = Set(visited) + absPath
                  expandText(content, …, depth+1, newVisited)
                    → produces expanded content with nested <cmd>/<file> wraps
                  truncateTail(expanded, { maxBytes: FILE_CAP })
                    → on overflow: write expanded to temp file, append
                      "[Output truncated … Full output: <path>]"
                → formatFileWrap(outcome, path)
                   → <file path="…" [status="failed|circular|truncated"
                                       error|inline-size|total-size]>
                      <output>
                      </file>
  → return { message: { ...event.message, content: [expandedText] } }
  → agent-session._replaceMessageInPlace mutates event.message in place
  → LLM (via currentContext.messages) sees the expanded text
```

Every match becomes a `<cmd>` or `<file>` wrap; the original text
outside matches (user prose, headings, etc.) is spliced unchanged.

For context files, the same chain is wrapped in `expandFile()`
(per-session `path + mtime + size` cache, so repeat turns do not
re-execute) and `substituteInSystemPrompt()` (regex-substitutes the
`<project_instructions>` body).

### Recursion in detail

A file loaded via `` @`path` `` is run through the same expansion
pipeline as the top-level text. This is what lets a single
`` @`./CLAUDE.md` `` pull in a whole doc tree.

Three guards keep this safe:

1. **Depth cap (`MAX_RECURSION_DEPTH = 10`).** Beyond the cap,
   `expandText` returns the file content with whatever `` @`path` ``
   references it still contains unexpanded. The LLM sees the
   unresolved syntax and can decide what to do (e.g., use `read`).
2. **Visited set.** Each `expandText` call accepts a `visited:
   Set<string>` of absolute paths. When loading a file, the file's
   own abs path is added; if a nested reference hits the same path
   again, the load is short-circuited with
   `[file skipped: circular reference: …]` rather than looping.
3. **Per-parallel-task copy.** In `expandFileReferences`, file reads
   are parallelized with `Promise.all`. Each task gets its own
   `Set(visited)` so the shared set is never mutated mid-flight.

The depth cap is a safety net, not a target — in normal use, depth
1–3 is plenty. If a user hits the cap, their reference graph is too
deep and they should restructure.

### Helpers (in `src/index.ts`)

- `findAllMatches(text)` — finds `!`cmd``, `!```sh\ncmd\n```,
  `` @`path` ``, `@```\npaths\n``` `. Fenced first, then inline;
  within each character class (`!` vs `@`), fenced wins; inline
  matches inside any fenced range (of either class) are skipped.
  The inline `` @`path` `` regex uses a `(?<!\w)` lookbehind to
  avoid false positives on email-like text.
- `runCommand(command, cwd, timeoutMs)` — wraps `bashOps.exec`,
  returns a `CommandOutcome` (output, exitCode, truncated,
  byte sizes). Failed commands bypass truncation.
- `loadFileRaw(relPath, cwd)` — reads a file with `fs.readFile(path,
  "utf-8")` and returns a `FileOutcome` (output, status
  `"ok" | "failed"`, error?, …). Never throws — the status field
  tells the caller whether to recurse.
- `formatCmdWrap(outcome, command, lang)` — builds `<cmd source="…"
  [lang="…"] [status="…" exit-code|inline-size|total-size]>…</cmd>`,
  picking single-line vs multi-line wrapping based on body line count.
- `formatFileWrap(outcome, path)` — builds `<file path="…" [status="…"
  error|inline-size|total-size]>…</file>` with the same wrapping rule.
- `quoteAttr(value)` — wraps a value in `"` (or `'` if it contains `"`).
- `truncateSource(source)` — collapses to first line and truncates
  to ≤ `SOURCE_MAX_CHARS` (20) with a trailing `...`.
- `wrapWithTag(tagName, attrs, content)` — applies the
  inline-vs-multi-line wrapping rule (trailing `\n` stripped).
- `expandFileReferences(match, cwd, …, visited)` — loads each path
  in a `FileMatch`, recursively expands the content (which itself
  produces wrapped output), applies the per-file cap, formats via
  `formatFileWrap`. Parallel reads.
- `expandText(text, cwd, …, depth, visited)` — the top-level
  splicer. Finds matches, walks right-to-left, dispatches to
  `runCommand` (commands) or `expandFileReferences` (files). The
  final splice of each match is the wrapped output, so the LLM sees
  `<cmd>…</cmd>` / `<file>…</file>` blocks in place of the original
  syntax.
- `expandFile(filePath, original, cwd, …)` — `expandText` plus the
  per-session `path + mtime + size` cache (module-level `Map`).
- `substituteInSystemPrompt(systemPrompt, filePath, original,
  expanded)` — swaps the `<project_instructions>` body iff it
  still matches the pre-expansion `originalContent`.
- `describeExecError(err, timeoutMs)` — maps `bashOps.exec` error
  shapes (`timeout:N`, `Working directory does not exist:…`) into
  the byte-compatible `[command failed: …]` format.
- `describeFileError(err)` — formats a Node FS error as
  `<CODE>: <message>` for `[file failed: …]`.
- `writeFullOutput(text)` — writes the full content to
  `/tmp/pi-cmd-expand-<hex>.log` for the truncation footer.

### Wrap format

Every match is replaced with a `<cmd>` or `<file>` wrap carrying
provenance (`source` for commands, `path` for files, optional
`lang` for fenced commands) and outcome metadata (`status` +
relevant attribute). Single-line content wraps inline; multi-line
content wraps multi-line with open / close tags on their own lines.
The body still contains the human-readable marker
(`[command failed: …]`, `[file failed: …]`,
`[Output truncated …]`, `[file skipped: circular reference: …]`)
so the LLM can read both the structured attributes and the prose.

For fenced multi-file (`` @```\npaths\n``` ``), each path gets its
own `<file>` wrap; the wraps are joined with a blank line. There
is no enclosing `<files>` wrapper.

The `source` attribute on `<cmd>` is truncated to ≤ 20 characters
(first line of a fenced body, `...` indicating further truncation).
Paths on `<file>` are preserved verbatim.

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

### Per-extension config file (`pi-cmd-expand.json`)

Two independent on/off toggles, read on `session_start`:

| Location                          | Scope                |
| --------------------------------- | -------------------- |
| `~/.pi/agent/pi-cmd-expand.json`  | Global (all projects)|
| `./.pi/pi-cmd-expand.json`        | Project (this cwd)   |

Schema (all keys optional; missing / wrong-typed / unknown keys
fall back to defaults without throwing):

```json
{
  "enableCmd": true,
  "enableFile": true
}
```

| Key           | Default | Effect                                                                                                                                                                       |
| ------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enableCmd`   | `true`  | When `false`, `` !`cmd` `` / `` !```sh ` blocks are left as literal text in both user messages and `AGENTS.md` / `CLAUDE.md`. The toggle applies at every expansion level, so `` !`cmd` `` inside a loaded file is also left literal. |
| `enableFile`  | `true`  | When `false`, `` @`path` `` / `` @``` ` blocks are left as literal text in both user messages and context files. Same recursive semantics.                                    |

Project overrides global on a per-key basis (shallow merge). The
loader logs parse / IO errors to `console.error` and falls back to
defaults instead of aborting the session. Mid-session edits to the
config file do not take effect until the next session start (or
`/reload`).

### Hard-coded `const` knobs

All five are `const` at the top of `src/index.ts`:

| Constant                   | Default  | Effect                                                                                                                                                                                                                                            |
| -------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEFAULT_TIMEOUT_MS`       | `5_000`  | Per-command timeout. On expiry, partial output (if any) is reported inline followed by `[command failed: timed out after 5000ms]`. Applies to commands executed inside any loaded file as well.                                                  |
| `DEFAULT_MAX_OUTPUT_BYTES` | `2_000`  | Soft cap on inline command output. Above this, `truncateTail` keeps the last N bytes and the full output is written to a temp file whose path is appended inline so the LLM can `read` it on demand.                                                  |
| `DEFAULT_MAX_FILE_BYTES`   | `10_000` | Soft cap on inline file content (after recursive expansion). Same truncation policy as commands; full expanded content is persisted to a temp file above this. Larger than the command cap because source files tend to be larger than command output. |
| `MAX_RECURSION_DEPTH`      | `10`     | Hard cap on `` @`path` `` nesting. Beyond this depth, `expandText` returns the file content with its `` @`path` `` references still unexpanded. The LLM sees the unresolved syntax and can decide what to do (e.g., use `read`).                |
| `SOURCE_MAX_CHARS`         | `20`     | Maximum length of the `source` attribute on `<cmd>` tags. Longer commands are truncated to first 17 chars + `...` (fenced commands use only their first line as the source). Full command still runs — only the visible provenance is short.        |

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
- `getAgentDir()` — returns `~/.pi/agent/` (honours the
  `PI_CODING_AGENT_DIR` env var). Used to locate the global config
  file.
- `CONFIG_DIR_NAME` — the project-local config directory name
  (defaults to `.pi`). Used for both the config file lookup and to
  match pi's convention for project-local resources.

## Common gotchas

- **Right-to-left splice.** `expandText` walks matches from the
  end so earlier byte offsets stay valid. If you change the
  iteration order, recompute `start`/`end` from the mutated `out`
  string instead.
- **Fenced has priority over inline.** `findAllMatches` collects
  fenced ranges first (of either class); inline matches whose
  `start`/`end` fall inside any fenced range are skipped. Outer /
  longer forms first — if you add a new form, follow the same
  priority.
- **`!` and `@` don't interfere.** An inline `!`cmd`` inside a
  fenced `` @`path` `` block is just text in the path list; an
  inline `` @`path` `` inside a fenced `!```sh\ncmd\n``` ` block is
  just text in the shell script. Cross-character class interaction
  only happens via the fenced-skip rule (an inline of either class
  inside a fenced range of either class is skipped).
- **`(?<!\w)` lookbehind on inline `` @`path` ``.** This avoids
  false positives on email-like text (`user@`example.com`` — the
  `r` before `@` excludes it). If you remove it, emails get matched
  as file paths. `` @` `` at start-of-string, after whitespace, or
  after punctuation still triggers.
- **Failed commands bypass truncation.** Non-zero exit / thrown
  error returns the full partial output + a `[command failed: …]`
  note, no temp file. Truncation would only obscure the diagnostic.
- **File errors never throw.** `loadFileRaw` returns the error as
  a `[file failed: …]` string, so a missing or unreadable file
  always reaches the LLM inline rather than aborting the turn.
- **TUI does not re-render the user message on `message_end`.**
  `interactive-mode.js` adds the user message to the chat in
  `message_start` and `break`s for `message_end` on the user
  role. Our handler rewrites `event.message.content` in place for
  the LLM, but the on-screen chat bubble keeps showing the raw
  `` !`cmd` `` / `` @`path` ``. This is a pi design gap — not
  something the extension can paper over from inside `message_end`.
- **Recursive temp files can be large.** When `` @`A`` `` loads a
  file whose expansion is large (or whose expansion pulls in more
  large files), the temp file written by `truncateOrKeep` contains
  the FULL expanded content (with all nested refs resolved). The
  per-file cap still bounds the inline view, but the temp file is
  unbounded by design — the user explicitly asked for these refs.

## Manual smoke tests

`.pi/prompts/*.md` are slash-commands (`/test-truncation`,
`/test-scope`, `/test-file-inline`, `/test-file-recursive`,
`/demo-review`, …) for manually exercising each behaviour path
against a real LLM turn. They are **not** run by `npm test`.
