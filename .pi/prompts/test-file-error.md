---
description: Test that `@`path`` for a non-existent file reports an inline error
---

Try to load this non-existent file and tell me what error appears:

@`./no/such/file/missing.md`

Expected behaviour:
- The expansion does NOT throw. A missing file becomes an inline marker
  of the form `[file failed: ENOENT: no such file or directory, open
  '/abs/path']`.
- The message still completes normally (the turn is not aborted).
- The LLM (you) sees the error inline and can decide what to do — e.g.,
  suggest a corrected path, fall back to `ls` to discover real files, etc.

If the turn aborts with an exception, error handling is broken.
If the literal text `@`./no/such/file/missing.md`` appears (no
  `[file failed: …]` marker), error handling is broken.