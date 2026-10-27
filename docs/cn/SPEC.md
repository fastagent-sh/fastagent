---
title: Agent API 设计解读
description: "解读 Agent API：一个服务化 agent 对消费者提供的接口，为什么是这个形状，和 ACP、A2A、AG-UI、OpenAI 的对照，以及它和 pi-durable 的关系。"
status: current
---

# Agent API 设计解读

规范原文见 [SPEC.md](../SPEC.md)，架构和取舍见 [architecture.md](../design/architecture.md)。两者与本文不一致时，以英文原文
为准。本文解读的是 v1。代码已经在进程内改用下一版 v2（`src/agent-api.ts`），见
[design/agent-api.md](../design/agent-api.md)：同一套模型同时有进程内和 HTTP 两种绑定，HTTP 用 API key 认证。v2 的 HTTP
绑定完成后它替换 SPEC.md，本文随之更新。

## 一句话概括

一个部署好的 agent 就像一个 bot，也是一个信任域：拿到它的代码能做它能做的一切。Agent API 只定义这个 bot 对**消费者**提供的
接口，一共 10 个操作，只有进程内的 TypeScript 绑定，FastAgent 不把它放到任何网络上。会话用哪个模型、哪个 thinking level
由调用方选择；其余一切（改 agent 的定义、压缩、查看会话内部）都是 harness（pi-durable）自己的 API，不在 Agent API 里。

## 1. 为什么是这个形状

之前的 SPEC v1（没有发布过）想做一个“任何 harness 都能实现”的中立协议，为此定义了 harness 端口和 `LoopPort`，在 pi-coding-agent 上模拟
pi-durable 原生就有的排队、幂等和消息记录，又在 pi-durable 上重建它不保存的事实。这些工作标准化的恰恰是各家 harness 差异最大、
变化最快的部分，而产品目标里没有一个需要它。

所以这一版换了两个前提：

- **只用一个 harness：pi-durable。** 它原生有服务化需要的东西：按 `whenBusy` 准入、按请求 id 去重、每条消息持久地结束一次、
  重启后接着回答，存储和执行环境也都可以替换。
- **只定义我们自己必须定义的那一层：消费者 API。** 我们自己的 channels、定时任务、wake 都是消费者，它们只用这 10 个操作
  就够了，这说明这一层是完整的。它同时把 pi-durable 的实验性 API 和内部 entry 种类挡在客户端之外。

## 2. 十个操作

| 操作 | 做什么 |
|---|---|
| `info` | bot 的名字、简介，消息可以带哪些内容类型（`inputs`，比如 `["text", "image"]`），以及可用的命令（`commands`：prompt 模板，和每个 skill 的 `skill:<name>`） |
| `invoke` | 向会话发一条消息（不带 `sessionId` 就新建会话）。消息一被持久记录就返回回执，不等它被回答 |
| `getMessage` | 按 id 或发送时的 key 查一条消息现在的状态：排队、处理中、已结束（结局和回答） |
| `createSession` | 新建空会话；带 `from` 就是从某个会话的某条 entry 分叉（开 thread、“从这里分支”）；可以用 `model`、`thinkingLevel` 选择新会话的设置 |
| `configure` | 修改已有会话的 `model`、`thinkingLevel` 或两者，和 pi-durable 的 `configure()` 一样在一次提交里保存，从会话的下一次模型请求开始生效，正在回答的消息也会接着用新设置 |
| `read` | 状态加一页历史；不带游标返回最新一页，`before` 往前翻，`after` 往后读 |
| `resume` | 接上一个会话：按 `replayFrom` 重放、发当前状态快照、再接实时事件（见第 3 节） |
| `abort` | 停止当前回答，并撤回所有排队中的消息；等被停下的消息都结束后返回，和 pi-durable 的 `conversation.abort()` 一样；没拿到答复时返回 `unknown` |
| `attachment` | 读历史里图片的内容：base64 数据和声明的类型 |
| `listSessions` | 列出 Agent 持有的所有会话，最近有活动的排在前面，不管是谁建的（channel、定时任务、`invoke`、嵌入的应用）。会话的活动指它的创建、它接收的消息和它写下的 entry 中最新的一个；用 `before` 加不透明的游标翻页；每个会话的状态和最新内容用 `read` 读。harness 为自己的工作建的对话（比如子 agent 的）不算会话，不列出 |

