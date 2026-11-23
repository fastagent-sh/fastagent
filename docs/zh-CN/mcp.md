---
title: MCP 服务器
description: "接入本地 stdio 或远程 Streamable HTTP MCP 工具服务器，支持安全的密钥占位符替换、超时控制与环境隔离。"
status: current
---

# MCP 服务器

在 `fastagent.config.ts` 的 `mcpServers` 中声明任意本地 **stdio** 或远程 **Streamable HTTP** Model Context Protocol（MCP）服务器即可接入外部工具。发现的每个工具在 `pi-durable` 和 `dsh` 上都会以 `mcp__<server>__<tool>` 暴露给模型。

FastAgent 会刻意忽略 `.mcp.json`、编辑器配置和用户主目录配置，确保 Agent 的工具集合在每台开发机与容器中始终显式、可移植、可复现。

**支持范围：** MCP 协议 `2026-07-28`，返回文本或 JSON 结果的工具，基于 **stdio** 或带自定义请求头的 **Streamable HTTP**。
**暂不支持：** MCP OAuth 流程、resources、prompts、sampling、elicitation、旧版 HTTP+SSE、更早协议版本，以及工具列表热重载（新增工具需重新打开实例）。

## 本地服务器（stdio）

```ts
import { defineAgent } from "@fastagent-sh/fastagent";

export default defineAgent({
  model: "openai/gpt-5.5",
  mcpServers: {
    project: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/srv/project"],
      env: { LOG_LEVEL: "info" },
    },
  },
});
```

- 在实例工作目录直接启动，不经过 Shell。FastAgent 不会自动安装二进制：请使用 `npx -y`、将包加入 `package.json` 或在容器 `Dockerfile` 中预装。
- 仅接收最小基础环境（`PATH`、`HOME`、临时目录、locale）与显式声明的 `env`，绝不继承宿主机环境密钥。
- 若使用相对路径指向本地可执行文件，必须将其放在 `assets/` 下，以便 `fastagent build` 一并打包进 `dist/`。

## 远程服务器（Streamable HTTP）

```ts
import { defineAgent } from "@fastagent-sh/fastagent";

export default defineAgent({
  model: "openai/gpt-5.5",
  mcpServers: {
    internal: {
      type: "http",
      url: "https://mcp.example.com/mcp",
      headers: {
        Authorization: "Bearer ${SERVICE_TOKEN}",
      },
    },
  },
});
```

- **非回环地址强制 HTTPS。** 拒绝 HTTP 重定向，防止声明的请求头泄漏到其他主机。
- **密钥占位符替换：** `command`、`args`、`env` 与 `headers` 中的 `${NAME}` 占位符从实例密钥中解析（`.secrets/.env`、容器环境变量或 `openAgent({ secrets })`）。缺少变量会在启动时立即失败；切勿在 `fastagent.config.ts` 中硬编码 Token。
- **鉴权错误：** HTTP `401` 或 `403` 会导致启动失败并抛出 `McpError("authorization_required")`。
- **代理支持：** 自动遵循标准 `HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY`。

运行 `fastagent info` 可检查已声明的 MCP 服务器及其所需的全部密钥。

## 超时与故障处理

- **超时时间：** 协议探测超时 15s，初始连接超时 30s，单次请求或工具调用超时 60s。
- **取消传播：** 取消会话会将取消信号转发给 MCP 服务器（是否立即停止取决于服务器实现）。
- **崩溃恢复：** 因重启而中断的 MCP 工具调用会被如实报告为已中断，而不会盲目自动重跑。
- **不支持的返回格式：** 非文本/非 JSON 的工具输出会作为可见的工具错误返回。
- **幂等启动：** 客户端可能在协议协商阶段对服务器进行探测；请避免在服务器初始化阶段触发不可逆副作用。
