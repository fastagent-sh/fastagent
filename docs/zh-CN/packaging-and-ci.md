---
title: 打包、分发与 CI/CD
description: "使用 fastagent build 将 Agent 编译为版本化 npm 制品，在 CI 中用确定性退出码做发布门禁，像普通 TypeScript 代码一样升级与回滚。"
status: current
---

# 打包、分发与 CI/CD

FastAgent 项目由标准的 Markdown 和 TypeScript 构成——没有专有图编排 DSL，也没有隐藏的云端状态。`fastagent build` 会将项目编译为一个自包含的不可变 npm 包并输出到 `dist/`，让你可以用与普通 TypeScript 库完全相同的软件工程流程来完成版本控制、测试、发布、嵌入和回滚。

## 1. `fastagent build` 的产物结构

在 Agent 目录内运行 `fastagent build`：

```bash
fastagent build           # 使用 tsc 做类型检查并输出 dist/
fastagent build --json    # 面向 CI 与 Coding Agent 的机器可读输出
```

`fastagent build` 会先将产物写入暂存区 `.fastagent/build`，待所有检查全部通过后才原子替换为 `dist/`——构建失败绝不会破坏上一次可用的 `dist/`。

```text
dist/
├── index.js              # 生成的 ESM 入口，默认导出 AgentDefinition
├── index.d.ts            # TypeScript 类型声明（export default definition: AgentDefinition）
├── package.json          # 独立 ESM 清单，核心运行时归入 peerDependencies
├── build.json            # SHA-256 源码指纹，确保 fastagent start 拒绝陈旧构建
├── SYSTEM.md             # 拷贝的提示词、规则、README 与许可证文件
├── AGENTS.md
├── skills/               # 拷贝的 Agent Skills
├── prompts/              # 拷贝的提示词模板
├── assets/               # 拷贝的静态资源
├── fastagent.config.js   # 编译后的配置
└── src/                  # 编译后的工具与扩展（不含测试文件）
```

### 内置安全与工程卫生检查

在写入 `dist/` 之前，每次构建都会强制执行严格的制品边界校验：

- **完整 TypeScript 类型检查：** 使用项目自身的 `tsc` 编译 `fastagent.config.ts` 以及 `src/tools/` 和 `src/extensions/` 下的所有模块（仅当你已单独运行过 `tsc --noEmit` 时才传 `--no-check`）。
- **禁止跨目录越界导入：** 拒绝引用 Agent 目录之外的源码文件，防止产出的 `dist/` 缺失依赖。
- **绝不夹带本机状态或密钥：** 永不拷贝 `.secrets/`、`.env*`、`.state/`、`node_modules/`、`.git/`，也不会读取本机 `~/.pi/agent` 中的任何内容。
- **MCP 与 Harness 兼容性检查：** 验证相对路径的本地 stdio MCP 命令确实存在于 `dist/` 中；若 `mcpServers` 出现明文硬编码凭证（而非 `${VAR}` 占位符），或 `fastagent.config.ts` 选择了跳过 `pi-durable` 专有 `src/extensions/*` 的 Harness（如 `dsh`），会发出构建警告。
- **通过 `peerDependencies` 共享运行时：** `dist/package.json` 会将 `@fastagent-sh/fastagent` 以及内置 `pi-*` 包（`@earendil-works/pi-durable`、`@earendil-works/pi-ai`、`@earendil-works/pi-schema`）移入 `peerDependencies`。当宿主应用同时嵌入多个 Agent 包时，Node 只会安装一份共享运行时，不会重复膨胀。

## 2. 作为标准 npm 包分发与版本管理

因为 `dist/` 是一个完整的 ESM 包（`"type": "module"`，且 `exports["."]` 指向 `./index.js` 与 `./index.d.ts`），你可以直接沿用任意标准 JavaScript 包分发流程：

### 方式 A：发布到私有（或公有）npm Registry

```bash
# 在 Agent 仓库内（或 CI 发版任务中）
fastagent build
npm publish ./dist --access restricted
```

随后像普通依赖库一样在宿主后端安装并锁定版本：

```bash
npm install @acme/saas-copilot@1.4.2
```

```ts
import { baseEnv, openAgent } from "@fastagent-sh/fastagent";
import copilot from "@acme/saas-copilot";

const agent = await openAgent(copilot, {
  root: "/var/lib/myapp/copilot",
  secrets: { OPENAI_API_KEY: process.env.OPENAI_API_KEY },
  env: baseEnv(process.env),
});
```

升级 Agent 或回滚一次提示词/工具回归，只需要在 `package.json` 中修改 SemVer 版本号。在常驻后端服务中，调用 `await agent.close()` 后重新打开新版定义即可完成热升级。

### 方式 B：在 Monorepo Workspace 中直接消费

将 Agent 放在 `packages/saas-copilot/`，在 workspace 流水线中执行 `fastagent build`，然后任选以下一种方式供宿主应用导入：

1. 在 `packages/saas-copilot/package.json` 中添加指向编译产物的 `exports` 入口：

```json
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  }
}
```

2. 或从宿主应用直接导入 `./dist/index.js`（参考 [`examples/saas-copilot/server.ts`](../../examples/saas-copilot/server.ts)）。

## 3. 在 CI/CD 中设置发布门禁

每条 FastAgent CLI 命令都同时为 Coding Agent 与无人值守 CI 流水线设计：

