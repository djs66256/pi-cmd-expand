# AGENTS.md

Developer / AI-agent guide for **pi-cmd-expand**.

> End users should read [README.md](./README.md) instead. This document
> is for agents and contributors working **on** the extension.

## What this project is

A [pi](https://pi.dev) extension that expands inline shell-command and
file-reference syntax in prompts and project context files before the
agent sees them. Four forms are supported, all Claude Code–compatible:

- `` !`cmd` `` (inline command)
- `` !```lang\ncmd\n``` `` (fenced command; language tag optional)
- `` @`path/to/file` `` (inline file reference; backtick-delimited so
  paths with spaces work)
- `` @```lang\npath1\npath2\n``` `` (fenced file reference; one or more
  paths, language tag optional and ignored)

Inline file references resolve to a single file's content; fenced file
references resolve to one or more files, each in its own
`<file path="…">…</file>` wrap. Both forms recursively expand any
further references found inside the loaded file, up to a depth cap of 10.

## Repository layout

```
pi-cmd-expand/
├── src/index.ts                       # the extension (single file)
├── test/
│   ├── extension.test.mjs             # unit tests (node --test, jiti)
│   └── prompt-template-path.test.mjs  # end-to-end in-place-contract regression
├── docs/                              # design + implementation docs
├── .pi/prompts/                       # manual smoke-test slash-commands
├── package.json                       # pi-package manifest + scripts
├── README.md / README.zh.md
├── AGENTS.md
└── LICENSE
```

## Build / test

```bash
npm test                              # node --test, jiti-loaded TS
npm test -- --test-reporter=spec      # prettier output
```

Tests build a hand-rolled `ExtensionAPI` stub and call the registered
handlers directly — they do **not** spawn a real pi session.
`prompt-template-path.test.mjs` additionally replays the full pi code
path (processEvents → _handleAgentEvent → _replaceMessageInPlace →
streamAssistantResponse) to assert the in-place replacement actually
reaches the LLM context.

`npm run check` runs `biome check .`; biome is not a checked-in dep, so
invoke via `npx biome`.

## Design & implementation docs

| Document | Contents |
| -------- | -------- |
| [docs/architecture.md](./docs/architecture.md) | Event hooks, data flow, recursion guards, the scope contract (four hooks we deliberately don't register), pi imports used. |
| [docs/internals.md](./docs/internals.md) | Helper-by-helper map of `src/index.ts`, wrap format, common gotchas. |
| [docs/configuration.md](./docs/configuration.md) | `pi-cmd-expand.json` schema and precedence, hard-coded `const` knobs. |
| [docs/behaviour.md](./docs/behaviour.md) | User-visible semantics: failures, truncation, caching, timeout, shell. |

**Before changing anything, read
[the scope contract](./docs/architecture.md#the-scope-contract-do-not-break-this)**
— `input` / `user_bash` / `tool_call` / `tool_result` must stay
unregistered, and `test/extension.test.mjs` enforces it.

## Manual smoke tests

`.pi/prompts/*.md` are slash-commands (`/test-truncation`, `/test-scope`,
`/test-file-inline`, `/test-file-recursive`, `/demo-review`, …) for
manually exercising each behaviour path against a real LLM turn. They
are **not** run by `npm test`.
