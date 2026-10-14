---
title: SPEC v1 设计解读
description: "从产品设计、开发者与调用方、架构三个角度解读 Agent Handler 协议 v1 草案。"
status: draft
---

# SPEC v1 设计解读

规范原文见 [SPEC-v1.md](../SPEC-v1.md)，设计理由见 [agent-service.md](../design/agent-service.md) §7 和 §9。两者与本文不一致时，以 SPEC 为准。

## 一句话概括

SPEC v1 把 FastAgent 从一个"调一次、跑一轮、断开就停"的函数，改成一个**持有对话的服务**：

- 调用方把消息交给服务，服务先登记，再负责把活干完；
- 调用方可以随时离开，之后再回来查询结果、接着看进度，或者叫停；
- 每次工作都有编号、有记录，重启后也能查到。

---

## 一、为什么要有 v1：v0.1 的问题

v0.1 只有一个函数：`invoke(scope, prompt) => AsyncIterable<AgentEvent>`。它适合"嵌进程序里、调一次拿答案"，但不适合当服务用：

| v0.1 的规定 | 实际造成的问题 |
|---|---|
| 调用方停止读取，agent 必须停止工作（MUST 3） | 手机网络一断、网页一刷新，正在跑的任务就被杀掉 |
| 会话忙时直接拒绝（`session_busy`） | Telegram、Slack、飞书、定时任务各自写一套"等一等再试"的逻辑 |
| 工作没有编号 | 无法回答"我刚才那条消息处理了没有、结果是什么" |
| 没有幂等 | 进程崩溃后 channel 重投同一条消息，agent 可能把同一件事做两遍 |
| 读历史、steer、中止放在可选的 `/control/*` 扩展里 | 客户端要同时对接两套接口，两套状态还可能对不上 |
| 只有 `completed`/`failed` 两种结尾 | 说不清"被用户取消"和"进程重启打断"有什么区别 |

v1 的设计来源是两个本身就为长时间、多入口运行设计的 harness：pi-durable 和 DeepSeek Harness。ACP 的 v2 草案独立地走到了同一个模型，所以 ACP 被当作兼容目标，而不是直接采用的契约。

---

## 二、产品设计角度

### 1. 四个概念

| 概念 | 是什么 | 用户怎么感知 |
|---|---|---|
| **Session（会话）** | 一段对话，里面的工作共享同一份历史 | 一个 Slack 线程、一个网页聊天窗口、一个定时任务 |
| **Message（消息）** | 用户或 agent 说的一句话 | 只有内容，没有 id，也不能单独操作 |
| **Run（一次工作）** | agent 从接下一条消息到停下来的整个过程，中间可能调用模型和工具很多次 | "agent 正在忙"；"这次花了多少 token、成功还是失败" |
| **Entry（记录）** | 会话历史里的一条记录：消息、工具结果、run 的开始和结束、设置变更、压缩 | 聊天记录本身；断线后从哪里接着看；从哪里分叉 |

刻意不暴露的有两个：

- **step**：一次模型调用加上它触发的工具调用，属于 harness 内部；
- **turn**：这个词在业界一半人指 step、一半人指 run，所以干脆不用。v0.1 的 turn 等于 v1 的 run。

为什么调用方拿到的是 run，而不是"这条消息的结果"？因为 steer 进来的消息会并入同一个 run，真正有结局的只有 run。需要一个只属于自己的结果，就单独开一个会话。

### 2. 会话忙时怎么办：`whenBusy`

现在由调用方说明意图，服务来执行。只有服务能做到不出现竞争。

| `whenBusy` | 会话正在跑别的 run 时 | 典型场景 |
|---|---|---|
| `queue`（默认） | 排队，成为一个新 run，按到达顺序执行 | 群聊里连续来了几条消息 |
| `steer` | 并入正在跑的 run，在当前这轮工具调用结束后被读到 | 用户补充一句"对了，用英文回答" |
| `reject` | 直接拒绝，返回 `busy` | 定时任务不想堆积 |