创建会话时，`model` 用 `{ provider, modelId }`，`thinkingLevel` 用 pi-durable 原生支持的 `off`、`minimal`、`low`、`medium`、
`high`、`xhigh`、`max`。它们和会话在同一次提交里保存，重启后保留。fork 继承分叉 entry 当时的设置（空会话继承当前设置），
每个显式传入的字段分别覆盖继承来的值，不改变源会话。仍然没有设置的字段在收到消息时取部署默认值。创建时和 pi-durable 一样只保存
选择，不检查模型是否可用；如果发消息时会话没有可用模型，`invoke` 返回 `missing_model`。`invoke` 不接受模型或 thinking level，
只用会话设置；修改已有会话的设置用 `configure`，同样只保存、不检查可用性。会话不存在返回 `not_found`，两个字段都没给返回
`invalid_request`，都不记录任何东西。会话的 `state` 带着它当前的 `model` 和 `thinkingLevel`（还没设置的字段不出现），调用方可以读回
自己的选择，以及第一条消息被接收时填进去的部署默认值。

**发消息和看会话是分开的两件事**，和 pi-durable 一样：`submit` 返回一个句柄，过程另外用 `watchEvents` 订阅。对应到这里：

- `invoke` 返回回执 `{ sessionId, message, duplicate }`，以及一个 `wait()`，等这条消息结束，对应 pi-durable 的
  `Submission.wait()`。即使消息在调用 `wait()` 之前就结束了，`wait()` 也会返回它的 `done`。`wait()` 返回 `unfinished` 有两种
  情况：Agent 的存储出错、调用方通过 `signal` 放弃等待。放弃等待只结束这一次等待，不影响消息本身（和取消
  pi-durable 的等待 context 一样）。`unfinished` 从不表示“被拒绝”：调用方应该之后用 `getMessage` 查，不带 key 时不要重发。从不
  调用 `wait()` 的回执不占任何资源。
- 被拒绝时返回错误，什么都没记录，可以重发。
- 提交消息或取得完整回执失败，且不能证明消息被拒绝时，返回 `unknown`。包括提交期间存储失败、消息已记录但读状态失败、重复消息的
  回执读不出来。提交期间只有明确的拒绝才可返回 rejection，之后的读取失败不能算拒绝。
  `unknown` 表示没有取得完整回执，不一定是不知道是否接受：拿到了 `messageId` 就能证明已记录。结果必须带上所有已知的 `sessionId`、
  `messageId`。Agent 恢复后，有消息 id 就用 `getMessage` 查；没有消息 id 时，可以在同一会话用原来的 key 重试。如果两者都没有，
  不能认定被拒绝，也不能自动重发。
- 结果、事件和 entry 的数据都能 JSON 序列化，嵌入方可以原样转发给自己的客户端；回执里的 `wait()` 是附在数据旁边的方法。
- 想看回答怎么写出来，就用 `resume` 订阅会话。**一条消息的回答，是会话事件里它自己那条 `user_message`（会注明是哪条消息）之后、
  到它的 `done` 为止的内容**；在那之前的事件属于别的消息。为了不漏，调用方在 `invoke` 之前先 `resume`，这要求会话已经存在：新对话
  先用 `createSession` 建出来，并在发任何消息之前记下它的 id。Agent 保证一条消息的 `done` 先于之后被取走的消息的 entry 发出，即使
  pi-durable 在同一次提交里结束前一条、放入后一条，所以“从 `user_message` 到 `done`”的划分是可靠的。`done` 不会被重放，所以在 `invoke` 之后才 `resume` 的调用方，要在拿到快照后用 `getMessage` 查一次，
  补上订阅之前就已结束的情况。
- `stream(agent, request)` 把这件事包了起来，适用于任何 `Agent`，只是 API 的一个调用方，不增加任何语义（见 SPEC.md
  §3.1）。它返回 `StreamResult`：成功时是回执加 `events`（这条消息 `user_message` 之后、到它的 `done` 为止的事件，会话无法继续
  跟随时以 `serving_error` 结束）；也可能是 invoke 的拒绝或 `unknown`，包括后者携带的已知 id。channel 用回执里的 `messageId`
  记录这一轮，并把拒绝的原因告诉用户。它要求请求带 `sessionId`：只有已存在的会话才能在发消息之前订阅，新对话由调用方先建会话、记下
  id，这也保证了带 key 重试时始终落在同一个会话里（§3.3）。它先不带重放地 `resume`，拿到快照后再 `invoke`，然后按回执里的状态处理：
  新消息或还在排队的，它的 `user_message` 会以实时事件到来；正在处理的重复消息，从它的 `user_message` 之后重新接上，先把重放的内容
  暂存，快照后用 `getMessage` 查一次：仍在处理就把暂存的发出去并接着看实时事件，已经结束就只发到它的回答为止（重放可能已经越过它、
  进入下一条消息），再给出 `done`；已经结束的重复消息，用 `read` 读出它之后到回答为止的 entry，再给出 `done`。

