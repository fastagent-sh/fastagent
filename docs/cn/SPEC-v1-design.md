---
title: SPEC v1 设计解读
description: "解读 Agent API v1：一个服务化 agent 对消费者提供的接口，为什么是这个形状，以及它和 pi-durable 的关系。"
status: current
---

# SPEC v1 设计解读

规范原文见 [SPEC.md](../SPEC.md)，架构和取舍见 [architecture.md](../design/architecture.md)。两者与本文不一致时，以
英文原文为准。

## 一句话概括

一个部署好的 agent 就像一个 bot：能访问到它的人都可以和它对话。SPEC v1 只定义这个 bot 对**消费者**提供的接口，一共 7 个操作，
进程内（TypeScript）和 HTTP 两种绑定，语义完全相同。其余一切（改模型、压缩、查看所有会话）都是 harness（pi-durable）自己的
API，不在 SPEC 里。

## 1. 为什么是这个形状

上一版 SPEC v1 想做一个“任何 harness 都能实现”的中立协议，为此定义了 harness 端口和 `LoopPort`，在 pi-coding-agent 上模拟
pi-durable 原生就有的排队、幂等和消息记录，又在 pi-durable 上重建它不保存的事实。这些工作标准化的恰恰是各家 harness 差异最大、
变化最快的部分，而产品目标里没有一个需要它。

所以这一版换了两个前提：

- **只用一个 harness：pi-durable。** 它原生有服务化需要的东西：按 `whenBusy` 准入、按请求 id 去重、每条消息持久地结束一次、
  重启后接着回答，存储和执行环境也都可以替换。
- **只定义我们自己必须定义的那一层：消费者 API。** 我们自己的 channels、定时任务、wake、REPL 都是消费者，它们只用这 7 个操作
  就够了，这说明这一层是完整的。它同时把 pi-durable 的实验性 API 和内部 entry 种类挡在客户端之外。

## 2. 七个操作

| 操作 | HTTP | 做什么 |
|---|---|---|
| `info` | `GET /agent` | bot 的名字和简介 |
| `invoke` | `POST /invoke` | 发一条消息：不带 `sessionId` 就新建会话。默认返回 SSE 流；`Accept: application/json` 时等消息结束后一次性返回 |
| `createSession` | `POST /sessions` | 新建空会话；带 `from` 就是从某个会话的某条 entry 分叉（开 thread、“从这里分支”） |
| `read` | `GET /sessions/{s}` | 状态加一页历史；不带游标返回最新一页，`before` 往前翻，`after` 往后读 |
| `follow` | `GET /sessions/{s}/events` | 游标之后的 entry，然后接上实时事件；断线用 `Last-Event-ID` 续上 |
| `abort` | `POST /sessions/{s}/abort` | 停止当前回答，并撤回所有排队中的消息；命名沿用 pi-durable 的 `abort` |
| `attachment` | `GET /sessions/{s}/attachments/{ref}` | 读历史里图片的内容 |

进程内的 `invoke` 返回一个既能逐条读事件、又带 `result` 的对象：只想要最终回答就 `await invocation.result`，替代了原来的
`collect`。

## 3. 几个关键决定

- **会话 id 由服务端生成，调用方自己记住。** pi-durable 不接受调用方指定的会话 id。channel 和定时任务在自己的状态里记“哪个聊天
  对应哪个会话”。服务端不提供会话列表，也不提供删除。
- **会话 id 就是这个会话的钥匙。** bot 对所有人开放，谁持有会话 id，谁就能读、跟随、发消息、停止、从它分叉。所以 SPEC 要求
  会话 id 不可猜测（至少 122 位随机数，和 UUIDv4 一样）。认证、限流由上层负责。
- **幂等 key 必须和 `sessionId` 一起用。** pi-durable 的 key 只在单个会话内有效；不带会话的 invoke 如果重试，会建出两个会话。
  想安全重试第一条消息，就先 `createSession` 拿到 id，再带 key 发。
- **查一条消息的结局，就用同一个 key 再发一次。** 返回同一条消息（`duplicate: true`），流里重放它从自己的 entry 到回答的内容，
  以同一个 `done` 结束。这替代了原来的 `messages.get` 和 `messages.follow`。
- **消息的结局只有四种：** `completed`、`max_tokens`、`canceled`、`failed`。没有 `interrupted`：进程重启后 pi-durable 会接着
  回答已取走的消息，排队的消息也还在。`answer` 只在 `completed` 和 `max_tokens` 时出现，执行过工具调用的中间回复不算回答。
- **用量记在 entry 上：** 每条 `assistant_message` 一份，`compaction` 记生成摘要的那几次调用；fork 复制来的 entry 不带。
  单个会话内或跨会话相加，每次模型调用都只算一次。
- **浏览器也只是一个调用方。** HTTP 上带 body 的请求必须是 `content-type: application/json`，否则在读取之前就拒绝：表单或
  `text/plain` 的跨域 POST 不经过预检，拒绝返回结果也挡不住已经开始的运行。

## 4. 不在 SPEC 里的

| 不在 SPEC 里 | 去哪里 |
|---|---|
| 改模型、思考档位、压缩、查看或列出所有会话 | pi-durable 的原生 API（`agent.harness`）；需要 HTTP 的话，开发者自己写一个路由 |
| 列出、删除会话 | 不提供：调用方自己记，数据不删除 |
| rewind、编辑消息、重新生成 | 不提供：用“从这里分叉”加“重新发一次”代替 |
| 身份、认证、限流 | 上层（网关、私有网络、云的 IAM、嵌入方的中间件） |
| 图片以外的文件上传 | 这一版不做 |
| A2A 等其他协议 | 以后在这套 API 外面再包一层 |

## 5. 和上一版的对照

| 上一版 v1 | 这一版 v1 |
|---|---|
| harness 无关的协议，加 harness 端口和 `LoopPort` | 只有 pi-durable，SPEC 只管消费者接口 |
| 调用方可以给会话命名 | 服务端生成不可猜测的 id |
| `sessions.list`、`rewind`、`compact`、`update`、`delete`、`/control` 平面 | 去掉；需要的用 pi-durable 原生 API |
| `messages.get`、`messages.follow`、`messages.cancel` | 用同一个 key 重发；停止用 `abort` |
| `sessions.create({ fork })` | `createSession({ from })` |
| `GET /sessions/{s}/follow` | `GET /sessions/{s}/events` |
| `capabilities`、`durableQueue`、`durableTaken` | 去掉：只有一个实现，持久性直接写进 MUST |
| `intercepted`、`interrupted` 结局，`source` 字段 | 去掉：pi-durable 不产生前两种，`source` 没有读者 |
| `collect` | `invocation.result`，或 HTTP 的 JSON 等待模式 |
