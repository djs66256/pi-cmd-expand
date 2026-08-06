---
description: Test the 10 000-byte file truncation path for `@`path``
---

Load this large file and tell me whether you see the full content or
just a tail:

@`./README.md`

(README.md in this repo is small, but if the file you load is over
10 000 bytes, the inline content must be tail-truncated, with the
full content written to a temp file whose path appears in the
`[Output truncated … Full output: <path>]` footer.)

Expected behaviour:
- For small files (< 10 KB), the full content is inlined verbatim, no
  truncation footer.
- For files over 10 KB, the inline content is the last ~10 KB only.
- A trailing line reads roughly:
  `[Output truncated to last 10.0KB of N.NKB. Full output: /tmp/pi-cmd-expand-<hex>.log]`
- The temp file path is platform-dependent (`/tmp` on Linux, a
  per-user `/var/folders/.../T` on macOS, etc.).

If the full file appears inline and no footer is present for an over-sized
  file, truncation is broken.