---
title: API 参考
description: "按角色选择安装的 FastAgent npm 包、公开 TypeScript 导出入口以及对应完整指南索引。"
status: current
---

# API 参考

FastAgent 发布 3 个版本号同步锁定的 npm 包，你可以按角色只安装所需部分。每个包均包含完整 TypeScript 类型声明（`dist/*.d.ts`）以支持编辑器内联文档提示。

## 编写、打包或嵌入 Agent

| 包名 | 何时安装 | 核心导出 |
| --- | --- | --- |
| **`@fastagent-sh/fastagent`** | 编写 Agent、打包制品、运行 CLI 或在 Node/Bun 后端中嵌入 | `defineAgent`、`defineTool`、`needs`、`sessionIdOf`、`openAgent`、`openPostgresDatabase`、`baseEnv`、`AgentError`、`LIMITS`、`hasEnded`、`McpError`，以及全部核心 Agent API 类型（`Agent`、`LocalAgent`、`RemoteAgent`、`Session`、`Message`、`Entry`、`InvokeRequest` 等） |
| **`@fastagent-sh/harness-dsh`** | 启用内核级 OS 沙箱（`--harness dsh`，实验性；由 `@fastagent-sh/fastagent` 懒加载） | `openDshAgent`、`MemoryDshEventStore`、`openSqliteDshStore` |

## 调用或运维已部署的 Agent

| 包名 / 子入口 | 何时安装 | 核心导出 |
| --- | --- | --- |
| **`@fastagent-sh/client`** | 从 Node、Bun、Deno、浏览器或边缘函数调用任意 HTTP FastAgent（零 Node 依赖） | `connectAgent`、`ConnectOptions`、`AgentError`、`LIMITS`、`hasEnded` 及全部核心 Agent API 类型 |
| **`@fastagent-sh/client/auth`** | 通过 HTTP 驱动远端 OAuth / API Key 登录（零 Node 依赖） | `connectAuth`、`ConnectOptions`、`AuthApi`、`AuthFlowState`、`AuthProviderStatus`、`StartAuthLoginRequest`、`AuthLoginInput` |

## 扩展 FastAgent（Harness 与协议作者）

| 入口路径 | 用途 | 核心导出 |
| --- | --- | --- |
| **`@fastagent-sh/fastagent/harness`** | 构建可插拔服务端运行时 Harness 适配器（`@fastagent-sh/harness-<name>/provider`） | `HarnessProvider`、`HarnessStorageOpenContext`、`HarnessAgentOpenContext`、`adaptToolRejectingPark`、`retainToolOutput`、`createEventChannel`、`classifyPiAiError`、`toPiThinkingLevel`、`migratePgSchema`、`acquirePgInstanceLease`、`InstanceHeld`、`isPgConflict` |
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
| 管理远程端点、远程登录与客户端 SDK | [远程实例与客户端](remotes.md) |
| 部署到 Docker、Compose、Fly.io、Railway 或任意容器宿主机 | [部署指南](deploy.md) |
| 理解系统架构与隔离边界 | [技术架构](architecture.md) |

FastAgent 处于 1.0 前阶段，[Agent API](agent-api.md) 是所有包共享的稳定契约中心。
