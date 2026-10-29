---
title: Agent API 设计解读
description: "解读 Agent API v2：一个服务化 agent 对调用方提供的接口，为什么是这个形状，进程内和 HTTP 两种绑定，以及和 ACP、A2A、AG-UI、OpenAI 的对照。"
status: current
---

# Agent API 设计解读

规范原文见 [SPEC.md](../SPEC.md)，架构和取舍见 [architecture.md](../design/architecture.md)。两者与本文不一致时，以英文原文
为准。本文解读的是 v2；v1 在 SPEC.md 的 git 历史里，两版的差别见原文 §13。

## 一句话概括

一个部署好的 agent 像互联网上任何一个服务一样被调用：从程序里调，走 HTTP，带一个 key。Agent API 只定义这个 agent 对
**调用方**提供的接口：一个 `Agent`，下面是 `sessions` 和 `messages` 两组操作。同一套模型有两种绑定：进程内的 TypeScript
接口（`openAgent`），和 HTTP（`/v1` 加 `connectAgent`）。两者名字、对象、错误都一样，调用方换一行拿到 agent 的代码，就能在
"打开本地目录"和"连到部署"之间切换。改 agent 的定义、查看会话内部这类运维操作，是 harness（pi-durable）自己的 API，
不在这里。

## 1. 它要保证的四件事

一条消息可能要跑几分钟，调用方和 agent 之间的网络随时会断，跑 agent 的进程也会重启。所以这套 API 要保证的事情很窄：

- **接受一条，结束一次。** 消息先持久记录再确认收到，只结束一次，重启后还在。
- **找得回来。** 断了连接的调用方能按 id 查到这条消息后来怎样了，以及它的回答。
- **重试不会跑两遍。** 不确定发没发到的调用方，用同一个 key 再发一次，拿到的是同一条消息。
- **能看着它写，断了能接上。** 调用方能看到回答一点点写出来，断线后从最后看到的地方接着看。

原文其余部分都是围绕这四点的命名和形状。

## 2. 四个概念

| 概念 | 是什么 | 调用方对它做什么 |
|---|---|---|
| Agent | 一个服务化的 agent，也是一个信任域 | 问它接受什么、提供什么（`info`），花了多少（`usage`） |
| Session（会话） | 一段对话：entry 组成的历史、状态和设置。id 由 Agent 生成 | 新建、列出、读、**看**、改设置；停止或压缩它正在做的事 |
| Message（消息） | 调用方发进会话的一件事，从被接受到结束：一个状态，加上回答 | **发**它，**查**它 |
| Entry | 会话历史里的一条持久记录：用户说的、agent 写的、工具返回的、一次压缩 | 当历史读，也在它写下时收到 |

**会话是"看"的单位，消息是"发和查"的单位。** 一个会话可能有好几个调用方同时在写（两个浏览器标签页，一个 channel 加一个
定时任务），所以会话的状态只能说明它忙不忙，说不出"你那条消息"有没有被回答、回答是什么。消息这个概念就是为了回答这个问题才存在的。
agent 怎样分步、分轮回答，不在 API 里；agent 一起处理的两条消息可能共用一个回答，但每条消息的状态和回答都是它自己的。

## 3. 操作

| 操作 | 做什么 |
|---|---|
| `info` / `usage` | agent 提供的命令、工具、模型和默认模型；整个实例的花费 |
| `sessions.create` | 新建空会话，或带 `forkFrom` 从某个会话的某条 entry 分叉；可以同时选模型、thinking level、追加的 `instructions` 和启用的 `tools` |
| `sessions.get` / `list` | 会话现在的样子；按最近活动列出实例里所有会话，不管是谁建的 |
| `sessions.update` | 改会话设置，从下一次模型请求开始生效；`null` 表示回到部署默认值 |
| `sessions.entries` | 一页历史；不带游标是最新一页，往前翻用 `before` |
| `sessions.events` | 看一个会话（见第 5 节） |
| `sessions.cancel` | 停下会话正在做的一切：正在回答的、排队的、还没落地的手动压缩。停止被记录后就返回，重启后依然有效 |
| `sessions.compact` | 现在就压缩会话较早的 entry；接受后返回，摘要作为 `compaction` entry 到达 |
| `sessions.attachment` | entry 里图片的内容 |
| `messages.send` | 发一条消息。消息被记录就返回；带 `wait` 则等它结束，或等到 `wait` 秒，按那时的状态返回 |
| `messages.stream` | 发一条消息，并把它写出的过程交给调用方 |
| `messages.get` | 按 id 或发送时的 key 查一条消息；`wait` 同上 |

