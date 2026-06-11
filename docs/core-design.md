---
title: fastagent - 核心设计(参考实现)
type: design-doc
status: design
updated: 2026-06-11
share_link: https://qsort.me/e7yv5ox2
share_updated: 2026-06-08T16:43:10+08:00
---

# fastagent - 核心设计(参考实现)

> 索引 [[fastagent]] · 协议 [[SPEC]] · 同目录 [[positioning]] · [[comparisons]]

> **契约层已抽到 [[SPEC]](Agent Handler 协议,引擎中立)。本文只讲 fastagent 的参考实现--怎么用 pi 实现那个协议 + 怎么部署到任意 runtime。** repo 现有实现(config.yaml + 焊死 channel)以本文为准重构,不背向后兼容。

## 0. 定位:三件套

> **fastagent = agent serving 的 WSGI**(对外易懂的说法;技术宗谱是 ASGI / fetch handler,见 [[SPEC]])。一套把「触发源 / 部署 target / agent 引擎」三方解耦的 serving 契约,加一个建在 pi 上的参考实现,加一条「指向文件夹就部署到任意 runtime」的工具链。

| fastagent 层 | 干什么 | web 世界对应 | 在哪定义 |
|---|---|---|---|
| **契约层** | Agent Handler:`invoke(scope, prompt) => AsyncIterable<AgentEvent>` | **fetch handler / ASGI** | **[[SPEC]]** |
| **参考实现层** | 建在 pi-agent-core 上,把协议跑起来 | Werkzeug + gunicorn | 本文 §3-5 |
| **工具链层** | 指向 agent 定义文件夹 → 编译 → 部署到任意 target | Vercel + Buildpacks | 本文 §6 |

核心发明是**契约层**(那套 primitives);参考实现和工具链让它好用、先活下来。fastagent 占的是 **gateway 那一格,不是 Flask**--它不是让你写 agent 的框架(agent 是 pi 引擎 + 你的 markdown 定义),是让现成 agent 能被服务/部署的中立层。

## 0.5 core 设计目标:N×M×K 的分层口径(定稿)

产品目标是把 **N triggers × M agents × K hosts** 从相乘塌成相加。但三个轴不是一个契约扁下来的,是三道缝,分属不同层--**core 只直接管 N×M**:

| 轴 | 由什么解耦 | 在哪一层 |
|---|---|---|
| **N×M**(trigger ↔ agent)| `invoke` 的签名 + 事件([[SPEC]])| **core / 契约** |
| **M**(引擎多样)| invoke 是黑盒接口 + 装配层注入(定义装载 → `LoadedDefinition` → 装配出 `Agent`)| core(依赖反转)|
| **K**(host 多样)| invoke 的无状态性质(SPEC MUST「无位置依赖」)+ `SessionStore`/`ExecutionEnv` 注入,使 host 可替换;真正"编译到某 runtime" = target adapter | K 的*可*解耦在 core,K 的解耦*动作*在工具链层(SPEC §10 out of scope)|

精确口径:**`invoke` 是 N×M 的窄腰;core 的无状态不变量 + DI 注入点,是让「×K」可被上层塌掉的钩子;K 本身的塌缩(target adapter)不在 core、不在 SPEC。** core = 对引擎中立、且被约束成 host-可移植的 serving 契约,不是"N×M×K 三轴契约"。

对位 wedge/moat:N×M(invoke 契约)= **wedge**(忠实、无新机制、可复制);×K(target adapter)= **moat**(逐 runtime 啤异构,工程积累)。

## 1. 用户与空缺(发生点)

**触发时刻**:用户用 coding agent(Claude Code / pi / Codex)vibe 出了一个 agent 定义文件夹(`AGENTS.md` + `skills/`),想让它「在我不盯着时也干活」--收 webhook、定时巡检、随时在 Telegram 找得到。**这一刻本地交互式工具模式必然失效。**

**覆盖地图(谁锁死/缺失什么轴)**:

| 现有实现 | 在哪轴掉链子 |
|---|---|
| pi / Claude Code / Codex | 常驻、机器触发、多租户、部署 全缺 |
| Claude Agent SDK + Hosting | **锁 Claude 引擎** |
| OpenCode `serve` | **锁 OpenCode 这个 agent** |
| ACP | 假设人在环 + editor 提供环境;是 IDE 协议非 serving |
| A2A | 假设 agent 已是 running endpoint,不管你怎么变出 endpoint |
| ADP / Ninetrix / Agent Executor | 要写新 manifest 重定义,不消费现成文件夹 |
| Flue | code-first,吃不到「已 vibe 出 markdown 定义、不想写代码」的人 |
| Hermes Agent / OpenClaw | 常驻多-channel 个人 agent 产品:N 轴做得全(Telegram/Discord/cron...),但**垂直一体、锁自家引擎/定义**,不消费现成 AGENTS.md、非中立 serving 层 |