会话空闲时，三种方式都会直接开始一个新 run。

### 3. 工作不依赖调用方存活

- 调用方停止读取只是**离开**（detach），工作继续进行。
- 叫停工作只能显式调用：
  - `runs.cancel`：停掉某一个 run；
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
- run 以 `completed` 结束时，`collect` 返回答案。
- 被拒绝、失败、被取消或被打断时，`collect` 都会抛错，不会把半截答案当成功。

### 2. 聊天界面

1. 打开会话：调用 `read()`，不带游标时返回**最新一页**（默认 100 条，页内从旧到新）。
2. 调用 `follow({ after: 最后一条的 id })`，先补齐中间漏掉的记录，再接实时事件，不丢也不重复。
3. 发消息：`invoke({ sessionId, prompt })`。
4. 渲染以下事件：
   - `message_delta`：逐字输出；
   - `tool_started` / `tool_progress`：工具执行中；
   - `entry`：已经落盘的正式记录。
5. 往上翻历史时，用 `prev` 游标继续 `read`。

只有 entry 是持久的，其余都是实时事件。断线重连后能看到所有漏掉的 entry，但看不到中间的逐字输出，这是有意的设计。

### 3. 可靠的 channel：飞书、Slack、Telegram

```ts
agent.invoke({
  sessionId: placeId,          // 一个群或线程
  idempotencyKey: platformMsgId,
  prompt,
});
```

- 平台重投、或者 FastAgent 崩溃后重发同一个 key，返回同一个 run，标记 `duplicate: true`，不会重复执行。
- 重复的那个流会从 `run_started` 开始重放整个 run，所以 `collect` 拿到的答案和第一次完全一样。
- 只有一个例外：上次的 run 是 `interrupted`（进程挂了），同一个 key 会开一个新 run。这样 channel 仍然是"至少一次"：
  - 要么已经有一个结果；
  - 要么由调用方明确决定重做。

  服务自己永远不会自动重跑，因为工具可能已经产生了副作用。

### 4. 断线恢复

```ts
const run = await session.runs.get({ runId });   // 或 { idempotencyKey }
for await (const e of session.runs.follow(runId, { after: lastEntryId })) { /* ... */ }
```

`runs.get` 返回 `undefined` 只有两种可能：这个 run 从来没被接受过，或者它的会话已经被删除。所以它可以安全地用来判断"要不要重发"。正因为如果存储故障时也返回 `undefined` 会误导调用方，规范允许这几个读操作在存储不可用时 reject 一个 `unavailable` 错误。

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
| 查询 run | `GET /sessions/{s}/runs/{r}`：查不到时返回 `200 null`，不用 `404`，避免和"路由不存在"混淆 |

连接在收到回执之前断开时，无法知道 run 有没有被接受：服务端只在 run 落盘之后才回复。带 `idempotencyKey` 时，用 `runs.get({ idempotencyKey })` 一查就知道，而且带着 key 重发无论如何都安全；不带 key 时，客户端不能把这次 invoke 报成 `rejected`，因为 `rejected` 的意思是"什么都没记录"，调用方会因此重发。

---

## 四、开发者角度：实现一个 Agent 或接入一个 harness

### 1. 必须遵守的五条（Agent MUST）

| 条款 | 含义 |
|---|---|
| 1. 一种结尾 | 读到底的流，要么只有一个 `rejected`，要么以自己那个 run 的 `run_ended` 结束；进程停止是唯一例外 |
| 2. 失败是事件 | 迭代 `invoke` 和 `follow` 永远不抛异常；失败的 run 以 `failed` outcome 结束 |
| 3. 离开不等于停止 | 调用方断开时只释放这个流占用的资源，run 继续 |
| 4. 先持久化再回执 | 发出 `accepted` 之前，run 的 id、key 和来源必须已经落盘；每个 run 恰好一条 `run_ended`；永不自动重跑 |
| 5. 能力如实声明 | 做不到的操作返回 `unsupported`，不能悄悄忽略、模拟或降级 |

