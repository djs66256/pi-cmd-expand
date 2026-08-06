---
description: Test fenced `@```...``` ` form — multi-file load with labels
---

Read both of these files at once and tell me the relationship between them:

@```
./README.md
./AGENTS.md
```

Expected behaviour:
- The fenced form reads both files in one expansion pass.
- Each file gets a `=== <path> ===` header in the inline output, so you
  can tell which content belongs to which file.
- Both files must load relative to the agent's cwd (`./README.md` is the
  project's README, `./AGENTS.md` is this repo's developer guide).
- The content order matches the order listed (README first, then AGENTS.md).
- The on-screen chat bubble may still show the raw `@```...``` ` text —
  the LLM still receives the expanded content via `message_end`.

If a `[file failed: ENOENT: ...]` appears for one of them, the file path
  is wrong relative to cwd.