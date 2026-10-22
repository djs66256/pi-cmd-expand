# Architecture

How `pi-cmd-expand` is wired into pi. For the user-facing behaviour
these hooks produce, see [behaviour.md](./behaviour.md); for the
function-level map see [internals.md](./internals.md).

The whole extension is a single TypeScript file (`src/index.ts`) that
default-exports a factory, registers three event handlers, and does
nothing else.

## Event hooks

| Event                | What it does |
| -------------------- | ------------ |
| `message_end`        | Rewrites `` !`cmd` `` / `` @`path` `` / their fenced forms in the final user message (post-template / post-skill expansion) in place before the LLM call. The same path covers both directly-typed and template-sourced input — there is no earlier hook that can see template bodies. Honours `enableCmd` / `enableFile`. |
| `before_agent_start` | Walks `event.systemPromptOptions.contextFiles`, expands each `AGENTS.md` / `CLAUDE.md` block (both `` !`cmd` `` and `` @`path` ``, recursively), and substitutes the expanded content into the system prompt's `<project_instructions path="…">` block. This is the only pi event that exposes both the system prompt string AND the structured `contextFiles` list. Honours `enableCmd` / `enableFile`. |
| `session_start`      | Loads and merges the global + project config files into module-level `currentConfig`. Runs once per session start and again on `/reload`. See [configuration.md](./configuration.md). |

## Data flow

Per `` !`cmd` `` / `` @`path` `` occurrence:

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

For context files the same chain is wrapped in `expandFile()`
(per-session `path + mtime + size` cache, so repeat turns do not
re-execute) and `substituteInSystemPrompt()` (regex-substitutes the
`<project_instructions>` body).

## Recursion

A file loaded via `` @`path` `` is run through the same expansion
pipeline as the top-level text. This is what lets a single
`` @`./CLAUDE.md` `` pull in a whole doc tree.

Three guards keep this safe:

1. **Depth cap (`MAX_RECURSION_DEPTH = 10`).** Beyond the cap,
   `expandText` returns the file content with whatever `` @`path` ``
   references it still contains unexpanded. The LLM sees the
   unresolved syntax and can decide what to do (e.g. use `read`).
2. **Visited set.** Each `expandText` call accepts a
   `visited: Set<string>` of absolute paths. When loading a file, the
   file's own abs path is added; if a nested reference hits the same
   path again, the load is short-circuited with
   `[file skipped: circular reference: …]` rather than looping.
3. **Per-parallel-task copy.** In `expandFileReferences`, file reads
   are parallelized with `Promise.all`. Each task gets its own
   `Set(visited)` so the shared set is never mutated mid-flight.

The depth cap is a safety net, not a target — in normal use, depth
1–3 is plenty. If a user hits the cap, their reference graph is too
deep and they should restructure.

## The scope contract (do not break this)

Four hooks are deliberately NOT registered. Registering any of them
would be a regression:

| Event         | Why we don't hook it |
| ------------- | -------------------- |
| `input`       | Would only see directly-typed text (templates expand *after* `input` runs) and would have to be paired with `message_end` for the template case. Centralising in `message_end` keeps both paths on the same in-place rewrite contract. The TUI still shows the raw `` !`cmd` `` form for both — see [internals.md](./internals.md#common-gotchas). |
| `user_bash`   | Start-of-line `!cmd` belongs to pi's native `!bash` (with `!!` / cancellation / live-streaming semantics). Hooking here would double-handle and break those. |
| `tool_call`   | The agent's own `bash` tool must run untouched. Any `` !`cmd` `` text the LLM happens to run lands in the shell literally. |
| `tool_result` | Symmetric to `tool_call`. |

`test/extension.test.mjs` asserts all four are `undefined` after the
extension registers, so a regression is caught at `npm test`.

## Imports we use

`@earendil-works/pi-coding-agent` is **host-provided**: pi injects it
into extensions via loader aliases / virtual modules. It is therefore
declared as a `peerDependency` with a `"*"` range (and pinned to the
current host version only as a `devDependency` for local tests) — never
as a regular `dependency`, which would install a second copy of pi
inside the extension and create duplicate runtime modules.

From `@earendil-works/pi-coding-agent`:

- `ExtensionAPI` (type) — the API surface.
- `createLocalBashOperations()` — returns
  `{ exec(command, cwd, { onData, timeout }) → Promise<{ exitCode }> }`,
  the same backend pi's built-in `bash` tool uses.
- `truncateTail(text, { maxBytes })` — tail-truncates a string.
- `formatSize(bytes)` — human-readable byte size for the truncation
  footer.
- `getAgentDir()` — returns `~/.pi/agent/` (honours the
  `PI_CODING_AGENT_DIR` env var). Used to locate the global config file.
- `CONFIG_DIR_NAME` — the project-local config directory name
  (defaults to `.pi`). Used for the config file lookup and to match
  pi's convention for project-local resources.