**空缺 = 消费现成 markdown 定义、引擎/target/云中立、机器触发的跨 runtime 部署**。没有一个现有方案落在这。

**试金石(也是 search→MVP 的 exit condition)**:能否一条命令把一个现成 `AGENTS.md`+`skills` 部署到 **AWS AgentCore**(serverless、每 invocation 现起 runtime、session 外置)并跑通一次 invoke。AgentCore 最难、最能证伪 core 是否真无状态;做穿它 = 设计成立。

## 2. 概念框架(对齐业界)

业界 2025-26 已收敛:**Agent = Model + Harness**,Harness = model 之外的一切(含 turn loop、tools、sandbox、memory、permissions)。

术语校准:
- 业界的 **harness**(含 loop)= **pi 的 `AgentHarness`**。Hermes Agent(Nous)、OpenClaw、Claude Code 同为「harness + 捆绑 serving」的垂直产品形态。
- 你 vibe 出的 `AGENTS.md`+`skills` 文件夹,本文称 **agent 定义(agent definition)**,**不叫 harness**--它是"内容/定义",不是执行系统。

**prompt 层的精确口径(定稿;AGENTS.md ≠ system prompt)**。最终发给模型的 system prompt 是 harness **组装**的产物,四段式(pi/Claude Code 同构,已验证 pi 源码):

| 段 | 内容 | 谁拥有 |
|---|---|---|
| 1 base prompt | 身份、工具使用规范、行为准则(质量大头) | **引擎 binding 资产,继承自引擎**(pi binding → `piBasePrompt`,镜像 pi 的、按实际 tools 参数化、去 pi-TUI 文档段;claude/codex 引擎的 SDK 内部自带组装,binding 无需注入。理由:定义作者在该引擎下 vibe 出 AGENTS.md,换 base = 行为漂移、违背忠实性。可配置覆盖) |
| 2 instructions | **AGENTS.md 的内容**,被包成 `<project_instructions>` 注入 | **agent 定义**(定义装载 `definition.ts` 读出) |
| 3 skills listing | `<available_skills>` 列表,指引模型按需读 SKILL.md(需 read 工具才真可用) | 定义(定义装载读出)+ prompt 组装格式化 |
| 4 env context | date / cwd | harness 生成 |

即:**AGENTS.md = 项目级指令("README for agents"),只是注入物 2;定义装载的产出是 instructions + skills,不是 systemPrompt;最终 systemPrompt 由 prompt 组装(`assembleSystemPrompt`)产出。**

标准已分四层,fastagent 在每层的姿态:

| 层 | 事实标准 | fastagent |
|---|---|---|
| 内容/定义 | AGENTS.md · Agent Skills · MCP | **consume** |
| 调用(editor↔agent) | ACP | 可选 channel(见 §6) |
| 调用(agent↔agent) | A2A | consume(见 §6) |
| **serving(触发源↔agent)** | **空** | **Agent Handler([[SPEC]])= 这一层的 gateway** |
| 打包/部署 | OCI · ADP | target adapter 输出(见 §6) |

## 3. 契约 = [[SPEC]]

契约层不在本文重复定义--见 [[SPEC]]。要点(供下文实现参照):

```ts
interface Agent { invoke(scope: Scope, prompt: Prompt): AsyncIterable<AgentEvent>; }
```
- 一个 turn = 一次 `invoke`,返回单一异步事件流(`text` / `tool_*` / `completed` / `failed`)。
- `Scope` 核心只 `session`;buffered 是 `collect()` 退化;3+1 条 MUST(终局唯一 / cancel-cleanup / 忽略未知非终局 / 可选 portable 无位置依赖)。
- **引擎中立**:任何引擎只要把"跑一个 turn"包成这个流就合规。fastagent 是用 **pi** 实现它的参考实现。

## 4. 参考实现:用 pi 实现 Agent Handler

