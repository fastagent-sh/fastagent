---
title: SPEC v1 设计解读
description: "从产品设计、开发者与调用方、架构三个角度解读 Agent Handler 协议 v1。"
status: current
---

# SPEC v1 设计解读

规范原文见 [SPEC.md](../SPEC.md)，设计理由见 [agent-service.md](../design/agent-service.md) §7 和 §9。两者与本文不一致时，以 SPEC 为准。

## 一句话概括

SPEC v1 把 FastAgent 从一个"调一次、跑一轮、断开就停"的函数，改成一个**持有对话的服务**：

- 调用方把消息交给服务，服务先登记，再负责把它处理完；
- 调用方可以随时离开，之后再回来查询这条消息的结果、接着看进度，或者叫停；
- 每条消息都有编号和持久记录，重启后也能查到它的结局。

---

## 一、为什么要有 v1：v0.1 的问题

v0.1 只有一个函数：`invoke(scope, prompt) => AsyncIterable<AgentEvent>`。它适合"嵌进程序里、调一次拿答案"，但不适合当服务用：

| v0.1 的规定 | 实际造成的问题 |
|---|---|
| 调用方停止读取，agent 必须停止工作（MUST 3） | 手机网络一断、网页一刷新，正在做的事就被杀掉 |
| 会话忙时直接拒绝（`session_busy`） | Telegram、Slack、飞书、定时任务各自写一套"等一等再试"的逻辑 |
| 消息没有编号 | 无法回答"我刚才那条消息处理了没有、结果是什么" |
| 没有幂等 | 进程崩溃后 channel 重投同一条消息，agent 可能把同一件事做两遍 |
| 读历史、steer、中止放在可选的 `/control/*` 扩展里 | 客户端要同时对接两套接口，两套状态还可能对不上 |
| 只有 `completed`/`failed` 两种结尾 | 说不清"被用户取消"和"进程重启打断"有什么区别 |

v1 的设计来源是两个本身就为长时间、多入口运行设计的 harness：pi-durable 和 DeepSeek Harness。ACP 的 v2 草案独立地走到了同一个模型，所以 ACP 被当作兼容目标，而不是直接采用的契约。

---

## 二、产品设计角度

### 1. 三个概念

| 概念 | 是什么 | 用户怎么感知 |
|---|---|---|
| **Session（会话）** | 一段对话，里面的消息共享同一份历史 | 一个 Slack 线程、一个网页聊天窗口、一个定时任务 |
| **Message（消息）** | 调用方发进会话的一条消息，从被接受到有结局 | "我这条消息排着队 / 正在处理 / 已回答"；"回答是什么、花了多少 token、成功还是失败" |
| **Entry（记录）** | 会话历史里的一条记录：被处理的用户消息、agent 的回复、工具结果、设置变更、压缩 | 聊天记录本身；断线后从哪里接着看；从哪里分叉 |

agent 怎么干活（step、turn、run）属于 harness 内部，不进协议。会话同一时间只做一件事：接下一条消息，调用模型和工具，直到给出回答。

**为什么调用方拿到的是消息，而不是 run。** v1 最初的草稿让调用方拿 run（一段工作，可能包含多条 steer 进来的消息），并把 run 的开始和结束作为 entry 写进日志。实测 pi-durable 1.3.0 后改成了消息，原因是：

- 真正必须持久化的东西是按消息的：channel 欠每个用户一个回答；重试要靠 key；重启后要知道哪些消息被打断。pi-durable 正是这样：每条输入（submission）持久地结束一次，要么 `done` 并指向回答它的 entry，要么 `unanswered` 并给出原因，并且和 entry 在同一次提交里原子写入。它的 run 只是调度状态，结束后不保留。
- 把 run 边界写进日志代价最大：边界要在 run 的所有 entry 之前和之后，而日志 harness 也在写。pi-durable 会在结束一个 run 的同一次提交里放入下一条排队消息，所以它的边界没法按顺序写进日志，只能从提交顺序去猜。
- steer 进来的消息并不是没有自己的结局：它被哪段工作接走，就由那段工作的回答来回答，结局也和那段工作相同。

