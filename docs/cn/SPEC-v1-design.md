---
title: SPEC v1 设计解读
description: "解读 Agent API v1：一个服务化 agent 对消费者提供的接口，为什么是这个形状，和 ACP、A2A、AG-UI、OpenAI 的对照，以及它和 pi-durable 的关系。"
status: current
---

# SPEC v1 设计解读

规范原文见 [SPEC.md](../SPEC.md)，架构和取舍见 [architecture.md](../design/architecture.md)。两者与本文不一致时，以
英文原文为准。

## 一句话概括

一个部署好的 agent 就像一个 bot：能访问到它的人都可以和它对话。SPEC v1 只定义这个 bot 对**消费者**提供的接口，一共 8 个操作，
进程内（TypeScript）和 HTTP 两种绑定，语义完全相同。其余一切（改模型、压缩、查看所有会话）都是 harness（pi-durable）自己的
API，不在 SPEC 里。

## 1. 为什么是这个形状

上一版 SPEC v1 想做一个“任何 harness 都能实现”的中立协议，为此定义了 harness 端口和 `LoopPort`，在 pi-coding-agent 上模拟
pi-durable 原生就有的排队、幂等和消息记录，又在 pi-durable 上重建它不保存的事实。这些工作标准化的恰恰是各家 harness 差异最大、
变化最快的部分，而产品目标里没有一个需要它。

所以这一版换了两个前提：

- **只用一个 harness：pi-durable。** 它原生有服务化需要的东西：按 `whenBusy` 准入、按请求 id 去重、每条消息持久地结束一次、
  重启后接着回答，存储和执行环境也都可以替换。
- **只定义我们自己必须定义的那一层：消费者 API。** 我们自己的 channels、定时任务、wake 都是消费者，它们只用这 8 个操作
  就够了，这说明这一层是完整的。它同时把 pi-durable 的实验性 API 和内部 entry 种类挡在客户端之外。

## 2. 八个操作

| 操作 | HTTP | 做什么 |
|---|---|---|
| `info` | `GET /agent` | bot 的名字、简介，以及接受哪些输入（`inputs`，比如 `["text", "image"]`；模型不支持图片时界面就不显示上传按钮） |
| `invoke` | `POST /invoke` | 发一条消息：不带 `sessionId` 就新建会话。默认返回 SSE 流；`Accept: application/json` 时等消息结束后一次性返回 |
| `getMessage` | `GET /sessions/{s}/messages/{m}` | 按 id 查一条消息现在的状态：排队、处理中、已结束（结局和回答） |
| `createSession` | `POST /sessions` | 新建空会话；带 `from` 就是从某个会话的某条 entry 分叉（开 thread、“从这里分支”） |
| `read` | `GET /sessions/{s}` | 状态加一页历史；不带游标返回最新一页，`before` 往前翻，`after` 往后读 |
| `resume` | `GET /sessions/{s}/events` | 接上一个会话：按 `replayFrom` 重放、发当前状态快照、再接实时事件（见第 3 节） |
| `abort` | `POST /sessions/{s}/abort` | 停止当前回答，并撤回所有排队中的消息；命名沿用 pi-durable 的 `abort` |
| `attachment` | `GET /sessions/{s}/attachments/{ref}` | 读历史里图片的内容 |

进程内的 `invoke` 返回一个既能逐条读事件、又带 `result` 的对象：只想要最终回答就 `await invocation.result`，替代了原来的
`collect`。

消息的输入是内容数组 `content: [{ type: "text", text }, { type: "image", mimeType, data }]`，`user_message` 和 `tool_result`
entry 也是同样的结构，以后加文件、音频不用再加新字段。ACP、A2A、OpenAI 都是这个形状。

## 3. 接上一个会话：重放、快照、实时

这部分参照了 ACP v2 的 `session/resume`。`resume` 和 invoke 的流用同一套三段式：

1. **重放**：`resume` 按 `replayFrom` 决定：不带就不重放；`{ type: "start" }` 重放全部 entry；`{ type: "after", entryId }`
   重放这条之后的。invoke 的流重放这条消息自己从 `user_message` 开始的 entry。重放里只有 entry，没有过去的实时事件和状态。
2. **快照**：然后**必须**发一个 `state`，即使什么都没重放。它是“过去”和“现在”的分界线：客户端以它为准判断 bot 是不是还在回答，
   不要从重放内容去推断。
3. **实时**：之后是实时事件和新的 entry，和快照之间不漏不重；每条消息结束时发它的 `done`。

**回答中途接上也能看到已经写出的部分。** 正在写的 `assistant_message` 在写完前就有 id：`message_delta` 带上这个 `entryId`，
快照里的 `state.reply` 是目前已写出的文字。客户端先显示 `reply`，再把后续的 delta 接在后面。pi-durable 每 100 毫秒就把部分回答
写进存储，所以这一点有基础，spike 时确认。

典型用法：客户端回到一个之前显示过的会话，就从它手里最后一条 entry 之后 `resume`；打开一个很长、从没显示过的会话，就先 `read`
最新一页，再从这页最后一条之后 `resume`。

## 4. 几个关键决定

- **会话 id 由服务端生成，调用方自己记住。** pi-durable 不接受调用方指定的会话 id。channel 和定时任务在自己的状态里记“哪个聊天
  对应哪个会话”。服务端不提供会话列表，也不提供删除。
- **会话 id 就是这个会话的钥匙。** bot 对所有人开放，谁持有会话 id，谁就能读、接上、发消息、停止、从它分叉。所以 SPEC 要求
  会话 id 不可猜测（至少 122 位随机数，和 UUIDv4 一样）。认证、限流由上层负责。
