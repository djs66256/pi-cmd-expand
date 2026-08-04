---
description: Test the 5-second timeout (command takes ~8s, should be killed)
---

Run this and tell me whether the process actually completed or was killed:

!`sleep 8 && echo DONE_AFTER_8S`

Expected behaviour (default 5s timeout):
- The command does NOT print `DONE_AFTER_8S`.
- The inline output ends with a line like:
  `[command failed: timed out after 5000ms]`
- The turn should complete in roughly 5s, not 8s.

If you see `DONE_AFTER_8S`, the timeout is broken.
