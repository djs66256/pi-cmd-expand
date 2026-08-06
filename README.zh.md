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

两种展开可以通过 JSON 配置文件独立开关——`~/.pi/agent/pi-cmd-expand.json`
（全局）和 `./.pi/pi-cmd-expand.json`（项目级，按 key 覆盖全局）：

```json
{
  "enableCmd": true,
  "enableFile": true
}
```

任一项设为 `false`，对应语法在所有展开层级都保留为字面量。配置文件在
session 启动时读取（`/reload` 时也会重读）；解析错误会被打印并忽略。
完整 schema、优先级规则和常见用法见
**[docs/configuration.md](./docs/configuration.md)**（英文）。

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

`input` / `user_bash` / `tool_call` / `tool_result` 这四个钩子**故意
不**注册：这样 pi 原生的 `!bash` 和 agent 自带的 `bash` 工具都保持
原样，同时直接键入和模板体两条路径共用 `message_end` 里同一套 in-place
重写协议（该事件在 template / skill 展开**之后**、LLM 调用**之前**
触发）。完整原理见
**[docs/architecture.md](./docs/architecture.md#the-scope-contract-do-not-break-this)**（英文）。

## 行为说明

- **包装格式** — `<cmd source="…">` / `<file path="…">`，出错时附加
  `status` / `exit-code` / `error` / `inline-size` / `total-size`。
  单行内容行内包装，多行内容标签独占一行。
- **失败处理** — 失败会变成 wrap 里的 `[command failed: …]` /
  `[file failed: …]` / `[file skipped: circular reference: …]`。展开
  过程永不抛异常，坏掉的引用不会中断整轮。
- **输出截断** — 命令输出超 2 KB、文件内容超 10 KB 会尾部截断，完整
  内容写入 `/tmp/pi-cmd-expand-*.log` 并把路径附在行内。
- **递归加载** — 深度上限 10，环引用短路。
- **缓存** — 上下文文件展开按 `path + mtime + size` 在会话内缓存。
- **超时** — 每条命令 5 秒。
- **Shell** — 复用 pi 内置的 `createLocalBashOperations()`，`|`、`>`、
  `$VAR` 和跨平台 shell 解析都正常工作。
- **邮箱安全** — `` user@`example.com` `` 不会被当成文件引用。

每一项的完整说明见 **[docs/behaviour.zh.md](./docs/behaviour.zh.md)**。

## 开发

```bash
npm test                         # node --test，jiti 加载 TS
npm test -- --test-reporter=spec # 更可读的输出
```

开发者 / agent 指南见 **[AGENTS.md](./AGENTS.md)**；架构、内部实现、
配置与行为参考见 **[docs/](./docs)**。

## 手动验证 prompt

`.pi/prompts/` 下有 15 个 slash-command（`/test-inline`、
`/test-file-inline`、`/test-file-multi`、`/test-truncation`、
`/test-scope` 等），在 pi 交互模式里调用可以手动检查每个行为
路径。`demo-*` 是真实使用场景示例（git diff 评审、项目结构
快照）。这些**不**被 `npm test` 运行。

## License

MIT

[English](./README.md)