由于 SPEC v1 还没有对外发布过，这次改动仍然叫 v1。

### 2. 会话忙时怎么办：`whenBusy`

由调用方说明意图，服务来执行。只有服务能做到不出现竞争。

| `whenBusy` | 会话正在处理别的消息时 | 典型场景 |
|---|---|---|
| `queue`（默认） | 排队，按到达顺序，前一段工作结束后再处理 | 群聊里连续来了几条消息 |
| `steer` | 当前工作在这轮工具调用结束后接走它，由当前工作的回答来回答；如果当前工作已经给出回答，它就排在队首，由下一段工作单独回答 | 用户补充一句"对了，用英文回答" |
| `reject` | 直接拒绝，返回 `busy` | 定时任务不想堆积 |

会话空闲时，三种方式都会立刻处理这条消息。被同一段工作接走的消息，回答和结局都相同。

### 3. 工作不依赖调用方存活

- 调用方停止读取只是**离开**（detach），工作继续进行。
- 叫停工作只能显式调用：
  - `messages.cancel`：撤回一条排队的消息，或停掉正在处理它的那段工作；
  - `abort`：停掉整个会话正在做的一切；
  - `delete`：删除会话。

### 4. 谁能用什么：两个平面

| 平面 | 给谁用 | 包含哪些操作 | 默认 |
|---|---|---|---|
| 用户平面 | 和 agent 对话的人，以及代表他们的客户端（duang、应用前端） | 发消息、看历史、实时跟随、取消、回退、压缩 | 开 |
| 控制平面 | 运维和构建者 | 改会话名、模型和思考级别；删除会话 | 关 |

FastAgent 本身不做认证，它的定位是放在网关后面的后端服务。

这带来一个要明确告知用户的风险：用户平面默认开启，任何能访问到端口的人都能列出所有会话，包括 channel 里的私聊，还能读取、跟随和中止它们。所以有公网地址的部署必须放在网关后面；如果只用 channel，可以把 `http.api` 关掉。

---

## 三、调用方角度

### 1. 最简单：调一次拿答案

```ts
const { text } = await collect(agent.invoke({ prompt: { text: "总结这个 issue" } }));
```

- 不带 `sessionId` 时，每次 invoke 都会新建一个会话。
- 消息以 `completed` 结束时，`collect` 返回它的回答。
- 被拒绝、失败、被取消或被打断时，`collect` 都会抛错，不会把半截答案当成功。

### 2. 聊天界面

1. 打开会话：调用 `read()`，不带游标时返回**最新一页**（默认 100 条，页内从旧到新）。
2. 调用 `follow({ after: 最后一条的 id })`，先补齐中间漏掉的记录，再接实时事件，不丢也不重复。
3. 发消息：`invoke({ sessionId, prompt })`。
4. 渲染以下事件：
   - `message_delta`：逐字输出；
   - `tool_started` / `tool_progress`：工具执行中；
   - `entry`：已经落盘的正式记录；
   - `done`：某条消息有了结局。
5. 往上翻历史时，用 `prev` 游标继续 `read`。

只有 entry 是持久的；`done` 由消息的持久记录生成，任何时候来跟随一条已结束的消息都能收到；其余都是实时事件。断线重连后能看到所有漏掉的 entry，但看不到中间的逐字输出，这是有意的设计。

### 3. 可靠的 channel：飞书、Slack、Telegram

```ts
agent.invoke({
  sessionId: placeId,          // 一个群或线程
  idempotencyKey: platformMsgId,
  prompt,
});
```

- 平台重投、或者 FastAgent 崩溃后重发同一个 key，返回同一条消息，标记 `duplicate: true`，不会重复处理。
- 重复的那个流从这条消息的 `user_message` entry 开始，以同一个 `done` 结束，所以 `collect` 拿到的答案和第一次完全一样。
- 只有一个例外：上次那条消息是 `interrupted`（进程挂了），同一个 key 会作为一条新消息重新接受。这样 channel 仍然是"至少一次"：
  - 要么已经有一个结果；
  - 要么由调用方明确决定重做。

  服务自己永远不会自动重做，因为工具可能已经产生了副作用。