**底座 = `AgentHarness`(pi-agent-core),不是 `AgentSession`(pi-coding-agent)。** 后者是 TUI 封装,绑 SettingsManager/ResourceLoader/ExtensionRunner + 直接读盘。`AgentHarness` 宿主中立,只要 `env` + `session` + `tools` + `model` + `systemPrompt`。

pi 的 `AgentHarness` 有**两个口**:`prompt(text) => Promise<AssistantMessage>`(buffered 终值)+ `subscribe(piEvent)`(事件旁路)。SPEC 的**单一事件流**,就是把这两个口 **fan-in** 成一个 async generator:

```ts
// invoke(scope, prompt) 的参考实现(与代码同步,见 engines/pi/invoke.ts):把 pi 双口 fan-in 成单流
async function* invoke(scope: Scope, prompt: Prompt): AsyncIterable<AgentEvent> {
  const release = lease.tryAcquire(scope.session);          // 单写者,fail-fast(见 §6.6)
  if (!release) { yield failedBusy(); return; }             // "session busy",不排队
  try {
    const harness = await harnessFactory(scope.session);      // 每 invoke 现起,open-or-create session
    const queue = new EventQueue<AgentEvent>();
    const unsub = harness.subscribe(pe => queue.push(toAgentEvent(pe))); // pi event → AgentEvent
    try {
      const run = harness.prompt(prompt.text, { images: prompt.images });
      yield* queue.drainUntil(run);                         // text / tool_* 边跑边 yield
      yield toTerminal(await run);  // completed / failed -- MUST inspect resolved message 的 stopReason
    } finally {
      unsub(); await harness.abort();                       // 清理绝不抛(MUST 2/3)
    }
  } finally {
    release();                                              // cancel/正常结束都释放
  }
}
```

**关键点:**
- **单一 translator**:`toAgentEvent`(pi 事件 → `AgentEvent`)+ `toTerminal`(pi `AssistantMessage` → `completed`/`failed`)。对 pi 的全部依赖收敛到这一处。SPEC 坍成单流后,旧版的"两个 translator + 双 seam"也坍成"一个 generator fan-in 双口"。
- **`failed` 以 stopReason 为准,不只靠 catch**:pi 的 `prompt()` 在模型错误/abort 时**不一定 throw**--常态是 resolve 一个 `stopReason: "error" | "aborted"` 的 `AssistantMessage`。所以 `toTerminal(await run)` MUST inspect resolved message 的 `stopReason`(`error`/`aborted` → `failed`);外层 `try/catch` 只兑底真正的 throw。光靠 catch 会漏掉一整类失败,违反 SPEC MUST 1。
- **无状态多-session**:pi 是「1 harness = 1 session」;fastagent 要服务无数 session,所以**每 invoke 现起一个绑该 session 的 harness,用完即弃**。唯一活态 = 在飞的 turn,两次 invoke 之间没有不可重建的东西。**这是能 serverless、能部署 AgentCore 的最硬地基。**
- **cancel 落地**:消费者 `break` → generator 收到 `return()` → `finally` 跑 `harness.abort()` + `lease.release()`。SPEC MUST 2 天然由 async generator 的 cleanup 兑现。

实现层注入点(协议看不到,见 [[SPEC]] §9 依赖反转)--**已实现的实际签名**:

```ts
// 低层：引擎接线被打包进 harnessFactory（PiHarnessFactory）；lease = 进程内 fail-fast 单写者（§6.6）
createPiAgentFromHarness({ harnessFactory: (session: string) => AgentHarness, lease?: Lease }): Agent
// 中层:batteries-included(repo/env/auth/lease 全有默认、可覆盖)
createPiAgent({ model, systemPrompt?, tools?, skills?, repo?, env?, getApiKeyAndHeaders?, lease? }): Agent
// 高层:指向文件夹(装载定义 + 组装 prompt + 默认工具)
createPiAgentFromDefinition(dir, { model, ... }): Promise<{ agent, definition }>
// 顶层:指向 workspace(定义 + fastagent.config.ts):装载 config → 解析 model/tools → L2
createPiAgentFromWorkspace(dir, { model? }): Promise<{ agent, definition, config, configPath?, modelSpec }>
```

四级返回同一契约类型 **`Agent`**(做 IO 的 L2/L3 另附装载产物--`LoadedDefinition` / config--供 caller surface 诊断)--消费者永远拿到同型的 Agent,不感知装配级别。跨进程 lease 仍 deferred(§8);middleware 未建(无消费者)。model 来源是配置非定义(AGENTS.md 不讲用哪个 LLM),见 §6 装配点归类。

