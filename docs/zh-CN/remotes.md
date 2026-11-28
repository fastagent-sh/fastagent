---
title: 远程实例与客户端
description: "运维已部署的 FastAgent 实例：保存命名 HTTP 端点、通过 CLI 远程调用与登录，以及从任意后端或边缘函数接入。"
status: current
---

# 远程实例与客户端

当 Agent 上线到 Docker、Fly.io、Railway 或自有云环境后，日常运维通常需要三件事：跨环境的快捷 CLI 访问、免重部署的远程模型提供商登录，以及面向业务应用与 Webhook 的零依赖客户端。

FastAgent 通过 `~/.config/fastagent/remotes.json` 与同一份 [Agent API](agent-api.md) 统一解决这三件事。

## 1. 保存部署端点（`fastagent remote`）

`fastagent remote` 在 `~/.config/fastagent/remotes.json` 中管理命名 HTTP 端点（可通过 `FASTAGENT_REMOTES_PATH` 或 `$XDG_CONFIG_HOME/fastagent/remotes.json` 覆盖）。

```bash
# 保存一个 HTTP 部署（推荐使用 $ENV_VAR 环境变量引用而非明文 API Key）
fastagent remote add prod https://agent.example.com --key '$PROD_AGENT_KEY' --default

# 列出已保存的远程端点（明文密钥自动脱敏；$ENV_VAR 会展示变量名）
fastagent remote list
fastagent remote list --json

# 切换默认端点或移除端点
fastagent remote default prod
fastagent remote remove prod
```

`~/.config/fastagent/remotes.json` 示例：

```json
{
  "default": "prod",
  "remotes": {
    "prod": {
      "type": "http",
      "url": "https://agent.example.com",
      "apiKey": "$PROD_AGENT_KEY"
    }
  }
}
```

## 2. 通过 CLI 远程调用与认证

### 发送消息

```bash
# 使用 remotes.json 中的命名端点
fastagent invoke --remote prod "Summarize open incidents"

# 复用调用方命名对话（适合定时任务与持续告警）
fastagent invoke --remote prod --conversation daily-digest "/daily-digest"

# 直接指定 URL（从环境变量读取 FASTAGENT_API_KEY，或传 --key）
FASTAGENT_API_KEY="$PROD_AGENT_KEY" fastagent invoke --url https://agent.example.com "hello"
```

可传入 `--session <id>` 续接指定会话、`--model <provider/modelId>` 临时覆盖本次调用模型，或 `--json` 输出 NDJSON 事件流。

### 远程模型提供商认证

线上实例通过 `/v1/auth/*` 获取的提供商凭证会写入持久化存储（`/data` 上的 SQLite 或 PostgreSQL），OAuth 会话与刷新后的 Token 在重启与空闲休眠后均完整保留：

```bash
# 在远程实例上完成交互式 OAuth 或 API Key 登录
fastagent login openai-codex --remote prod
fastagent login anthropic --url https://agent.example.com

# 非交互式就绪检查（退出码：0 就绪，1 未就绪，2 无效）
fastagent login openai/gpt-5.5 --check --remote prod --json

# 从远程实例移除已保存的凭证
fastagent logout openai-codex --remote prod
```

注意区分两层认证：
- **`FASTAGENT_API_KEY`** 用于认证**你的调用方访问 FastAgent 实例**。
- **`fastagent login --remote`** 用于认证**FastAgent 实例访问模型提供商**（OpenAI、Anthropic 等）。

## 3. 从业务应用连接（`@fastagent-sh/client`）

零 Node 依赖——只要存在 `fetch` 即可运行（Node、Bun、Deno、浏览器、边缘函数）：

```ts
import { connectAgent } from "@fastagent-sh/client";
import { connectAuth } from "@fastagent-sh/client/auth";

const agent = connectAgent("https://agent.example.com", {
  apiKey: process.env.PROD_AGENT_KEY!,
});

const msg = await agent.invoke(
  {
    conversation: "incident:inc-415",
    idempotencyKey: webhookEventId,
    content: "Triage the 503 spike on /api/checkout",
  },
  { wait: 120 },
);

const auth = connectAuth("https://agent.example.com", {
  apiKey: process.env.PROD_AGENT_KEY!,
});
const providers = await auth.providers();
```