### 4. 断线恢复

```ts
const m = await session.messages.get({ messageId });   // 或 { idempotencyKey }
for await (const e of session.messages.follow(messageId, { after: lastEntryId })) { /* ... */ }
```

`messages.get` 返回 `undefined` 只有两种可能：这条消息从来没被接受过，或者它的会话已经被删除。所以它可以安全地用来判断"要不要重发"。正因为如果存储故障时也返回 `undefined` 会误导调用方，规范允许这几个读操作在存储不可用时 reject 一个 `unavailable` 错误。

### 5. 错误处理

- 每个错误都有 `code`、`message`、`retryable`。
- 遇到不认识的 code，按 `retryable` 决定要不要重试。
- 12 个错误码各自对应固定的 HTTP 状态，例如：
  - `busy`：429，可重试；
  - `missing_model`、`auth_required`：422，属于缺配置，重试没用；
  - `unavailable`：503，可重试。

### 6. HTTP

| 场景 | 接口 |
|---|---|
| 发消息 | `POST /invoke`：默认是 SSE 事件流；带 `Accept: application/json` 时立刻返回 `202` 和回执，之后自己去查 |
| 实时跟随 | `GET /sessions/{s}/follow`：SSE 的 `id` 就是 entry id，浏览器断线后用 `Last-Event-ID` 自动续上 |
| 查询消息 | `GET /sessions/{s}/messages/{m}`：查不到时返回 `200 null`，不用 `404`，避免和"路由不存在"混淆 |

连接在收到回执之前断开时，无法知道消息有没有被接受：服务端只在消息落盘之后才回复。带 `idempotencyKey` 时，带着 key 重发一次就能确定：服务端认得这个 key 就返回那条消息，不认得就接受它。不能只用 `messages.get` 去查，因为服务端可能还在处理第一个请求，查的时候没有、查完之后才被接受；不带 key 时，客户端不能把这次 invoke 报成 `rejected`，因为 `rejected` 的意思是"什么都没记录"，调用方会因此重发。

---

## 四、开发者角度：实现一个 Agent 或接入一个 harness

### 1. 必须遵守的五条（Agent MUST）

| 条款 | 含义 |
|---|---|
| 1. 一种结尾 | 读到底的流，要么只有一个 `rejected`，要么以自己那条消息的 `done` 结束；进程停止是唯一例外 |
| 2. 失败是事件 | 迭代 `invoke`、`follow`、`messages.follow` 永远不抛异常；处理失败的消息以 `failed` 结局结束 |
| 3. 离开不等于停止 | 调用方断开时只释放这个流占用的资源，工作继续 |
| 4. 先持久化再回执 | 发出 `accepted` 之前，消息的 id、key 和来源必须已经落盘；每条消息恰好结束一次，先落盘再报告；永不自动重做 |
| 5. 能力如实声明 | 做不到的操作返回 `unsupported`，不能悄悄忽略、模拟或降级 |

调用方这边有两条，与 v0.1 相同：

- 不认识的事件类型和 entry 类型直接忽略；
- 中间层转发时必须原样透传。

### 2. 几条容易做错的语义

- **幂等的原子性**：查 key、登记消息、入队必须在同一个会话内串行完成。同一个 key 并发进来，只能产生一条消息。
- **steer 的去向**：回执不承诺 steer 一定被当前工作接走，因为 harness 只有到下一步才知道。规则保证无论哪种情况，每条消息都有且只有一个回答。
- **`interrupted` 的收尾**：重启后第一次打开这个会话时，先把被打断的消息记为结束，再回应任何操作。这样重连的 `messages.follow` 不会永远等下去。
- **会话的生命周期**：
  - invoke 一个不存在的会话会自动创建它；
  - 其他操作遇到不存在的会话返回 `not_found`；
  - fork 只能通过 `sessions.create` 完成，只复制历史，不复制消息记录。`fork.context: "recent"` 照样复制历史，但只让模型看到最近的一段（和长会话的限窗一样，可以记成一条 `compaction` entry）；聊天 thread 从 room 开出来时用它。不管理上下文的 Agent 按默认的 `"full"` 处理。

