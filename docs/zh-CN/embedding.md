---
title: 嵌入应用
description: "将 FastAgent 直接嵌入你的 Node 后端或桌面应用，保留原有的认证、数据库与路由。"
status: current
---

# 嵌入应用

当你希望保留自己的用户认证、租户模型、业务数据库和前端界面，同时开箱获得持久化会话、崩溃恢复、流式输出与工具执行能力时，可以直接将编译后的 FastAgent 嵌入到你的 Node 后端或桌面应用中。

```bash
npm i @fastagent-sh/fastagent       # 需要 Node ≥ 24.15
```

先使用 `fastagent build` 将 Agent 编译为独立 npm 包（见[打包、分发与 CI/CD](packaging-and-ci.md)），再从宿主应用导入。

## 选择嵌入模式

| 场景 | 推荐方式 |
| --- | --- |
| **在自有鉴权后端中编写自定义路由 / UI** | 调用 `openAgent()`，在你的路由处理器中直接调用 `agent.messages.stream`、`agent.messages.send` 或 `agent.invoke`。 |
| **单 Node 进程托管多租户实例** | 使用 `openPostgresDatabase()` 创建共享连接池，传给每个 `openAgent({ name, database })`。 |
| **在现有 Web 服务中暴露标准 `/v1` Agent API** | 调用 `const service = await agent.serve({ apiKeys })`，将 `service.fetch` 挂载到 Next.js、Hono、Express 或 Fastify。 |
| **本地桌面应用** | 传入应用独占的 `root`，用 `agent.info().models` 渲染模型选择器，并妥善处理 `info().unusableDefault`。 |

## 1. 打开 Agent

```ts
import { baseEnv, openAgent } from "@fastagent-sh/fastagent";
import copilot from "@acme/saas-copilot"; // 由 `fastagent build` 编译产出

const agent = await openAgent(copilot, {
  root: "/var/lib/myapp/copilot",
  secrets: {
    ANTHROPIC_API_KEY: vault.read("anthropic"),
    LINEAR_API_KEY: vault.read("linear"),
  },
  env: baseEnv(process.env), // 供 Agent 子进程使用的 PATH、HOME、locale 与代理设置
  model: "anthropic/claude-sonnet-4-6",
});

// 关闭时停止所有 HTTP 端点并释放存储锁/租约
await agent.close();
```

`openAgent(definition, options)` 的关键选项：

- **`root`（必填，绝对路径）：** Agent 工作目录；本地 SQLite 状态存放在 `<root>/.state/`。
- **`name`：** 实例名称（单段路径名）。使用 PostgreSQL（`database` 或 `secrets.FASTAGENT_DATABASE_URL`）时必填。
- **`secrets`：** `needs()`、MCP `${VAR}` 占位符、环境变量型模型密钥与 `OTEL_*` 追踪配置的唯一来源。`openAgent` 绝不读取 `process.env`、`.secrets/` 或 `~/.fastagent`（模型凭证也可来自实例持久化存储 `/v1/auth/*` / `service.auth` 或 `<root>/.state/auth.json`）。
- **`env`：** Agent 派生子进程（`bash`、技能脚本、stdio MCP 服务器）的基础环境变量。默认为空；传入 `baseEnv(process.env)` 以透传标准 `PATH`、`HOME`、locale 与代理设置。请把 `OTEL_*` 放在 `secrets` 而非 `env`，防止子进程读到收集端凭证。
- **`model`：** 可选的 `provider/modelId`，覆盖 `fastagent.config.ts`。
- **`harness` / `sandbox`：** 可选 `"pi-durable"`（默认）或 `"dsh"`（需安装 `@fastagent-sh/harness-dsh`），`dsh` 下支持 `sandbox: "workspace" | "read-only" | "off"`。
- **`database`：** PostgreSQL 描述符（`{ url }`、`openPostgresDatabase(...)` 或 `@fastagent-sh/agentcore` 提供的 `dsqlDatabase({ endpoint })`）。

### 在单进程中通过一个 PostgreSQL 连接池托管多租户实例

当单个 Node 进程需要在 PostgreSQL（或 Aurora DSQL）上运行大量隔离实例时，用 `openPostgresDatabase` 共享一个连接池：

```ts
import { baseEnv, openAgent, openPostgresDatabase } from "@fastagent-sh/fastagent";
import copilot from "@acme/saas-copilot";

const db = openPostgresDatabase({ url: process.env.DATABASE_URL! }, { max: 20 });

const tenantA = await openAgent(copilot, {
  root: "/var/lib/myapp/tenants/a",
  name: "tenant-a",
  database: db,
  secrets: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
  env: baseEnv(process.env),
});

// Schema 迁移仅执行一次；关闭单个实例只释放其租约，保持共享连接池开启。
await tenantA.close();
// 在进程退出时统一关闭共享连接池。
await db.close();
```