- **幂等 key 必须和 `sessionId` 一起用。** pi-durable 的 key 只在单个会话内有效；不带会话的 invoke 如果重试，会建出两个会话。
  想安全重试第一条消息，就先 `createSession` 拿到 id，再带 key 发。
- **查一条消息：`getMessage`。** 所有对照的规范（A2A 的 `GetTask`、OpenAI 的 `GET /responses/{id}`）都有按 id 查状态，
  它是轮询式客户端（serverless 函数、带超时的 HTTP 调用方）的标准做法，并且直接对应 pi-durable 的 submission 记录。
- **消息的结局只有四种：** `completed`、`max_tokens`、`canceled`、`failed`。没有 `interrupted`：进程重启后 pi-durable 会接着
  回答已取走的消息，排队的消息也还在。`answer` 只在 `completed` 和 `max_tokens` 时出现，执行过工具调用的中间回复不算回答。
- **用量记在 entry 上：** 每条 `assistant_message` 一份，`compaction` 记生成摘要的那几次调用；fork 复制来的 entry 不带。
  单个会话内或跨会话相加，每次模型调用都只算一次。
- **会扩展的取值都是开放的**（§6.1）：事件类型、entry 种类、内容类型、`inputs`、结局、会话状态、错误码。规范定义的名字不含
  `.`；实现方自己加的必须带自己的前缀（例如 `fastagent.plan`）。客户端遇到不认识的事件就忽略，不认识的会话状态当作“忙”，
  不认识的结局当作“结束但没有完成”。
- **浏览器也只是一个调用方。** HTTP 上带 body 的请求必须是 `content-type: application/json`，否则在读取之前就拒绝：表单或
  `text/plain` 的跨域 POST 不经过预检，拒绝返回结果也挡不住已经开始的运行。

## 5. 和其他接口规范的对照

| 维度 | SPEC v1 | ACP v2 | A2A 1.0 | AG-UI 1.0 | OpenAI Responses |
|---|---|---|---|---|---|
| 会话 id | agent 生成 | agent 生成 | `contextId` | 客户端给 `threadId` | 服务端生成 |
| 调用方拿到的单位 | message | 写入对话时返回 `messageId` | Task 或 Message | run | response |
| 按 id 查状态 | `getMessage` | 无 | `GetTask` | 无 | `GET /responses/{id}` |
| 断线重连 | `resume`：重放、快照、实时 | `session/resume` 加 `replayFrom` 和状态快照 | `SubscribeToTask` | 快照事件 | `starting_after` 序号 |
| 取消 | `abort`（整个会话） | `session/cancel`（整个会话） | `CancelTask` | 无 | 单个 response |
| 去重 | 会话内 `idempotencyKey` | 无 | 可选（客户端 `messageId`） | 无 | 无 |
| 会话忙时 | `queue`、`steer`、`reject` | 不要求支持 | 无 | 无 | 无 |
| 人工确认 | 暂不做 | permission、elicitation | `input-required` | interrupt | 无 |

ACP v2 独立演化出了和我们几乎一样的模型（agent 生成会话 id、消息写入即返回 id、不暴露 turn id、会话级取消、`idle`/`running`、
按游标恢复并附状态快照），这是这个设计方向的一个旁证。

没有采纳的：把 run/turn/task 当作一等公民的 id（我们以消息为单位）；客户端持有历史、每次把历史发过来（AG-UI，我们由服务端持有）；
共享状态的 JSON Patch、计划、模式（特定 agent 的功能，用带前缀的自定义事件表达）；客户端提供文件系统和终端（ACP，我们的 agent
在服务端运行）；会话列表、关闭、删除和多租户字段；JSON-RPC 作为主传输。人工确认、消息结束时推送 webhook、`notice` 提示事件，
以后按 §6.1 的规则加，不影响现有客户端。

## 6. 不在 SPEC 里的

| 不在 SPEC 里 | 去哪里 |
|---|---|
| 改模型、思考档位、压缩、查看或列出所有会话 | pi-durable 的原生 API（`agent.harness`）；需要 HTTP 的话，开发者自己写一个路由 |
| 列出、删除会话 | 不提供：调用方自己记，数据不删除 |
| rewind、编辑消息、重新生成 | 不提供：用“从这里分叉”加“重新发一次”代替 |
| 身份、认证、限流 | 上层（网关、私有网络、云的 IAM、嵌入方的中间件） |
| 人工确认、agent 反问 | 以后的版本按 §6.1 加 |
| 图片以外的文件上传 | 这一版不做 |
| ACP、A2A 等其他协议 | 不在当前产品目标里；需要时在这套 API 外面包一层 |

## 7. 和上一版的对照

| 上一版 v1 | 这一版 v1 |
|---|---|
| harness 无关的协议，加 harness 端口和 `LoopPort` | 只有 pi-durable，SPEC 只管消费者接口 |
| 调用方可以给会话命名 | 服务端生成不可猜测的 id |
| `sessions.list`、`rewind`、`compact`、`update`、`delete`、`/control` 平面 | 去掉；需要的用 pi-durable 原生 API |
| `messages.get`、`messages.follow`、`messages.cancel` | `getMessage`；接上会话用 `resume`；停止用 `abort` |
| `follow` | `resume`：按 `replayFrom` 重放，必发状态快照，回答中途也能接上 |
| `prompt: { text, images }` | `content` 内容数组 |
| `sessions.create({ fork })` | `createSession({ from })` |
| `capabilities`、`durableQueue`、`durableTaken` | 去掉：只有一个实现，持久性直接写进 MUST；`info` 只说明接受哪些输入 |
| `intercepted`、`interrupted` 结局，`source` 字段 | 去掉：pi-durable 不产生前两种，`source` 没有读者 |
| `collect` | `invocation.result`，或 HTTP 的 JSON 等待模式 |