### 3. 能力声明：`info().capabilities`

不同 harness 能力不同，客户端读一次即可，因为它在 agent 的整个生命周期内固定不变。

| 能力 | pi-coding-agent（通过 `LoopPort` 接入） | pi-durable |
|---|---|---|
| `steer` | 支持 | 支持 |
| `fork` | 支持 | 支持 |
| `rewind` | 支持 | 不支持，没有对应调用 |
| `delete` | 支持 | 不支持，没有对应调用 |
| `durableQueue`：重启后排队的消息还在 | 否 | 是 |
| `durableWork`：重启后正在进行的工作继续 | 否 | 是 |

### 4. 上限

| 项目 | 取值 |
|---|---|
| 每个会话的排队消息 | 20 条 |
| 每个进程同时在途的消息 | 参考实现 100 条 |
| `read` 每页 | 默认 100 条，最多 500 条，参考实现到 4 MiB 截断 |
| `idempotencyKey` 长度 | 1 到 256 个字符 |

超过上限时返回 `busy`，并在 `details.reason` 里说明是哪一种：`running`、`queue_full` 或 `capacity`。

### 5. 一套 conformance suite

所有 harness 都跑同一套测试，分别在进程内和通过 HTTP 各跑一遍。覆盖的范围：

- 回执和结尾；
- 三种 `whenBusy`，包括 steer 在回答之后才到的情况；
- 幂等，包括并发和 `interrupted` 的例外；
- 断开、取消、中止，以及失败或取消之后队列照常继续；
- 重启后的行为，包括"工具副作用次数不增加"；
- 分页和续读；
- fork、rewind、compact。

一个 harness 是否合规，就看它能否通过这套测试。

### 6. 对 agent 作者的影响

写 `SYSTEM.md`、`skills/`、`tools/` 的人基本不受影响。目录定义不变，变的是服务对外的协议。自己写 channel 的开发者需要改成调用新的 `invoke(request)`。

---

## 五、架构角度

### 1. 分层

```text
入口         CLI · SDK · HTTP/SSE · channels · 定时任务 · wake
               ↓ 全部调用同一个协议（本 SPEC）
服务层       id 映射 · 忙时规则 · 上限 · follow · 平面划分      ← 只写一次
               ↓ harness port（实现内部契约，不写进 SPEC）
harness      pi-coding-agent（+ `LoopPort`）· pi-durable · 将来 ACP agent / DeepSeek Harness
               ↓
存储         .state/（文件系统；pi-durable 用其中的 SQLite）；将来 AgentCore 上换成 API 存储
```

channel、定时任务和 wake 不再走特殊通道，它们和外部应用一样调用同一个协议，只是在进程内多一个 `source` 字段。远程调用方不能设置 `source`，所以没人能冒充 channel。

### 2. 队列放在哪里

设计时比较过两种方案：

| | A：队列放在服务层 | B：队列放在 port 后面（选定） |
|---|---|---|
| 自带持久队列的 harness（pi-durable、dsh） | 它的队列用不上，重启后排队的消息会丢 | 直接使用它的原生队列，重启不丢 |
| 只有循环的 harness（pi、ACP agent） | 直接可用 | 由共享的 `LoopPort` 补上队列、消息编号和消息记录 |

选 B，因为接入 pi-durable 的意义就在于它的持久性。pi-durable 直接实现 `HarnessPort`。

steer 必须交给 harness 实现：只有它的循环知道一个 step 在哪里结束。从外面只能杀掉正在执行的工具，或者等工作结束。

### 3. 状态放在哪里

每条消息有一份持久记录：被接受时写入 id、key 和来源（在回执之前），结束时写一次结局、它变成的 entry、回答和用量（在报告之前）。消息的状态由这份记录和队列推导出来。日志里只放对话本身，不再有 run 的开始和结束标记。