## 5. 坍缩:实现真正发明了什么

连续审查把实现从「~12 个概念」坍缩到 **几项发明 + 其余 pi 透传**:

1. **把 pi 双口 fan-in 成 SPEC 单流**(+ 单一 event/terminal translator)
2. **无状态多-session 编排**(每 invoke 现起 harness,用完即弃)
3. **`SessionStore.lease`**(跨进程单写者;pi 无)
4. **请求级 middleware + 依赖反转 adapter 架构**

删除清单(每条过 R5):

| 删除 | 理由 |
|---|---|
| Capability / fit-check | `ExecutionEnv` 是 monolithic 的,"有 fs 没 shell" 的 env 不存在 → false precision |
| fastagent `Tool` / `ToolContext` | 退化成 pi `AgentTool`,零 delta |
| Budget(核心概念) | 是 middleware;只在 `failed` 上体现 |
| 结构化失败分类(transient/fatal/content_filter) | 引擎不提供这个区分度;`failed.retryable` 足够 |

> **实现薄,而且应该薄**。价值在协议 + 部署 DX,不在概念量。

## 6. 部署:三层所有权 + 跨 runtime 编译

**文件结构按「谁拥有 / 是否进 git / 是否可重建」分三层:**

```
工作区根/
├── AGENTS.md / skills/ / .mcp.json   # 1 agent 定义:标准、可移植、fastagent 只读;定义装载(definition.ts)读盘产出 LoadedDefinition
├── fastagent.config.ts · 自定义代码 · .env   # 2 production source:用户拥有、可见、进 git(机密走 .env)
└── .fastagent/                       # 3 machine state:fastagent 生成、gitignore、可删可重建
```

### 6.1 装配点参数归类(定稿,二维)

装配点 = `create.ts` 的 L0–L3 梯子(L0 住 invoke.ts),**产物是实现 invoke 契约的 `Agent`**。每个参数按两条轴归位--**概念归属**(M=agent 是什么 / K=在哪怎么跑 / auth=凭什么连)决定该谁负责;**来源**(定义/配置/host)决定谁来填。三个产出层中,**定义装载(definition.ts)与 config 装载(config.ts)已建成;target adapter 未建--K 侧参数仍是默认值**。

| 参数 | 概念归属 | 来源 |
|---|---|---|
| `instructions`(→ systemPrompt 的一段) | M | **定义**(AGENTS.md 正文 → 定义装载;见 §2 prompt 四段式) |
| base prompt(→ systemPrompt 骨架) | M | **引擎 binding 资产**(继承自引擎:pi→piBasePrompt;配置可覆盖) |
| `tools` / skills | M | **定义**(skills/ + .mcp.json → 定义装载) |
| `model` | M | **配置**(fastagent.config / env;AGENTS.md 不讲用哪个 LLM) |
| `repo`(SessionStore) | K | **配置**选后端+参数 + **host**(target adapter 接线实现) |
| `env`(ExecutionEnv) | K | **配置**选环境 + **host**(target adapter 接线实现) |
| `lease` | K | **配置**策略/TTL + **host**(target adapter 接线实现) |
| `getApiKeyAndHeaders` | auth(横切) | **配置/secrets**(.env / vault) |

```
定义文件 ─(definition.ts)→ instructions, skills(systemPrompt=prompt 组装产出) ┐
配置 ─(fastagent.config + .env)→ model, 后端选择, secrets   ├→ createPiAgent → agent ←(N: channel 调 invoke,不是装配参数)
host ─(target adapter)→ repo/env/lease 的实现接线            ┘
```

注:**定义装载只产出「定义推导」那一格**(instructions + skills);model 是配置项,不在 AGENTS.md 里。

### 6.3 config v1(定稿,已实现)

