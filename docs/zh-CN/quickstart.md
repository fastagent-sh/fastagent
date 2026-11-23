---
title: 快速上手
description: "5 分钟从零创建一个带强类型 TypeScript 工具、可持久化运行的 FastAgent 服务。"
status: current
---

# 快速上手

在 5 分钟内，你将完成创建 Agent、添加强类型 TypeScript 工具、本地热重载运行，以及以生产模式通过 Agent API 对外提供服务。

**前提条件：** Node ≥ 24.15。

```bash
npm i -g @fastagent-sh/fastagent
```

> 在 Agent 目录内，全局 `fastagent` 命令会自动委托给该项目安装的本地版本。不想全局安装？可以使用 `npx @fastagent-sh/fastagent <command>`（切勿使用 `npx fastagent`，那是另一个无关的包）或项目里的 `npm run dev` / `build` / `start` 脚本。

## 1. 创建或初始化你的 Agent

```bash
fastagent init my-agent          # 创建全新 Agent 目录
cd my-agent
```

如果当前目录已有 `SYSTEM.md` 或 `skills/`，或在现有应用仓库里新增一个 Agent：

```bash
fastagent init                   # 初始化或断点续跑当前目录（保留已有文件）
fastagent init agents/support    # 在现有应用的子目录中创建 Agent
```

对于全新目录，`init` 会初始化独立 Git 仓库并生成初始提示词（`SYSTEM.md`）、示例技能（`skills/writing-great-skills/`）、配置文件（`fastagent.config.ts`）、`package.json` 以及 `.gitignore`（确保 `.secrets/` 和 `.fastagent/` 不会进入版本控制）。对于已有 Agent 目录，它会保留你的原有文件、仅补齐缺失配置并检查依赖——可先运行 `fastagent info --json` 确认已有技能已被识别。

## 2. 发送第一条消息

```bash
fastagent invoke "Summarize SYSTEM.md in one sentence"
```

首次在终端运行时，FastAgent 会引导你选择模型并完成登录认证，随后打印可直接写入 `fastagent.config.ts` 的 `model` 配置行。在非交互环境下运行？传入 `--model provider/model-id` 即可。使用 `fastagent models` 可浏览可用模型列表。

## 3. 添加一个强类型 TypeScript 工具

新建 `src/tools/reverse.ts`。FastAgent 会自动加载 `src/tools/` 下的所有文件，无需手动注册。`defineTool` 在 `pi-durable` 与 `dsh` 两种 Harness 上表现完全一致，支持原生 JSON Schema（`as const`）、Zod v4（或任意 Standard JSON Schema v1 库）以及 `pi-schema`：

```ts
// src/tools/reverse.ts
import { defineTool } from "@fastagent-sh/fastagent";

export default defineTool({
  name: "reverse",
  description: "Reverse a string.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to reverse" },
    },
    required: ["text"],
  } as const,
  execute: async ({ text }) => [...text].reverse().join(""),
});
```

立刻测试调用：

```bash
fastagent invoke "Reverse the word hello with the reverse tool"
```

记得在 `SYSTEM.md` 中提及你的自定义工具，让模型明确何时调用它。如果工具需要 API Key 或配置值，请使用 [`needs()`](configuration.md#在代码中声明密钥) 声明。

## 4. 本地热重载运行

```bash
fastagent dev
```

`dev` 会在 `http://127.0.0.1:8787` 启动本地服务：
- 修改 `SYSTEM.md`、`AGENTS.md`、`skills/` 和 `prompts/` 会在下一条消息立即生效，无需重启。
- 修改 `src/`、`fastagent.config.ts`、`package.json` 或 `.secrets/.env` 会在当前活跃轮次结束后优雅重启。
- 对话历史在每次重启后均完整保留。

在第二个终端中执行 `fastagent invoke` 时，它会自动连接到正在运行的 `dev` 服务并共享同一份会话。如果在 `.secrets/.env` 中配置了 `FASTAGENT_API_KEY`，还可以直接通过 HTTP 调用（`POST /v1/invoke`、`/v1/sessions` 或使用 `@fastagent-sh/client` 的 `connectAgent()`）。

## 5. 编译并以生产模式运行

```bash
fastagent build
fastagent start
```

`fastagent build` 会执行类型检查并将 Agent 编译打包至 `dist/`。`fastagent start` 以生产姿态运行编译产物（关闭文件监听，输出结构化 `info` 日志）。

需要为内置编码工具（`read`、`write`、`edit`、`bash`）启用内核级 OS 沙箱？安装 `@fastagent-sh/harness-dsh` 并通过 `--harness dsh` 启动：

```bash
npm i @fastagent-sh/harness-dsh
fastagent dev --harness dsh
```

## 下一步

- **按步骤构建真实生产 Agent（或交给 Coding Agent 搭建）：** [Agent 开发指南](ai-start.md)
- **打包为 npm 制品并接入 CI/CD：** [打包、分发与 CI/CD](packaging-and-ci.md)
- **深入了解底层原理：** [技术架构](architecture.md)
- **从代码或 HTTP 调用：** [Agent API](agent-api.md) · [嵌入应用](embedding.md)
- **发布上线：** [部署指南](deploy.md) · [AWS AgentCore](agentcore.md)
- **运维线上实例与终端交互：** [远程实例与客户端](remotes.md)
