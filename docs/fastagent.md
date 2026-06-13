---
title: FastAgent
type: product-overview
status: design
updated: 2026-06-11
domain: https://fastagent.sh
---

# FastAgent

> 把你用 Claude Code / Codex vibe 出来的 **agent 定义**(`AGENTS.md` + `skills/`),**零重写**编译、部署成 production 服务——webhook 服务 / 定时 worker / Telegram·Slack bot / 云端常驻 agent,落到任意 runtime(AgentCore / Lambda / Fly / Workers)。
>
> **agent serving 的 WSGI。** 一套把「触发源 / 部署 target / agent 引擎」三方解耦的 serving 契约(`invoke`)+ 建在 pi 上的参考实现 + 「指向文件夹就部署到任意地方」的工具链。三件套对位:**WSGI(契约)· Werkzeug+gunicorn(实现=pi)· Vercel+Buildpacks(部署)**。引擎/模型/云全中立。

## Why this product (AI wedge)

**触发时刻**:用户对一个本地 agent 满意之后,迟早想要它**在我不盯着的时候也干活**——定时巡检、收 webhook、随时在 Telegram 找得到。就在这一刻,本地工具模式(pi / Claude Code / Codex)必然失效。

**今天的缺口**:每个 coding-agent 用户都已攒下 agent 定义文件夹(`AGENTS.md` + `skills/` + 标准 markdown),却**没有一条不重写就能把它变成 production 服务的路**。这个 artifact 正在成为 agent 的事实创作形态(AGENTS.md / Agent Skills / MCP 标准 2025–26 收敛中),而"部署这个 artifact"无人认领——serving 这层的「触发源↔agent」中立契约是空的(ACP=editor、A2A=agent 网络,都不填)。

**AI wedge**:fastagent **消费标准、不另立格式**,于是你 vibe 出来的文件夹**零重写**就是部署产物——`point-at-folder → live service`。这是 code-first 框架(Flue)结构上吃不到的人群,也是成品助理(OpenClaw)主动放弃的通用性。

**防御**:不锁模型 / 不锁云 / 不锁某个 coding agent。平台吸收**已是现实**(Claude Agent SDK + 官方《Hosting》文档、OpenCode `serve`),但它们都锁自己的引擎。开放中立是唯一持久防线——正是 WSGI 当年靠中立把 N×M 适配收敛成 N+M 的方式。

## Product boundary

FastAgent is the product unit in this repository: a neutral agent-serving contract (`invoke`), a pi-based reference implementation, and a deployment toolchain for turning existing agent definitions into services on any runtime.

## Design summary

> **Conclusion: FastAgent is agent-serving WSGI (contract + reference implementation + deployment toolchain), not a Flask-style application framework.** The supporting design rationale lives in the documents below.

### 文档导航(本目录)

| 文档 | 内容 |
|---|---|
| [SPEC](SPEC.md) | **Agent Handler 协议规范**(契约层,引擎中立):`invoke(scope, prompt) => AsyncIterable<AgentEvent>`、5 事件、3+1 MUST、宗 ASGI、对标 fetch handler |
| [positioning](positioning.md) | 战略定位:用户需求 / 市场 / 生态位 / 竞品矩阵 / 历史类比 / SWOT / 明确不做什么 |
| [core-design](core-design.md) | 核心设计:agent serving 的 WSGI(契约层/实现层分清)、pi 双口 fan-in 成 SPEC 单流(toAgentEvent/toTerminal 两 translator)、无状态多-session(每 invoke 现起 harness)、装配点二维归类、tools/skills 挂载、config v1、对外 consume A2A/ACP、跨 runtime 编译 |
| [comparisons](comparisons.md) | Flue / OpenClaw / pi 深度对比 + "GitHub issue 三连" worked example |

### 关键结论速记

- **占 WSGI 那一格,不是 Flask。** fastagent 不是写 agent 的框架(agent = pi 引擎 + 你的 markdown 定义),是让现成 agent 能被服务/部署的中立层。三件套:WSGI(契约)· Werkzeug+gunicorn(参考实现=pi)· Vercel+Buildpacks(部署工具链)。
- **invoke = agent serving 的 WSGI 位**:不对外(对外是 HTTP/A2A/ACP),是「触发源/target/引擎」三方解耦的中立契约。WSGI 不对外,invoke 不对外恰恰证明它在 WSGI 位,不是反例。
- **对 pi 的依赖收敛到两个 translator**(`toAgentEvent` 流内事件 + `toTerminal` 终局):非 pi 引擎实现同样的映射就能提供 invoke。早期「AgentObservation 8 语义」设计已坍缩进 SPEC 的 5 事件单流。
- **建在 `AgentHarness`(pi-agent-core),不是 `AgentSession`(TUI 封装)**:前者 `prompt()=>AssistantMessage` buffered,是 invoke 天然底座。
- **无状态多-session**(实现为 `createPiAgentFromHarness`/`createPiAgent`):每 invoke 现起一个绑 session 的 harness,用完即弃;唯一活态是"在飞的 turn"。能 serverless、部署 AgentCore 的地基。
- **真空缺 = markdown-native + 引擎/target/云中立的跨 runtime 部署**:试金石 = 一条命令把现成 `AGENTS.md`+`skills` 部署到 AgentCore 跑通。没人做到(Claude SDK 锁 Claude、OpenCode serve 锁 OpenCode、ADP 要写新 manifest)。
- **对外 consume 标准,不另立 wire**:A2A(agent 网络,只在 Message 层)/ ACP(editor,角色倒置→只能可选 channel)/ webhook(主入口无标准,自定义)。invoke 不对齐 A2A 数据模型(pi-shaped),双 seam 喂 A2A 的 push executor。
- **术语校准**:业界 Agent = Model + Harness,harness 含 turn loop = pi 的 `AgentHarness`;你的 `AGENTS.md`+`skills` 文件夹本文称 **agent 定义**,不叫 harness。
- **护城河**:契约设计 + **无状态跨 runtime 解耦**(moat,工程积累)+ 部署 DX(wedge,可复制)+ 开放中立。
- **两个悬顶风险(已是现实)**:薄层感知价值薄;平台吸收(Claude Agent SDK Hosting / OpenCode serve 已发生)。中立是唯一持久防线;「成为标准」是上行期权,不是 base case。

### ⚠️ 状态与边界

- [core-design](core-design.md) is the implementation-design source of truth; the code source of truth is `core/`.
- **"跨人/跨项目/跨组织调度"** 是你**用 fastagent 造出来的一类 app**(A2A Task 层 / workflow,framework 之上),不是 framework 本身——三件套在"组织级 Agent 协作"场景的落点,不与"serving 的 WSGI"产品形态冲突。
- **autonomy 安全(狂徒锁链落点)= v2 纵深**,不是第一性发生点;部署通了之后才成为下一道缝。

## 现状

core v0.1 本地 dev 链路已闭合:SPEC 参考实现(pi 双口 fan-in)、L0–L3 装配阶梯、HTTP/SSE channel、`fastagent dev`、持久 session(jsonl,重启存活)。下一步:`build`/`start`,再到 AgentCore target adapter(试金石)。
