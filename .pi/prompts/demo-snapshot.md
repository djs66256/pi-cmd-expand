---
description: Practical demo: snapshot the project layout into context
---

Project layout snapshot, taken right now in the agent's cwd:

Top-level (sorted):
!`ls -1 | sort`

TypeScript files under src/ (at most 20):
!`find src -maxdepth 2 -name '*.ts' | head -20`

Package manifest:
!`cat package.json | head -40`

Based on the above, give me a 3-sentence summary of what this project does
and what its entry points are.
