---
title: fastagent — 战略定位
type: product-positioning
status: design
updated: 2026-06-05
---

# fastagent 战略定位

> 索引 [fastagent](fastagent.md) · 同目录 [core-design](core-design.md) · [comparisons](comparisons.md)

> 多角度盘点:用户需求 / 市场 / 生态位 / 竞品 / 历史类比 / SWOT。诚实优先,风险摆台面。

## 北极星

> **你已经把 agent vibe 出来了——它是你的 `AGENTS.md` + `skills/` 文件夹(一份 agent 定义)。fastagent 不碰它,加一份 config 就把它编译、部署成 production 服务:webhook 服务、定时 worker、Telegram/Slack bot、云端常驻 agent——落到任意 runtime(AgentCore / Lambda / Fly / Workers)。一份可移植定义,任意 target,引擎/模型/云全中立。**

fastagent = **agent serving 的 WSGI**:把「触发源 / 部署 target / agent 引擎」三方解耦的中立契约(`invoke`)+ 建在 pi 上的参考实现 + 「指向文件夹就部署」的工具链。**不是** Flask 式应用框架(你不在它里面写 agent,agent 是 pi 引擎 + 你的 markdown 定义),**不是** code-first SDK,**不是** batteries-included 产品。

> 术语:业界 **Agent = Model + Harness**,harness 含 turn loop = pi 的 `AgentHarness`。你的 `AGENTS.md`+`skills` 文件夹本文称 **agent 定义**,不叫 harness。

---

## 1. 真实用户需求

收紧的触发点:

> 用户对一个本地 agent 满意之后,迟早想要它**在我不盯着的时候也干活**——定时巡检、收 webhook、Telegram 随时找得到。**就在这一刻,本地工具模式(pi/Claude Code)必然失效,fastagent 成为唯一的路。**

| 人群 | 需求强度 | 契合 | 风险 |
|---|---|---|---|
| **A. 个人/power user**:攒了有用的 agent 定义,想让它自己跑 | 中,人群巨大且在涨 | **最高**,markdown-native 正中 | 很多人满足于本地按需跑,deploy 需求比人群浅 |
| **B. 团队把 agent 做进产品**:要 typed 输出/auth/可观测/上自家 infra | 高,有钱 | 中,但他们**会写代码**,更可能用 SDK | 竞争最激烈,markdown 优势最弱 |
| **C. indie hacker 做 agent 产品** | 高,重 DX | 中,和 Flue 抢同批人 | 直接撞 Flue |

**最锐、竞争最少、最契合的是 A 的"零重写把文件夹变成 always-on 服务、跑在任意地方"。** 诚实警告:deploy 需求的**深度可能比定义-文件夹人群规模浅**——叙事必须咬住"我不在时它要干活"这个本地模式必然崩的时刻,而非泛泛"productionize"。

## 2. 市场

- **agent 框架市场已很挤**:LangGraph / Vercel AI SDK / Mastra / CrewAI / OpenAI Agents SDK / Cloudflare Agents …… 绝大多数是 **code-first 编排**。
- **"部署/serving agent"作为 framing**:基本是**基础设施厂商自留地**(Cloudflare Agents/DO、Vercel、AWS AgentCore)——锁进它们的云。
- **markdown-native + 跨 runtime 中立这一格**:产品侧有 OpenClaw,**serving 契约层几乎空白**。真空。
- **serving 层的契约标准是空的**:ACP=editor↔agent(假设人在环 + editor 提供环境)、A2A=agent↔agent 网络(假设已是 running endpoint),**两个都不填「触发源↔agent」的 serving 砖缝**。webhook/cron 这个 serving 主入口干脆无标准。
- **时机对**:AGENTS.md / Agent Skills / MCP 正在 2025–26 收敛;每个 coding agent 都在产出定义文件夹,**这个 artifact 正在变成事实标准,而"部署它"无人认领。**

**最大威胁 — 平台吸收(已是现实,不是未来)**:
- **Claude Agent SDK + 官方《Hosting the Agent SDK》** 已经在教你把 Claude Code 跑成生产服务(subprocess、session、scaling、multi-tenant)——但**锁 Claude 引擎**。
- **OpenCode `serve`**(163K stars)已是 headless HTTP server + OpenAPI——但**锁 OpenCode**。

