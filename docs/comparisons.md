---
title: fastagent — 竞品深度对比
type: competitive-analysis
status: design
updated: 2026-06-05
---

# 竞品深度对比:Flue / OpenClaw / Claude SDK / OpenCode / pi

> 索引 [fastagent](fastagent.md) · 同目录 [positioning](positioning.md) · [core-design](core-design.md)

> 战略矩阵见 [positioning.md](positioning.md)。本文逐项拆解 + 一个 worked example。

## 总览:framework ↔ product × markdown ↔ code

```
                      product / app
                            │
            OpenClaw  ●     │   ● OpenCode serve(锁引擎的 server)
        (个人助理产品)      │
                            │
  markdown ─────────────────┼───────────────── code-first
   native                   │
                            │
          fastagent  ●      │      ● Flue
     (定义 → 任意 target)    │   (TS 写 agent)
                            │
              serving 契约 / framework
```

| | 它是什么 | agent 怎么定义 | 你拿它干嘛 | 中立? | Web 类比 |
|---|---|---|---|---|---|
| **OpenClaw** | **产品**(个人多渠道助理) | markdown(SOUL/AGENTS/skills) | 自托管 + 定制**这一个** app | 半 | WordPress |
| **fastagent** | **serving 契约 + 实现 + 工具链** | markdown 定义 + config | 把**任意**定义部署成**任意**形态、**任意** target | **全中立** | **WSGI + gunicorn / Vercel** |
| **Flue** | **框架** | code-first(TS) | 写 agent → build → 部署 | 引擎半锁 | Astro / Next |
| **Claude Agent SDK** | **SDK + hosting** | Claude Code 文件夹 | 把 Claude Code 跑成服务 | **锁 Claude** | —— |
| **OpenCode `serve`** | **产品 server** | OpenCode | 跑 OpenCode 的 HTTP server | **锁 OpenCode** | —— |

---

## Flue(Astro 团队)

- 自称 **"The Agent Harness Framework"**——核心卖点是**自带 harness**(`@flue/runtime`);模型层用 pi-ai。
- **编程模型 = workflow-centric**:`.flue/workflows/*.ts` 写 `run({init, payload})` 编排,可用 valibot schema 拿 typed 结构化结果。
- **Sandbox 是一等公民、真差异化**:默认虚拟 sandbox(just-bash)+ 丰富 connector(Daytona/E2B/Modal/Vercel/CF)+ `local()` 给 CI。
- **部署目标**:Node / Cloudflare Workers / GitHub Actions / GitLab CI。`flue build` 出 artifact 再部署(两步)。

**和 fastagent 的哲学分叉(都直面竞争,非零和)**:

| | Flue | fastagent |
|---|---|---|
| agent 是什么 | 你**用 TS 写**的 | 你**用 markdown vibe** 的定义文件夹 |
| 入口 | code-first | markdown-native,代码是逃生舱 |
| 与标准 | 自成 runtime API | **consume AGENTS.md/Skills/MCP;对外 consume A2A/ACP,不另立** |
| 调用契约 | Flue 私有 API | **Agent Handler:`invoke(scope, prompt) => AsyncIterable<AgentEvent>`(引擎中立,见 [SPEC](SPEC.md))** |
| 跨 runtime | 虚拟 sandbox **抹平**环境 | **无状态 core + env 注入 + target adapter**,让同一定义编译到异构 runtime |
| build/deploy | 分两步 | `deploy` 端到端一条命令 |

> 有意思:Flue 用**虚拟 sandbox 抹平环境**(占栈更深、自带 harness+sandbox),fastagent 用**无状态 core + env 注入**让引擎/target 解耦、保持中立。两种"run anywhere"哲学。Flue 吃不到「已 vibe 出 markdown 定义、不想写 TS」的人——那是 fastagent 的 wedge。

---

## OpenClaw

- **不是框架,是产品**:_"the product is the assistant."_ 你自托管的个人 AI 助理,单用户、always-on。
- **markdown-native**:SOUL.md + AGENTS.md + skills/(和 Claude Code 同一套)。
- **渠道狂魔**:WhatsApp/Telegram/Slack/Discord/Signal/iMessage/飞书/微信… 20+,加语音 + Canvas UI。
- **成熟度高**:OpenAI/GitHub/NVIDIA/Vercel 赞助、MIT、安全边界完善、插件 SDK + MCP。

**三条战略读数:**
1. **验证**:重量级玩家真金白银验证了"markdown 定义 + 多渠道 + 自托管"是真需求。
2. **威胁/边界**:**别去拼渠道**。OpenClaw 锁死 app 形态 = 个人助理;在"做更好的助理"上必输。
3. **差异化**:**OpenClaw 是可以用 fastagent 来 build 的东西。** 你是 serving 层,它是 WordPress——前提是**别做成更差的 WordPress**。

**真实重叠 vs 分歧**:重叠只有"个人多渠道助理"这一格;fastagent 的跨 runtime 部署 / 多 target / A2A 网络 / 云端自主,OpenClaw 根本不做。

---

## Claude Agent SDK & OpenCode `serve`(平台吸收的两个真身)

这两个最该正视——它们正在做"把 agent 跑成服务",而且已经发布:

- **Claude Agent SDK**:`query()` programmatic + headless `-p` + 官方《Hosting the Agent SDK》(subprocess 架构、session 持久化、scaling、multi-tenant Docker/K8s)。**但 subprocess 是 `claude` CLI——锁 Claude 引擎、锁模型。**
- **OpenCode `serve`**:headless HTTP server + OpenAPI 3.1 + 自动生成 SDK + 多 client。**但它是 OpenCode 这个产品的 server——锁 OpenCode。**

**fastagent 的唯一立足点 = 它们锁死的那条轴:中立。** 同样"把 agent 变服务",fastagent 不锁引擎/模型/云/coding-agent。它们一个版本就能把"把文件夹跑成服务"做掉(平台吸收),但**做不到中立**——这是开放层的唯一持久防线,也是 fastagent 存在的全部理由。

---

## pi(pi-agent-core / pi-coding-agent)

**不是竞品,是参考实现的底座(Werkzeug + gunicorn 那层的引擎)。** fastagent 建在 **pi-agent-core 的 `AgentHarness`**(不是 pi-coding-agent 的 `AgentSession`,后者是 TUI 封装、拖文件系统耦合)。pi 给的:`AgentHarness`(turn loop / `prompt()=>AssistantMessage` buffered / subscribe / hooks / compaction)、`ExecutionEnv = FileSystem & Shell`、`SessionRepo`、`AgentTool`/`Skill`、整套事件。

fastagent **建在它上,不重造**:把 pi 的双口(`prompt` buffered + `subscribe`)fan-in 成 [SPEC](SPEC.md) 的单一事件流;对 pi 的依赖收敛到一个 translator(pi 事件→`AgentEvent`)。详 [core-design.md §4](core-design.md)。

---

## Worked example:GitHub issue 自动三连

"三连" = 新 issue 一开,自动:① 打标签 ② 发评论 ③ 指派。**关键:三连逻辑两个框架都写在 markdown(AGENTS.md + skill),agent 用 `gh` CLI 执行——差别只在触发/装配/部署。**

### Flue(惯用 = CI workflow)

```ts
// src/workflows/triage.ts
export async function run({ init, payload }: FlueContext) {
  const agent = createAgent(() => ({
    model: 'anthropic/claude-sonnet-4-6',
    sandbox: local({ env: { GH_TOKEN: process.env.GH_TOKEN } }),  // CI runner 即环境
  }));
  const session = await (await init(agent)).session();
  const { data } = await session.skill('issue-triage', {
    args: { repo: payload.repo, issue: payload.issue },
    result: v.object({ labels: v.array(v.string()), commented: v.boolean(), assignee: v.nullable(v.string()) }),
  });
  return data;
}
```
GitHub Actions 里 `npx flue run triage`。**没有"部署"步骤——CI runner 就是运行环境。**

### fastagent(惯用 = 常驻 webhook channel;API 为示意)

> 下面是 channel adapter 调 `invoke` 的形状示意。对外这个 channel 可暴露成普通 HTTP webhook,或一个 A2A endpoint;agent 逻辑仍在 markdown 定义里,与 Flue 一字不差。

```ts
// fastagent/app.ts(production source:用户拥有、进 git)
export default defineApp(async (ctx) => ({
  agent: ctx.default,                       // 复用默认 agent 定义;bash 继承部署环境的 GH_TOKEN
  channels: [githubWebhook({
    name: "github",
    onIssueOpened: (agent) => async (repo, issue) => {
      const { text } = await collect(agent.invoke(
        { session: `gh-${repo}-${issue}` },             // scope:核心只 session
        { text: `Triage issue #${issue} in ${repo}.` }, // prompt
      ));                                                // 单流 → collect 退化成 buffered
      return text;
    },
  })],
}));
```
`fastagent deploy --target agentcore`(或 `fly` / `workers`)→ 一条命令编译 + 部署 → webhook/endpoint 指向它。

### 对照

| 环节 | Flue | fastagent |
|---|---|---|
| 触发模型 | 事件→CI 跑一次(serverless) | webhook→常驻/serverless invoke |
| 三连逻辑 | markdown skill | **完全一样** |
| `gh` 鉴权 | `local()` 显式注 env | bash 继承部署环境 |
| 上线 | `git push`(无部署步骤) | `deploy --target`(一条命令,任意 runtime) |
| 跨 runtime | Node / Workers / CI | **AgentCore / Lambda / Fly / Workers / E2B(无状态 core 支撑)** |

**本质**:agent 本身两边几乎相同(都是 AGENTS.md + skill + bash/gh,共享 Claude-Code DNA);**分歧全在外壳**——Flue 包成 typed/可编排 workflow,fastagent 包成可部署任意 runtime 的 serving。事件驱动 Flue 的 CI 更顺手;长期在线 + 跨 runtime 部署 + 中立是 fastagent 甜区。

### fastagent 架构上本来就 multi-target

`invoke` 是单流不动点(buffered 用 `collect` 退化),适配不同进程模型:① CLI 一次性 `invoke` 进 GitHub Action(≈ `flue run`);② 常驻 webhook channel;③ **AgentCore 部署本就是 serverless**(每 invocation `InvokeAgentRuntime` 现起 runtime)。能跑 ③ 的前提正是 [core-design §4](core-design.md) 的**无状态多-session 工厂**——这也是别人(Claude SDK / OpenCode 的有状态常驻设计)结构上吃不到 AgentCore 的原因。