`fastagent.config.ts` = `defineConfig({ model, tools, http })` --**只有 3 个键**,每个都过「一句话讲得清 + 有近期故事」门槛:`model`="provider/modelId" 字符串;`tools`=追加在 pi 默认工具后的自定义工具数组(即「无入口部署下 code tools 的归宿」);`http.port`。优先级 CLI flag > config > `FASTAGENT_MODEL`;无 config = zero-config 跑默认。**刻意不进 v1**:sessions/env 选型(K 轴,等 hosting 刀由真实后端定形状)、base/auth/skillPaths 覆盖(默认几乎总是对的,留库 API 作逃生舱)。选 .ts 非 yaml(旧版教训):tools 是代码需 import、类型补全、生态收敛(vite/next 同款);toolchain 要声明式数据时构建期执行 config 取 resolved 值。红线:config 只描述部署选择,绝不描述 agent 身份/行为。消费者 = **L3(`createPiAgentFromWorkspace`,config 驱动装配的收口);CLI(`fastagent dev`,已实现)经 L3 消费,自身只留进程副作用/展示/起服务;`build`/`start` 随后--业界 dev/build/start 三连,恰好对上 dev-server / bundleAgentDefinition / 跑产物)。

### 6.2 tools/skills 挂载口径(定稿;参照 agentskills.io 规范 + pi/Claude Code 实现)

- **skills 发现位置是 client 约定,规范不定**。pi 的层级:user 全局(`~/.pi/agent/skills`,先加载)→ 项目(`.pi/skills`)→ 额外 skillPaths(settings/extensions);碰撞先到者赢 + 发 collision 诊断。
- **fastagent 的口径(经忠实性推导翻转过一次,定稿)**:缺省 `skillPaths = defaultGlobalSkillPaths()`(`~/.pi/agent/skills` + `~/.agents/skills`)--**默认加载全局,忠实 pi 本地体验**。高级控制:`skillPaths: []` = 只扫定义内;自定义数组 = 精确选装。
- **部署路径必经 `bundleAgentDefinition`(一键部署的「编译」阶段,非可选 dev 工具)**:把胜出的全局/额外 skills 整夹物化进自包含产物 → **服务器完整复现本地体验**(这是产品承诺)。运行时默认扫全局只是本地 dev 便利;服务器上 home 不存在自然为空只是兜底,**产物才是真相**。skills(纯文件)拷贝即自包含;**code tools 不在打包范围**(见下条)。
- **碰撞**:定义内 skills 赢(部署单元是权威),先到者赢 + surface `collisions`(不吞)。机制同 pi、优先级取向不同(pi 是 user 先,我们是 definition 先--部署单元不同)。
- **默认工具 = pi 核心集(read/bash/edit/write),忠实性口径(经场景推导翻转过一次,定稿)**:直接用 pi-coding-agent 的工厂(`createCodingTools`),工具名/描述/行为与 pi 本地逐字一致--定义作者是带全套工具 vibe 的,砍工具 = 行为漂移(同 base prompt 逻辑)。**工具层不是安全边界**:隔离是 K 侧 ExecutionEnv/sandbox 的职责(本地=用户自己的机器;AgentCore=microVM);对公网收紧 = 显式传 `tools`(如 `piReadOnlyTools`),是部署姿态非默认。渐进披露三级(discovery/activation/execution)随之全部开箱可用。pi 工具的 operations 可注入(BashOperations 等),未来 sandbox adapter 换 operations 即可。
- **打包机制(bundleAgentDefinition)**:运行时只扫定义内的规则不变;dev 在**构建时**用 `bundleAgentDefinition(src, out, {skillPaths})` 把全局/额外挂载的**胜出** skill 整夹(含 scripts/references/assets)物化进产物,部署单元自包含、可直接再装载。败者不进包。
- **自定义 tools = 代码,显式 `tools:` 注入,不做魔法目录(定稿;曾实现过 `<dir>/tools/*.ts` 自动加载,审查后删除)**。模式(ketchup 验证):项目里的普通 TS 模块实现 `AgentTool`,显式 import + `tools: [...piDefaultTools(cwd), myTool]`(示例 examples/lookup-order-tool.ts)。**删除自动加载的理由**:(a) tool 是代码,开发者已在代码里,显式 import 型检/可重构,魔法目录只省一行 import;(b) 假对称违反分层--定义夹=标准可移植数据,tools=代码属 layer-2;(c) bundle 拷源文件不带 npm 依赖,自包含是假的。无用户入口的部署下声明 tools 的归宿 = `fastagent.config.ts`(config 刀);声明式/可移植的挂工具 = **MCP**(`.mcp.json`,未来一刀)。进程内 code tools 无跨引擎标准,fastagent-on-pi 用 pi `AgentTool`。**pi extensions(含全局自定义 tools)不自动加载**:其契约绑 TUI 宿主(ctx.ui/commands/渲染),headless 无对应物;桥 = 把 `pi.registerTool({...})` 的参数搬成项目 tool 模块(形状几乎相同)。
- spec 的 `allowed-tools`(实验性)暂不实现;`.mcp.json`(MCP tools)未来一刀。

