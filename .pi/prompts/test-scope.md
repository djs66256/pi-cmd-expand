---
description: Test scope: the LLM's own bash tool calls are NOT subject to `!`cmd`` expansion
---

Run a shell command that contains literal backtick syntax:

!`echo "this should run verbatim through your bash tool" | wc -c`

Expected behaviour (this is a SCOPE test):
- Your `bash` tool receives the literal command
  `echo "this should run verbatim through your bash tool" | wc -c`
  and runs it as a normal shell command.
- The extension does NOT pre-expand it -- the `!`cmd`` rule only
  applies to user input and project context files, not to commands
  you (the agent) decide to run.
- Result: a single number (the byte count) appears in your bash
  output, no `[command failed: ...]` line, no substitution text.

If you see a `[command failed: ...]` line or the literal command text
appears as your reply, the scope boundary is broken.
