---
title: 使用 FastAgent 开发 Agent
description: "从想法到经过测试并成功部署的持久化 Agent 服务——面向人类开发者与 Coding Agent 的端到端实操指南。"
status: current
---

# 使用 FastAgent 开发 Agent

本指南带你把一个 Agent 从构想落地为经过测试、成功部署的持久化服务，每一步都配有可执行的验收检查。无论是由人类开发者亲自操作，还是交给 Coding Agent 代为构建，流程完全一致。

```text
define scope → init → prompt, skill, tool → typecheck & unit test → live invoke
  → deploy check & deploy → verify & report
```

## 1. 明确各类职责的归属位置

先与项目负责人确认 Agent 的目标、允许执行的操作、外部联系范围与审批规则。如果目录中已存在 Agent（包含 `fastagent.config.ts`），请直接复用。

| 职责 | 归属位置 |
| --- | --- |
| 目标、常驻规则、审批边界 | `SYSTEM.md` |
| Agent 处理的项目事实数据 | 项目自身的文件，通过工具按需读取 |
| 可复用操作流程 | `skills/<name>/SKILL.md` |
| 精确的强类型操作与外部 API 调用 | `src/tools/<name>.ts` |
| 模型、Harness、沙箱、编码工具、Provider、MCP 服务器 | `fastagent.config.ts` |
| 业务记录与用户数据 | 你自己的业务数据库；会话历史不是业务数据库 |

让 Agent 自主决定工具调用步骤；仅当产品明确要求固定顺序编排时，才把刚性多步流水线放在宿主应用中。

**选择正确的隔离姿态：** 在默认的 `pi-durable` Harness 上，内置编码工具（`read`、`write`、`edit`、`bash`）以当前操作系统进程权限运行——提示词或强类型工具本身不是安全沙箱。需要强隔离时，可在 `fastagent.config.ts` 中设置 `codingTools: false`（或 `["read"]`）、使用 `harness: "dsh"` 启用内核级 OS 沙箱（`workspace` 或 `read-only`），或将 Agent 隔离在容器 / AgentCore MicroVM 中。

## 2. 创建或初始化 Agent 项目

```bash
npm install -g @fastagent-sh/fastagent
fastagent init my-agent          # 创建全新 Agent 目录
cd my-agent
```

若目录中已有 `SYSTEM.md`、`skills/` 或 `src/tools/`，可直接在该目录运行 `fastagent init` 就地补齐配置与依赖（保留原有文件；可先运行 `fastagent info --json` 确认已有技能已被识别）。若要在现有应用仓库中接入 Agent，请使用独立子目录（例如 `fastagent init agents/support`），避免修改宿主应用配置。若 `npm install` 中途失败，直接重跑同一 `fastagent init` 命令即可安全续跑；在已就绪的项目中重复运行不会产生任何修改。

后续步骤保持在 Agent 目录内执行：在 Agent 目录中，全局 `fastagent` 会自动委托给项目本地安装的版本。若未全局安装，请使用 `npx @fastagent-sh/fastagent <command>`（切勿使用 `npx fastagent`，那是另一个无关包）。

## 3. 配置 TypeScript

工具、辅助函数与测试统一使用 TypeScript 编写。Node ≥ 24.15 通过剥离类型原生执行 TypeScript，因此需要注意：
- 导入相对模块时带上 `.ts` 扩展名（`../lib/batches.ts`），导入纯类型时使用 `import type`；
- 避免使用不可擦除语法（`enum`、`namespace`、构造函数参数属性、装饰器、JSX）。

```bash
npm install --save-dev typescript@^7.0.2 @types/node@22
npm pkg set 'scripts.typecheck=tsc --noEmit' 'scripts.test=node --test test/*.test.ts'
mkdir -p lib test skills/review-batches src/tools
```

**`tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2025",
    "module": "NodeNext",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "lib/**/*.ts", "test/**/*.ts", "fastagent.config.ts"]
}
```

## 4. 添加提示词、技能与可移植工具

下面是一个完全离线的完整示例：用于规划提案评审批次的 Agent。

**`SYSTEM.md`**

```markdown
# Review assistant

Help the owner review project proposals in manageable batches. Choose relevant sources and methods,
separate evidence from assumptions, and retain the owner's decisions in the agreed working notes.
Use review-batches when planning a review and plan-batches for the batch count.
Ask before sending messages, publishing changes, or spending money. Record pending approvals instead
of treating silence as permission.
```

**`skills/review-batches/SKILL.md`**

```markdown
---
name: review-batches
description: Plan manageable batches when the owner asks to review a set of proposals.
---

Confirm which proposals are in scope and the owner's preferred batch size. Use plan-batches for the
count. Group related proposals, explain uncertain evidence, and present a draft plan for approval.
```

**`lib/batches.ts`**

```ts
export function batchCount(items: number, size: number): number {
  return Math.ceil(items / size);
}
```

**`src/tools/plan-batches.ts`**

```ts
import { defineTool } from "@fastagent-sh/fastagent";
import { batchCount } from "../../lib/batches.ts";

export default defineTool({
  name: "plan-batches",
  description: "Count review batches for a non-negative item count and a positive batch size.",
  parameters: {
    type: "object",
    properties: {
      items: { type: "integer", minimum: 0 },
      size: { type: "integer", minimum: 1 },
    },
    required: ["items", "size"],
  } as const,
  execute: async ({ items, size }) => JSON.stringify({ batches: batchCount(items, size) }),
});
```

