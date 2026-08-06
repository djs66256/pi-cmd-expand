# pi-cmd-expand

一个 [pi](https://pi.dev) 插件，用于在 prompt 和项目上下文文件
（AGENTS.md / CLAUDE.md）**送到 agent 之前**展开其中的内联 shell
命令和文件引用。

支持四种语法（与 Claude Code 兼容）：

````text
!`ls -la`
@`path/to/file.md`
````

`````text
!```sh
ls -la
```

@```
path/to/file_1
path/to/file_2
```
`````

fenced 形式的语言标签是可选的。命令形式的 shell 标签（例如 `sh`、
`bash`、`shell`、`zsh`、`fish`）都能识别；标签只是语法元数据，不会决定
实际执行命令时使用的 shell。`` @``` `` 形式的语言标签会被忽略。

## 作用

- 用户输入消息中任意位置的 **`` !`cmd` ``** → 命令在 agent 当前工作
  目录下执行，输出包装在 `<cmd source="…">…</cmd>` 里，agent 看到
  的就是替换后的文本。
- 用户输入消息中任意位置的 **`` @`path` ``** → 文件的 UTF-8 内容
  包装在 `<file path="…">…</file>` 里。路径以 agent 的 cwd 为基准
  解析，绝对路径则原样使用。
- **`AGENTS.md` / `CLAUDE.md`** 中的 **`` !`cmd` ``** / **`` @`path` ``**
  → 在会话开始时展开同一规则，所以项目上下文里可以直接放实时的文件
  快照、package 列表、diff，**以及内联的源文件**。
- **递归加载** — 通过 `` @`path` `` 加载的文件本身也会走同一套展开
  规则，里面的 `` @`path` `` 或 `` !`cmd` `` 也会被解析（深度上限
  10；环引用会被短路）。所以一条 `` @`./README.md` `` 可以一次性把
  整棵文档树拉进上下文。

每次展开都会包装在语义标签（`<cmd>` 或 `<file>`）里，属性携带来源
（`source`、`path`、`lang`）和结果元数据（`status`、`exit-code`、
`error`、`inline-size`、`total-size`）。单行内容走行内包装，多行
内容走多行包装（开/闭标签独占一行）。

所有命令执行和文件路径解析都以 **agent 的 cwd**（`ctx.cwd`）为基准，
不是 prompt 或上下文文件所在目录。

## 安装

从 [npm registry](https://www.npmjs.com/package/pi-cmd-expand) 安装。

### 用户全局（`~/.pi/agent/settings.json`）

```bash
pi install npm:pi-cmd-expand
```

### 项目本地（`.pi/settings.json`，可与团队共享）

```bash
pi install npm:pi-cmd-expand -l
```

### 不安装、直接试一下

```bash
pi -e npm:pi-cmd-expand
```

> 想锁版本，追加 `@x.y.z`，例如 `pi install npm:pi-cmd-expand@0.1.0`。
> 带版本号的安装会被 `pi update --extensions` 跳过，只能通过
> 显式 `pi install npm:pi-cmd-expand@<新版本>` 升级。

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

入口：
@`./src/index.ts`

姊妹文档：
@```
./README.md
./CHANGELOG.md
```
`````

pi 加载它之后，agent 看到的就是 agent 工作目录下真实的文件系统
快照、`src/index.ts` 的完整内容（如果它内部还包含 `` @`path` `` /
`` !`cmd` `` 会被递归展开），以及 `README.md` 和 `CHANGELOG.md` —
每个文件各自带 `<file>` 包装。

Inline（单文件）：
```
…入口：<file path="./src/index.ts">…</file>…
```

Fenced（多文件，每个文件一个 wrap）：
```
…姊妹文档：
<file path="./README.md">…</file>

<file path="./CHANGELOG.md">…</file>
```

## 配置

两种展开可以独立开关，通过 JSON 配置文件控制。两个位置
（项目级在每个键上覆盖全局）：

| 位置                                | 范围                |
| ----------------------------------- | ------------------- |
| `~/.pi/agent/pi-cmd-expand.json`    | 全局（所有项目）    |
| `./.pi/pi-cmd-expand.json`          | 项目本地（当前目录）|

Schema——所有 key 都是可选的；缺失 / 类型错误 / 未知的 key 会
安静地回退到默认值，不抛错：

```json
{
  "enableCmd": true,
  "enableFile": true
}
```

| Key           | 默认值 | 作用                                                                                                                  |
| ------------- | ------ | --------------------------------------------------------------------------------------------------------------------- |
| `enableCmd`   | `true` | 为 `false` 时，`` !`cmd` `` / `` !```sh ` 块在用户消息和 `AGENTS.md` / `CLAUDE.md` 中都保留为字面量。该开关作用于所有展开层级，所以已加载文件内的 `` !`cmd` `` 也会保持字面量。 |
| `enableFile`  | `true` | 为 `false` 时，`` @`path` `` / `` @``` ` 块在用户消息和上下文文件中都保留为字面量。同样在所有展开层级生效。            |

配置文件在 session 启动时读取（`/reload` 时也会重新读取）。会话
中途的修改不会立即生效，下次启动（或 `/reload`）后才生效。解析
错误会被打印到日志并忽略——回退到默认值。

常见用法：

- **只关闭 cmd、保留 `@`-file**：让命令保持为字面量文本供 LLM 阅读
  （并决定是否用内置的 `bash` 工具运行，保留你在那边设置的安全策
  略），但仍会内联上下文文件。
- **只关闭 file、保留 `!`-cmd**：在 prompt 模板里预先计算命令快
  照，但阻止扩展读取 prompt 引用的任何文件。在受控环境中很有用。

## 作用范围

扩展规则是故意做窄的：

| 来源 | 是否展开 |
| --- | --- |
| 用户直接敲的  `` !`cmd` ``  /  `` @`path` ``  | ✅ `message_end` 事件（LLM 能看到展开后文本；TUI 聊天区的 user message 气泡仍然显示源码，因为 pi 在 `message_end` 不重渲染 user 消息） |
| prompt 模板（`/foo`）或 skill（`/skill:bar`）正文里的  `` !`cmd` ``  /  `` @`path` ``  | ✅ `message_end` 事件（template 展开之后） |
| `AGENTS.md` / `CLAUDE.md` 中的  `` !`cmd` ``  /  `` @`path` ``  | ✅ `before_agent_start` 事件 |
| 通过 `` @`path` `` 加载的文件内部再出现 `` @`path` ``  | ✅ 递归展开（深度上限 10） |
| 行首的 `!cmd` | ❌ pi 原生的 `!bash` |
| LLM 通过 `bash` 工具执行的命令 | ❌ 不动 |
| agent 用 `read` 工具读的文件 | ❌ 只有显式通过 `` @`path` `` 引用的文件会被展开 |

`input` / `user_bash` / `tool_call` / `tool_result` 这四个钩子**故意不**注册：`input` 是因为 TUI 对 template-body 场景本来就显示不出展开后文本，集中到 `message_end` 后直接键入和模板体两条路径走同一套 in-place 重写协议；`user_bash` 是为了 pi 原生的 `!bash`（含 `!!`、取消、实时流式）保持原样；`tool_call` / `tool_result` 是为了 agent 自带的 `bash` 工具不被提前展开。

> **为什么用户输入只要一个钩子？** `message_end` 事件在模板 /
> skill 展开**之后**、LLM 调用**之前**触发（见 pi
> [docs/extensions.md#message_end](https://pi.dev/docs/extensions#message_end)），
> 所以不管是直接键入还是模板体带来的 `` !`cmd` ``，此时都已经
> 在 user message 里了，在 `message_end` 里原地改写就同时覆盖两条
> 路径。完整原理见 [AGENTS.md](./AGENTS.md)。

## 行为说明

- **包装格式** — 每次展开都包装在 `<cmd>…</cmd>` 或 `<file>…</file>`
  里。来源在属性里（命令的 `source`、文件的 `path`、fenced 命令可选
  的 `lang`）。结果元数据（`status="failed" exit-code="N"`、
  `status="truncated" inline-size=… total-size=…`、
  `status="circular"`）在出错时附加；标签正文仍然保留人类可读的
  `[command failed: …]` / `[file failed: …]` /
  `[Output truncated …]` / `[file skipped: circular reference: …]`
  标记。单行内容行内包装（`<cmd source="ls">AUTHORS</cmd>`）；多行
  内容多行包装，标签独占一行：
  ```
  <cmd source="ls -1">
  AUTHORS
  LICENSE
  README.md
  </cmd>
  ```
- **失败处理** — 失败的命令在 wrap 里标注为
  `[command failed: exit code N]`（如有 stdout/stderr 会在错误信息
  上方一并保留）；找不到的文件在 wrap 里标注为
  `[file failed: ENOENT: no such file or directory, open '/abs/path']`；
  `` @`path` `` 出现环引用时则在 wrap 里标注为
  `[file skipped: circular reference: ./foo.md]`。展开过程永远
  不会抛异常，所以一个坏掉的  `` !`cmd` ``  或  `` @`path` ``  不
  会让整轮中断。
- **输出截断** — 单条命令输出超过 2 KB 会被尾部截断，文件内容
  超过 10 KB 会被尾部截断，完整内容写到
  `/tmp/pi-cmd-expand-*.log`，路径会作为
  `[Output truncated ... Full output: <path>]` 放在 wrap 里，LLM
  可按需读取。失败的命令不走截断，保留诊断信息。
- **递归加载** — 通过 `` @`path` `` 加载的文件会走和顶层文本
  同样的展开管线，深度上限 10。环引用通过 per-chain visited set
  短路。深度上限只是一个安全网，正常使用 1–3 层就够了。递归
  展开会产生嵌套的 `<file>` 标签（外层来自用户 prompt，内层来自
  被加载文件的内部）。
- **缓存** — 上下文文件展开按 `path + mtime + size` 缓存在当前
  会话内，多轮对话中不会重复执行命令或重新读取同样的文件。被
  `` @`path` `` 加载进来的文件**不会**单独缓存——它们是作为包含
  文件展开结果的一部分被缓存的，只在包含文件变化时重新读取。
- **超时** — 每条命令 5 秒。慢命令会被杀，在 wrap 里标注为
  `[command failed: timed out after 5000ms]`。
- **Shell** — 通过 pi 内置的 `createLocalBashOperations()` 执行，
  所以 shell 解析（Windows Git Bash、WSL、Unix `/bin/bash`、
  `sh` 兜底）、输出清理（去 ANSI、控制字符、CR 归一化）、超时
  杀整棵进程树都是直接复用 pi `bash` 工具的能力。`|`、`>`、`$VAR`
  都能正常工作。
- **source 截断** — `<cmd>` 标签的 `source` 属性会截断到 ≤ 20 字
  （fenced 形式只取第一行，超出加 `...`）。长命令照常执行，只是
  可视的来源变短。
- **邮箱安全** — 内联 `` @`path` `` 用了 `(?<!\w)` lookbehind，
  所以邮件式文本（如 `` user@`example.com` ``）不会被误匹配。
  紧跟单词字符（字母数字 / `_`）后的 `` @` `` 不会被匹配；位于
  字符串开头、空格之后、标点之后的 `` @` `` 仍会触发文件加载。

## 开发

```bash
npm test                         # node --test，jiti 加载 TS
npm test -- --test-reporter=spec # 更可读的输出
```

完整开发者 / agent 指南（架构、事件钩子、scope 约束、配置项、
常见坑）见 **[AGENTS.md](./AGENTS.md)**。

## 手动验证 prompt

`.pi/prompts/` 下有 15 个 slash-command（`/test-inline`、
`/test-file-inline`、`/test-file-multi`、`/test-truncation`、
`/test-scope` 等），在 pi 交互模式里调用可以手动检查每个行为
路径。`demo-*` 是真实使用场景示例（git diff 评审、项目结构
快照）。这些**不**被 `npm test` 运行。

## License

MIT

[English](./README.md)