消息的输入是内容数组 `content: [{ type: "text", text }, { type: "image", mimeType, data }]`，`user_message` 和 `tool_result`
entry 也是同样的结构。内容类型是开放的取值（§6.1），以后加新类型不用改结构。

**命令**：消息文字以 `/<name>` 开头、并且 `name` 在 `info().commands` 里时，就是一条命令。Agent 在模型看到之前展开它：prompt
模板展开成模板正文，名字后面的词作为参数；`/skill:<name>` 展开成这个 skill 的完整说明，后面的词作为请求附在后面。不用命令时，模型只
看到每个 skill 的名字和描述，任务对得上时自己去读它的说明（Agent Skills 规范的按需加载）。`user_message` entry 里记录的是调用方原本发的内容，
所以历史里显示的是 `/review 123`，不是展开后的文本。`/` 后面跟着不认识的名字，就按原文交给模型。聊天客户端可以把 `commands`
显示成菜单，channel 可以把它注册成平台的命令列表。

## 3. 接上一个会话：重放、快照、实时

这部分参照了 ACP v2 的 `session/resume`。`resume` 分三步：

1. **重放**：按 `replayFrom` 决定：不带就不重放；`{ type: "start" }` 重放全部 entry；`{ type: "after", entryId }` 重放这条之后的。
   重放里只有 entry，没有过去的实时事件和状态。
2. **快照**：然后**必须**发一个 `state`，即使什么都没重放。它是“过去”和“现在”的分界线：客户端以它为准判断 bot 是不是还在回答，
   不要从重放内容去推断。
3. **实时**：之后是实时事件和新的 entry，和快照之间不漏不重；每条消息结束时发它的 `done`。

`resume` 只在调用方停止读取，或以 `serving_error` 结束时才结束。

**回答中途接上也能看到已经写出的部分。** `assistant_message` 写完才有 id。写的过程中，快照里的 `state.reply` 是目前已写出的文字，
`message_delta` 在它后面追加。一个会话同一时间只写一条 agent 消息，所以 delta 不需要带 id：客户端先显示 `reply`，再接上后面的
delta；收到 `retry_scheduled` 就丢掉已显示的部分（下一次尝试从头写）；`assistant_message` entry 到达后用它替换。
delta 可能没覆盖到回答的最后一段，以 entry 的文字为准。

典型用法：客户端回到一个之前显示过的会话，就从它手里最后一条 entry 之后 `resume`；打开一个很长、从没显示过的会话，就先 `read`
最新一页，再从这页最后一条之后 `resume`。

## 4. 几个关键决定

- **会话 id 由服务端生成，调用方自己记住。** pi-durable 生成 conversation id，不接受调用方指定。channel 和定时任务在自己的
  状态里记“哪个聊天或 thread 对应哪个会话”。服务端按最近活动列出所有会话（`listSessions`），这样 duang 的侧栏能显示 channel、定时任务发起的对话；但不提供删除，
  因为 pi-durable 没有删除。同一个存储里，pi-durable 给会话、消息、entry 分配 id 用的是同一个递增计数器，所以一个会话最新的那个
  id 就代表它最近的活动，排序不需要时钟；一个实例跨多个存储时按时间比较，和横向扩展一起设计。
- **映射按固定顺序、在固定的地方建立**（architecture.md §2）：只在 channel 已经按“位置”（一个聊天、一个 thread）串行处理的地方
  建立映射，也就是以位置为键的 turn queue 加持久的 turn store，所以同一个新位置并发到达的两条消息、或者首条消息的重投，会先后执行，
  后一个能看到前一个写下的映射；跨进程时，同一时间只有一个进程持有实例状态（服务进程的租约）。顺序是：先 `createSession`（开 thread
  时是分叉），再持久地写映射，最后带平台消息 id 作为 key 向映射到的会话 invoke。channel 从不发不带 `sessionId` 的 invoke，因为那样
  带不了 key。`createSession` 之后、写映射之前崩溃，会留下一个没人引用的会话（空的，或一个 fork），重试不会复用它，也没有东西删除它；
  但不会有消息被回答两次，因为消息只在映射写好之后才发。
