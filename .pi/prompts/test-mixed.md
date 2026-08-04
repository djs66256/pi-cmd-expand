---
description: Test mixed inline + fenced + failing command in one prompt
---

Run all three of these and report what each one printed.

1. Inline, should succeed:
   !`echo OK_INLINE`

2. Fenced, should succeed:
   !```sh
   echo OK_FENCED
   ```

3. Inline, should report a failure inline (do NOT try to fix it):
   !`sh -c 'echo before-fail; exit 3'`

Expected:
- (1) and (2) show their `OK_*` text.
- (3) shows `before-fail` followed by a `[command failed: exit code 3]` line.
