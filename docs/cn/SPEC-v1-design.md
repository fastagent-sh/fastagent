---
title: Agent API 设计解读
description: "解读 Agent API：一个服务化 agent 对消费者提供的接口，为什么是这个形状，和 ACP、A2A、AG-UI、OpenAI 的对照，以及它和 pi-durable 的关系。"
status: current
---

# Agent API 设计解读

规范原文见 [agent-api.md](../design/agent-api.md)，架构和取舍见 [architecture.md](../design/architecture.md)。两者与本文
不一致时，以英文原文为准。Agent API 已经定下、还没实现：迁移（#788）完成后它替换 [SPEC.md](../SPEC.md)，在那之前代码实现的
仍是 SPEC.md。

## 一句话概括

一个部署好的 agent 就像一个 bot：能访问到它的人都可以和它对话。Agent API 只定义这个 bot 对**消费者**提供的接口，一共 8 个操作，
进程内（TypeScript）和 HTTP 两种绑定，语义完全相同。其余一切（改模型、压缩、查看所有会话）都是 harness（pi-durable）自己的
API，不在 Agent API 里。

## 1. 为什么是这个形状

现在的 SPEC v1 想做一个“任何 harness 都能实现”的中立协议，为此定义了 harness 端口和 `LoopPort`，在 pi-coding-agent 上模拟
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
| `info` | `GET /agent` | bot 的名字、简介，以及消息可以带哪些内容类型（`inputs`，比如 `["text", "image"]`） |
| `invoke` | `POST /invoke` | 发一条消息：不带 `sessionId` 就新建会话。默认返回 SSE 流；`Accept: application/json` 时一接受就返回 `202` 和回执，之后用 `getMessage` 查或 `resume` 接上 |
| `getMessage` | `GET /sessions/{s}/messages/{m}`，或 `?idempotencyKey=` 按 key 查 | 按 id 或发送时的 key 查一条消息现在的状态：排队、处理中、已结束（结局和回答） |
| `createSession` | `POST /sessions` | 新建空会话；带 `from` 就是从某个会话的某条 entry 分叉（开 thread、“从这里分支”） |
| `read` | `GET /sessions/{s}` | 状态加一页历史；不带游标返回最新一页，`before` 往前翻，`after` 往后读 |
| `resume` | `GET /sessions/{s}/events` | 接上一个会话：按 `replayFrom` 重放、发当前状态快照、再接实时事件（见第 3 节） |
| `abort` | `POST /sessions/{s}/abort` | 停止当前回答，并撤回所有排队中的消息 |
| `attachment` | `GET /sessions/{s}/attachments/{ref}` | 读历史里图片的内容 |

进程内的 `invoke` 返回一个既能逐条读事件、又带 `result` 的对象：只想要最终回答就 `await invocation.result`，替代了原来的
`collect`。`result` 有三种结果：消息结束（`ok: true`）、被拒绝（`error`，什么都没记录），以及 `unfinished`：流在知道结局之前
停了，原因由流的最后一个事件 `serving_error` 说明：Agent 没法继续（比如存储故障），或者远程客户端的连接断了。流不会悄无声息地停。`unfinished` 带着回执里已知的会话 id 和消息 id（如果回执已经到了），它从不表示“被拒绝”，所以调用方应该用
`getMessage` 查，或带同一个 key 重发，不带 key 时不要重发。

JSON 模式不等消息结束：一次回答可能要几分钟，比大多数部署前面代理的空闲超时（例如 60 秒）还长；等待中连接被切断，没带 key
的调用方连查询用的 id 都拿不到。所以 JSON 模式一接受就返回回执。

消息的输入是内容数组 `content: [{ type: "text", text }, { type: "image", mimeType, data }]`，`user_message` 和 `tool_result`
entry 也是同样的结构。内容类型是开放的取值（§6.1），以后加新类型不用改结构。

## 3. 接上一个会话：重放、快照、实时

这部分参照了 ACP v2 的 `session/resume`。`resume` 接上的是整个会话，invoke 的流接上的是它自己那条消息，两者都分三步：

1. **重放**：`resume` 按 `replayFrom` 决定：不带就不重放；`{ type: "start" }` 重放全部 entry；`{ type: "after", entryId }`
   重放这条之后的。invoke 的流在消息被取走后，重放这条消息自己从 `user_message` 开始的 entry。重放里只有 entry，没有过去的
   实时事件和状态。
2. **快照**：然后**必须**发一个 `state`，即使什么都没重放。它是“过去”和“现在”的分界线：客户端以它为准判断 bot 是不是还在回答，
   不要从重放内容去推断。
3. **实时**：之后是实时事件和新的 entry，和快照之间不漏不重。`resume` 收到整个会话的，每条消息结束时发它的 `done`；invoke 的流
   只在它的消息被处理期间收到，以它自己的 `done` 结束。

invoke 的流在消息排队期间只收到 `state`，不带 `reply`：排在别的消息后面时，收不到那条消息的 entry、实时事件和 `done`。
对一条已经结束的消息重复发送，没有实时部分，所以不发快照：重放它从 `user_message` 到回答的 entry（没有回答就只有
`user_message`，排队时就被撤回的消息什么都没有），然后是 `done`。