`signal` 只放弃等待，从不停止被等的东西：调用拒绝并带上 signal 的原因，消息照常进行。只有 `cancel` 会让 agent 停下。

## 4. 几个关键决定

- **模型和工具的设置只保存、不当场检查。** 发消息时会话指定的模型 agent 没有，拒绝 `missing_model`；模型有、但这里没有它
  provider 的凭证，消息被接受，然后以 `auth_required` 失败；会话的 `tools` 里有 agent 已经没有的工具（后来的部署删掉了），
  拒绝 `missing_tool` 并说出是哪个，直到 `update` 改掉。会话永远不会悄悄少用几个工具。
- **会话忙时（`whenBusy`）：** `queue`（默认）排在后面；`steer` 在 agent 还在忙时就交给它，在下一步拿走；`reject` 直接以
  `busy` 拒绝。会话空闲时，三种都立刻被拿走。
- **消息只有四种结局，而且这是封闭集合：** `completed`、`incomplete`（回答在 token 上限处被截断）、`failed`（`error` 说明原因）、
  `canceled`。执行过工具调用的中间回复不算回答。状态本身是开放的：以后的版本可以加"等人回答"这类状态，旧调用方把不认识的状态
  当作"还没结束"，继续等或继续看，不会误以为已经结束。
- **幂等只做在发消息上。** key 在一个会话内唯一；带见过的 key 发送，返回那条消息现在的样子，不记录任何新东西。查 key、记录、
  排队在每个会话内是一步，所以同一个 key 的并发发送只产生一条消息。只有发消息重复执行才有害（agent 会再答一遍，工具会再执行
  一遍）；会话建两次只是多一个没人引用的空会话，所以 `create` 不做幂等，pi-durable 也只在提交消息上提供 `requestId` 去重。
- **"可能已记录"和"什么都没记录"是两个错误码。** 发送可能已经被记录、但没能确认时（存储在记录时或之后失败，或者连接在回答
  前断了），拒绝 `unconfirmed`，`details` 带上已知的 `sessionId`、`messageId` 和 key，不可重试：没带 key 时再发一次会多出
  一条消息。`unavailable` 的意思是"同一个请求可以安全地再发一次"：要么什么都没记录，要么重复执行无害（再改一次设置、再停一次、
  再压缩一次，或者回答丢失的 `create` 留下一个空会话）。
- **`cancel` 没拿到回答时，不要靠再调一次来确认。** 那会把这期间新发来的消息也停掉。应该先读会话和想停的那些消息，确实还想全部
  停下再调。
- **id 不透明、永不复用。** pi-durable 的 id 是每个存储从头开始的计数器，部署又可能换掉存储（AgentCore 每次部署都会清空
  session storage），所以对外的 id 是"存储的 incarnation（建存储时生成的随机值）+ pi-durable 的 id"。旧存储的 id 得到
  `not_found`，不会指到别人的新会话。这是编码，不是查表。
- **fork 共享源会话的 entry。** fork 的历史开头就是源会话的那些 entry 本身，id 和内容都一样；源会话的消息仍然属于源会话。
- **用量记在 pi-durable 记账的地方：** 每次模型回复（`assistant` entry 的 `usage`）、每个会话（`Session.usage`，包括失败和
  中止的尝试、压缩摘要的调用）、整个实例（`usage()`）。没有"每条消息"的用量：一起处理的消息共用同一次调用，按消息分只能是估算。
- **会扩展的取值都是开放的：** 事件类型、entry 种类、内容类型、状态、错误码。规范定义的名字不含 `.`，实现自己加的必须带前缀
  （比如 `fastagent.plan`）。调用方忽略不认识的事件类型，把不认识的会话状态当作"忙"，对不认识的错误码按 `retryable` 处理。