- 绝不阻塞在交互式终端等待输入（传入 `--no-input` 或依赖自动非 TTY 检测；缺少参数时立即退出码 `2` 并给出具体提示）。
- 数据类命令支持 `--json` 结构化输出与确定性退出码（`0` 通过、`1` 致命错误或检测到密钥泄漏、`2` 参数错误或缺少输入）。

GitHub Actions 门禁示例（验证配置、类型构建与容器密钥防泄漏）：

```yaml
name: Verify & Ship Agent
on: [push, pull_request]

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "24"
      - run: npm ci
      - run: npm exec -- fastagent info --json
      - run: npm exec -- fastagent build --json
      # 当仓库同时包含容器部署文件（通过 `fastagent deploy init` 生成）时运行：
      - run: npm exec -- fastagent deploy check --json
```

- `fastagent info --json` 以只读方式校验 Agent 定义，并输出模型、工具、MCP 服务器与 `needs()` 声明的密钥清单。
- `fastagent build --json` 执行 TypeScript 校验并产出不可变 `dist/` 制品，返回 `{ dist, name, version, warnings }`。
- `fastagent deploy check --json` 检查 Docker 构建上下文，一旦发现 `.secrets/`、`.env*` 或 `.state/` 可能打入镜像即返回退出码 `1` 阻断发布。

## 4. 在 CI 中做工具单测与提示词回归评估

推荐采用三层测试金字塔，而不是在测试中 Mock 大模型（Mock 模型只能测通接线，测不出 `SYSTEM.md` 或 `skills/` 的行为退化）：

| 层级 | 验证目标 | 工具与执行频率 |
| --- | --- | --- |
| **1. 静态门禁** | TypeScript 类型、工具与 MCP 声明、Harness 兼容性、镜像密钥防泄漏 | 每次提交运行 `fastagent info --json`、`fastagent build --json`、`fastagent deploy check --json` |
| **2. 工具单元测试** | 参数 Schema 校验与转换、业务逻辑、`needs()` 密钥注入、`sessionIdOf()` 读取 | 每次提交用 Vitest 进程内直接调用 `defineTool`（零网络、零 Harness 启动） |
| **3. 行为回归 Evals** | 真实模型下的提示词、技能触发与工具调用质量 | PR 或每晚定时运行 Promptfoo 调用 `fastagent invoke --no-input` |

### 在 Vitest 中零 Harness 直接单测 `defineTool` 与 `needs()`

`defineTool` 返回与 Harness 无关的纯 `PortableTool` 对象，你可以将 `*.test.ts` 直接放在 `src/tools/*.ts` 同级目录（`fastagent build` 与运行时扫描会自动忽略 `*.test.*` 和 `*.spec.*`），无需启动任何运行时即可毫秒级单测：

```ts
// src/tools/workspace-metrics.test.ts
import { expect, it } from "vitest";
import type { ToolExecutionApi } from "@fastagent-sh/fastagent";
import metricsFactory from "./workspace-metrics.ts";

const stubApi: ToolExecutionApi = {
  output: () => {},
  executeTool: async () => ({}),
};

it("无需启动 Harness 即可校验参数并读取 sessionIdOf", async () => {
  const tool = metricsFactory.build({ TENANT_ID: "acme" });
  const result = await tool.execute({ windowDays: 14 }, stubApi, { sessionId: "sess-1" });
  expect(result.isError).toBeUndefined();
  expect(JSON.parse(result.output?.[0]?.text ?? "{}")).toMatchObject({
    tenantId: "acme",
    sessionId: "sess-1",
    windowDays: 14,
  });
});
```

### 用 Promptfoo 对提示词与技能做回归评估

通过 `fastagent invoke --no-input` 接入真实模型评估（如果 Agent 启用了本地 Shell/文件工具，可追加 `--harness dsh --sandbox read-only`）：

```yaml
# promptfooconfig.yaml
providers:
  - id: exec:npx @fastagent-sh/fastagent invoke --no-input
prompts:
  - "{{prompt}}"
tests:
  - vars:
      prompt: "Summarize workspace usage for the last 14 days"
    assert:
      - type: contains
        value: "Pro"
      - type: llm-rubric
        value: "Reports active seats and API request limits clearly without inventing metrics"
```

在 PR 或夜间 CI 流水线中注入模型密钥后运行 `npx promptfoo eval --ci` 即可完成端到端行为回归。

## 5. 为“人类 + Coding Agent”共同维护而设计

因为整个 Agent 仅包含 Markdown 提示词/技能与强类型 TypeScript 模块——没有任何可视化画布导出物或专有图 DSL——Coding Agent（Claude Code、Codex、Cursor、Pi）可以直接采用与工程师完全一致的闭环来修改和验证项目：

1. 编辑 `SYSTEM.md`、`skills/<name>/SKILL.md` 或 `src/tools/*.ts`。
2. 运行 `fastagent info --json` 与 `fastagent build --json` 验证类型与配置装配。
3. 使用 `fastagent invoke --json "..."` 做确定性冒烟测试。
4. 在提交 PR 或发布版本前运行 `fastagent deploy check --json`。

## 下一步

- 将编译后的 Agent 包嵌入后端：[嵌入应用](embedding.md)
- 部署容器或空闲休眠云服务：[部署指南](deploy.md)
- 在 AWS 上运行每用户隔离 MicroVM：[AWS AgentCore](agentcore.md)
- 全部 CLI 参数与退出码：[CLI 参考](cli.md)