### 6.4 跨 runtime 编译(工具链层的真工程)

同一份 agent 定义,target adapter 编译成适配不同 runtime 的部署产物。难点不是 wire,是**异构 target 的进程/env/session 模型全不同**:

| target | 进程模型 | env 供给 | session |
|---|---|---|---|
| AgentCore | serverless,现起即弃 | OCI 内 | 外置(DDB) |
| Lambda | 无状态,冷启动 | 容器 | 外置 |
| Fly | 常驻进程 | 本地 fs | 本地/外置 |
| Workers | V8 isolate,无 Node fs | 受限 | 外置 |
| E2B | sandbox | 远程 | 外置 |

让同一份定义跑在这些上面,靠的正是 §4 的**无状态 invoke + env 注入 + session 外置(SessionStore)+ target adapter**。SPEC 的 portable conformance(无位置依赖)正是为此而设。这是 ACP 结构上不碰(它把 env 留给 client)、而 fastagent 必须做的--也是「没人能部署到 AgentCore」的技术核心。**部署 DX 是 wedge(可复制),无状态跨 runtime 解耦是 moat(工程积累)。**

**两处非正交耦合(诚实标注,别被 N+M+K 的算术骗了)**:

1. **M⊥K 是假设出来的,不免费**:§5 删 capability/fit-check 等于假设 `ExecutionEnv` 同质。Workers 没 Node fs--要 shell/fs 的 agent 跑不上去。撞 Workers 时这个假设要还债。
2. **N⊥K 不干净**:cron 要 host 给调度器,webhook 要 host 给公网 ingress;特定 (trigger, host) 对需要特定 host 基建(AgentCore 为此开 EventBridge + API Gateway)。N×K 不是自由组合,这块耦合压在 target adapter 层。

即:N×M 是真窄腰(干净塌缩);×K 是工程上逐 host 啤出来的近似正交,不是协议白送。

**对外 wire(consume 标准,不另立)**:invoke 不对外。
- **A2A**(agent↔agent):consume--暴露 Agent Card,把 invoke 的单流 fan-out 到 A2A 的 event queue(`for await (e of invoke) eventQueue.push(toTaskUpdate(e))`);终局 → final Message/Task。Task 状态机/Artifact 在 adapter + userland,不进 core。`scope.session` ≙ A2A `contextId`,`completed.data` ≙ Artifact。
- **ACP**(editor):可选 channel,但 ACP 角色倒置(client 提供 env / human-in-loop),agent 要切「委托 env」模式,独立分支非主路。
- **webhook/cron**(serving 主入口):无标准,channel adapter 自定义 → invoke。

> SPEC 的单流(AsyncIterable)天然适配 A2A 的 push executor(`for await` 转 push)--比旧版"buffered + 旁路 subscribe"喂得更顺。

## 6.5 session 模型:tree / fork / 回退如何跨 host 可移植(定稿)

**session = 一棵持久化的 entry 树 + 一个 leaf 指针**(沿用 pi 的 `SessionStorage`:append-only entry 带 `parentId` + `LeafEntry`)。**turn = 一次 invoke = 沿 leaf 向前追加一节**,所以 `session : invoke = 1 : 多`。「长程对话」是错觉:每 invoke 无状态、用完即弃;连续性靠 SessionStore 持久化 entry 树、下次 `open` + 回放 `getPathToRoot(leaf)` 重建上下文(满足 SPEC portable conformance)。

> ✅ 连续性已接:`engines/pi` 的 `piHarnessFactory` 每 invoke **open-or-create**(已有则 open、harness 经 buildContext 看到历史;否则 create)。caller 只需**跨 invoke 复用同一 repo 实例**。详见 [[session]]。

**回退 / 重试 / regenerate = session 管理,不进 invoke**(SPEC §10:编排 = 上层):
- **回退** = 把 leaf 移回某 entry(pi `navigateTree`);被甩的 turn 成死分支,不删(可选 `summarize` 留痕)。
- **干净重试** = 先回退到失败 turn 的 start 边界(SPEC §6 警告 `retryable` 非原子,半跑的 turn 可能已 append entry / 跑过带副作用 tool),**再** invoke。
- **regenerate** = 在某 user message 处 fork。

**业界对照(2026 调研):**

