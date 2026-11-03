# MCP 协议实现笔记（写 server 时踩过的）

依据 [MCP 规范 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/changelog)。

## 传输层只有两种

`stdio` 与 **Streamable HTTP**。早期文档里的「HTTP+SSE」已在 2025-03-26 被取代
（规范原文：*replaces the HTTP+SSE transport from protocol version 2024-11-05*）。

## stdio 的三条铁律

规范原文两句话决定了它们：

> Messages are delimited by newlines, and **MUST NOT** contain embedded newlines.
> The server **MUST NOT** write anything to its `stdout` that is not a valid MCP message.

1. **stdout 只准出现 MCP 消息** —— 一句 `console.log` / `print` 就会让客户端解析器崩掉。
2. **一条消息一行** —— `JSON.stringify(msg, null, 2)` 这种美化同样违规，症状更隐蔽（客户端只是「没反应」）。
3. **握手顺序** —— `initialize`（版本协商）→ 客户端发 `notifications/initialized` → 才能 `tools/list` / `tools/call`。
   通知没有 `id`，**不许回复**。

## 错误语义

| 情况 | 正确做法 |
|---|---|
| 工具内部失败（文件不存在、参数缺失） | `result` 里 `isError: true` + 说明文字，让模型能自我纠正 |
| 未知工具 | JSON-RPC 错误 `-32602` |
| 未知方法 | `-32601` |
| 非法 JSON | `-32700` |

2025-11-25 明确了一条：**输入校验错误应作为工具执行错误返回**，而不是协议错误。

## 版本协商

server 回显客户端请求的版本（若支持），未知版本回落到自己最新的。
声明某个版本 ≠ 实现它全部可选特性：`icons`、`tasks`、`elicitation` 都是能力协商的可选项。
本 server 只声明 `tools` 能力。

## 自测的两种故障（真有工具能复现）

`experiments/` 下的两个变体故意写错，用来验证客户端会不会炸：

- `server-print.mjs`：工具里加了 `console.log` → 客户端收到非 JSON 行
- `server-pretty.mjs`：响应改成缩进 JSON → 一条消息被拆成多行

跑法：`node client.mjs --list --server experiments/server-pretty.mjs`
