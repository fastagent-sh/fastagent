---
title: Session — fastagent session-admin 标准(草案)
type: design-doc
status: design
updated: 2026-06-09
---

# Session — fastagent session-admin 标准(草案)

> 索引 [fastagent](fastagent.md) · 协议 [SPEC](SPEC.md) · 实现 [core-design](core-design.md)

> **`invoke`(见 [SPEC](SPEC.md))让对话向前长一节;session-admin 管对话的树:读历史 / fork / 回退。两个正交面。** 本文定义后者——一个 event-sourced DAG + 分层解耦。`status: design`,**不冻进 locked SPEC**(SPEC §10:Task 编排/长任务状态 = 上层)。它是 fastagent 的标准扩展(moat),会演进;接口待第一个要分支/回退的 channel/UI 拉动再定型。

## 1. 心智模型:Git for conversations(minus merge)

session 的结构 = **event sourcing**(只追加日志 + 状态靠 fold 派生)+ **Git 的对象模型**(节点带 parent 指针成 DAG + 一个可移动的 current 指针)。pi 的 session、LangGraph 的 checkpointer 都是这个范式的实例;Git 是原型。**我们 codify 的是这个通用范式,不是某一家的实现。**

| Git | 本标准(中立) | 说明 |
|---|---|---|
| commit(不可变 + parent) | `entry`(id, parentId) | 不叫 commit——无内容寻址/staging |
| HEAD | `current` 指针 | 可指任意节点(≈detached HEAD)|
| reflog(HEAD 移动入日志) | 指针移动 = 追加一条 entry | 只追加,不破坏性改 |
| checkout/reset(移 HEAD) | `navigate(id)` | 不借 checkout/reset(重载、劝退)|
| branch / 新 ref | `fork(id?)` → 新 session id | fork 双语境都精确、不过度承诺 |
| git log(沿 parent 路径) | `getHistory()` | 对话语境用 history |
| checkout 投影成工作区 | **projection**(引擎特有,见 §6b) | entries → 模型上下文 |
| merge / rebase | **不引入** | 对话是树,无 merge;引入=制造落空预期 |

**偏差(别过拟合 Git)**:① 无 merge(对话是树,单 parent);② current 可指任意节点;③ 非内容寻址(用时间序 id)。

## 2. 分层:为什么是这几层(逐层被什么力逼出)

中间那块**永远存在**(consumer 与 host 之间总要有人做树逻辑)。真正的问题是中间切不切。下面是逐层的存在理由——**注意 ② 的理由与引擎数量无关**。

```
┌─ ① Consumer API(×N:caller / channel / UI)────────────────┐
│ current() / navigate(id) / fork(id?) / getHistory() /      │  opaque id + 中立 kind/preview
│ capabilities()                                             │
└────────────────────────────────────────────────────────────┘
              ▲ 用(只见 id/kind/preview,不见 payload)
┌─ ② DAG core(引擎中立,fastagent 自有,写一次)─────────────┐
│ Entry{id,parentId,kind,payload} + append-only 不变量        │  ← 由「薄 host 缝 + 复用 pi 树」
│ + 纯图逻辑:getPathToRoot / fork-prefix / navigate(移指针) │     逼出,与引擎数量无关
└────────────────────────────────────────────────────────────┘
   ▲ 扁平存储原语(K)              ▲ 解释 payload(M,模块非冻结接口)
┌─ ③a Host adapter(薄)──────┐   ┌─ ③b Engine 模块(pi 特有)────┐
│ append / getEntries /       │   │ payload 语义 + 两个 projection │
│ getEntry / get·setPointer / │   │  · model-context(给 invoke)  │
│ lease   (payload opaque)    │   │  · display(产 kind+preview)   │
│ jsonl / pg / ddb / AgentCore│   │ 把 turn 产出包成 payload       │
└─────────────────────────────┘   └────────────────────────────────┘
```

**① Consumer**——被 ×N 逼出:多 channel/UI 要一个稳定、可理解的面。与引擎数量无关,现在就需要。

**③a Host(薄)**——被 ×K 逼出:多 host 要一个**好实现**的存储缝。与引擎数量无关,现在就需要。

**② DAG core(中立)**——被 **「薄 host 缝 + 复用 pi 树」** 逼出,**不是被 M 多样性逼出**:要 host 缝薄(只 `append/get/pointer/lease`),图逻辑(`getPathToRoot`/fork/navigate)就**必须**落在 host 之上的 fastagent 里;要复用 pi 的树,这层就是"pi 树逻辑 + 架到薄 host 缝上的胶水"。**所以 ② 现在就该有——这就是"守住 host 缝薄"的必然产物。**

