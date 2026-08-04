---
description: Document the boundary: start-of-line `!cmd` is pi's native `!bash`, NOT an expansion path
---

Type these into the editor and submit (one line each, two lines total):

!`echo hello-from-bash`

Expected behaviour (this is a SCOPE test, not an expansion test):

- The `!` triggers pi's built-in `!bash` handler, NOT this extension.
- Pi runs the literal command `` `echo hello-from-bash` `` in bash.
- Bash itself expands the backticks via command substitution, so the
  user sees the string `hello-from-bash` in a normal bash result block.
- This extension's `input` hook is NEVER reached for this text, so
  there is no 2000-byte truncation cap, no temp file, and no
  `` [Output truncated ...] `` footer.
- The result is a single bash result block in the turn, with
  `hello-from-bash` as the output.

If you see a `[command failed: ...]` line, the extension incorrectly
intercepted pi's native `!bash` -- this is a regression.
