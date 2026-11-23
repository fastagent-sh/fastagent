---
title: 产品概览
description: "面向生产级 AI Agent 的 TypeScript 运行时：用 Markdown、Skills、强类型工具和 MCP 编写，打包为 npm 制品，嵌入 Node.js、Docker 自托管或部署到任意云。"
status: current
---

# 产品概览

**面向生产级 AI Agent 的 TypeScript 运行时。**

FastAgent 是面向嵌入式、后台运行和自托管 AI Agent 的开源 TypeScript & Node.js 运行时。使用 Markdown（`SYSTEM.md`、`AGENTS.md`、`skills/`）、强类型 TypeScript 工具（`defineTool`）与 MCP 服务器编写 Agent——天然适配工程师与 Coding Agent 共同维护。通过 `fastagent build` 编译为版本化 npm 制品后，即可直接嵌入 Next.js、Hono、Express 或 Fastify（保留原有鉴权与数据库）、使用 Docker 自托管，或部署到 Fly.io、Railway 与 AWS AgentCore，全部统一在同一个 Agent API 之下。

## FastAgent 解决的生产级问题

1. **直接嵌入现有应用，无需重写技术栈。** 通过 `openAgent()` 将 Agent 直接放入 Next.js、Hono、Express 或 Fastify，或将其标准 Fetch Handler 挂载到现有路由旁。应用完整保留自己的用户认证、租户模型与 PostgreSQL 数据库，无需单独维护一套 Python 服务。
2. **扛住崩溃、断连与重试的后台运行能力。** 已接收的消息在返回确认前即持久化到 SQLite、PostgreSQL 或 Aurora DSQL，并具备单写者安全隔离。发布部署或进程重启后长任务自动恢复，SSE 流可从最后一条持久化记录（`after`）断点续传，重试的 Webhook 绝不重复执行（`Idempotency-Key`），空闲容器可自动休眠并按需唤醒（`POST /v1/invoke`）。
3. **超越提示词护栏的真实生产安全。** 密钥紧邻使用代码声明（`needs()`），部署前由 `fastagent deploy check` 拦截镜像泄漏，且绝不透传到子 Shell 环境。可按需启用纯工具模式（`codingTools: false`）、内核级 OS 沙箱（`--harness dsh`）或 Amazon Bedrock AgentCore 每用户独立 MicroVM，并通过 OpenTelemetry 导出不含提示词和回复正文的链路追踪。
4. **从本地笔记本迁移到任意基础设施，调用代码零修改。** 因为所有调用方——CLI、进程内嵌入 `openAgent()`、零 Node 依赖 HTTP 客户端 `@fastagent-sh/client`、AWS 客户端 `@fastagent-sh/client-agentcore` 以及交互式 Pi TUI `@fastagent-sh/pi-remote`——都面向同一份 [Agent API](agent-api.md)，你可以随时从本地 SQLite 迁往 Docker、Fly.io、Railway 或 AWS AgentCore，或切换模型与 Harness（`pi-durable` ↔ `dsh`），业务代码一行不用改。

## Agent 项目目录结构

每个 Agent 位于由 `fastagent.config.ts` 标识的独立目录中：

```text
my-agent/
├── fastagent.config.ts   # defineAgent({ model, harness, sandbox, codingTools, providers, mcpServers, starters })
├── package.json          # Agent 名称、描述、依赖与 dev/build/start 脚本
├── SYSTEM.md             # 系统提示词（每条消息自动重新读取）
├── AGENTS.md             # 可选的项目约定，自动附加到提示词
├── skills/               # 可选的 Agent Skills（skills/<name>/SKILL.md），可通过 /skill:<name> 调用
├── prompts/              # 可选的提示词模板（prompts/<name>.md），可通过 /<name> 调用
├── src/
│   ├── tools/            # 可选的可移植 TypeScript 工具（defineTool）
│   └── extensions/       # 可选的 pi-durable 扩展（defineExtension）
├── .secrets/             # 已加入 .gitignore 的本地密钥（.env、auth.json），绝不进入构建产物或镜像
└── .fastagent/           # 已加入 .gitignore 的本地运行时实例（dev/、start/）
```

`fastagent init` 会将该目录初始化为独立的 Git 仓库。修改提示词、`AGENTS.md`、Skills 与模板无需重启，在下一条消息即刻生效。`fastagent build` 将 Agent 编译到 `dist/`，产出不可变的标准 npm 包，供 `fastagent start`、宿主应用嵌入或容器直接加载。

## 核心概念

