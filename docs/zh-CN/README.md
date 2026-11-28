---
title: 中文文档
description: "FastAgent 中文文档：产品概览、技术架构、打包与 CI/CD、配置指南、远程运维、嵌入应用、部署与 API 参考。"
status: current
---

# FastAgent 中文文档

[English](../README.md) · **简体中文**

FastAgent 是面向生产级 AI Agent 的开源 TypeScript & Node.js 运行时。用 Markdown（`SYSTEM.md`、`AGENTS.md`、`skills/`）、强类型 TypeScript 工具与 MCP 编写 Agent——打包为版本化 npm 制品、直接嵌入你的应用、使用 Docker 自托管，或部署到 Fly.io、Railway 与 AWS AgentCore。

## 从这里开始

| 目标 | 指南 |
| --- | --- |
| 了解 FastAgent 的定位、解决的问题与边界 | [产品概览](overview.md) |
| 5 分钟搭建并运行你的第一个 Agent | [快速上手](quickstart.md) |
| 浏览生产级示例（`pr-review-agent`、`incident-triage-agent`、`saas-copilot`、`agentcore-per-user`、`deep-research-agent`） | [示例项目](../../examples/README.md) |
| 将 Agent 打包为版本化 npm 制品并在 CI 中设置门禁 | [打包、分发与 CI/CD](packaging-and-ci.md) |
| 端到端构建与验证流程（适合人类开发者与 Coding Agent） | [Agent 开发指南](ai-start.md) |

## 架构与契约

| 目标 | 指南 |
| --- | --- |
| 理解系统分层、包边界、双 Harness、存储隔离与安全机制 | [技术架构](architecture.md) |
| 查阅会话、消息、`POST /v1/invoke`、流式输出、远程认证与错误契约 | [Agent API](agent-api.md) |

## 构建与配置

| 目标 | 指南 |
| --- | --- |
| 配置模型、Harness、OS 沙箱、工具、密钥、存储与链路追踪 | [配置指南](configuration.md) |
| 接入本地 stdio 与远程 Streamable HTTP MCP 工具服务器 | [MCP 服务器](mcp.md) |

## 连接与运维

| 目标 | 指南 |
| --- | --- |
| 管理远程端点、调用线上部署、远程登录以及使用 `@fastagent-sh/pi-remote` | [远程实例与客户端](remotes.md) |
| 查询全部 `fastagent` 命令、参数与退出码 | [CLI 参考](cli.md) |

## 嵌入与部署

| 目标 | 指南 |
| --- | --- |
| 将 Agent 嵌入现有 Node 或 Bun 后端 | [嵌入应用](embedding.md) |
| 部署到 Docker、Compose、Fly.io、Railway 或任意容器宿主机 | [部署指南](deploy.md) |
| 在 Amazon Bedrock AgentCore + Aurora DSQL 上运行每用户隔离 MicroVM | [AWS AgentCore](agentcore.md) |

## 参考与排错

| 目标 | 指南 |
| --- | --- |
| 查看公开 npm 包与 TypeScript 导出入口 | [API 参考](api-reference.md) |
| 排查安装、Harness、远程连接、认证与部署中的常见问题 | [故障排查](troubleshooting.md) |
