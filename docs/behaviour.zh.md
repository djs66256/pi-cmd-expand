# 行为说明

各类展开的详细语义。快速上手见 [README.zh.md](../README.zh.md)，实现
细节见 [architecture.md](./architecture.md)（英文）。

## 包装格式

每次展开都包装在 `<cmd>…</cmd>` 或 `<file>…</file>` 里。来源在属性里
（命令的 `source`、文件的 `path`、fenced 命令可选的 `lang`）。结果
元数据（`status="failed" exit-code="N"`、
`status="truncated" inline-size=… total-size=…`、`status="circular"`）
在出错时附加；标签正文仍然保留人类可读的
`[command failed: …]` / `[file failed: …]` / `[Output truncated …]` /
`[file skipped: circular reference: …]` 标记。

单行内容行内包装（`<cmd source="ls">AUTHORS</cmd>`）；多行内容多行
包装，标签独占一行：

```
<cmd source="ls -1">
AUTHORS
LICENSE
README.md
</cmd>
```

## 失败处理

- 失败的命令标注为 `[command failed: exit code N]`（如有 stdout/stderr
  会在错误信息上方一并保留）。
- 找不到的文件标注为
  `[file failed: ENOENT: no such file or directory, open '/abs/path']`。
- `` @`path` `` 出现环引用时标注为
  `[file skipped: circular reference: ./foo.md]`。

展开过程永远不会抛异常，所以一个坏掉的 `` !`cmd` `` 或 `` @`path` ``
不会让整轮中断。

## 输出截断

单条命令输出超过 2 KB 会被尾部截断，文件内容超过 10 KB 会被尾部截断，
完整内容写到 `/tmp/pi-cmd-expand-*.log`，路径会作为
`[Output truncated ... Full output: <path>]` 放在 wrap 里，LLM 可按需
读取。失败的命令不走截断，保留诊断信息。

## 递归加载

通过 `` @`path` `` 加载的文件会走和顶层文本同样的展开管线，深度上限
10。环引用通过 per-chain visited set 短路。深度上限只是一个安全网，
正常使用 1–3 层就够了。递归展开会产生嵌套的 `<file>` 标签（外层来自
用户 prompt，内层来自被加载文件的内部）。

## 缓存

上下文文件展开按 `path + mtime + size` 缓存在当前会话内，多轮对话中
不会重复执行命令或重新读取同样的文件。被 `` @`path` `` 加载进来的
文件**不会**单独缓存——它们是作为包含文件展开结果的一部分被缓存的，
只在包含文件变化时重新读取。

## 超时

每条命令 5 秒。慢命令会被杀，标注为
`[command failed: timed out after 5000ms]`。

## Shell

通过 pi 内置的 `createLocalBashOperations()` 执行，所以 shell 解析
（Windows Git Bash、WSL、Unix `/bin/bash`、`sh` 兜底）、输出清理
（去 ANSI、控制字符、CR 归一化）、超时杀整棵进程树都是直接复用 pi
`bash` 工具的能力。`|`、`>`、`$VAR` 都能正常工作。

## source 截断

`<cmd>` 标签的 `source` 属性会截断到 ≤ 20 字（fenced 形式只取第一行，
超出加 `...`）。长命令照常执行，只是可视的来源变短。

## 邮箱安全

内联 `` @`path` `` 用了 `(?<!\w)` lookbehind，所以邮件式文本（如
`` user@`example.com` ``）不会被误匹配。紧跟单词字符（字母数字 / `_`）
后的 `` @` `` 不会被匹配；位于字符串开头、空格之后、标点之后的
`` @` `` 仍会触发文件加载。