- **id 是不透明的，永不复用。** pi-durable 的 id 在每个存储里是一个从 2 开始的计数器，而部署可能换掉存储（AgentCore 每次 deploy
  会清空 session storage，卷也可能重建）。所以对外的 id 是“存储的 incarnation（创建存储时生成的随机 id）+ pi-durable 的 id”，
  会话、消息、entry 都这样。存储换掉后，旧 id 得到 `not_found`，而不是别人的新会话；id 本身也说明了它属于哪个存储，多个存储时
  可以据此路由。这是编码，不是查表，不需要存任何映射。
- **持久性和 id 不复用，以宿主存储的持久性为限。** 如果宿主的存储在机器故障时会丢掉最新的写入，那么最新接受的消息可能丢失，
  随之发出的 id 也可能被再次发出。AgentCore 的 session storage 在宿主机故障后就是这种情况（见 architecture.md §4.3）。不能丢消息的
  调用方，应该一直保留消息，直到看到它的 `done`。
- **开 thread**：分叉点仍然按 key 找（`getMessage` 带平台消息 id）；thread 对应的会话按上面的顺序建立和记录。
- **一个实例就是一个信任域，Agent API 不上网络**（SPEC.md §8、§10；architecture.md §2）。Agent 不认证任何人；拿到它的
  代码能做它能做的一切：对每个会话发消息、读取、接上、改设置、停止、分叉，agent 的工具也带着进程的全部权限。它的调用方都在运行
  agent 的那个进程里：我们自己的 channels、定时任务、wake、`invoke` 命令，以及嵌入 agent 的应用。谁把 agent 放到网络上，谁决定谁能访问：
  channel 必须（MUST）校验请求确实来自它的平台（平台的签名或 token），嵌入方用自己应用的认证保护自己写的路由。FastAgent 的部署
  只暴露会校验调用方的入口（channel 的 webhook，宿主自己的入口，比如 AgentCore 的 IAM）。FastAgent 自己的调用方都不需要通过网络
  访问 Agent API；今天通过网络调用它的用法（外部时钟代替 schedule、部署后的冒烟测试、`curl`、`connectAgent`）在 architecture.md
  §5 里逐项写了去掉还是替换；剩下的远程需求（duang 的线上 agent，以及 agent 之间互相调用）都还没开始做，等做的时候按实际需求再
  设计远程绑定。
- **能接触到 agent 的人都在它的信任域里。** 平台签名只能证明请求来自平台，证明不了发消息的是谁：任何能给 channel 的 bot 发消息的人，
  都能让 agent 用工具去读它能读到的东西，包括别的聊天的对话；嵌入方放进来的每个用户也一样。同一个实例里的会话彼此之间并不隔离：
  agent 的工具能读到这个实例的存储和文件，不管是哪个会话让它去读的。
- **按实例隔离客户。** 彼此不能看到对方对话的人，要分到不同的实例（各自的存储、进程和文件），或者用一个工具碰不到存储和文件的
  agent。一个公开 bot 的用户和 owner 的其他聊天，在这样拆开之前都属于同一个信任域。会话 id 只是名字，不是凭证，可能是顺序编号。
- **幂等 key 必须和 `sessionId` 一起用。** pi-durable 的 key 只在单个会话内有效；不带会话的 invoke 如果重试，会建出两个会话。
  想安全重试第一条消息，就先 `createSession` 拿到 id，再带 key 发。
- **查一条消息：`getMessage`。** 参照 A2A 的 `GetTask` 和 OpenAI 的 `GET /responses/{id}`。调用方不知道消息怎样了时，用它查状态，
  再用 `resume` 接上会话看 agent 写了什么。用自己的东西（比如聊天平台的消息 id）作 key 的调用方，可以直接按 key 查，不用自己
  维护映射。
