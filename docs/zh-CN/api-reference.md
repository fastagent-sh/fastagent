---
title: API 参考
description: "按角色选择安装的 FastAgent npm 包、公开 TypeScript 导出入口以及对应完整指南索引。"
status: current
---

# API 参考

FastAgent 发布 6 个版本号同步锁定的 npm 包，你可以按角色只安装所需部分。每个包均包含完整 TypeScript 类型声明（`dist/*.d.ts`）以支持编辑器内联文档提示。

## 编写、打包或嵌入 Agent

| 包名 | 何时安装 | 核心导出 |
| --- | --- | --- |
| **`@fastagent-sh/fastagent`** | 编写 Agent、打包制品、运行 CLI 或在 Node 中嵌入 | `defineAgent`、`defineTool`、`needs`、`sessionIdOf`、`openAgent`、`openPostgresDatabase`、`baseEnv`、`AgentError`、`LIMITS`、`hasEnded`、`McpError`，以及全部 Agent API 类型（`Agent`、`LocalAgent`、`RemoteAgent`、`Session`、`Message`、`Entry`、`InvokeRequest`、`AuthApi` 等） |
| **`@fastagent-sh/harness-dsh`** | 启用内核级 OS 沙箱（`--harness dsh`，实验性；由 `@fastagent-sh/fastagent` 懒加载） | `openDshAgent`、`MemoryDshEventStore`、`openSqliteDshStore` |

## 调用或运维已部署的 Agent

| 包名 | 何时安装 | 核心导出 |
| --- | --- | --- |
| **`@fastagent-sh/client`** | 从 Node、Bun、Deno 或边缘函数调用任意 HTTP FastAgent（零 Node 依赖） | `connectAgent`、`connectAuth`、`ConnectOptions`、`AgentError`、`LIMITS`、`hasEnded` 及全部 Agent API 类型 |
| **`@fastagent-sh/client-agentcore`** | 从后端、CLI `--remote` 或 Pi 调用 AWS AgentCore 实例（零服务端/DB/CDK 依赖） | `connectAgentCore`、`connectAgentCoreAuth`、`connectRemote`、`AgentCoreConnection`，并重新导出 `connectAgent`、`connectAuth`、`AgentError` 及 Agent API 类型 |
| **`@fastagent-sh/pi-remote`** | 在 Pi TUI（`/fa`）中与已部署的 HTTP 或 AgentCore 实例实时对话 | 默认导出 `fastAgentRemoteExtension` |

## 部署到 Amazon Bedrock AgentCore

| 包名 / 子入口 | 何时安装 | 核心导出 |
| --- | --- | --- |
| **`@fastagent-sh/agentcore`** | 运行 AgentCore 容器服务与 Aurora DSQL 适配器 | `serveAgentCore`、`AgentCoreOptions`、`dsqlDatabase`、`DsqlOptions` |
| **`@fastagent-sh/agentcore/cdk`** | 在 AWS CDK 栈中配置 Aurora DSQL 与 Secrets Manager 权限 | `FastAgentResources`、`FastAgentResourcesProps`、`AgentRuntime` |
| **`@fastagent-sh/agentcore/cli`** | 由 `fastagent agentcore ...` 自动调用 | `run`（`init`、`start`、`invoke`） |

## 扩展 FastAgent（平台与传输协议作者）

| 入口路径 | 用途 | 核心导出 |
| --- | --- | --- |
| **`@fastagent-sh/fastagent/platform`** | 构建自定义 `fastagent deploy init <target>` 与运行时 CLI 扩展 | `ExtensionCli`、`ContainerTarget`、`agentFacts`、`writeContainer`、`buildContextLeaks`、`loadAgentBuild`、`invokeOverApi`、`readInvokeMessage`、`modelRefOf`、`DATABASE_URL_ENV`、`Unavailable`、`PostgresDatabase`、`PostgresLimits`、`CreateIndex`、`PgExecutor` |
| **`@fastagent-sh/client/remotes`** | 构建可插拔 `remotes.json` 传输协议包（`@fastagent-sh/client-<type>`） | `RemotesFile`、`RemoteConfig`、`HttpRemoteConfig`、`ExtensionRemoteConfig`、`RemoteConnection`、`resolveRemotesPath`、`parseRemotesJson`、`upsertRemoteConfig`、`removeRemoteConfig`、`setDefaultRemoteConfig`、`expandRemoteEnvRef`、`connectExtensionRemote` |
| **`@fastagent-sh/client/agent-api`** | 直接校验或组合 Agent API 的 Effect Schema | 全部 Agent API 类型、事件、认证流程的 Effect Schema、`AgentError`、`LIMITS`、`hasEnded`、`decodeRequest` |
| **`@fastagent-sh/client/http/contract`** | 直接对接 HTTP 契约与 OpenAPI Schema | `AgentHttpApi`、`API_PREFIX`、`statusOf`、`Refusal`、`Authorization`、`Malformed`、`SessionEventFrame`、`MessageStreamEventFrame` |
| **`@fastagent-sh/client/stream`** | 在 `Agent` 实现之上组合 `messages.stream` | `messageStream`、`StreamSource`、`leavableIterator` |

## 按任务查阅指南

| 任务 | 指南 |
| --- | --- |
| 调用会话、消息、`POST /v1/invoke`、流式输出或远程认证 | [Agent API](agent-api.md) |
| 打包为版本化 npm 制品并在 CI 中设置门禁 | [打包、分发与 CI/CD](packaging-and-ci.md) |
| 配置模型、工具、`needs`、OS 沙箱、PostgreSQL 与追踪 | [配置指南](configuration.md) |
| 使用 `openAgent`、`openPostgresDatabase` 与 `service.fetch` 嵌入应用 | [嵌入应用](embedding.md) |
| 管理远程端点、远程登录与 `@fastagent-sh/pi-remote` | [远程实例与客户端](remotes.md) |
| 部署到 Docker、Compose、Fly.io、Railway 或 AWS AgentCore | [部署指南](deploy.md) · [AWS AgentCore](agentcore.md) |
| 理解系统架构与隔离边界 | [技术架构](architecture.md) |

FastAgent 处于 1.0 前阶段，[Agent API](agent-api.md) 是所有包共享的稳定契约中心。