- **pi-durable**：它自己的 submission 就是这份记录，和 entry 在同一次提交里原子写入。
- **pi-coding-agent**：`LoopPort` 把两种记录写进 pi 的会话日志：`message_accepted` 和 `message_ended`。两者都是 plane marker：不对外发布、不能作为 rewind 目标、模型看不到、fork 不复制。
- **ACP agent**：ACP 没法往 agent 的历史里追加自己的记录，所以 `LoopPort` 自己保存整份日志，消息记录也写在里面。

不单独存一个文件，因为两个文件没法原子写入。

只有实时事件放在内存里。对只有循环的 harness，排队顺序和当前工作也在内存里。内存丢了不会让消息凭空消失，它会被认定为 `interrupted`。

这要求每个会话的日志只有一个写者。从第一次有操作拿到会话，到会话空闲、队列为空且没有操作持有它，`LoopPort` 一直持有这个会话唯一的 `SessionManager`，每段工作新绑定的 `AgentSession` 都用它，所有写入（消息记录、被撤回消息的结束、`update`、`rewind`、`compact`）也都经过它。对会话的任何操作，包括只读的 `read`，都要先经过 `LoopPort` 的会话锁拿到这个 `SessionManager`；本进程第一次拿到时先结束被打断的消息，所以重启后同时到达的两个请求不会各结束一次。如果另开一个 `SessionManager` 写同一个文件，写入的 entry 会变成活动分支之外的旁支，等于丢失。细节见 [agent-service.md](../design/agent-service.md) §9.3。

steer 进来的消息最后怎么样了，只有 harness 知道：写成了 entry、被扩展消费（不写 entry，结局是 `intercepted`），或者没被处理（pi 的 `steer()` 可能在 run 结束后才进队列）。所以 loop 按 `LoopPort` 给每条消息的 id、在发生的那一刻报告它的去向；工作结束时还没被报告的，就是没被处理，`LoopPort` 让下一段工作在队首接走它。按 id 而不按位置，是因为某条 steer 出错时，按位置会让后面的消息全部错位；当场报告，是为了让正在处理的消息也能查到已写入的 entry。进程中断的工作没有这份报告，所以它的消息结局是 `interrupted`，不带 entryId。按 user entry 的条数推断是不行的：被扩展消费的消息没有 entry，会被处理两遍。

### 4. 位置依赖（MUST 8，比 v0.1 弱）

- 会话**空闲**时，任何进程都能接手，状态全部可以从存储重建。
- 会话**有消息在处理或在排队**时，请求必须送到正在处理它的那个进程。

所以真正的水平扩展需要在前面放一个会话路由器。为了方便路由，每个针对单个会话的 HTTP 路由都把会话 id 放在路径里。只有三个例外：

- `POST /invoke`：会话 id 在 body 里；
- `POST /sessions` 带 fork：读一个会话、写另一个会话；
- `GET /sessions`：跨所有会话。

这三个属于 step 6（AgentCore 每个会话一个 microVM）要解决的问题。

### 5. 和 ACP 的关系

ACP 是双向兼容目标，在 step 5 实现：

- **FastAgent 作为 ACP agent**：通过一个桥接层把本协议映射到 ACP v1，供编辑器使用；
- **ACP agent 作为 harness**：通过 port 接入，能力会少一些，例如不支持 steer、没有持久队列。

ACP v1 表达不了三样东西：调用方自己命名的会话、幂等 key、在请求返回之后按 id 查询消息状态。

---

## 六、现状和未决问题

- **现状**：v1 在 step 4 替换了 v0.1，成为锁定的 [SPEC.md](../SPEC.md)。从 run 改为消息的这一版尚未实现，代码目前仍按 run 模型服务，step 4 内完成切换。
- **待实现**：pi-durable 作为第二个 harness（`harness: "pi-durable"`），直接实现 `HarnessPort`。
- **待设计**：
  - 跨进程租约和 AgentCore 横向扩展（step 6）；
  - 身份和权限（principal）；
  - 结构化结果（v0.1 的 `completed.data` 已删除，等有需求再设计）。
