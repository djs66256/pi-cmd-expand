---
description: Test that `!cmd` WITHOUT backticks is NOT expanded (plain pi `!bash` path)
---

Type these two lines into the editor (each on its own line, press Enter between
them, then submit):

!ls
!pwd

Expected behaviour:
- Both lines start with `!` but neither is in backticks, so the extension
  must NOT intercept them.
- pi's native `!bash` mechanism runs each as a normal shell command.
- The turn contains two separate bash result blocks (one for `ls`, one for
  `pwd`), not a single substituted message.

If the entire two-line text appears as a single assistant response without
any bash result blocks, the extension incorrectly swallowed the input.
