---
description: Test the 2000-byte output truncation path
---

Run this and tell me what you see (do not truncate your answer):

!`printf 'X%.0s' {1..4000} && echo`

Expected behaviour:
- You should NOT see 4000 `X` characters inline.
- The inline text should be at most ~2000 bytes.
- A trailing line should read roughly:
  `[Output truncated to last 2.0KB of 3.9KB. Full output: /tmp/pi-cmd-expand-<hex>.log]`

If the full 4000 `X`s appear inline, the truncation is broken.
If the footer line is missing, the temp-file path is missing.