## 5. 看一个会话、看一条消息

`sessions.events` 按三步交付，这部分参照了 ACP v2 的 `session/resume`：

1. **重放**：`after` 之后的 entry；`after: "start"` 重放全部；不带 `after` 不重放。
2. **快照**：一个 `state` 事件，带会话现在的样子，即使什么都没重放。调用方以它判断会话是不是还在回答；正在写的回答在
   `session.reply` 里。
3. **实时**：之后发生的一切，和快照之间不漏不重。一条消息的 `done` 一定先于之后被拿走的消息的 `user` entry 发出。

entry 是持久的，在哪里读到都一样。`delta`（回答正在写的部分）、`tool_started`、`tool_progress`、`retrying` 只在实时里出现：
中途接上的调用方先显示 `state.session.reply`，再接上后面的 delta，收到 `retrying` 就丢掉已显示的部分（下一次尝试从头写），
`assistant` entry 到达后用它替换。流在调用方停止读取时结束，或以 `stream_error` 事件结束（不叫 `error`：浏览器的
`EventSource` 会把叫 `error` 的事件和断线交给同一个监听器）。断了的调用方带着最后收到的 entry id 作 `after` 接着看，不会漏。

`messages.stream` 把"发一条、看它写完"包在一起：先给一个 `message` 事件（消息被记录时的样子），再给会话里属于它的事件，从它的
`user` entry 到它的 `done`。用见过的 key 再发，就从这条消息现在的位置交付：还在回答的，先给已写出的 entry，再给 `state`，然后
接实时；已经结束的，给到回答为止的 entry，再给 `done`。

一个流在首次读取时被拒绝（比如会话不存在）；一旦交付过任何东西，之后的失败只会以 `stream_error` 事件结束，不会再 reject，否则
调用方会把一条已经记录的消息当成被拒绝。

## 6. HTTP 绑定

- **一份契约。** `src/http/contract.ts` 用 Effect 的 `HttpApi` 从 `src/agent-api.ts` 的 Schema 拼出所有路由；服务端从它回答，
  `connectAgent` 通过它调用，`/v1/openapi.json` 也从它生成，所以三者不可能描述不同的 API。错误的 HTTP 状态码由一个函数
  `statusOf` 按原文 §7 的表决定，429 和 503 带 `Retry-After`；解码时接受任意错误码，新服务端加的码旧客户端也能读。
- **key。** `Authorization: Bearer <key>`，key 来自实例环境里的 `FASTAGENT_API_KEY`，逗号分隔可以有多个，用来不中断地换 key。
  没有 key 就不提供 `/v1`，启动报告会说明。没有 CORS：key 是整个实例的凭证，浏览器从来不拿它，浏览器应用调用自己的后端。
  定义里写 `http: { api: false }` 时，任何 serve（`dev`、`start`、每个部署）都不提供 `/v1`，即使环境里还留着 key。
- **等待最长 60 秒。** 一次 HTTP 请求最多等 60 秒；`connectAgent` 用剩下的时间再问一次 `get`，所以同一个 `wait` 在两种绑定里
  意思一样。
- **事件流用 SSE。** 只有 `entry` 事件带 `id:`，所以浏览器的 `Last-Event-ID` 就是最后收到的 entry；`Last-Event-ID` 优先于
  `?after=`（`EventSource` 重连时用的是它最初打开的 URL）。安静的流每 15 秒发一行注释，免得代理把连接关掉。
- **发消息的 key 走 `Idempotency-Key` 头**，和 `by-key` 路径一样做百分号编码：头只能放 Latin-1、首尾空白会被裁掉，而 key 可以是
  任意 1 到 256 个字符。
- **`connectAgent` 给没带 key 的发送自己生成一个**，这样回答丢失时能以 `unconfirmed` 带上这个 key，调用方用它查到消息。
- **CLI。** `fastagent deploy` 在 `.secrets/production/.env` 里没有 key 时生成一个，随其他值一起带到部署，报告里给出 API 地址和
  检查命令；`fastagent invoke --url <base>` 用和本地 `invoke` 一样的输出和退出码检查一个部署。