| 系统 | 历史形状 | fork 机制 | 节点寻址 |
|---|---|---|---|
| AWS AgentCore | 扁平事件日志(actor, session) | 无(线性) | 无 |
| Claude Agent SDK | 线性 transcript + leaf | **fork → 新 session id**(leaf 处复制历史) | 无(只能 leaf) |
| OpenAI Responses | DAG(`previous_response_id`) | 多响应指向同一 prev_id | 有(节点在调用里) |
| LangGraph | 树(checkpoint 的 parent 链) | `update_state` / 从 `checkpoint_id` replay | 有(checkpoint_id) |
| pi | 树 + leaf | fork / `navigateTree` | 有(任意 entry) |

**结论(定稿):**

1. **树是 SessionStore 的逻辑,不是 host 的能力。** host 只需提供三原语:`durable append + read(history) + single-writer(lock)`;从扁平 entry 读 `parentId` 即重建树。
2. **fork / 回退跨 host 可移植。** 凡能 append+read+锁的后端(jsonl / pg / ddb / **AgentCore**)都能模拟。两策略:**森林**(每 host session 保持线性,分支 = 新 session id + 我们自存的 "forked-from" 边;顺 AgentCore 纹理、Claude 同款)作 floor;**树进 payload**(整棵树编码进 entry,复刻 pi)作可选优化--注意 AgentCore 的长期语义抽取会把死分支也吃进"记忆",用它时**只当短期事件存储**。唯一做不到的极端 host:既隐藏历史、又只能 leaf 线性追加、且无分支原语(AgentCore 不是)。
3. **入口在 session-admin 面,不进 `Scope`。** fork **返回新 session id**(Claude 同款),不把 node-id 塞进 invoke。理由是**契约卫生,不是存储做不到**:node-in-scope 会(a)被忽略时静默 append-to-leaf → 写坏对话;(b)隐藏分支落点(caller 跟 A、新 turn 落 B)。invoke 永远只有一个普适动词「续接此 session」,降级永不静默。
4. **定位**:这把「分支 / 回退」从「只有树引擎才有的奢侈品」变成 fastagent 在**任意 host 上统一提供**的可移植 capability--AgentCore 这种最硬的 host 也能给到分支语义,正是试金石要证的「无状态可移植」。它属于 **×K 的 moat**(逐后端啤 SessionStore 的工程),不是协议白送。

> 展开为独立标准草案 [[session]](event-sourced DAG + 三层解耦:1 Consumer API / 2 DAG core / 3a Host adapter · 3b Engine adapter)。

## 6.6 同 session 并发:core 只留 fail-fast 地板,UX 在 channel(定稿)

> 这一节是从第一性原理重新推导的结果:先问「同 session 并发是真需求还是假需求」,再决定机制。曾错走一步:默认 FIFO 串队 lease--把一个症状当成一种需求解了。

**同 session = 同一段对话线程;同 session 并发 invoke = 同一对话同时有两个 turn 在跑。** 它由这些场景产生:

| # | 场景 | 本质 | 理想 UX | 对的机制 |
|---|---|---|---|---|
| 1 | 用户手抖/超时重发(double-submit / client retry / 刷新) | 重复意图 | 去重 / 忽略第二个 / 幂等 | dedupe / 幂等键 |
| 2 | 用户连发("做 X"...紧接"还有 Y") | 一个用户追加/改主意 | 第二条注入在飞 turn 或排成 follow-up | **steering**(SPEC §8,已 defer) |
| 3 | 多端/群聊(多人同时说) | 多参与者的真·两个 turn | 串行进连贯 transcript + 等待方"忙"反馈 | 串行 + 反馈 |
| 4 | webhook 风暴(同一 issue 连续触发) | 机器重复/最新态 | 合并 / debounce | coalesce / latest-wins |
| 5 | 失败后重试 | 替换不是叠加 | 替换原 turn(且原已结束) | 多数非真并发 |

**归并成三类,「FIFO 串跑两遍」只契合一类且不完整:**
- **A 重复意图(1/4/5)** → 该去重/合并,**绝不该跑两遍**(跑两遍 = 同一意图产生两条回复)。
- **B 单用户连发(2)** → 该 **steering**(第二条修饰/排在第一条上,agent 感知),不是两个独立 turn 抢跑。
- **C 多参与者(3)** → 该 **串行 + 给等待方反馈**(连 C 都需要"你在排队"这个反馈)。

