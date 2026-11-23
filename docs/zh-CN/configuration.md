---
title: 配置指南
description: "配置 Agent 的模型、自定义提供商、工具、OS 沙箱、密钥、HTTP API、SQLite 或 PostgreSQL 存储以及 OpenTelemetry 链路追踪。"
status: current
---

# 配置指南

FastAgent 将随代码提交的 Agent 定义（`fastagent.config.ts`、提示词、技能、工具）与按环境注入的配置和密钥（环境变量、`.secrets/` 或 `openAgent` 参数）严格分离。

| 你想配置什么 | 存放位置 |
| --- | --- |
| 提示词、运行规范、技能、提示词模板 | `SYSTEM.md`、`AGENTS.md`、`skills/`、`prompts/` |
| 自定义 TypeScript 工具与扩展 | `src/tools/`、`src/extensions/` |
| 默认模型、Harness、OS 沙箱、编码工具、自定义 Provider、MCP 服务器 | `fastagent.config.ts` |
| 按环境覆盖项（端口、存储、模型、Harness、API Key） | CLI 参数与 `FASTAGENT_*` 环境变量 |
| 提供商登录凭证与密钥 | `.secrets/.env`、`.secrets/auth.json`、环境变量或远程 `fastagent login --remote` |

## Agent 默认配置（`fastagent.config.ts`）