调用方这边有两条，与 v0.1 相同：

- 不认识的事件类型和 entry 类型直接忽略；
- 中间层转发时必须原样透传。

### 2. 几条容易做错的语义

- **幂等的原子性**：查 key、登记 run、入队必须在同一个会话内串行完成。同一个 key 并发进来，只能产生一个 run。
- **steer 的承诺**：消息一旦被接受为 `joined`，在 run 读到它之前，这个 run 不能结束。所以回执不需要等 harness 确认。
- **`interrupted` 的收尾**：重启后第一次打开这个会话时，先补写 `run_ended`，再回应任何操作。这样重连的 `runs.follow` 不会永远等下去。
- **会话的生命周期**：
  - invoke 一个不存在的会话会自动创建它；
  - 其他操作遇到不存在的会话返回 `not_found`；
  - fork 只能通过 `sessions.create` 完成。

### 3. 能力声明：`info().capabilities`

不同 harness 能力不同，客户端读一次即可，因为它在 agent 的整个生命周期内固定不变。

| 能力 | pi-coding-agent（通过 `LoopPort` 接入） | pi-durable |
|---|---|---|
| `steer` | 支持 | 支持 |
| `fork` | 支持 | 支持 |
| `rewind` | 支持 | 不支持，暂无对应调用 |
| `delete` | 支持 | 待定 |
| `durableQueue`：重启后排队的 run 还在 | 否 | 是 |
| `durableRuns`：重启后正在跑的 run 继续跑 | 否 | 是 |

### 4. 上限

| 项目 | 取值 |
|---|---|
| 每个会话的排队 run | 20 个 |
| 每个进程同时在途的 run | 参考实现 100 个 |
| `read` 每页 | 默认 100 条，最多 500 条，参考实现到 4 MiB 截断 |
| `idempotencyKey` 长度 | 1 到 256 个字符 |

超过上限时返回 `busy`，并在 `details.reason` 里说明是哪一种：`running`、`queue_full` 或 `capacity`。

### 5. 一套 conformance suite

所有 harness 都跑同一套测试，分别在进程内和通过 HTTP 各跑一遍。覆盖的范围：

