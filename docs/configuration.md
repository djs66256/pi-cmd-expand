# Configuration

Two layers: a JSON config file (user-editable) and hard-coded `const`
knobs (source-only).

## Config file (`pi-cmd-expand.json`)

Two independent on/off toggles, read on `session_start`:

| Location                         | Scope                 |
| -------------------------------- | --------------------- |
| `~/.pi/agent/pi-cmd-expand.json` | Global (all projects) |
| `./.pi/pi-cmd-expand.json`       | Project (this cwd)    |

Schema — all keys optional; missing / wrong-typed / unknown keys fall
back to defaults without throwing:

```json
{
  "enableCmd": true,
  "enableFile": true
}
```

| Key          | Default | Effect |
| ------------ | ------- | ------ |
| `enableCmd`  | `true`  | When `false`, `` !`cmd` `` / `` !```sh `` blocks are left as literal text in both user messages and `AGENTS.md` / `CLAUDE.md`. The toggle applies at every expansion level, so `` !`cmd` `` inside a loaded file is also left literal. |
| `enableFile` | `true`  | When `false`, `` @`path` `` / `` @``` `` blocks are left as literal text in both user messages and context files. Same recursive semantics. |

Project overrides global on a per-key basis (shallow merge). The loader
logs parse / IO errors to `console.error` and falls back to defaults
instead of aborting the session. Mid-session edits do not take effect
until the next session start (or `/reload`).

### Use cases

- **Disable cmd only**, keep `@`-files: leave commands as literal text
  the LLM can read (and decide to run with the built-in `bash` tool,
  preserving any safety affordances set up there), but still inline
  context files.
- **Disable file only**, keep `!`-cmds: pre-compute command snapshots in
  a prompt template, but stop the extension from reading any file the
  prompt references. Useful for tightly-controlled environments.

## Hard-coded `const` knobs

All five are `const` at the top of `src/index.ts`:

| Constant                   | Default  | Effect |
| -------------------------- | -------- | ------ |
| `DEFAULT_TIMEOUT_MS`       | `5_000`  | Per-command timeout. On expiry, partial output (if any) is reported inline followed by `[command failed: timed out after 5000ms]`. Applies to commands executed inside any loaded file as well. |
| `DEFAULT_MAX_OUTPUT_BYTES` | `2_000`  | Soft cap on inline command output. Above this, `truncateTail` keeps the last N bytes and the full output is written to a temp file whose path is appended inline so the LLM can `read` it on demand. |
| `DEFAULT_MAX_FILE_BYTES`   | `10_000` | Soft cap on inline file content (after recursive expansion). Same truncation policy as commands. Larger than the command cap because source files tend to be larger than command output. |
| `MAX_RECURSION_DEPTH`      | `10`     | Hard cap on `` @`path` `` nesting. Beyond this depth, `expandText` returns the file content with its `` @`path` `` references still unexpanded, so the LLM can decide what to do (e.g. use `read`). |
| `SOURCE_MAX_CHARS`         | `20`     | Maximum length of the `source` attribute on `<cmd>` tags. Longer commands are truncated to first 17 chars + `...` (fenced commands use only their first line as the source). Full command still runs — only the visible provenance is short. |

Temp files are **not** auto-cleaned — they live in `os.tmpdir()` and the
OS reclaims them on reboot.