`resume` 只在调用方停止读取，或以 `serving_error` 结束时才结束。HTTP 绑定的 TypeScript 客户端不会自己重连：连接断了就以
`serving_error` 结束流，由调用方从最后一条 entry 之后再 `resume`。

SSE 上，每个 `entry` 事件的 id 是 entry id，快照的 id 是拍快照时最新的 entry id（会话还没有 entry 时是 `start`）。所以不带游标打开的
流，即使在第一条 entry 到达之前断线，重连时浏览器带上的 `Last-Event-ID` 也能从快照处接上，不会漏掉断线期间写下的 entry。

**回答中途接上也能看到已经写出的部分。** 正在写的 `assistant_message` 在写完前就有 id：`message_delta` 带上这个 `entryId`，
快照里的 `state.reply` 是目前已写出的文字。客户端先显示 `reply`，再把后续的 delta 接在后面。pi-durable 每 100 毫秒就把部分回答
写进存储，所以这一点有基础，spike 时确认。

典型用法：客户端回到一个之前显示过的会话，就从它手里最后一条 entry 之后 `resume`；打开一个很长、从没显示过的会话，就先 `read`
最新一页，再从这页最后一条之后 `resume`。

## 4. 几个关键决定

- **会话 id 由服务端生成，调用方自己记住。** pi-durable 生成 conversation id，不接受调用方指定。channel 和定时任务在自己的
  状态里记“哪个聊天对应哪个会话”。服务端不提供会话列表，也不提供删除。
- **id 是不透明的，永不复用。** pi-durable 的 id 在每个存储里是一个从 2 开始的计数器，而部署可能换掉存储（AgentCore 每次 deploy
  会清空 session storage，卷也可能重建）。所以对外的 id 是“存储的 incarnation（创建存储时生成的随机 id）+ pi-durable 的 id”，
  会话、消息、entry 都这样。存储换掉后，旧 id 得到 `not_found`，而不是别人的新会话；id 本身也说明了它属于哪个存储，多个存储时
  可以据此路由。这是编码，不是查表，不需要存任何映射。
- **开 thread**：分叉点仍然按 key 找（`getMessage` 带平台消息 id）；thread 对应的会话 id 在 `createSession` 分叉之后记进 channel
  的状态。如果分叉之后、记录之前进程崩溃，会留下一个没人引用的 fork，重试不会复用它，也没有东西删除它。
- **会话 id 只是名字，不是凭证。** 它可能是顺序编号。能访问到 agent 的人就能访问它的每个会话：读、接上、发消息、停止、从它分叉。
  多个用户共用一个部署时，用户之间的隔离由前面的一层负责：一个记录“用户 → 会话”映射、只放行自己会话的 facade，包括 fork 的
  源会话和不带 `sessionId` 的 invoke 新建的会话（见 [security-boundary.md](../design/security-boundary.md) §4）。认证、限流也由
  上层负责。
- **幂等 key 必须和 `sessionId` 一起用。** pi-durable 的 key 只在单个会话内有效；不带会话的 invoke 如果重试，会建出两个会话。
  想安全重试第一条消息，就先 `createSession` 拿到 id，再带 key 发。
- **查一条消息：`getMessage`。** 参照 A2A 的 `GetTask` 和 OpenAI 的 `GET /responses/{id}`。调用方丢了流之后，用它查消息状态，
  再用 `resume` 接上会话看 agent 写了什么。用自己的东西（比如聊天平台的消息 id）作 key 的调用方，可以直接按 key 查，不用自己
  维护映射。
- **消息状态只保留消费者需要的字段：** 没有 `takenAt`、`endedAt`，时间只在 entry 的 `timestamp` 上。
- **消息的结局只有四种：** `completed`、`max_tokens`、`canceled`、`failed`。没有 `interrupted`：进程重启后 pi-durable 会接着
  回答已取走的消息，排队的消息也还在。`answer` 只在 `completed` 和 `max_tokens` 时出现，执行过工具调用的中间回复不算回答。
- **用量记在 entry 上：** 每条 `assistant_message` 一份，`compaction` 记生成摘要的那几次调用；fork 复制来的 entry 不带。
  单个会话内或跨会话相加，每次模型调用都只算一次。
- **会扩展的取值都是开放的**（§6.1）：事件类型、entry 种类、内容类型、`inputs`、结局、会话状态、错误码。规范定义的名字不含
  `.`；实现方自己加的必须带自己的前缀（例如 `fastagent.plan`）。客户端遇到不认识的事件就忽略，不认识的会话状态当作“忙”，
  不认识的结局当作“结束但没有完成”。
- **浏览器也只是一个调用方。** HTTP 上每个 `POST`，不管有没有 body，都必须是 `content-type: application/json`，否则在读取之前
  就拒绝：表单、`text/plain` 或没有 body 的跨域 POST 不经过预检，拒绝返回结果也挡不住已经做了的事（开始一次运行、中止一个会话、
  建一个会话）。