- 回执和结尾；
- 三种 `whenBusy`；
- 幂等，包括并发和 `interrupted` 的例外；
- 断开、取消、中止；
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
存储         .state/（文件系统）；将来 AgentCore 上换成 API 存储
```

channel、定时任务和 wake 不再走特殊通道，它们和外部应用一样调用同一个协议，只是在进程内多一个 `source` 字段。远程调用方不能设置 `source`，所以没人能冒充 channel。

### 2. 队列放在哪里

设计时比较过两种方案：

| | A：队列放在服务层 | B：队列放在 port 后面（选定） |
|---|---|---|
| 自带持久队列的 harness（pi-durable、dsh） | 它的队列用不上，重启后排队的 run 会丢 | 直接使用它的原生队列，重启不丢 |
| 只有循环的 harness（pi、ACP agent） | 直接可用 | 由共享的 `LoopPort` 补上队列、run 编号和开始/结束记录 |

选 B，因为接入 pi-durable 的意义就在于它的持久性。

steer 必须交给 harness 实现：只有它的循环知道一个 step 在哪里结束。从外面只能杀掉正在执行的工具，或者等 run 结束。

### 3. 状态放在哪里

一个 run 的状态由两份持久记录推导出来：

1. **run 记录**：id、key、来源，在回执前写入。
2. **会话日志**：其中包含 `run_started` 和 `run_ended`。

只有实时事件放在内存里。对只有循环的 harness，排队顺序和当前 run 也在内存里。内存丢了不会让 run 凭空消失，它会被认定为 `interrupted`。

对 pi-coding-agent，`LoopPort` 把这两份记录都写进 pi 的会话日志，共三种记录，每条都带自己的 runId：

- `run_accepted` 是 plane marker：不对外发布、不能作为 rewind 目标、模型看不到、fork 不复制。
- `run_started` 和 `run_ended` 是 run marker：SPEC v1 要求对外发布（`read`、`follow`、重复 invoke 的重放都要读到），但模型同样看不到，fork 也不复制，因为 fork 只复制历史、不复制 run。

对 ACP agent，ACP 没法往 agent 的历史里追加自己的记录，所以 `LoopPort` 自己保存整份日志，run 记录也写在里面。
不单独存一个文件，因为两个文件没法原子写入。pi-durable 也一样：它的 submission 是单独一张表，但和 entry 在同一次 commit 里写入。

这要求每个会话的日志只有一个写者。从第一次有操作拿到会话，到会话空闲、队列为空且没有操作持有它，`LoopPort` 一直持有这个会话唯一的 `SessionManager`，每个 run 新绑定的 `AgentSession` 都用它，所有写入（标记、被撤回 run 的 `run_ended`、`update`、`rewind`、`compact`）也都经过它。对会话的任何操作，包括只读的 `read`，都要先经过 `LoopPort` 的会话锁拿到这个 `SessionManager`；本进程第一次拿到时先补写中断 run 的 `run_ended`，所以重启后同时到达的两个请求不会各写一条。如果另开一个 `SessionManager` 写同一个文件，写入的 entry 会变成活动分支之外的旁支，等于丢失。细节见 [agent-service.md](../design/agent-service.md) §9.3。

steer 进来的消息最后怎么样了，只有 harness 知道：写成了 entry、被扩展消费（不写 entry），或者没被处理（pi 的 `steer()` 可能在 run 结束后才进队列）。所以 loop 按 `LoopPort` 给每条消息的 id、在发生的那一刻报告它的去向；run 结束时还没被报告的，就是没被处理，`LoopPort` 在同一个 run 里补跑，并把每条消息对应的 entry 记进 `run_ended`。按 id 而不按位置，是因为某条 steer 出错时，按位置会让后面的消息全部错位；当场报告，是为了让运行中的 run 也能查到已写入的 entry。进程中断的 run 没有这份记录，所以它的消息不带 entryId。按 user entry 的条数推断是不行的：被扩展消费的消息没有 entry，会被跑两遍。

### 4. 位置依赖（MUST 8，比 v0.1 弱）

- 会话**空闲**时，任何进程都能接手，状态全部可以从存储重建。
- 会话**有 run 在跑或在排队**时，请求必须送到正在处理它的那个进程。

所以真正的水平扩展需要在前面放一个会话路由器。为了方便路由，每个针对单个会话的 HTTP 路由都把会话 id 放在路径里。只有三个例外：

- `POST /invoke`：会话 id 在 body 里；
- `POST /sessions` 带 fork：读一个会话、写另一个会话；
- `GET /sessions`：跨所有会话。

这三个属于 step 6（AgentCore 每个会话一个 microVM）要解决的问题。

### 5. 和 ACP 的关系

ACP 是双向兼容目标，在 step 5 实现：

- **FastAgent 作为 ACP agent**：通过一个桥接层把本协议映射到 ACP v1，供编辑器使用；
- **ACP agent 作为 harness**：通过 port 接入，能力会少一些，例如不支持 steer、没有持久队列。

ACP v1 表达不了三样东西：调用方自己命名的会话、幂等 key、按 id 查询 run 状态。

---

## 六、现状和未决问题

- **现状**：[SPEC-v1.md](../SPEC-v1.md) 是草案，代码仍然实现 [v0.1](../SPEC.md)。step 4 落地后，v1 替换 `docs/SPEC.md` 并锁定。
- **待设计**：
  - harness port 的具体接口；
  - pi-durable 的几个缺口：失败后队列不会自动继续、没有 rewind 和 delete；
  - 跨进程租约和 AgentCore 横向扩展（step 6）；
  - 身份和权限（principal）；
  - 结构化结果（v0.1 的 `completed.data` 已删除，等有需求再设计）。
