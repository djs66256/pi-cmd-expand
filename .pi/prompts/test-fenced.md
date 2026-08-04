---
description: Test fenced `!```sh\n...\n``` ` form (input event path)
---

Run this multi-line command and tell me what it prints:

!```sh
echo "== current user =="
whoami
echo "== uname =="
uname -srm
echo "== date =="
date '+%Y-%m-%d %H:%M:%S %Z'
```

If you see the three section headers followed by the corresponding values,
the fenced form worked.