**③b Engine(pi 特有)**——**是模块边界,不是冻结接口**:
- **分离(现在做,零成本)**:projection/payload 是 pi 特有的;放进单独模块、`②` 不 import pi,使 ② 可审计地保持中立。
- **冻接口(现在不做)**:只有 pi 一个样本,**不定义 EngineAdapter 契约**(就是我们否过的"从单例抽象")。引擎 #2 来时共同形状才浮现,那时再抽。

> **红线:`navigate` / `fork` 在 ②(纯图操作),绝不下放给 ③b。** 一旦下放,leaf-only/线性引擎就给不了任意节点 navigate,跨 host 可移植的 moat 蒸发。③b 只解释 payload。

## 3. 数据模型:Entry(② 拥有)

```ts
interface Entry {
  id: string;                 // opaque,可寻址(navigate/fork 靶点;getHistory 返回)
  parentId: string | null;    // 父链 → DAG;root 为 null
  kind: EntryKind;            // 中立元数据,由 ③b 打;② 图操作 + ① 渲染靠它
  payload: Json;              // 只有 ③b(引擎)解释;对 ②/③a/① opaque
  preview?: string;           // ③b 产的中立可显示摘要,供 ① 渲染(payload 仍 opaque)
  timestamp: string;
}

type EntryKind =
  | "turn_input"    // 可 fork-before 的边界(≈ user message)
  | "turn_output"   // assistant / tool 产出
  | "pointer_move"  // 指针移动(navigate 追加的,payload 记 targetId)
  | "meta";         // 模型/工具变更、compaction、branch_summary 等
```

**不变量(event sourcing,跨 host 可移植的根):**
1. **只追加,不修改、不删除。** 死分支留在日志里,只是不在活跃路径上。
2. **指针移动也是一条 entry**(`kind:"pointer_move"`)。回退/navigate = 追加,不破坏历史。
3. **状态靠 fold 派生**:current = 重放日志最后一次 pointer-effect;活跃对话 = 从 current 沿 parentId 到 root。

## 4. ① Consumer API

```ts
interface SessionAdmin {
  current(session: string): Promise<string | null>;
  navigate(session: string, entryId: string): Promise<void>;  // 移指针(纯)
  fork(session: string, entryId?: string): Promise<string>;   // → 新 session id(缺省从 current)
  getHistory(session: string): Promise<Entry[]>;              // 活跃路径(payload opaque)
  capabilities(session: string): Promise<{ fork: boolean; navigate: boolean }>;
}
```

- **opaque id**:用 `getHistory` 的 `entry.id` 作 navigate/fork 靶点;靠 `kind` 判断合法靶点(如只在 `turn_input` 处 fork-before)。
- **payload 不解释**:UI 用 `kind` + `preview` 渲染。
- **fork 返回新 session id**(Claude SDK 同款);**绝不把 node-id 塞进 `Scope`**——契约卫生:那会在被忽略时静默 append-to-leaf 写坏对话、并隐藏分支落点。
- 变更操作(navigate/fork)在 lease 下执行(见 §6a / §7)。

## 5. ② DAG core(引擎中立,写一次)

纯图逻辑,跑在薄 ③a 之上,**不 import 任何引擎**:

- `getPathToRoot(current)`:沿 parentId 到 root,反转 → 活跃路径。
- `fork-prefix`:取靶点前缀路径,写入**新 session**(新 id,记 `parentSession` 血缘)。
- `navigate`:**纯移指针**——追加一条 `pointer_move` entry + 更新 current。**不做摘要**(branch-summary 是 ③b 的独立 enrichment,见 §6b),否则 ② 被 pi 污染。
- `capabilities` 推导:依 ③a 能力给出 fork/navigate 是否可用。

**moat 命根**:这些逻辑是 fastagent 的、只要求 ③a 提供 `append+read+lock`,所以任意 host 都拿到全树。

## 6. Adapter

### 6a Host / storage adapter(K)— SessionLogStore 薄原语,payload opaque

```ts
interface SessionLogStore {
  append(session: string, entry: Entry): Promise<void>;
  getEntries(session: string): Promise<Entry[]>;        // 扁平,全部
  getEntry(session: string, id: string): Promise<Entry | undefined>;
  getPointer(session: string): Promise<string | null>;
  setPointer(session: string, id: string | null): Promise<void>;
  lease(session: string): Promise<{ release(): Promise<void> }>;  // 跨进程单写者
}
```

- **只做存储,不做图遍历**(`getPathToRoot` 在 ②,避免图逻辑下泄到每个 host)。
- **pointer 双源**:日志是**真相**(重放 `pointer_move`),`getPointer/setPointer` 标量是 **O(1) 缓存**;不变量 `标量 == replay(日志)`。
- **payload 当 opaque Json** 存取。
- **lease 守 ② 的所有 mutation**(invoke 的 append + navigate + fork),不只 invoke。
- 实例:jsonl / pg / ddb / **AgentCore**(只当**短期事件存储**,避开其长期语义抽取把死分支吃进"记忆")。

