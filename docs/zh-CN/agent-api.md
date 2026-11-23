---
title: Agent API
description: "如何从任意应用、后端、定时任务或 CLI 调用 FastAgent 服务：单次 invoke、会话管理、流式输出、远程认证、错误处理与 HTTP 路由。"
status: current
---

# Agent API

无论 Agent 是嵌入在你的 Node 应用中（`openAgent`）、通过 HTTP 对外提供服务（`connectAgent`），还是运行在 Amazon Bedrock AgentCore 上（`connectAgentCore`），你对接的都是同一份契约：Agent API。

```ts
import { connectAgent } from "@fastagent-sh/client";

const agent = connectAgent("https://agent.example.com", {
  apiKey: process.env.AGENT_API_KEY!,
});
// 或者进程内嵌入：
// const agent = await openAgent(copilot, { root: "/var/lib/myapp/copilot" });

const reply = await agent.invoke(
  {
    conversation: "incident:inc-415",
    idempotencyKey: webhookEventId,
    content: "Triage the 503 spike on /api/checkout",
  },
  { wait: 120 },
);
console.log(reply.status, reply.answer?.text);
```

`@fastagent-sh/client` 与 `@fastagent-sh/fastagent` 内置完整 TypeScript 类型，每个运行中的 HTTP 实例还会在 `GET /v1/openapi.json` 自动暴露 OpenAPI 3.1 文档。

## 选择调用模式

| 使用场景 | 推荐调用方式 | 原因 |
| --- | --- | --- |
| **Webhook、定时任务、空闲休眠托管或无状态后端** | `agent.invoke` / `invokeStream`（`POST /v1/invoke`） | 单次请求自动创建或复用命名 `conversation`，最长等待 600s（或流式返回），并通过 `Idempotency-Key` 对重试去重。 |
| **带实时文本与工具进度的聊天界面** | `sessions.create` + `messages.stream`（或 `sessions.events`） | 实时推送正文/思考增量、工具开始与进度、重试通知与持久化条目；断连后通过 `after` 无缝续传。 |
| **异步 / 后台任务编排** | `messages.send`（不传 `wait`）+ `messages.get(..., { wait })` | 持久化落盘即返回；按 `messageId` 或 `idempotencyKey` 轮询或长轮询直到 `hasEnded(message)`。 |
| **为线上实例完成模型提供商登录** | `connectAuth`（`/v1/auth/*`）或 `fastagent login --remote` | 驱动交互式 OAuth 或 API Key 登录，并将凭证持久化保存在实例存储中。 |

## 可靠性保障

- **接收一次，收敛一次。** 消息在确认返回前即写入持久化存储，即使经历崩溃或重启也只会收敛到唯一终态。
- **安全重试。** 携带相同 `idempotencyKey` 重发会直接返回原消息，不会重复执行。
- **断线可恢复。** 响应中途网络断开时，可通过 `messages.get` 查询结果，或从最后一条持久化 `entry.id` 重新接上事件流。
- **跨 Harness 语义一致。** `pi-durable` 与 `@fastagent-sh/harness-dsh` 严格遵守完全相同的契约语义。

## 核心对象模型

| 对象 | 含义 |
| --- | --- |
| **Agent** | 一个运行中的实例（一个信任域）。`info()` 返回可用模型、工具、命令与示例开场白；`usage()` 返回累计用量。 |
| **Session** | 一段持久化对话，包含历史条目、`status`（`idle` / `running`）、`title`、时间戳、会话配置（`model`、`thinkingLevel`、`instructions`、`tools`）、当前 `contextUsage`、累计 `usage` 与实时活动状态（`reply`、`activeTools`、`queuedMessages`、`compacting`）。 |
| **Message** | 提交到会话的一条请求，追踪其 `status`、`entryId`、`answer`、`error`、`idempotencyKey` 与调用方 `metadata`。 |
| **Entry** | 会话历史中的一条不可变记录：`user`、`assistant`、`tool_result` 或 `compaction`。分叉会话共享分叉点之前的历史条目（保留原 ID）。 |

```text
session s1
├─ message m1 "Triage the 503 spike"   completed, answer = e4
│    e1 user · e2 assistant (tool call) · e3 tool_result · e4 assistant (answer)
├─ message m2 "Check deploy #842"      running
└─ message m3 "Draft status update"    queued, behind m2
```

> 监听 **session** 以观察对话中发生的一切；查询 **message** 以了解某一条具体请求的执行结果。

## 单次调用（`POST /v1/invoke`）

`invoke()` 与 `invokeStream()` 在一次往返内完成会话查找/创建与消息执行，非常适合 Webhook、外部调度器与空闲休眠容器：

