---
description: Test recursive file loading — a file loaded via `@path` may itself contain `@path`
---

Read this top-level file. Note that its content may include further
`@`path/to/file`` references — those should be resolved recursively:

@`./.pi/prompts/test-file-inline.md`

Expected behaviour:
- The top-level `@` reference loads test-file-inline.md.
- Inside that file, any further `@` or `!` patterns are also expanded
  (recursive expansion, depth-capped at 10).
- If test-file-inline.md itself contains `@`./package.json`` (it does
  NOT in this version, but if it did), package.json's content would also
  appear in the inline output, recursively expanded.
- Cycles are short-circuited: if file A references B and B references A,
  the second hop is replaced inline with `[file skipped: circular
  reference: …]` rather than looping forever.

If you see the literal text `@`./package.json`` in the inline output (no
  expansion), recursion is broken.