- **消息状态只保留消费者需要的字段：** 没有 `takenAt`、`endedAt`，时间只在 entry 的 `timestamp` 上。
- **`abort` 和 pi-durable 一致。** 它停下正在回答的消息、撤回排队的消息，等这些消息都以 `canceled` 结束后才返回，并报告停下了
  哪些。停止会先被持久记录再等待，所以调用方不再等待也不会丢掉这次中止，进程重启后这些消息照样以 `canceled` 结束。正在执行的工具
  要响应中止信号才会结束，这是对工具的要求；在那之前 `abort` 一直等，也可以用 `signal` 放弃等待。它报告所有还没结束、被它停下的
  消息，包括上一次 `abort` 还在停的。
- **`abort` 没拿到答复时返回 `unknown`**：等待中 `signal` 被触发，或者存储出错。这时不知道停止有没有
  被记录，而且**不能靠再调一次 `abort` 来弄清楚**：那会把这期间新发来的消息也一起停掉，而第一次 `abort` 本来不会停它们。调用方应该先用
  `read`（`limit: 0`）看会话状态、用 `getMessage` 看要停的那些消息，确实还想全部停下时再调一次。
- **消息的结局只有四种：** `completed`、`max_tokens`、`canceled`、`failed`。没有 `interrupted`：进程重启后 pi-durable 会接着
  回答已取走的消息，排队的消息也还在。`answer` 只在 `completed` 和 `max_tokens` 时出现，执行过工具调用的中间回复不算回答。
- **fork 共享源会话的 entry：** fork 的历史开头就是源会话的那些 entry 本身，id 和内容都相同，之后写的才是 fork 自己的。每条 entry
  带 `sessionId`，说明是哪个会话写的；同一条 entry 不管从哪个会话读，内容都一样。
- **用量：** 每条 `assistant_message` 带这次模型回复的 `usage`。一个会话总共花了多少看 `state.usage`，它就是 pi-durable 给这个
  会话记的账本（`pi.usage`）：会话自己发出的每次模型调用（包括失败和中止的尝试、生成 compaction 摘要的调用）按
  `provider/model` 分开，工具报告的花费按工具名分开。它只算会话自己的调用，fork 从零开始记，所以跨会话相加时每次调用只算一次；
  fork 共享来的 entry 算源会话的。compaction 的摘要没有 entry 记录花费，所以把会话的 entry 加起来会比 `state.usage` 少。
- **会扩展的取值都是开放的**（§6.1）：事件类型、entry 种类、内容类型、`inputs`、结局、会话状态、错误码。规范定义的名字不含
  `.`；实现方自己加的必须带自己的前缀（例如 `fastagent.plan`）。客户端遇到不认识的事件就忽略，不认识的会话状态当作“忙”，
  不认识的结局当作“结束但没有完成”。

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
回答中途也能接上（ACP 的 resume 和 OpenAI 的序号都支持）。

没有采纳的：把 run/turn/task 当作一等公民的 id（我们以消息为单位）；客户端持有历史、每次把历史发过来（AG-UI，我们由服务端持有）；
共享状态的 JSON Patch、计划、模式（特定 agent 的功能，用带前缀的自定义事件表达）；客户端提供文件系统和终端（ACP，我们的 agent
在服务端运行）；关闭、删除会话和多租户字段；自己的传输协议（它是进程内的 TypeScript，放到网络上的应用自己决定怎么传）。人工确认、
消息结束时推送 webhook（A2A、OpenAI 后台模式）、`notice` 实时提示事件（ACP），以后按扩展规则加，不影响现有调用方。

## 6. 不在 Agent API 里的

| 不在 Agent API 里 | 去哪里 |
|---|---|
| 改会话的工具、扩展或指令、压缩、查看所有会话 | pi-durable 的原生 API（`agent.harness`） |
| 删除会话 | 不提供：pi-durable 没有删除 |
| 身份、认证、限流 | 实例是一个信任域；谁把它放到网络上，谁决定谁能访问（channel 的平台签名、宿主的 IAM、嵌入方自己的认证） |
| 网络绑定（HTTP 等） | 不提供：嵌入方在自己的路由里调用这套 API；远程绑定等有使用方时再按它的需求设计 |
| 人工确认、agent 反问 | 以后的版本按 §6.1 加 |
| 图片以外的文件上传 | 这一版不做 |
| ACP、A2A 等其他协议 | 在这套 API 外面调用它；做这些协议的绑定不在当前产品目标里 |