#### 职责边界（为什么不内置通用 `AgentPool`）

FastAgent 有意保持为**单实例数据面**：`openPostgresDatabase()` 与 `openAgent()` 负责底层分布式持久化原语（共享连接池、单次迁移、池级批量续约、单写者租约隔离、协作式空闲让渡以及 `ready()` / `busy()` / `closed` 生命周期信号）；宿主应用负责多租户编排（租户到密钥的动态解析、跨副本粘性路由、宿主侧活跃 SSE/WebSocket 计数以及内存与 MCP 客户端驱逐预算）。把编排留在宿主侧，可避免将特定的租户模型或密钥管理抽象强加给现有业务后端。

多租户共享连接池生产提示：
- **池级批量续约：** 共享同一个 `openPostgresDatabase()` 句柄的多个实例会自动把租约续约合并为每周期一条批量 SQL（单批最多 500 个实例），避免随租户数量线性放大心跳写库压力。
- **协作式空闲让渡与纯订阅 SSE：** 在滚动发布或多副本流量漂移时，若新副本请求打开某个已被旧副本持有但当前空闲（`!agent.busy()`）的实例，旧副本会在下一次续约周期主动释放租约并干净关闭，而不会阻塞至租约过期；活跃消息轮次与远程认证流程（`agent.busy() === true`）绝不会被中途打断。注意让渡判定仅看 `agent.busy()`，不感知纯订阅状态的 `sessions.events()` 流：当无在途消息但浏览器挂着空闲 SSE 的租户被迁移到新副本时，旧流会结束，前端需凭 `?after=<entryId>` / `Last-Event-ID` 自动断点重连。
- **宿主缓存 4 条实现契约**（完整参考见 [`examples/saas-copilot/server.ts`](../../examples/saas-copilot/server.ts)）：
  1. **并发打开去重：** 按租户缓存进行中的 `openAgent()` Promise，防止高并发冷启动重复打开。
  2. **命中时检查 `agent.ready()` 并等待旧句柄关闭完成：** 当 `close()` 或协作让渡开始时，`ready()` 会同步切换为 `false`（早于异步 resolve 的 `agent.closed`）；命中到 `!agent.ready()` 的条目时应摘除，并等待 `agent.closed`（或正在进行的 `close()`）完成后再重新打开同一实例，避免与尚未释放的 SQLite 锁或 PostgreSQL 租约产生竞态。
  3. **监听 `agent.closed` 自动摘除：** 在 `agent.closed` settle 后清理缓存条目（同时覆盖协作让渡与异常失租）。
  4. **控制内存与 MCP 预算：** 通过 TTL/LRU 回收长期空闲（`!agent.busy()` 且无活跃宿主 SSE 流）的实例，多副本下按租户 ID 做粘性路由，并在进程退出时先关闭所有缓存实例再调用 `db.close()`。

## 2. 调用 Agent API

`LocalAgent` 暴露完整的 [Agent API](agent-api.md)（`sessions`、`messages`、`invoke`、`invokeStream`）以及生命周期辅助方法：

```ts
// 单次或命名对话调用
const digest = await agent.invoke(
  { conversation: "daily-digest", content: "/daily-digest" },
  { wait: 120 },
);

// 交互式会话与实时流式输出
const session = await agent.sessions.create();
for await (const event of agent.messages.stream({ sessionId: session.id, content: "hi" })) {
  if (event.type === "delta" && event.channel === "text") render(event.text);
  if (event.type === "done") finish(event.message);
}
```

`LocalAgent` 上的生命周期辅助方法：
- **`agent.ready()` / `service.ready()`：** 运行时可接收工作时返回 `true`，关闭一旦开始（在异步清理完成前）即同步切换为 `false`；`GET /health` 会同步返回 `503`，但嵌入式模式绝不退出宿主进程。
- **`agent.busy()`：** 当有任意消息轮次或远程认证流程活跃时返回 `true`（适合优雅下线或空闲休眠探活）。
- **`agent.closed`：** 可选 Promise，在 `close()` 或 PostgreSQL 单写者租约丢失后的清理完成后 resolve。
- **`agent.close()`：** 关闭已启动的 HTTP 服务并释放存储。运行中的轮次会被安全中断并在下次打开时自动恢复（若需永久终止，请先调用 `agent.sessions.cancel(sessionId)`）。

### 向终端用户推送流式输出

切勿将 `FASTAGENT_API_KEY` 下发到浏览器。在你的业务后端校验当前用户及其会话 ID 归属，再直接转发事件流：