**唯一持久防线 = 开放、跨厂商、跨 host、跨引擎**:吃任何 coding agent 的定义、部署到任何 host、不绑任何模型/云/引擎。开放不是美德,是生存策略——WSGI 当年正是靠中立把 N×M 适配收敛成 N+M 活下来。

## 3. 生态位:盟友多、敌人少的水平层

```
模型层          Anthropic/OpenAI … + pi-ai(provider 抽象)
引擎层(harness)  pi-agent-core —— turn loop / env / sessions / tools / events   ← 参考实现底座
serving 契约层   ★ fastagent(invoke = WSGI;markdown-native、引擎/target 中立)  ← 我们在这
对外 wire 层     HTTP / A2A(agent 网络)/ ACP(editor) —— consume,不另立
target 层        Node / Fly / CF Workers / AWS AgentCore / Lambda / E2B —— 跨 runtime 编译,正交可插
产品/app 层      OpenClaw(成品) | A2A Task 编排 | 用契约造出来的东西
```

**不和 pi 竞争(是它客户),不和 host 竞争(target 它们),不和标准竞争(consume 它们)。** 同层对手只有 Flue,部分重叠 OpenClaw。押注:`invoke` 像 WSGI 一样把「agent 行为 ⊥ 怎么被触发/服务/host」解耦,让 channel/target/wire adapter 在它周围生长。

## 4. 竞品矩阵

| | 层 | agent 怎么定义 | 自带引擎? | 锁厂商/云/引擎? | 主用户 | 动词 |
|---|---|---|---|---|---|---|
| **pi-agent-core** | 引擎 | (引擎本身) | —— | 否 | 框架作者 | 跑一个 turn |
| **fastagent** | **serving 契约+实现+工具链** | **markdown 定义 + config** | 否(用 pi) | **否** | 有定义的人 | **把文件夹变服务、部署任意 target** |
| **Flue** | 框架 | code-first(TS) | 半(自带 harness) | 否 | 工程师 | 写 agent 再部署 |
| **OpenClaw** | 产品 | markdown | 是(整套) | 半(是个产品) | 想要助理的人 | 自托管+定制这 app |
| **Claude Agent SDK** | SDK + hosting | Claude Code 文件夹 | 是 | **是(Anthropic)** | Claude 用户 | 把 Claude Code 跑成服务 |
| **OpenCode `serve`** | 产品 server | OpenCode | 是 | **是(OpenCode)** | OpenCode 用户 | 跑 OpenCode server |
| **ACP** | 协议(editor↔agent) | —— | —— | 否 | editor/agent 作者 | IDE 连 agent |
| **A2A** | 协议(agent↔agent) | —— | —— | 否 | agent 作者 | agent 网络互调 |
| **AWS AgentCore** | host runtime | (任意,要适配) | —— | **是(AWS)** | AWS 用户 | serverless 跑 agent |

两条结构性差异化:**(a) 唯一 markdown-native + 引擎/模型/云全中立的 serving 层;(b) serving 这层的契约(WSGI 位)目前没人立——ACP/A2A 都在隔壁场景,大厂方案都锁自己生态。**

详细的 Flue / OpenClaw / Claude SDK / OpenCode 拆解见 [comparisons.md](comparisons.md)。

## 5. 历史类比(把定位讲活)

| 类比 | 映射 | 教训 |
|---|---|---|
| **① WSGI / PEP-333**(身份,最深) | `invoke` = agent serving 的 WSGI:不对外(对外是 HTTP/A2A/ACP),是「触发源/target/引擎」之间谁都不拥有的中立砖缝。WSGI 把 server⊥app 解耦,催生 gunicorn/uWSGI + Flask/Django 在一个契约周围繁荣 | **agent serving 还没有 WSGI(ACP=editor、A2A=网络都不填);谁立成契约,谁定义这一层** |
| **② Werkzeug + gunicorn**(参考实现) | pi(`AgentHarness`/`ExecutionEnv`/`SessionRepo`)= 引擎;fastagent 参考实现 = 把契约跑起来的那层 | **先有好用的实现,标准才水到渠成**——不是反过来 |
| **③ Vercel / Buildpacks**(部署 DX) | "指向我的文件夹 → 零配置编译 → 跑在任意 runtime + URL/channel" | 体感北极星;**但我们是开源 + 开放 target,不锁平台** |
| **④ TanStack**(架构风格) | `@fastagent/core`(headless `invoke` 单流 = AsyncIterable<AgentEvent>)+ `channel-*`/`target-*` 野蛮生长 | 拥有 headless 中立原语 + 端到端类型,让 adapter 生态生长 |
| **⑤ Flask**(只剩哲学姿态) | micro / 可组合 / 你装配 / 不 batteries-included / 开放中立 | **保留哲学,但 fastagent 占 WSGI 那格、不是 Flask 那格**——它不是让你写 app 的框架 |