- **调用方命名 `conversation`：** 传入如 `"daily-digest"` 或 `"slack:C123:456"`。FastAgent 会自动复用已映射会话，若不存在或已被删除则新建同名会话。
- **严格 `sessionId`：** 直接指向已有会话 ID（不存在则拒绝并返回 `not_found`），与 `conversation` 互斥。
- **临时会话：** 两者都不传时自动创建新会话；携带 `idempotencyKey` 重试会返回同一个临时会话与消息，不会重复创建。
- **会话配置：** 可选 `session`（`SessionSettings`）用于初始化新会话，或在显式传入时更新已有会话配置。
- **超长等待：** HTTP `POST /v1/invoke` 支持最高 `600` 秒的 `wait`（`LIMITS.invokeWaitSeconds`）或 `"stream": true`。

```ts
const msg = await agent.invoke(
  {
    conversation: "daily-digest",
    content: "/daily-digest",
    whenBusy: "reject",
  },
  { wait: 300 },
);
```

## 会话与消息操作

| 操作 | 用途 |
| --- | --- |
| `info()`、`usage()` | 查询能力清单（模型、工具、命令、starters）与累计模型/工具用量 |
| `sessions.create({ title?, model?, thinkingLevel?, instructions?, tools?, forkFrom? })` | 创建新会话，或从已有会话的 `forkFrom.entryId` 分叉 |
| `sessions.get`、`sessions.list` | 查询单个会话，或按最近活跃度分页列出（`limit`、`after`） |
| `sessions.update` | 更新标题或后续轮次配置；传入 `null` 恢复默认值 |
| `sessions.delete` | 中止活跃任务并永久删除会话 |
| `sessions.entries` | 分页读取历史条目（最新一页在前，配合 `prev` / `next`） |
| `sessions.events` | 历史回放 + 当前快照 + 实时事件流（见[流式输出与断线重连](#流式输出与断线重连)） |
| `sessions.cancel` | 停止活跃与排队中的任务；落盘后返回 `{ stopped: string[] }` |
| `sessions.compact` | 压缩较早的上下文（支持 `instructions?`），产生一条 `compaction` 条目 |
| `sessions.attachment` | 按条目中的图片 `ref` 下载二进制字节与 `mimeType` |
| `messages.send` | 提交消息；立即返回或最长等待 `wait` 秒 |
| `messages.stream` | 提交消息并流式接收该消息直至 `done` 的全部事件 |
| `messages.get` | 按 `{ sessionId, messageId }` 或 `{ sessionId, idempotencyKey }` 查询消息，支持 `wait` |

传入 `AbortSignal`（`signal`）仅停止客户端的等待或订阅，不会取消 Agent 的后台执行——只有 `sessions.cancel` 会停止任务。`wait` 是最长等待秒数，返回后务必检查 `message.status`（或 `hasEnded(message)`）。

### 发送选项与消息生命周期

- **内容（`content`）：** 传入字符串或非空的 `text` / base64 `image` 数组。以 `/<name>` 开头且匹配 `info().commands` 的消息会自动展开对应提示词模板或 `/skill:<name>`，同时在 `user` 条目中保留原始文本。
- **幂等键（`idempotencyKey`）：** 1–256 字符，会话内唯一。`connectAgent` 在未显式传入时会自动生成一个 UUID（仅覆盖单次调用内部重试；跨调用方重试请显式传入业务幂等键）。若返回 `unconfirmed`，请用同一 key 重试。
- **调用方元数据（`metadata`）：** 最多附加 16 个字符串键值对（键 1–64 字符，值 ≤ 512 字符）用于业务路由关联，在 `send`、`get` 和 `done` 中原样返回，绝不传给模型。
- **繁忙策略（`whenBusy`）：**
  - `"queue"`（默认）：排队等待当前轮次结束。
  - `"steer"`：在当前执行轮次的下一步实时注入纠偏。
  - `"reject"`：立即拒绝并返回 `AgentError("busy")`（`details.reason: "running"`）。

| 状态 | 终态？ | `answer` | 说明 |
| --- | --- | --- | --- |
| `queued` | 否 | — | 已接收，排队等待执行 |
| `running` | 否 | — | 正在执行 |
| `completed` | 是 | 最终 `assistant` 条目 | 正常回答完成 |
| `incomplete` | 是 | 部分 `assistant` 条目 | 触及模型输出 Token 上限 |
| `failed` | 是 | — | 执行失败；`message.error` 说明原因（`missing_model`、`auth_required`、`model_error`、`internal`） |
| `canceled` | 是 | — | 被 `sessions.cancel` 终止或从队列撤回 |

## 流式输出与断线重连

`sessions.events(sessionId, { after, signal })` 保证无缺口有序交付：

1. **回放（Replay）：** 按序推送 `after` 之后的持久化 `entry`（`after: "start"` 回放全部，省略则不回放）。
2. **快照（Snapshot）：** 推送一条包含当前完整 `Session` 的 `state` 事件（含正在生成的 `reply`、`activeTools`、`queuedMessages` 与 `compacting`）。
3. **实时流（Live）：** 紧接快照之后推送实时事件。上一条消息的 `done` 必然早于下一条消息的 `user` 条目到达。

| 事件类型 | 携带内容 |
| --- | --- |
| `entry` | 持久化 `Entry`（`tool_result` 可包含工具返回的可选 `details`） |
| `state` | 当前 `Session` 快照（初始快照 + 标题/配置变更） |
| `delta` | 实时文本片段（`channel: "text"` 为回答正文，`"thinking"` 为思考过程） |
| `tool_started` | 工具调用启动（`toolCallId`、`name`、`args`） |
| `tool_progress` | 工具进度状态行（`text`）与可选多行尾部输出（`output`） |
| `retrying` | 退避重试通知（`attempt`、`maxAttempts`、`delayMs`、`reason`） |
| `compaction_started`、`compaction_failed` | 上下文压缩触发原因（`manual` / `threshold` / `overflow`）或失败 `error` |
| `done` | 终态 `Message` |
| `stream_error` | 流传输中断（`error`）；底层消息任务仍在继续运行 |

断线重连时，只需将 `after` 设为最后收到的 `entry.id` 重新打开 `sessions.events`（HTTP 同时支持 `Last-Event-ID`）。由于 `delta` 仅实时推送，中途重连时先渲染 `state.session.reply`，再追加后续 `delta` 即可。

`messages.stream` 会先发出一条 `message` 受理回执，随后推送该消息直至 `done` 的全部事件。

## 远程提供商认证（`/v1/auth/*`）

HTTP 与 AgentCore 实例均暴露 Auth API（`@fastagent-sh/client` 的 `connectAuth`、`@fastagent-sh/client-agentcore` 的 `connectAgentCoreAuth` 或 `fastagent login --remote`），让运维人员无需把凭证打进镜像即可远程为线上实例完成 OAuth 或 API Key 登录，凭证持久化存储在实例存储中跨重启保留。

| 方法 | HTTP 路由 | 用途 |
| --- | --- | --- |
| `auth.providers()` | `GET /v1/auth/providers` | 列出模型提供商、支持的登录方式（`oauth`、`api_key`）与当前认证状态 |
| `auth.startLogin({ provider, method? })` | `POST /v1/auth/login` | 启动登录流程，返回 `AuthFlowState`（`authUrl`、`deviceCode`、`prompt`、`status`） |
| `auth.getLogin(flowId, { wait? })` | `GET /v1/auth/login/{flowId}?wait` | 读取或长轮询流程进度（`pending`、`awaiting_input`、`completed`、`failed`、`canceled`） |
| `auth.submitInput(flowId, { promptId, value })` | `POST /v1/auth/login/{flowId}/input` | 提交交互输入（回调 URL、授权码、API Key、选项） |
| `auth.cancelLogin(flowId)` | `DELETE /v1/auth/login/{flowId}` | 取消进行中的登录流程（`204`） |
| `auth.logout(provider)` | `DELETE /v1/auth/providers/{provider}` | 移除持久化存储中的凭证（`{ removed: boolean }`） |

## 错误处理

被拒绝的操作会抛出 `AgentError`（`{ code, message, retryable, details? }`）；执行失败的消息在 `message.error` 中携带相同结构的 `AgentErrorData`。

| 错误码 | 触发场景 | 可重试 | HTTP 状态码 |
| --- | --- | --- | --- |
| `invalid_request` | 参数格式错误或超出大小限制（`details.reason: "too_large"`） | 否 | 400、413 |
| `unauthorized` | 缺少或无效的 Bearer Key / AWS IAM 凭证 | 否 | 401 |
| `not_found` | 会话、消息、认证流程、分叉源或游标不存在 | 否 | 404 |
| `busy` | `details.reason`：`"running"`、`"queue_full"` 或 `"capacity"` | 是 | 409、429、503（带 `Retry-After`） |
| `missing_model` | 未指定有效模型且无可用默认模型（`info().unusableDefault` 说明原因） | 否 | 409 |
| `missing_tool` | 会话启用了实例中不存在的工具 | 否 | 409 |
| `auth_required` | 模型提供商缺少有效凭证（位于 `message.error`） | 否 | — |
| `model_error` | 上游模型提供商报错（位于 `message.error`） | 否 | — |
| `unconfirmed` | 写入结果不确定；请携带相同 `idempotencyKey` 重试 | 否 | 500 |
| `unavailable` | 临时性服务或存储不可用；可直接原样重试 | 是 | 503（带 `Retry-After`） |
| `internal` | 未预期的内部错误 | 否 | 500 |

**向前兼容约定：** 忽略未知的事件类型或条目 `kind`，将未知会话状态视为繁忙，使用 `hasEnded(message)` 判断终态，对未知错误码依据 `error.retryable` 决定是否重试。

## HTTP 绑定

所有 API 路由位于 `/v1` 下，要求 `Authorization: Bearer <key>`（通过 `FASTAGENT_API_KEY` 或 `serve({ apiKeys })` 配置）。未设置密钥时仅开放 `GET /health`。服务刻意禁用 CORS——请从你的服务端调用 API，切勿直接从浏览器暴露密钥调用。

| HTTP 方法与路径 | 对应操作 |
| --- | --- |
| `GET /health` | 公开健康探针（`200 { "status": "ok" }`，无需认证） |
| `GET /v1/agent`、`GET /v1/usage`、`GET /v1/openapi.json` | `info`、`usage`、OpenAPI 3.1 文档 |
| `POST /v1/sessions`、`GET /v1/sessions?limit&after` | `sessions.create`（`201`）、`sessions.list` |
| `GET`、`PATCH`、`DELETE /v1/sessions/{sessionId}` | `sessions.get`、`sessions.update`、`sessions.delete`（`204`） |
| `GET /v1/sessions/{sessionId}/entries?after&before&limit` | `sessions.entries` |
| `GET /v1/sessions/{sessionId}/events?after` | `sessions.events`（SSE；支持 `Last-Event-ID`） |
| `POST /v1/sessions/{sessionId}/cancel`、`/compact` | `sessions.cancel`、`sessions.compact`（`202`） |
| `GET /v1/sessions/{sessionId}/attachments/{ref}` | `sessions.attachment` |
| `POST /v1/sessions/{sessionId}/messages` | `messages.send`；传入 `"stream": true` 即为 `messages.stream` |
| `GET /v1/sessions/{sessionId}/messages/{messageId}?wait` | 按 ID 查询 `messages.get` |
| `GET /v1/sessions/{sessionId}/messages/by-key/{idempotencyKey}?wait` | 按幂等键查询 `messages.get` |
| `POST /v1/invoke` | `invoke`（`wait` 最长 600s）；传入 `"stream": true` 即为 `invokeStream` |
| `GET /v1/auth/providers`、`DELETE /v1/auth/providers/{provider}` | `auth.providers`、`auth.logout` |
| `POST /v1/auth/login`、`GET /v1/auth/login/{flowId}?wait` | `auth.startLogin`、`auth.getLogin` |
| `POST /v1/auth/login/{flowId}/input`、`DELETE /v1/auth/login/{flowId}` | `auth.submitInput`、`auth.cancelLogin`（`204`） |

`idempotencyKey` 通过 URL 编码后的 `Idempotency-Key` 请求头传递。SSE 流发送 `event: <type>`、JSON `data`，持久化 `entry` 事件携带 `id: <entry.id>`，并至少每 15 秒发送一次保活注释。拒绝响应统一返回 `{ "error": AgentErrorData }`。

`connectAgent(url, { apiKey, fetch })` 与 `connectAuth(url, { apiKey, fetch })` 支持传入自定义 `fetch` 传输层以对接签名云协议（如 [`@fastagent-sh/client-agentcore`](agentcore.md)）。

```bash
# 单次命名对话调用（适用于定时任务、Webhook、空闲休眠托管）
curl -s https://agent.example.com/v1/invoke \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: daily-2026-04-15" \
  -d '{"conversation": "daily-digest", "content": "/daily-digest", "whenBusy": "reject", "wait": 300}'

# 向指定会话发送消息
SEND=$(uuidgen)
curl -s https://agent.example.com/v1/sessions/$SESSION/messages \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $SEND" \
  -d '{"content": "Triage the 503 spike on /api/checkout", "wait": 60}'
```

## 安全实践

- **单实例即单一信任域。** 一个 API Key 拥有该实例全部会话与认证端点的完整访问权限。
- **隔离终端用户。** 启用编码工具时，互不可见的用户必须隔离在不同实例中；或关闭编码工具（`codingTools: false`）、确保自定义工具不访问共享存储，并在业务后端校验每个会话 ID 的归属。
- **密钥仅保留在服务端并走 HTTPS。** 支持逗号分隔多密钥（`FASTAGENT_API_KEY=new,old`）实现零停机轮换。
- **Session ID 不是访问凭证。** 始终在你的应用层校验当前登录用户对 `sessionId` 的访问权限。

## 设计上有意不涵盖的范围

按单条消息精确拆分 Token 计费（并发/合并轮次共享模型调用）；强制结构化 JSON 回复 Schema（请定义强类型工具并读取其 `tool_result` 条目）；轮次中途交互式用户提问；出站完成 Webhook 回调（请使用 `POST /v1/invoke`、`messages.get` 带 `wait` 或 `sessions.events`）；图片以外的二进制附件；A2A/MCP 服务端绑定。
