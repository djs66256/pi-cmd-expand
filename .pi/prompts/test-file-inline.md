---
description: Test inline `@`path/to/file`` form — exercised via the `message_end` hook
---

Read the contents of this single file and tell me what it says (one sentence):

@`./package.json`

Expected behaviour:
- The `@` triggers this extension's file-loading hook, NOT pi's `!bash`.
- The package.json file's contents are inlined into the user message before
  the LLM call (via `message_end`).
- You (the agent) see the file contents directly, not the raw `@`path``
  syntax. Confirm by reporting the `name` field of the package.
- The on-screen chat bubble may still show the raw `@`path`` text — that
  is a pi TUI design gap (no re-render on `message_end` for user role),
  not something the extension can paper over.

If you see a `[file failed: ENOENT: ...]` line, package.json was not
  found relative to the agent's cwd.