> 关键修正:旧定位说"我们是 Flask"——错。Flask 是 build-time 应用框架(你用它写 app);fastagent 是 ship-time serving 层(app 已经是你的 markdown + pi)。**fastagent 站在 Flask 下游,占 WSGI 那一格。**

## 6. SWOT 与两个悬顶风险

| | |
|---|---|
| **S** | 唯一 markdown-native + 全中立的 serving 层(真空);serving 契约位无人立;无状态跨 runtime 解耦是工程壁垒;契约小而开放,盟友多敌人少 |
| **W** | 薄层 = **感知价值薄**("为啥不直接 pi + 几个脚本");deploy 需求**深度可能浅**;"我们是什么"难讲 |
| **O** | 成为 agent serving 的事实"部署契约"(像 WSGI 之于 Python web);adapter 生态社区化生长;随 AGENTS.md/Skills/MCP/A2A 一起赢;**做穿 AgentCore = 证明无状态设计 payoff** |
| **T** | **平台吸收已发生**(Claude Agent SDK Hosting / OpenCode serve);Flue 同层更快执行;大厂出竞品契约标准(A2A / Agent Executor);**标准不收敛** → "consume 标准"变"consume 5 个互不兼容标准" |

**最该正视的两个:**

1. **感知价值薄,是薄层的原罪。** WSGI/Flask 早期也被骂"不就是加几个装饰器"。破法只有一个:**DX 好到产生"原来这么简单"的情绪**——`point-at-folder → deploy anywhere` 必须丝滑到像魔法。契约干净是必要,**上手体感才是充分**。
2. **平台吸收是悬顶之剑,而且剑已出鞘。** Claude Agent SDK Hosting、OpenCode serve 已经在做"把 agent 跑成服务"——但都锁自己引擎。你赢的唯一方式:那天到来时,你已是**跨所有模型、所有云、所有 coding agent 的开放中立层**,而它们只能锁自己的生态。

## 7. 明确不做什么(边界)

| 边界 | 为什么 |
|---|---|
| **不和 OpenClaw 拼渠道** | 那是 OpenClaw 主场;在"做更好的私人助理"上必输。我们是你**用来造** OpenClaw-like 的层 |
| **不变 code-first SDK** | 那是 Flue 主场。差异化是"你的文件夹就是 agent",一旦让人 code agent 就蒸发 |
| **不另立 wire / 不造平行 agent 格式** | 内容层 consume AGENTS.md/Skills/MCP;对外 wire consume A2A/ACP/OCI。`invoke` 是**内部**契约,不对外、不对齐任何单一 wire 数据模型 |
| **不做 Task 编排层** | A2A 的 Task 状态机 / Artifact 版本 / 长任务查询 = **app 层**(adapter + userland),不进 core。"跨人/跨组织调度"是用 fastagent 造的 app,不是 framework |
| **不重造 harness 引擎** | 建在 pi 上。拥有 turn loop = 永久追前沿、零定位收益 |
| **不把 channel/target 焊进 core** | core 拥有**契约**不拥有**实现**。守住"小核、你装配"(WSGI/TanStack)的承诺 |
| **不靠对齐单一引擎换便利** | 事件流归一(`AgentEvent`)+ 终局归一(`completed`/`failed`)让 invoke 引擎中立——这是"可被任意引擎实现"的前提,不能为贴 pi 牺牲 |

## 一句话收口

> 护城河不是代码量(引擎是 pi 的),是**契约设计 + 无状态跨 runtime 解耦 + 部署 DX + 开放中立**。fastagent 赌的是:**agent serving 缺一个 WSGI,而它正好长在这个位置——让一代人觉得"把 vibe 出来的 agent 定义变成线上服务、跑在任意地方,就该这么简单"。** 「成为事实标准」是 huge upside,不是 base case;base case 是参考实现 + 部署 DX 本身够好用(WSGI 也是先有 gunicorn 好用)。
