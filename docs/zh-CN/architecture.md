---
title: 技术架构
description: "FastAgent 如何将提示词、技能与工具转化为持久化、隔离、云中立的服务：系统分层、单一 Agent API 契约、双 Harness、存储租约隔离、安全边界与包清单。"
status: current
---

# 技术架构

在生产环境中可靠运行 AI Agent，需要解决五个核心工程难题：

1. **调用方与运行时解耦**：更换模型、Harness 或宿主机时，应用、CLI 与远程客户端代码零改动。
2. **避免任务丢失或重复执行**：扛住进程崩溃、发布重启、客户端断连与空闲休眠唤醒。
3. **防止密钥和宿主机状态泄漏进构建产物或 Agent 子进程。**
4. **约束工具执行权限**：在 Agent 运行 Shell 命令或访问文件时强制施加隔离边界。
5. **保持客户端轻量且云中立**：边缘函数与业务后端不引入未使用的运行时或云厂商 SDK。

FastAgent 围绕这五项要求划分为清晰的分层架构：

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ Callers & Clients                                                          │
│  fastagent CLI · Your App (openAgent) · @fastagent-sh/client (HTTP/SSE)    │
│  @fastagent-sh/client-agentcore (AWS) · @fastagent-sh/pi-remote (Pi TUI)   │
└──────────────────────────────────┬─────────────────────────────────────────┘
                                   │  One Contract: Agent API
                                   │  (In-process / HTTP /v1 / AgentCore)
┌──────────────────────────────────▼─────────────────────────────────────────┐
│ Unified Serving Layer (@fastagent-sh/fastagent)                            │
│  Build & Definition · needs() Secrets · Model & Durable Auth Store         │
│  MCP Clients · POST /v1/invoke Conversations · OTLP Tracing · HTTP Server  │
└───────────────────┬────────────────────────────────────┬───────────────────┘
                    │                                    │ (optional, lazy)