- **AgentCore 上不提供。** 那里只能通过 `/invocations` 访问，HTTP API 要单独设计（经由 forwarder Lambda，加响应流）。

## 7. 安全模型

- **一个实例就是一个信任域。** 拿到 key 的人能做 API 能做的一切，覆盖所有会话；agent 的工具带着运行它的进程的全部权限。同一个
  实例里的会话彼此不隔离。
- **一个客户一个实例。** 彼此不能看到对方对话的人，分到不同的实例。key 只把外人挡在外面，不在实例内部再分权限。
- **能让 channel 的 bot 说话的人，都在信任域里。** 平台签名只证明请求来自平台，证明不了是谁发的：任何能给 bot 发消息的人，都能让
  agent 用工具去读它能读到的东西，包括别的聊天。
- **会话 id 是名字，不是凭证。**

## 8. 和其他接口规范的对照

这一节解读 [architecture.md](../design/architecture.md) §7。

| 维度 | Agent API | ACP v2 | A2A 1.0 | AG-UI 1.0 | OpenAI |
|---|---|---|---|---|---|
| 会话 id | Agent 生成 | agent 生成 | `contextId` | 客户端给 `threadId` | 服务端生成 |
| 调用方拿到的单位 | message | 写入对话时返回 `messageId` | Task 或 Message | run | response |
| 按 id 查状态 | `messages.get` | 无 | `GetTask` | 无 | `GET /responses/{id}` |
| 断线重连 | `sessions.events`：重放、快照、实时 | `session/resume` 加 `replayFrom` 和状态快照 | `SubscribeToTask` | 快照事件 | `starting_after` 序号 |
| 停止 | `sessions.cancel`（整个会话） | `session/cancel`（整个会话） | `CancelTask` | 无 | 单个 response |
| 去重 | 会话内 `idempotencyKey` | 无 | 可选（客户端 `messageId`） | 无 | 无 |
| 会话忙时 | `queue`、`steer`、`reject` | 不要求支持 | 无 | 无 | 无 |
| 反问用户 | 暂不做 | permission、elicitation | `input-required` | interrupt | 无 |

ACP v2 独立地得出了同样的模型：agent 生成会话 id，消息写入对话就返回，不暴露 turn id，按会话停止，状态只有 `idle`/`running`，
按游标恢复后再告知当前状态。Agent API 从对比中采纳了：`messages.get`（A2A、OpenAI）、重放后的状态快照（ACP）、内容数组
（ACP、A2A、OpenAI）、`info` 里说明提供什么（ACP 协商的能力）、开放取值加带前缀的扩展（ACP 的 `_` 名字）、回答中途也能接上
（ACP 的 resume 和 OpenAI 的序号都支持）。

没有采纳的：把 run、turn、task 当作一等公民的 id（这里以消息为单位）；客户端持有历史、每次发过来（AG-UI，这里由服务端持有）；
共享状态的 JSON Patch、计划、模式（属于特定 agent，用带前缀的扩展表达）；客户端提供文件系统和终端（ACP，这里的 agent 在服务端
运行）。

## 9. 不在 Agent API 里的

| 不在 Agent API 里 | 原因或去处 |
|---|---|
| 删除会话 | pi-durable 不删除任何东西 |
| 单条消息的用量 | 一起处理的消息共用调用，按消息分只能是估算 |
| 结构化结果 | 还没有调用方需要；需要时由 agent 定义一个工具，参数就是那个结果，调用方读它的 `tool_result` |
| agent 中途反问用户 | 以后按开放取值的规则加 |
| 消息结束时推送 webhook | 能等的用 `get` 加 `wait`，其余轮询 |
| 图片以外的文件 | 这一版不做 |
| A2A、MCP 绑定 | 都能映射到这个模型（会话对应 A2A 的 `contextId`，消息对应 Task；消息对应一次 MCP 工具调用），等有调用方需要时再设计 |
| AgentCore 上的 HTTP API | 见第 6 节 |
| 运维：改 agent 定义、查看会话内部 | pi-durable 自己的 API（`agent.harness`） |