## 5. 和其他接口规范的对照

这一节解读 [architecture.md](../design/architecture.md) §7。

| 维度 | Agent API | ACP v2 | A2A 1.0 | AG-UI 1.0 | OpenAI Responses |
|---|---|---|---|---|---|
| 会话 id | agent 生成 | agent 生成 | `contextId` | 客户端给 `threadId` | 服务端生成 |
| 调用方拿到的单位 | message | 写入对话时返回 `messageId` | Task 或 Message | run | response |
| 按 id 查状态 | `getMessage` | 无 | `GetTask` | 无 | `GET /responses/{id}` |
| 断线重连 | `resume`：重放、快照、实时 | `session/resume` 加 `replayFrom` 和状态快照 | `SubscribeToTask` | 快照事件 | `starting_after` 序号 |
| 取消 | `abort`（整个会话） | `session/cancel`（整个会话） | `CancelTask` | 无 | 单个 response |
| 去重 | 会话内 `idempotencyKey` | 无 | 可选（客户端 `messageId`） | 无 | 无 |
| 会话忙时 | `queue`、`steer`、`reject` | 不要求支持 | 无 | 无 | 无 |
| 人工确认 | 暂不做 | permission、elicitation | `input-required` | interrupt | 无 |

ACP v2 独立地得出了同样的模型：agent 生成会话 id、消息写入对话后就返回 id、不暴露 turn id、会话级取消、状态只有
`idle`/`running`、按游标恢复后再告知当前状态。Agent API 从对比中采纳了：`getMessage`（A2A、OpenAI）、重放后的状态快照（ACP）、
内容数组（ACP、A2A、OpenAI）、`info` 里说明接受哪些输入（ACP 协商的 prompt 能力）、开放取值加带前缀的扩展（ACP 的 `_` 名字）、
回答中途也能接上（ACP 给逐块输出带消息 id，OpenAI 的序号）。

没有采纳的：把 run/turn/task 当作一等公民的 id（我们以消息为单位）；客户端持有历史、每次把历史发过来（AG-UI，我们由服务端持有）；
共享状态的 JSON Patch、计划、模式（特定 agent 的功能，用带前缀的自定义事件表达）；客户端提供文件系统和终端（ACP，我们的 agent
在服务端运行）；会话列表、关闭、删除和多租户字段；JSON-RPC 作为主传输（REST 加 SSE 对 Web 消费者更简单）。人工确认、
消息结束时推送 webhook（A2A、OpenAI 后台模式）、`notice` 实时提示事件（ACP），以后按扩展规则加，不影响现有调用方。

## 6. 不在 Agent API 里的

| 不在 Agent API 里 | 去哪里 |
|---|---|
| 改模型、思考档位、压缩、查看或列出所有会话 | pi-durable 的原生 API（`agent.harness`）；需要 HTTP 的话，开发者自己写一个路由 |
| 列出、删除会话 | 不提供：调用方自己记，数据不删除 |
| 身份、认证、限流 | 上层（网关、私有网络、云的 IAM、嵌入方的中间件） |
| 人工确认、agent 反问 | 以后的版本按 §6.1 加 |
| 图片以外的文件上传 | 这一版不做 |
| ACP、A2A 等其他协议 | 在这套 API 外面调用它；做这些协议的绑定不在当前产品目标里 |

## 7. 和现在的 SPEC v1 的对照

这一节解读 agent-api.md §12 的第一张表。

| 现在的 SPEC v1（代码实现的） | Agent API |
|---|---|
| harness 无关的协议，通过 harness 端口和 `LoopPort` 实现 | 一个 harness（pi-durable）的消费者接口 |
| 调用方可以给会话命名，也可以由 Agent 命名 | 全部由 Agent 命名；id 不透明、永不复用 |
| `sessions.list`、`rewind`、`compact`、`update`、`delete`、`/control` 平面、`models`、`commands` | 去掉；运维用 pi-durable 原生 API |
| `messages.get`、`messages.follow`、`messages.cancel` | `getMessage`（按 id 或 key）；`resume`；`abort` |
| `follow` | `resume`：按 `replayFrom` 重放，必发快照，再接实时；回答中途也能接上 |
| invoke 流等于这条消息的 `messages.follow` | 同样只接这条消息，消息被处理后先发快照 |
| `prompt: { text, images }` | `content` 内容数组，按 `info().inputs` 检查 |
| `sessions.create({ sessionId, fork })` | `createSession({ from })` |
| `capabilities`、`durableQueue`、`durableTaken` | 去掉：持久性直接写进 MUST |
| `intercepted`、`interrupted` 结局；`source`；`takenAt`、`endedAt` | 去掉 |
| `collect`；`Accept: application/json` 返回 `202` | `invocation.result`，可能是 `unfinished`；JSON 模式同样返回 `202` |
| `serving_error { message }` | `serving_error { error }`：无法继续的流以它结束 |
| 只检查带 body 的请求 | 每个 `POST` 都要求 `content-type: application/json` |