| 概念 | 含义 |
| --- | --- |
| **Agent（定义）** | 由提示词、Skills、工具、Provider 与配置编译而成的不可变程序制品。 |
| **Instance（实例）** | Agent 的一个运行副本，拥有独立工作目录、密钥与持久化存储（SQLite 或 PostgreSQL / Aurora DSQL）。 |
| **Session（会话）** | 实例内的一段持久化对话，保存历史记录、会话配置（`model`、`thinkingLevel`、`instructions`、`tools`）、用量统计与实时执行状态。 |
| **Conversation（命名对话）** | 传给 `POST /v1/invoke` 或 `fastagent invoke --conversation` 的调用方自定义名称（例如 `"pr-fastagent-1140"` 或 `"incident:inc-415"`），自动映射并复用对应会话。 |
| **Message（消息）** | 调用方向会话提交的一次请求。一旦接收，即使经历重启也会收敛到唯一终态（`completed`、`incomplete`、`failed` 或 `canceled`）。 |
| **Entry（记录条目）** | 会话历史中的一条持久化记录（`user`、`assistant`、`tool_result`、`compaction`）。 |
| **Tool（工具）** | 模型可调用的强类型动作——包括内置编码工具（`read`、`write`、`edit`、`bash`）、自定义 TypeScript 工具（`defineTool`）或 [MCP 服务器工具](mcp.md)。 |
| **Skill（技能）** | 位于 `skills/<name>/SKILL.md` 的可复用操作指令，可按需加载或通过 `/skill:<name>` 显式触发。 |
| **Remote（远程端点）** | 保存在 `~/.config/fastagent/remotes.json` 的线上部署地址（HTTP 或可插拔云传输如 AgentCore），由 CLI 与 `@fastagent-sh/pi-remote` 共享。 |

## 运行与部署方式

| 模式 | 使用方式 | 存储 |
| --- | --- | --- |
| **本地开发** | `fastagent dev`、`fastagent invoke` | 本地 SQLite（`.fastagent/dev/.state/`） |
| **应用内嵌入** | `openAgent(definition, { root, secrets, env })` | 本地 SQLite 或 PostgreSQL（独占或通过 `openPostgresDatabase` 共享连接池） |
| **容器自托管 / 托管云** | `fastagent deploy init docker\|compose\|fly\|railway` | 挂载卷 `/data` 或 `FASTAGENT_DATABASE_URL`（PostgreSQL） |
| **Amazon Bedrock AgentCore** | `npm i @fastagent-sh/agentcore && fastagent deploy init agentcore` | 每个 AgentCore 会话独立 MicroVM + Aurora DSQL + Secrets Manager |

## FastAgent 刻意留给外部应用的职责

| 职责 | 为什么放在 FastAgent 之外 |
| --- | --- |
| **聊天平台接入器** | Slack、Telegram、Discord 与 Web UI 属于 Agent API 的外部调用方，而非运行时插件。 |
| **终端用户鉴权与计费** | 一个 API Key 控制整个实例；你的业务应用完整保留用户登录、多租户与路由控制权。 |
| **静态 DAG 工作流与定时调度器** | 由 Agent 自主决定工具调用步骤；定时任务与事件驱动工作通过外部调度器单次调用 `POST /v1/invoke` 触发（GitHub Actions、Cloud Scheduler、EventBridge、Webhook）。 |
| **固定形态的 UI** | 终端交互可使用 [`@fastagent-sh/pi-remote`](remotes.md#4-从终端实时交互fastagent-shpi-remote)，Web/App 端可基于 `sessions.events` 与 `messages.stream` 自由构建任何界面。 |

## 当前边界

- **单实例单写者：** 同一时刻只有一个进程拥有某个实例的存储写权限（通过 SQLite `EXCLUSIVE` 锁或 PostgreSQL/DSQL 租约强制保障）。水平扩展应跨实例进行（例如按用户或租户拆分实例），而非让多个写进程同时挂载同一实例。
- **实验性 DSH Harness：** `@fastagent-sh/harness-dsh` 提供完整的 Agent API 契约一致性与内核级 OS 沙箱，当前锁定上游预发布版本的 `@deepseek-ai/dsh`。

## 下一步

- 浏览生产级[示例项目](../../examples/README.md)（PR 审查、AI SRE 告警排查、多租户 SaaS Copilot、AWS AgentCore、深度调研）。
- 跟随[快速上手](quickstart.md)在 5 分钟内搭建并运行第一个 Agent。
- 阅读[打包、分发与 CI/CD](packaging-and-ci.md)，了解如何编译版本化 npm 制品与设置 CI 门禁。
- 阅读[技术架构](architecture.md)，深入理解包边界、双 Harness、存储隔离与安全机制。
- 将[Agent 开发指南](ai-start.md)交给 Coding Agent 或亲自按步骤完成端到端构建与部署。
