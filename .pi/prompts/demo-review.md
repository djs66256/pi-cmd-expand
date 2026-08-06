---
description: Practical demo: review current git changes with the diff inlined
---

Here are my current uncommitted changes, inlined so you can read them:

```diff
!`git diff --no-color`
```

(If there are no diff lines, the working tree is clean -- just say so.)

Note: the diff itself is wrapped in `<cmd source="git diff...">...</cmd>`
(our `<cmd>` / `<file>` wrap format). The wrapping just frames the
output; the content is the real git diff.

Please review for:
- Bugs and logic errors
- Security issues
- Error-handling gaps
- Style nits worth flagging