┌───────────────────▼──────────────────┐ ┌───────────────▼───────────────────┐
│ Harness: pi-durable (default)        │ │ Harness: @fastagent-sh/harness-dsh│
│  Durable loop · src/extensions       │ │  @deepseek-ai/dsh · OS Sandbox    │
│  SQLite (EXCLUSIVE) / PostgreSQL     │ │  SQLite / PostgreSQL & Aurora     │
│  & Aurora DSQL                       │ │  DSQL (shared fenced leases)      │
└──────────────────────────────────────┘ └───────────────────────────────────┘
```

## 1. 统一契约：Agent API

与 FastAgent 实例的每一次交互——进程内嵌入、HTTP/SSE、AWS AgentCore、CLI `invoke` 或 `@fastagent-sh/pi-remote`——全部经由 `@fastagent-sh/client` 中以 Schema 定义的单一契约：

- **服务端、客户端与文档零漂移：** 请求/响应 Schema、SSE 帧格式、错误码与 `GET /v1/openapi.json` 全部派生自同一套 Effect Schema 定义。
- **不向调用方泄漏 Harness 类型：** 切换模型、数据库或 Harness 不会改变任何调用方代码。
- **端到端可靠性：** 幂等键、断点续传游标（`after` / `Last-Event-ID`）、显式终态与单次调用 `POST /v1/invoke` 均是契约的一等公民。

完整规范见 [Agent API](agent-api.md)。

## 2. 统一服务层与双 Harness

FastAgent 将全部平台能力集中在统一服务层，仅把 Agent 执行循环、事件日志存储与可选 OS 沙箱委托给所选 Harness。因此你在项目中配置的一切在 `pi-durable` 与 `dsh` 上行为完全一致：

| 能力 | 统一服务层 | Harness 专属 |
| --- | --- | --- |
| 提示词、技能、模板、`fastagent.config.ts`、`fastagent build` | ✓ | — |
| 可移植工具（`defineTool`）、`needs()` 密钥、MCP 服务器 | ✓ | — |
| `pi-ai` 模型提供商与分层/持久化凭证（`/v1/auth/*`） | ✓ | — |
| 调用方命名对话映射（`POST /v1/invoke`） | ✓ | — |
| HTTP 服务器（`/health`、`/v1/*`）与 OpenTelemetry OTLP 追踪 | ✓ | — |
| Agent 执行循环与会话/消息事件日志 | — | `pi-durable` 或 `dsh` |
| `src/extensions/`（`defineExtension`） | — | 仅 `pi-durable`（在 `dsh` 上跳过并告警） |
| 内核级 OS 沙箱（`workspace`、`read-only`、`off`） | — | `@fastagent-sh/harness-dsh` |

由于 `pi-durable` 与 `dsh` 使用各自独立的表命名空间保存会话事件日志，同时共享持久化凭证和命名对话映射，你可以在同一份存储上测试或切换 Harness 而不会破坏已有会话。

## 3. 持久化、单写者租约隔离与崩溃恢复

每条已接收的消息在向调用方返回确认前均已落盘。如果进程崩溃、重启，或被空闲休眠平台回收，下一个启动的进程会自动恢复未完成的消息（被中断的工具调用会如实上报，除非明确安全，否则不会盲目重放）。

为防止脑裂执行（两个进程同时恢复同一个会话），**同一时刻只有一个进程拥有一个实例的存储写权限**：

- **本地 SQLite（默认）：** 实例数据存放在 `<root>/.state/`（`agent.sqlite`、`credentials.sqlite`、`conversations.sqlite`）。`agent.sqlite` 以 WAL + `EXCLUSIVE` 锁模式打开；第二个打开者会短暂等待优雅重启，超时则显式失败。
- **共享 PostgreSQL 与 Aurora DSQL：** 配置 `FASTAGENT_DATABASE_URL` 或 `openAgent({ database })` 后，所有表按实例 `name` 分区（必填，无默认值）。活跃写进程持有带过期时间的租约并在提交时写入隔离令牌（fencing token）；若进程卡顿丢失租约，后续提交会被隔离拒绝，并在接替进程接管前干净关闭（`agent.closed` 触发）。
- **多实例共享连接池：** 单进程托管大量实例时，用 `openPostgresDatabase()` 打开一个连接池并传给每个 `openAgent()`。Schema 迁移仅执行一次，关闭单个实例只释放该实例租约，不会关闭共享连接池。
- **Amazon Aurora DSQL（`@fastagent-sh/agentcore`）：** `dsqlDatabase({ endpoint })` 负责按连接签发 IAM Token、对超过 DSQL 1 MiB 值上限的数据自动分片、强制事务体积上限（单消息最大 6.4 MiB），并在不依赖 advisory lock、序列或临时表的前提下异步创建索引。

## 4. 安全与隔离边界

FastAgent 在四个独立边界隔离不可信输入、密钥与运行时状态：

1. **制品与运行环境分离：** 编译产物（`dist/`）与容器镜像只包含 Agent 定义，绝不包含 `~/.pi/agent`、`.secrets/`、`.env*` 或 `.state/`。`needs()` 声明的必填密钥在打开时校验；`fastagent deploy check` 与 AgentCore CDK 合成阶段会自动拦截任何本地密钥或状态泄漏。
2. **受控的子进程环境：** `bash` 命令、技能脚本与 stdio MCP 服务器绝不继承宿主机的原始 `process.env`，仅接收显式的基础环境（`baseEnv(process.env)` 或 `openAgent({ env })`）、Agent 自身的 `node_modules/.bin` 路径以及声明的密钥。
3. **可配置的工具与 OS 隔离：**
   - **实例级信任域：** 一个 `FASTAGENT_API_KEY` 控制整个实例。在 `pi-durable` 上启用编码工具（`read`、`write`、`edit`、`bash`）时，请将互不可见的用户隔离到独立实例（独立容器或 AgentCore MicroVM）。
   - **内核级 OS 沙箱（`harness: "dsh"`）：** 文件系统工具基于规范化 `realpath` 限制在实例工作目录内（或只读），`bash` 运行在内核沙箱内（macOS `sandbox-exec`、Linux `bwrap`/`Landlock`、Windows 受限令牌），若系统无法提供沙箱则直接拒绝启动（fail closed）。
   - **纯工具多租户嵌入：** 在 `fastagent.config.ts` 中设置 `codingTools: false`，编写不访问共享文件/存储的自定义工具，并在业务后端路由中校验每个用户的会话归属权。
4. **精确的空闲休眠探活（`agent.busy()`）：** 每个实例实时追踪自身未结束的消息轮次与活跃远程认证流程，使托管平台（如 AgentCore 的 `HealthyBusy` 探针）在活跃时保持存活、在空闲时安全休眠。

## 5. 可插拔远程传输协议

CLI（`--remote`）与 `@fastagent-sh/pi-remote` 共享同一份远程配置（`~/.config/fastagent/remotes.json`）。标准 HTTP 远程通过 `@fastagent-sh/client` 连接；云专属远程（`type: "<name>"`）动态加载 `@fastagent-sh/client-<name>`——例如安装 `@fastagent-sh/client-agentcore` 即可同时为 CLI 和 Pi 启用 `type: "agentcore"`，且核心包零 AWS SDK 依赖。

## 6. 零内容泄漏的可观测性

配置 `OTEL_EXPORTER_OTLP_ENDPOINT` 或 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` 后，两种 Harness 均通过 OTLP/HTTP JSON 导出 OpenTelemetry 追踪：
- 记录消息受理、执行轮次、工具调用与模型调用，附带 Token 用量、成本、OpenTelemetry GenAI 属性（`gen_ai.*`）。
- 跨进程重启透传 W3C `traceparent`，确保恢复后的工作仍挂在同一条 Trace 下。
- 绝不在追踪 Span 中记录提示词正文、模型回复或工具参数。
- 收集端不可达时仅打印警告并丢弃批次，绝不拖慢或中断 Agent 执行。

## 7. 包清单与依赖边界

FastAgent 以 6 个版本号锁定的 npm 包发布，按角色按需安装：

| 包 | 何时安装 | 依赖体量 |
| --- | --- | --- |
| [`@fastagent-sh/fastagent`](api-reference.md) | 编写、运行（`dev`/`start`/`invoke`）、打包（`build`）或在 Node 中嵌入 Agent | 核心运行时（`pi-durable`）、CLI、HTTP 服务；零 `@deepseek-ai/*` 或云 SDK |
| [`@fastagent-sh/client`](api-reference.md) | 从 Node、Bun、Deno 或边缘函数调用 HTTP FastAgent 服务 | 仅依赖 `effect`；零 Node API、零运行时或云依赖 |
| [`@fastagent-sh/client-agentcore`](api-reference.md) | 从后端、CLI `--remote` 或 Pi 调用 AgentCore 部署实例 | `@fastagent-sh/client` + `@aws-sdk/client-bedrock-agentcore`；零服务端、DB 或 CDK 依赖 |
| [`@fastagent-sh/agentcore`](api-reference.md) | 在 Amazon Bedrock AgentCore + Aurora DSQL 上部署运行 Agent | 服务端运行时、DSQL 适配器、Secrets Manager、CLI 扩展、可选 CDK 构造 |
| [`@fastagent-sh/harness-dsh`](api-reference.md) | 启用内核级 OS 沙箱（`--harness dsh`） | `@deepseek-ai/dsh` 适配器；由 `@fastagent-sh/fastagent` 懒加载 |
| [`@fastagent-sh/pi-remote`](api-reference.md) | 在 Pi TUI（`/fa`）中交互式接入已部署的 HTTP 或 AgentCore 实例 | `@fastagent-sh/client`；宿主 Pi 包保持为可选 peer 依赖 |

### 运行时兼容矩阵

| 包分层 | 包含包 | 编译目标 | 运行时基线 | 说明 |
| --- | --- | --- | --- | --- |
| **客户端 SDK** | `@fastagent-sh/client`、`@fastagent-sh/client-agentcore` | ES2024 ESM | Node 22+、Web Baseline 浏览器、Cloudflare Workers、Vercel Edge、Bun | 不锁定 `engines`，零 Node API 依赖；公开入口返回标准 `Promise` / `AsyncIterable`。 |
| **服务端运行时与 CLI** | `@fastagent-sh/fastagent`、`@fastagent-sh/agentcore`、`@fastagent-sh/harness-dsh`、`@fastagent-sh/pi-remote` | ES2025 ESM | Node ≥ 24.15.0（推荐 Node 26 Active LTS）或 Bun ≥ 1.4.0 | 两个基线均原生提供 `node:sqlite`，无需编译原生 C++ 插件（Node `24.15.0` 起移除 `ExperimentalWarning`；Bun 自 `1.4.0` 起内置 `node:sqlite`）。 |