```ts
import { AgentError, type MessageStreamEvent } from "@fastagent-sh/fastagent";

app.post("/chat/:session", requireUser, async (req, res) => {
  const sessionId = await sessionOfUser(req.user, req.params.session);
  const events = agent.messages.stream({ sessionId, content: req.body.text })[Symbol.asyncIterator]();
  // 被拒绝的请求会在首次读取时抛出异常——在写出 SSE 响应头前先检查。
  const first = await events.next().catch((error: unknown) => error);
  if (first instanceof AgentError) return res.status(409).json(first);

  res.setHeader("content-type", "text/event-stream");
  for (let next = first as IteratorResult<MessageStreamEvent>; !next.done; next = await events.next()) {
    res.write(`data: ${JSON.stringify(next.value)}\n\n`);
  }
  res.end();
});
```

## 3. 挂载 HTTP Agent API

```ts
const service = await agent.serve({ apiKeys: [process.env.AGENT_API_KEY!] });

// 将 service.fetch 挂载到现有 Web 服务，或绑定独立端口：
const port = await service.listen(8787);

// 关闭 agent 会优雅排空 HTTP 服务（500 ms）并释放存储
await agent.close();
```

不传 `apiKeys` 时，`service.fetch` 仅提供 `GET /health`。传入 `apiKeys` 后，在 `/v1` 下暴露完整的 [Agent API](agent-api.md#http-绑定)。

### 在主流 Web 框架中挂载 `service.fetch`

`service.fetch` 接收标准 Web `Request` 并返回 Web `Response`，路由路径为 `/health` 与 `/v1/...`。挂载前请剥离路径前缀；对于 Node 原生 `(req, res)` 服务，可使用 `@hono/node-server` 的 `getRequestListener` 桥接。

> **务必挂载在任何 Body Parser 之前。** 注册在挂载点之前的 Body Parser 会提前消费原始请求流，导致 `service.fetch` 无法读取请求体：
>
> ```ts
> app.use("/agent", getRequestListener(service.fetch, { overrideGlobalObjects: false })); // 先挂载
> app.use(express.json()); // 后解析
> ```

```ts
const { fetch: handler } = service;

// Next.js App Router (app/agent/[...path]/route.ts)
const toAgent = (req: Request) => {
  const url = new URL(req.url);
  url.pathname = url.pathname.slice("/agent".length);
  return handler(new Request(url, req));
};
export { toAgent as GET, toAgent as POST, toAgent as PATCH, toAgent as DELETE };

// Hono（mount 会自动剥离前缀）
app.mount("/agent", handler);

// Express（挂载在 express.json() 之前）
import { getRequestListener } from "@hono/node-server";
app.use("/agent", getRequestListener(handler, { overrideGlobalObjects: false }));

// Fastify（保留未消费请求体、hijack 响应、剥离前缀）
const listener = getRequestListener(handler, { overrideGlobalObjects: false });
app.register(async (scope) => {
  scope.removeAllContentTypeParsers();
  scope.addContentTypeParser("*", (_req, payload, done) => done(null, payload));
  scope.all("/agent/*", (req, reply) => {
    reply.hijack();
    req.raw.url = req.raw.url!.slice("/agent".length);
    listener(req.raw, reply.raw);
  });
});
```

## 4. 隔离与打开保障

- **严格输入边界：** 除 `FASTAGENT_LOG_LEVEL` 外，`openAgent` 不读取 `process.env`、`.secrets/` 或 `~/.fastagent`，也绝不修改 `process.env` 或编译后的包（第三方云 SDK 在未覆盖时仍可能读取自身环境凭证链）。
- **打开即快速失败：** 相对路径 `root`、缺少必填 `needs()` 密钥、存储锁已被占用、使用 PostgreSQL 但未传 `name` 或不兼容的构建格式，都会让 `openAgent()` 立即拒绝并给出可操作的错误信息。
- **多用户隔离：** 一个实例是一个信任域。需要强隔离的用户请分配独立实例；若共享实例，请在 `fastagent.config.ts` 中设 `codingTools: false`，确保自定义工具不读写共享文件/存储，并在后端校验每个会话 ID（含 `forkFrom.sessionId`）。

## 5. 桌面应用宿主

在本地桌面应用中运行 Agent 时建议：

- 传入应用专属 `root`，避免与开发者的 `fastagent dev` 抢锁。
- 读取 `agent.info().models` 渲染模型选择器（含 `contextWindow` 与支持的 `thinkingLevels`）。
- 若 `fastagent.config.ts` 指定的默认模型被下线或改名，`openAgent()` 仍能打开，但 `info().defaultModel` 为空且 `info().unusableDefault` 说明原因；未显式指定模型的消息会拒绝并返回 `missing_model`。直接向 `openAgent()` 传入无效 `options.model` 则会在打开时失败。
- 升级到新编译版本时，先 `await agent.close()` 再用新构建重新打开。