来自 `@fastagent-sh/fastagent` 的 `defineTool` 在 `pi-durable` 和 `dsh` 上行为完全一致，支持原生 JSON Schema（`as const`）、Zod v4（或任意 Standard JSON Schema v1 库）及 `@earendil-works/pi-schema`。参数在 `execute` 运行前自动校验。需要密钥的工具用 `needs(["NAME"], (secrets) => defineTool(...))` 包裹。共享辅助模块请放在 `src/` 之外（此处放在 `lib/`）。

**`test/batches.test.ts`**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { batchCount } from "../lib/batches.ts";
import planBatches from "../src/tools/plan-batches.ts";

test("batch planning calculates counts, and the tool answers with them", async () => {
  assert.equal(batchCount(5, 2), 3);
  // This tool uses neither the harness api nor context.
  const result = await planBatches.execute({ items: 5, size: 2 }, {} as never, {} as never);
  assert.deepEqual(result.output, [{ type: "text", text: '{"batches":3}' }]);
});
```

在无需模型和任何密钥的情况下离线验证：

```bash
npm run typecheck
npm test
fastagent info --json      # 列出 plan-batches 工具与 /skill:review-batches
```

如果想确认类型检查确实生效，可以临时把 `test/batches.test.ts` 中的 `batchCount(5, 2)` 改为 `batchCount("5", 2)`，验证 `npm run typecheck` 失败后再恢复。

## 5. 发送一条真实模型消息

与负责人选定模型提供商与模型 ID，并用 `fastagent login <provider/model-id> --check` 检查就绪状态（就绪时退出码为 `0`）：

- **账号登录（OAuth）：** `fastagent login <provider> --method account --json` 会返回供负责人在自己终端运行的 `terminal_command` 以及完成后的验证命令 `check_command`。
- **API Key：** `fastagent login <provider> --method api-key --json` 会指明需要负责人填入的环境变量名及 `.secrets/.env` 文件路径。

**切勿让负责人在 Agent 对话框中粘贴任何密钥**，并确保密钥不出现在提交、Issue 或日志中。

在 `fastagent.config.ts` 中写入 `model: "provider/model-id"`，然后执行一次真实调用：

```bash
fastagent invoke "Use plan-batches for 5 proposals at 2 per batch. Do not send anything."
```

这会发起真实模型请求（可能产生费用）。最终回答输出到 `stdout`，工具调用与会话信息输出到 `stderr`。仅当消息以 `completed` 结束时退出码才为 `0`。请同时检查回答内容与工具调用轨迹，而非只看退出码。可搭配 `--json` 获取结构化 NDJSON 事件，`--session <id>` 续接会话，或 `--conversation <name>` 复用命名对话。

日常迭代请运行 `fastagent dev`：提示词、`AGENTS.md`、技能与模板的修改在下一条消息即刻生效，`src/` 的改动会优雅重启工作进程。若修改了 `src/` 之外的文件（如 `lib/`），需手动重启 `dev`。

## 6. 嵌入到业务应用（可选）

运行 `fastagent build` 编译 Agent，用 `openAgent(definition, { root, secrets, env })` 打开实例，并通过 [Agent API](agent-api.md)（`sessions.create`、`messages.send`、`messages.stream` 或 `invoke`）调用。应用保留完整的认证、租户隔离与业务数据管理权。详见[嵌入应用](embedding.md)。

## 7. 检查并部署上线

与负责人确定部署平台并阅读[部署指南](deploy.md)（若需 AWS 每用户 MicroVM 隔离，请阅读 [AWS AgentCore](agentcore.md)）。

```bash
fastagent deploy init docker   # 或 compose、fly、railway、agentcore
fastagent deploy check         # 校验定义可正常加载，且未泄漏本地密钥或状态
```

由负责人通过宿主平台的密钥管理或环境文件注入运行时密钥（`FASTAGENT_API_KEY`、模型 API Key、`needs` 声明的密钥）——切勿通过聊天记录传递。线上实例也可使用 `fastagent login <provider> --url <url>` 远程完成模型提供商认证（持久化存储在实例存储中）。

验证线上部署：

```bash
fastagent invoke --url https://<your-host> "hello"
```

也可以保存为命名远程端点（`fastagent remote add prod https://<your-host> --key '$PROD_AGENT_KEY'`），随后在 `invoke`、`login`、`logout` 和 [`@fastagent-sh/pi-remote`](remotes.md) 中统一使用 `--remote prod`。

部署后各类数据的持久化边界：

| 数据 | 持久化方式 |
| --- | --- |
| 提示词、技能、代码 | 打包进容器镜像；随新版本部署更新 |
| 会话、命名对话、远程认证凭证 | 持久化卷 `/data`（SQLite）或 PostgreSQL / Aurora DSQL（`FASTAGENT_DATABASE_URL`） |
| 业务记录与外部副作用 | 你自己的数据库或外部系统；工具的外部副作用应容忍重试 |

## 8. 汇报验证清单

| 检查项 | 证明了什么 | 不能证明什么 |
| --- | --- | --- |
| `npm run typecheck`、`npm test`、`fastagent info --json` | 类型安全、工具逻辑、定义装配正确 | 真实模型表现 |
| `fastagent invoke` | 模型调用、工具 Schema 与执行路径畅通 | 线上部署配置 |
| `fastagent deploy check` | 构建上下文无本地密钥或状态泄漏 | 线上宿主机网络连通性 |
| `fastagent invoke --url` / `--remote` | 线上服务通过 Agent API 正常响应 | 所有下游外部副作用 |

如实汇报实际执行的命令、结果、待负责人完成的剩余操作以及未验证项。确保 `.secrets/` 与 `.fastagent/` 未被提交，并关闭启动过的临时进程。