**分层决策:**
1. **invoke 本质是"跑一个 turn",turn 之间的并发编排在 invoke 之上**(channel/caller 的事)。
2. **谁知道该 dedupe/steer/queue/reject?是 channel**--它知 trigger 语义(HTTP 幂等键、聊天 steering、webhook debounce)。core 不知,也不该替它定。
3. **场景 B 的正解是 steering 输入流**(SPEC §8 第三参),不是 lease。

**所以 core 的唯一职责 = 一个「不写坏」的、最小且显式的地板。辙选 fail-fast 而非 queue:**

> 同 session 已有在飞 turn 时,第二个 invoke **立即** yield `failed{ retryable:true, details:"session busy" }`。

- **正确**:无交错写、无死锁(根本不排队,自然没有"排队中被 cancel"的槽泄漏)、无无界队列;
- **显式**(fail visibly):不再有"隐形挂住"的请求;
- **把 UX 决策推给 caller**:channel 自己决定重试/去重/显示"忙"/串行;
- 正好对上 SPEC `failed{retryable}` 语义。

需要"串行带反馈"的 channel(如群聊 Slack adapter),自己在 channel 层按 thread 排队即可--它做排队比在 async generator 的 `await`(在 try 外)里做安全得多。

**一句话**:同 session 并发的大多数是"重复"或"steering",不是"两个真 turn";core 不用 FIFO 串跑去糊弄所有场景,只留一个显式的 fail-fast 地板,把 UX 交给 channel,把单用户连发交给将来的 steering。这也把死锁从设计上去掉了--不是修 lease,是不该有那个排队 lease。

## 7. 不变量(实现的法律)

1. 参考实现把 pi 的双口 fan-in 成 SPEC 单流;对 pi 的依赖收敛到 `toAgentEvent` + `toTerminal` 两个 translator。
2. **IO 政策(精确化)**:invoke 路径(invoke/harness)永不碰盘;运行时读定义(definition.ts 的 load)只经 `ExecutionEnv`(可移植);build-time(bundle)与 Node 组合根模块(config/auth)可直接用 node fs。错误通道约定:env 层 Result → load/config 层 throw(启动期响亮失败)→ auth 层 undefined(未配置)+ warn(异常)→ invoke 边界 failed 事件(SPEC 强制)。非致命加载发现(diagnostics/collisions)作为数据返回由 caller surface。
3. 无状态:每 invoke 现起 harness,用完即弃;耐久状态全在 `SessionStore` 后(满足 SPEC portable conformance)。
4. 对外 consume 标准(A2A/ACP/OCI),不另立 wire;invoke 不对外、不对齐任何 wire 数据模型。
5. Task 编排 / Artifact 版本 / 长任务查询 = app 层(adapter + userland),不进 core。

## 8. 边界与开放问题

- **autonomy 安全(无人在环授权 / runaway 边界 / escalation)= v2 纵深**,不是第一性发生点。用户此刻的痛是「部署不了」,不是「不安全」;部署通了之后它才成为下一道缝(也正是 vision 里「狂徒锁链」的落点)。
- **「成为标准」是上行期权,不是 base case。** Agent Handler 技术上够格当 agent serving 的 gateway 标准,但事实标准要生态采纳,而大厂在出竞品标准(A2A / Agent Executor)。所以:把协议设计成开放可采纳的形状(已做,见 [[SPEC]]),产品价值赌「参考实现 + 部署 DX 够好用」,采纳是 huge upside。
- **pi 失败有三条路径,translator 以 stopReason 为准**:(1)`prompt()` reject(少数,由 catch 兑);(2)resolve 带 `stopReason: error/aborted` 的 message(常态,`toTerminal` 检查);(3)subscribe 的 `AssistantMessageEvent{type:"error"}`。以 resolved message 的 stopReason 为准产出 `failed`,catch 只兑底路径(1)。
- **lease**:进程内 fail-fast「session busy」地板已落地(见 §6.6 场景推导 + 决策)。**跨进程/多实例的分布式锁仍 deferred**(到有远程 SessionStore + 多实例/AgentCore 时再做)。
- 还没钉死的微决策:`retryable` 判定已抽成可注入 `RetryClassifier`(L0 选项;默认字符串启发式,终解仍待 pi 导出结构化分类);分布式 `SessionStore.lease` 最小形状;`EventQueue.drainUntil` 的 backpressure;非流式引擎的 `text` 退化(发一个大 delta)。