### 6b Engine 模块(M)— 解释 payload,不碰图逻辑

**职责 = 把 payload 翻译给所有上层**(模块,非冻结接口):

1. **包 payload**:把 turn 产出包成 entry payload,交给 ② 落盘(② 负责 id/parentId/append)。
2. **打 `kind` + `preview`**(display projection):② 图操作靠 kind,① 渲染靠 kind+preview。
3. **model-context projection**:把 ② 给的活跃路径折成自己的模型上下文(含 compaction、branch_summary 解释——全引擎特有,② 不懂)。
4. **branch-summary enrichment(可选)**:navigate 离开一条分支时,若要"留痕",由 ③b 生成一条 `kind:"meta"` 的摘要 entry,作为**独立 append**,**不焊进 `②.navigate`**。

接入形态(因引擎而异,正因如此不冻接口):
- **pi**:② 在 pi 的 `SessionStorage` 层接入——payload = pi `SessionTreeEntry`,`kind` 由 `entry.type`/`message.role` 映射(user→`turn_input`,assistant→`turn_output`,leaf→`pointer_move`,其余→`meta`)。
- **claude / opencode(未来)**:经 transcript 捕获把产出喂给 ②。

> ③b **不实现** navigate/fork(红线)。

## 7. 审阅留下的不变量与张力(实现的法律)

1. **navigate 纯粹**:② 只移指针;一切 pi 特有的离场摘要在 ③b,作独立 append。
2. **payload 单向 opaque**:只有 ③b 解释;②/③a/① 只碰 `id/parentId/kind/preview`。
3. **pointer 真相在日志**,③a 标量是缓存,维持 `标量 == replay(日志)`。
4. **lease 守全部 ② mutation**;fork 牵涉两 session(读源前缀 + 写新 id)。
5. **② 中立是一个赌注,不是证明**:只有 pi 一个样本,`kind` 分类法很可能照 pi 描的;真中立只有引擎 #2 能证伪。好在便宜可逆——赌错只重画 ③b,② 不动。

## 8. 开放问题

- **`kind` 最小集**:`{turn_input, turn_output, pointer_move, meta}` 够不够 ② 图操作 + ① 渲染?
- **path 读取 O(n)**:② 在扁平 entry 上走 parentId,远程 store 每次 O(n) 读 → 全量载入+缓存(pi 式)/ 物化活跃路径 / 可选 host 侧 path 读。v1 先全量载入。
- **lease 形状 + 争用策略**:navigate/fork 与在飞 turn 冲突时阻塞 or fail-fast(retryable)?TTL + fencing 防僵尸持有者。
- **payload stance A vs B**:A(现选)= opaque,session 与引擎绑定,存储跨 host 可移植。B(未来期权)= 标准化 message schema(consume A2A / AG-UI),跨引擎/UI 互解释——大承诺,等消费者拉动。
- **连续性已接**(§6b 的最小落地):`engines/pi` 的 `piHarnessFactory` 每 invoke **open-or-create**——已有 session 则 `open`(harness 经 `buildContext` = `getPathToRoot` + projection 看到历史),否则 `create`。连续性契约 = 同一 backing store + 同一 session id(jsonlSessionStore 跨进程重启仍连续,in-memory 需复用实例)。这是我们第一次实际碰本标准:`open`=读 substrate,`buildContext`=projection。
- **并发单写者已接(进程内,fail-fast)**:`createPiAgentFromHarness` 默认 `inProcessLease()`——同 session 已有在飞 turn 时第二个 invoke 立即 `failed{retryable}`("session busy"),**不排队**。这是 **invoke 编排层**只防写坏的地板,不是 §6a host substrate 的 `lease`;dedupe/排队/steering 是 channel/上层决策。**跨进程分布式锁仍 deferred**。尚未接:navigate / fork / 跨进程 lease。

## 9. 与 core / SPEC 的关系 + N×M×K 对齐

- **invoke(SPEC)**:`scope.session` 保持 opaque string = 沿 current 线性续接。**session-admin 不进 invoke / 不进 `Scope`。**
- **core([core-design](core-design.md) §6.5)**:已记录"tree/fork 跨 host 可移植"结论;本文是其展开。
- **N×M×K**:N(①)、K(③a)是**现在就标准化**的缝;M 的"中立核 ②"现在就立(因薄 host 缝),但 M 的"引擎适配 ③b"**只分模块、不冻接口**——M 轴真正的可换引擎,等第二个引擎兑现。
