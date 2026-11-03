# 在 DSH（Android）里挂本地 MCP server

DSH 引擎自带 MCP 客户端桥 `@deepseek-ai/dsh-mcp-client`，它把 MCP server 的工具注册成
`mcp__<serverName>__<toolName>`。

## 为什么不能走 App 的设置页

App 的「贴 `mcpServers` JSON」入口有一层分类器，**直接用 `command: "node"` 会被拒绝**：

```
kind: 'local', supported: false, error: mcp-local-path
```

它只接受三种：远程 Streamable HTTP、`npx` 从 npm 装的包、其它运行时的二进制（Python/Docker…）。
手机上通常没有这些运行时，所以「本地 `.mjs`」只能走 profile 的 patch 层。

## 正确做法：写进 profile 的 cordis.patch.yml

```yaml
- insert:
    - id: mcp-media-toolbox
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: mediatoolbox          # 只允许 [A-Za-z0-9_-]{1,32}
        command: !!js "process.env.DSH_NODE_BIN || '<你的 node 绝对路径>'"
        args:
          - --max-old-space-size=256
          - !!js "process.env.HOME + '/path/to/server.mjs'"
        failOnStartupError: false          # 起不来也不炸引擎，只是没工具
```

三个要点：

1. `command` 必须是**可执行的 node**。Android 上应用私有目录里的文件不可执行（`EACCES`），
   但指向 APK native lib 的那个符号链接可以。
2. Android profile 里 `hmr` 是 disabled，所以改配置**不热生效**，要重启引擎。
3. `failOnStartupError: false` 很关键：配置写错时引擎照常启动，只是工具不出现。

## 改完 server 怎么生效（不用重启引擎）

mcp-client 在 transport 关闭后按 `reconnect` 策略重连，新 connect 会重新 `tools/list`
并把旧工具换成新的。所以：

```bash
# 找到以 server.mjs 为参数的子进程
for p in /proc/[0-9]*; do pid=${p#/proc/}; tr '\0' ' ' < $p/cmdline 2>/dev/null | grep -q "server.mjs" && echo $pid; done
kill -TERM <pid>
```

几秒后日志出现 `connection lost; reconnecting in 500ms`，然后新版本就绪。

⚠️ 新增的工具仍需要客户端侧的按需加载（DSH 里是 `load_tools`），目录里看到名字 ≠ 已可调用。

## 排错顺序

1. `--dump-config` 看这行有没有进合成后的配置
2. 用引擎里的 `Config` schema 校一遍（`@deepseek-ai/dsh-mcp-client` 导出了 `Config`）
3. 用官方 `@modelcontextprotocol/client` 的 `StdioClientTransport` 按最终命令手工连一次
4. 再看引擎日志里的工具清单

第 3 步最有价值：它把「配置问题」和「server 问题」分开了。
