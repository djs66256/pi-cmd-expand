---
description: Test the 2000-byte output truncation path
---

Run this and tell me what you see (do not truncate your answer):

!`printf 'X%.0s' {1..4000} && echo`

Expected behaviour:
- You should NOT see 4000 `X` characters inline.
- The inline content should be at most ~2000 bytes (plus the wrap and
  the truncation footer, all inside `<cmd source="..." status="truncated"
  inline-size="…" total-size="…">…</cmd>`).
- The wrap should carry `status="truncated"`, `inline-size="…"`, and
  `total-size="…"` attributes.
- Inside the wrap, a trailing line should read roughly:
  `[Output truncated to last 2.0KB of 3.9KB. Full output: /tmp/pi-cmd-expand-<hex>.log]`

If the full 4000 `X`s appear inline, the truncation is broken.
If the footer line is missing, the temp-file path is missing.
If the `status="truncated"` attribute is missing, the wrap format regressed.