提交到 Git 并在所有环境共享。切勿在此硬编码密钥——请使用 [`needs()`](#在代码中声明密钥)。

```ts
import { defineAgent } from "@fastagent-sh/fastagent";

export default defineAgent({
  model: "openai/gpt-5.5",
  thinkingLevel: "high",
  harness: "pi-durable",
  codingTools: true,
  starters: ["Summarize today's issues"],
});
```

所有字段均为可选；未知字段会在启动时立即报错。

| 字段 | 默认值 | 控制内容 |
| --- | --- | --- |
| `model` | 无 | 默认 `provider/modelId`（见[模型选择](#模型选择)） |
| `thinkingLevel` | Harness 默认 | 推理强度：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` |
| `harness` | `"pi-durable"` | 运行时 Harness：`"pi-durable"` 或 `"dsh"`（实验性；需安装 `@fastagent-sh/harness-dsh`） |
| `sandbox` | `"workspace"`（`dsh` 下） | `harness: "dsh"` 时的 OS 沙箱模式：`"workspace"`、`"read-only"` 或 `"off"` |
| `codingTools` | `true` | 内置 `read`、`write`、`edit`、`bash`：`true`、`false` 或显式子集如 `["read"]` |
| `starters` | 无 | 最多 6 条示例开场白，通过 `info().starters` 暴露给客户端 |
| `providers` | `[]` | 自定义模型提供商或网关（`createProvider`，可用 `needs()` 包裹密钥） |
| `mcpServers` | 无 | Agent 可用的 [MCP 工具服务器](mcp.md) |

Agent 的 `name` 和 `description` 读取自 `package.json`。

## 模型选择

优先级（从高到低）：

```text
--model > FASTAGENT_MODEL > fastagent.config.ts 中的 model
```

运行 `fastagent models [search]` 列出所有内置与自定义的 `provider/modelId`。未设置模型时，交互式 CLI 会引导你选择模型并登录；非交互模式会直接失败并报 `missing model`。

所选模型不存在时，CLI 会在启动时立即停止。在嵌入式应用中，若配置文件里的默认模型被上游下线或改名，`openAgent()` 仍可正常打开（通过 `info().unusableDefault` 说明原因，并拒绝未显式指定模型的消息），而通过 `openAgent({ model })` 传入无效覆盖值则会立即报错。

### 自定义模型与自托管网关

使用 `@earendil-works/pi-ai` 的 `createProvider` 接入自托管端点（vLLM、Ollama）或内部网关，并用 `needs()` 包裹凭证：

```ts
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { defineAgent, needs } from "@fastagent-sh/fastagent";

const baseUrl = "http://vllm.internal:8000/v1";

export default defineAgent({
  model: "mygw/deepseek-v3",
  providers: [
    needs(["MYGW_API_KEY"], ({ MYGW_API_KEY }) =>
      createProvider({
        id: "mygw",
        name: "My gateway",
        baseUrl,
        auth: { apiKey: { name: "My gateway", resolve: async () => ({ auth: { apiKey: MYGW_API_KEY } }) } },
        models: [
          {
            id: "deepseek-v3",
            name: "DeepSeek V3",
            api: "openai-completions",
            provider: "mygw",
            baseUrl,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 65536,
            maxTokens: 8192,
          },
        ],
        api: openAICompletionsApi(),
      }),
    ),
  ],
});
```

声明与内置提供商相同 `id` 的 Provider 会覆盖内置定义。

## Harness 与沙箱选择

优先级（从高到低）：

```text
--harness > FASTAGENT_HARNESS > fastagent.config.ts 中的 harness > "pi-durable"
--sandbox > FASTAGENT_SANDBOX > fastagent.config.ts 中的 sandbox > "workspace"（在 "dsh" 下）
```

| 选项 | 适用场景 |
| --- | --- |
| **`pi-durable`（默认）** | 内置于 `@fastagent-sh/fastagent` 的标准生产选项；支持 `src/extensions/`。 |
| **`dsh` + `sandbox: "workspace"`** | 启用 `bash`/文件工具且希望通过内核沙箱（macOS `sandbox-exec`、Linux `bwrap`/`Landlock`、Windows 受限令牌）将读写限制在工作目录内。若系统无法提供沙箱则拒绝启动。 |
| **`dsh` + `sandbox: "read-only"`** | 允许检查工作区文件并运行只读命令，但严禁修改文件（`write` 和 `edit` 会被拒绝）。 |
| **`dsh` + `sandbox: "off"`** | 在已经高度隔离的容器内运行 `dsh`，不需要嵌套内核沙箱。 |

两种 Harness 共享同一个 SQLite 文件或 PostgreSQL 数据库，但各自使用互不冲突的表命名空间（`durable_*` 与 `dsh_*`），同时共享持久化凭证和命名对话映射。`SYSTEM.md`、`AGENTS.md`、`skills/`、`prompts/`、`src/tools/`（`defineTool`）与 `mcpServers` 在两者上完全一致；`src/extensions/` 仅适用于 `pi-durable`，在 `dsh` 上会被跳过并打印警告。

## 提示词、技能与模板

- **`SYSTEM.md`：** 每条消息都会重新读取。FastAgent 会自动附加 `AGENTS.md`（若存在）、`skills/` 的技能元数据、工作区指引（当启用 `codingTools` 时）以及部署说明（在容器部署模式下）。绝不读取本机 `~/.pi/agent` 中的文件。
- **`skills/<name>/SKILL.md`：** 自动发现并列在系统提示词中，可通过 `/skill:<name>` 直接调用。
- **`prompts/<name>.md`：** 当消息以 `/<name>` 开头时自动展开的提示词模板。

## 工具与扩展（`src/`）

放在 `src/tools/` 或 `src/extensions/` 下的每个文件都会按默认导出自动加载，无需手动注册。测试文件（`*.test.*`）会被自动忽略；共享辅助模块请放在 `src/` 之外（如 `lib/`）。将文件重命名为 `<name>.ts.disabled` 可临时禁用。

| 目录 | 默认导出 | 支持的 Harness |
| --- | --- | --- |
| `src/tools/` | `@fastagent-sh/fastagent`（或 `@earendil-works/pi-durable`）的 `defineTool(...)`，可选用 `needs()` 包裹 | `pi-durable` 与 `dsh` |
| `src/extensions/` | `@earendil-works/pi-durable` 的 `defineExtension(...)`，可选用 `needs()` 包裹 | 仅 `pi-durable`（`dsh` 跳过并告警） |

- **灵活的参数 Schema：** `defineTool` 支持 Standard JSON Schema v1（Zod v4、Valibot、ArkType、Effect `Schema.toStandardJSONSchemaV1`）、原生 JSON Schema 对象（带 `as const` 自动类型推导）或 `@earendil-works/pi-schema`。
- **简洁的返回值：** `execute` 可直接返回纯字符串 `string`，或返回完整的 `ToolExecutionResult`（`{ output, details?, isError? }`）。
- **查询当前会话 ID：** 调用 `@fastagent-sh/fastagent` 导出的 `await sessionIdOf(api, context)`，在两种 Harness 上均可获取当前 Agent API 会话 ID。
- **内置编码工具：** 默认启用 `read`、`write`、`edit` 和 `bash`。纯工具模式或多租户嵌入场景请设 `codingTools: false`（同时会从系统提示词中移除文件系统指引），或传入子集如 `codingTools: ["read"]`。即使禁用 `read`，技能仍可通过 `/skill:<name>` 正常访问。

## 认证与密钥

模型提供商凭证按以下优先级解析：

1. **实例持久化凭证** —— 通过远程 `fastagent login --url` / `--remote` 或 `/v1/auth/*` 保存在 `<root>/.state/credentials.sqlite` 或 PostgreSQL 中。
2. **项目认证文件** —— `.secrets/auth.json`（由本地 `fastagent login` 写入）。
3. **提供商环境变量** —— 来自环境或 `.secrets/.env`（`--env-file`）的 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`AWS_BEARER_TOKEN_BEDROCK` 等。
4. **全局认证文件** —— `~/.fastagent/.secrets/auth.json`（由 `fastagent login -g` 或在 Agent 目录外执行 `fastagent login` 写入）。

容器与嵌入式应用（`openAgent`）绝不读取本机 `.secrets/` 或 `~/.fastagent`：请通过宿主机环境变量、`openAgent({ secrets })` 或远程 `fastagent login --remote` 显式提供密钥。

### 在代码中声明密钥

将任何需要读取密钥或环境配置的工具、扩展或 Provider 用 `needs()` 包裹：

```ts
import { z } from "zod"; // 或原生 JSON Schema (`as const`)，或 @earendil-works/pi-schema
import { defineTool, needs } from "@fastagent-sh/fastagent";

export default needs(
  ["WEATHER_API_KEY", { name: "WEATHER_UNITS", description: "metric or imperial", optional: true }],
  ({ WEATHER_API_KEY, WEATHER_UNITS }) =>
    defineTool({
      name: "weather",
      description: "Get current weather for a city.",
      parameters: z.object({ city: z.string() }),
      execute: async ({ city }) => await lookupWeather(city, WEATHER_API_KEY, WEATHER_UNITS ?? "metric"),
    }),
);
```

缺少必填密钥时会在启动阶段立即失败并指明声明文件。运行 `fastagent info` 可列出 Agent 所需的全部密钥。

## HTTP 服务与 API Key

```text
port   dev:   --port > 8787              start: --port > PORT > 8787
bind   dev:   --bind > 127.0.0.1         start: --bind > 0.0.0.0 (all interfaces)
```

`--bind` 接受 IP 字面量或 `localhost`。每个运行中的服务都会响应 `GET /health`（就绪时返回 `200 {"status": "ok"}`，运行时关闭后返回 `503 {"status": "unavailable"}`）。

设置 `FASTAGENT_API_KEY`（本地放在 `.secrets/.env`，生产通过宿主机密钥注入）即可在 `/v1` 下开启 [Agent API](agent-api.md#http-绑定)（`Authorization: Bearer <key>`）。使用逗号分隔多密钥（`FASTAGENT_API_KEY=new,old`）可零停机轮换。

```bash
FASTAGENT_API_KEY=$(openssl rand -hex 32)
```

## 存储：SQLite 与 PostgreSQL

### 本地 SQLite（默认）

默认情况下，每个实例将状态保存在 `<root>/.state/`（`agent.sqlite`、`credentials.sqlite`、`conversations.sqlite`）：

| 参数 | 环境变量 | 默认值 |
| --- | --- | --- |
| `--root <dir>` | `FASTAGENT_ROOT` | `.fastagent/dev`（`start`：`.fastagent/start`；容器：`/data`） |
| `--name <name>` | `FASTAGENT_NAME` | 包名（使用 PostgreSQL 时必须显式指定，无默认值） |
| `--env-file <file>` | — | `.secrets/.env` |

`dev` 与 `start` 使用各自独立的本地实例目录（`.fastagent/dev/` vs `.fastagent/start/`），测试生产构建不会影响开发会话。

### 使用 PostgreSQL 存储会话

设置 `FASTAGENT_DATABASE_URL`（或向 `openAgent` 传入 `database`），即可将会话、持久化凭证与命名对话映射存入 PostgreSQL：

```bash
FASTAGENT_DATABASE_URL='postgres://user:password@host:5432/agents?sslmode=require' \
FASTAGENT_NAME=copilot \
fastagent start
```

- **必须显式指定名称：** 多个实例可共享同一 PostgreSQL 数据库，通过 `FASTAGENT_NAME`（`--name` 或 `openAgent({ name })`）分区隔离；缺少名称将返回退出码 `2`。
- **归属权绑定：** 首个打开某名称的 Agent 包拥有该名称；其他 Agent 包打开同名实例会被拒绝。
- **环境隔离：** 开发与生产环境请使用独立数据库。
- **单写者租约隔离：** 跨主机同一时刻仅允许一个进程拥有实例写权限。第二个打开者最多等待 35s 后报错（指明当前持有者）；崩溃进程会在 30s 内释放租约。
- **自动建表：** 首次打开自动创建所需表结构（需要 `CREATE TABLE` 权限）。
- **共享连接池与 Aurora DSQL：** 多实例宿主用 `openPostgresDatabase()` 封装共享连接池（见[嵌入应用](embedding.md#1-打开-agent)）；AWS 部署使用 `@fastagent-sh/agentcore` 的 `dsqlDatabase({ endpoint })`（见 [AWS AgentCore](agentcore.md)）。

## 日志与 OpenTelemetry 链路追踪

通过 `FASTAGENT_LOG_LEVEL` 设置日志级别：`debug`、`info`、`warn` 或 `error`（默认：`dev` 为 `debug`，`start` 为 `info`）。

配置 `OTEL_EXPORTER_OTLP_ENDPOINT`（或 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`）即可为 `pi-durable` 和 `dsh` 导出 OTLP/HTTP JSON 追踪。追踪记录消息受理、轮次、工具与模型调用，包含 Token 用量、成本、OpenTelemetry GenAI 属性（`gen_ai.*`）与 W3C `traceparent` 透传——绝不导出提示词正文、回复内容或工具参数。

| 环境变量 | 用途 |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Collector 基础地址（导出至 `<base>/v1/traces`） |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | 显式完整 traces 端点（覆盖基础地址） |
| `OTEL_EXPORTER_OTLP_HEADERS` / `OTEL_EXPORTER_OTLP_TRACES_HEADERS` | `key=value,...` 请求头（值需 URL 编码） |
| `OTEL_EXPORTER_OTLP_PROTOCOL` / `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` | 若设置必须为 `http/json`（默认） |
| `OTEL_SERVICE_NAME` | `service.name` 资源属性（默认为实例名） |
| `OTEL_RESOURCE_ATTRIBUTES` | 额外的 `key=value,...` 资源属性 |
| `OTEL_SDK_DISABLED=true` | 禁用追踪导出 |

CLI 命令从环境或 `.secrets/.env` 读取 `OTEL_*`；`openAgent()` 从 `options.secrets` 读取（防止 Agent 子进程读到收集端凭证）。Collector 故障不会阻塞 Agent 执行，丢弃批次时仅输出警告。

## 环境变量速查表

| 变量 | 作用范围 | 用途 |
| --- | --- | --- |
| `FASTAGENT_MODEL` | 运行时 / CLI | 覆盖默认 `provider/modelId` |
| `FASTAGENT_HARNESS` | 运行时 / CLI | 覆盖 Harness（`pi-durable` 或 `dsh`） |
| `FASTAGENT_SANDBOX` | 运行时 / CLI | 覆盖 DSH OS 沙箱模式（`workspace`、`read-only`、`off`） |
| `FASTAGENT_API_KEY` | 服务端 / CLI | 逗号分隔的 Bearer 密钥，用于启用 `/v1` HTTP 路由（同时作为 `--url` 默认密钥） |
| `FASTAGENT_ROOT` | 运行时 / CLI | 实例根目录（工作目录 + `.state/`） |
| `FASTAGENT_NAME` | 运行时 / CLI | 实例名称（PostgreSQL 与容器部署必填） |
| `FASTAGENT_DATABASE_URL` | 运行时 / CLI | 用于会话、凭证与命名对话的 PostgreSQL 连接串 |
| `FASTAGENT_LOG_LEVEL` | 运行时 / CLI | 日志级别（`debug`、`info`、`warn`、`error`） |
| `FASTAGENT_REMOTES_PATH` | CLI / `pi-remote` | 覆盖 `remotes.json` 路径（默认 `~/.config/fastagent/remotes.json`） |
| `FASTAGENT_DEPLOYED` | 容器 | 由生成的 `Dockerfile` 设为 `1`，强制启用挂载存储与部署检查 |
| `FASTAGENT_AGENTCORE_ARN` | AgentCore CLI | `fastagent agentcore invoke` 的默认 Runtime ARN |
| `FASTAGENT_DSQL_ENDPOINT` | AgentCore 服务端 | Aurora DSQL 集群端点 |
| `FASTAGENT_SECRETS` | AgentCore 服务端 | 存放 JSON 密钥值的 AWS Secrets Manager 密钥名称 |
