# pi-cmd-expand

一个 [pi](https://pi.dev) 插件，用于在 prompt 和项目上下文文件
（AGENTS.md / CLAUDE.md）**送到 agent 之前**展开其中的内联 shell
命令。

支持两种语法（与 Claude Code 兼容）：

````text
!`ls -la`
````

`````text
!```sh
ls -la
```
`````

## 作用

- 用户输入消息中任意位置的 **`` `!`cmd` ``** → 命令在 agent 当前工作
  目录下执行，输出就地拼接进消息，agent 看到的就是替换后的文本。
- **`AGENTS.md` / `CLAUDE.md`** 中的 **`` `!`cmd` ``** → 在会话开始时
  展开同一规则，所以项目上下文里可以直接放实时的文件快照、
  package 列表、diff 等等。

所有命令都在 **agent 的 cwd**（`ctx.cwd`）中执行，而不是 prompt
或上下文文件所在目录。

## 安装

### 项目内

```bash
pi install /absolute/path/to/pi-cmd-expand
# 或者
pi install ./pi-cmd-expand
```

### 用户全局

```bash
pi install /absolute/path/to/pi-cmd-expand -l
```

### 不安装、直接试一下

```bash
pi -e /absolute/path/to/pi-cmd-expand/src/index.ts
```

## 示例

假设 `CLAUDE.md` 是这样：

`````markdown
# 项目结构

源码文件：
!`find src -maxdepth 2 -name '*.ts' | head -20`

测试：
!```sh
ls tests/ | head -10
```
`````

pi 加载它之后，agent 看到的就是 agent 工作目录下真实的文件系统
快照。

## 作用范围

扩展规则是故意做窄的：

| 来源 | 是否展开 |
| --- | --- |
| 用户直接敲的  `` `!`cmd` ``  | ✅ `message_end` 事件（LLM 能看到展开后文本；TUI 聊天区的 user message 气泡仍然显示 `!`cmd` 源码，因为 pi 在 `message_end` 不重渲染 user 消息） |
| prompt 模板（`/foo`）或 skill（`/skill:bar`）正文里的  `` `!`cmd` ``  | ✅ `message_end` 事件（template 展开之后） |
| `AGENTS.md` / `CLAUDE.md` 中的  `` `!`cmd` ``  | ✅ `before_agent_start` 事件 |
| 行首的 `!cmd` | ❌ pi 原生的 `!bash` |
| LLM 通过 `bash` 工具执行的命令 | ❌ 不动 |
| agent 用 `read` 工具读的文件 | ❌ 只有项目上下文文件会被展开 |

`input` / `user_bash` / `tool_call` / `tool_result` 这四个钩子**故意不**注册：`input` 是因为 TUI 对 template-body 场景本来就显示不出展开后文本，集中到 `message_end` 后直接键入和模板体两条路径走同一套 in-place 重写协议；`user_bash` 是为了 pi 原生的 `!bash`（含 `!!`、取消、实时流式）保持原样；`tool_call` / `tool_result` 是为了 agent 自带的 `bash` 工具不被提前展开。

> **为什么用户输入只要一个钩子？** `message_end` 事件在模板 /
> skill 展开**之后**、LLM 调用**之前**触发（见 pi
> [docs/extensions.md#message_end](https://pi.dev/docs/extensions#message_end)），
> 所以不管是直接键入还是模板体带来的 `` `!`cmd` ``，此时都已经
> 在 user message 里了，在 `message_end` 里原地改写就同时覆盖两条
> 路径。完整原理见 [AGENTS.md](./AGENTS.md)。

## 行为说明

- **失败处理** — 失败的命令就地标注为
  `[command failed: exit code N]`（如有 stdout/stderr 会在错误信息
  上方一并保留）。展开过程永远不会抛异常，所以一个坏掉的  `` `!`cmd` `` 
  不会让整轮中断。
- **输出截断** — 单条命令输出超过 2 KB 会被尾部截断，完整输出
  写到 `/tmp/pi-cmd-expand-*.log`，路径会作为
  `[Output truncated ... Full output: <path>]` 追加到插入文本里，
  LLM 可按需读取。失败的命令不走截断，保留诊断信息。
- **缓存** — 上下文文件展开按 `path + mtime + size` 缓存在当前
  会话内，多轮对话中不会重复执行。
- **超时** — 每条命令 5 秒。慢命令会被杀，标注为
  `[command failed: timed out after 5000ms]`。
- **Shell** — 通过 pi 内置的 `createLocalBashOperations()` 执行，
  所以 shell 解析（Windows Git Bash、WSL、Unix `/bin/bash`、
  `sh` 兜底）、输出清理（去 ANSI、控制字符、CR 归一化）、超时杀
  整棵进程树都是直接复用 pi `bash` 工具的能力。`|`、`>`、`$VAR`
  都能正常工作。

## 开发

```bash
npm test                         # node --test，jiti 加载 TS
npm test -- --test-reporter=spec # 更可读的输出
```

完整开发者 / agent 指南（架构、事件钩子、scope 约束、配置项、
常见坑）见 **[AGENTS.md](./AGENTS.md)**。

## 手动验证 prompt

`.pi/prompts/` 下有 10 个 slash-command（`/test-inline`、
`/test-truncation`、`/test-scope` 等），在 pi 交互模式里调用可以
手动检查每个行为路径。`demo-*` 是真实使用场景示例（git diff
评审、项目结构快照）。这些**不**被 `npm test` 运行。

## License

MIT

[English](./README.md)
