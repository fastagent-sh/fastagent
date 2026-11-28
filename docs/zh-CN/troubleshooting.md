---
title: 故障排查
description: "快速定位并修复 FastAgent 在初始化、本地开发、OS 沙箱、远程认证与部署中的常见问题。"
status: current
---

# 故障排查

按以下报错信息或现象检索解决方案。提交 Issue 时，请附上 `fastagent info --json` 的输出结果。

## 初始化与开发

### `missing model`

**原因：** 未配置默认模型，且当前处于非交互终端无法弹出选择。
**解决：** 显式指定模型（运行 `fastagent models [search]` 查看有效的 `provider/modelId`）：

```bash
fastagent dev --model provider/modelId           # 单次运行覆盖
FASTAGENT_MODEL=provider/modelId fastagent dev   # Shell 或容器环境
# 或在 fastagent.config.ts 中设置 `model`        # 设为永久默认
```

### `auth: (none found)`

**原因：** 所选模型提供商在当前 Agent 下没有可用凭证。本地凭证按 Agent 保存在 `.secrets/auth.json`（`fastagent login -g` 写入 `~/.fastagent/.secrets/auth.json`）。
**解决：** 在 Agent 目录内运行 `fastagent login`，或在 `.secrets/.env` 中写入对应提供商的 API Key（如 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`）。

### 工具加载失败

**原因：** 出现 `Cannot find package`、`Unexpected token 'export'`，或报错指向 `src/tools/` 下的某个文件。
**解决：**
- 运行 `npm install` 并确认 `package.json` 中已设置 `"type": "module"`。
- `src/tools/` 下只放带有默认导出的可移植工具模块；辅助模块请移到 `src/tools/` 之外（例如 `lib/`）。
- 相对导入务必带 `.ts` 扩展名（`../lib/helper.ts`），纯类型导入使用 `import type`。

### `Invalid schema for function '...'`

**原因：** 部分模型提供商（尤其是 OpenAI）仅支持有限的 JSON Schema `format` 值（`date-time`、`date`、`email`、`uuid` 等），会拒绝 `format: "uri"` 等其他格式。
**解决：** 将不被支持的 `format` 替换为正则 `pattern`（JSON Schema 用 `pattern: "^https?://\\S+$"`，或 Zod 用 `z.string().regex(/^https?:\/\/\S+$/)`）。

### 端口已被占用

**解决：** 传入 `--port 8788`（或为 `fastagent start` 设置 `PORT=8788`）。

### `the storage ... is held by another process`

**原因：** 同一时刻仅允许一个进程持有某个实例的 SQLite 文件（或 PostgreSQL 租约）。另一个 `fastagent dev`、`fastagent start` 或独立 `fastagent invoke` 正在占用它。
**解决：** 停止另一个进程；或者保持 `fastagent dev` 运行，让 `fastagent invoke` 自动通过其 Agent API 连接。

## 本地开发

### `dev` 未检测到文件修改

- 修改 `SYSTEM.md`、`AGENTS.md`、`skills/` 与 `prompts/` 会在下一条消息自动生效。
- 修改 `src/`、`fastagent.config.ts`、`.mcp.json`、`package.json` 与 `.secrets/.env` 会在活跃轮次结束后优雅重启。
- `src/` 之外的文件（如 `lib/`）不在监听范围内，修改后需手动重启 `fastagent dev`。

### 发送消息时报 `busy`

**原因：** 会话队列已满（`details.reason: "queue_full"`）、进程触及并发上限（`"capacity"`），或当前已有轮次在运行且请求传入了 `whenBusy: "reject"`（`"running"`）。
**解决：** 独立任务请使用不同会话，或改传 `whenBusy: "queue"` / `"steer"`。

### 代理或企业网络错误

**解决：** 在 Shell 或 `.secrets/.env` 中设置 `HTTPS_PROXY`（及 `HTTP_PROXY` / `NO_PROXY`）。回环地址会自动绕过代理；局域网内部地址请加入 `NO_PROXY`。

## Harness 与 OS 沙箱

### `harness "dsh" requires @fastagent-sh/harness-dsh`

**原因：** `@fastagent-sh/harness-dsh` 是可选懒加载包，以保持核心包轻量。
**解决：** 在 Agent 目录中安装该包：

```bash
npm install @fastagent-sh/harness-dsh
```

### DSH 沙箱拒绝启动

**原因：** 在 `harness: "dsh"` 且 `sandbox: "workspace"` 或 `"read-only"` 下，若宿主机系统无法提供内核隔离（例如受限容器未开启 `bwrap` 所需的 user namespaces 或不支持 Landlock），`bash` 会按 fail-closed 原则拒绝启动。
**解决：** 为容器授予所需沙箱权限、在已隔离容器中使用 `--sandbox off`，或通过 `codingTools: ["read"]` / `codingTools: false` 关闭 `bash`。

## 远程端点与远程认证

### 远程调用报错 `unauthorized` 与 `auth_required` 的区别

- **`unauthorized`（HTTP 401）：** 你传给 FastAgent 服务的 **API Key**（`FASTAGENT_API_KEY`、`--key` 或 `remotes.json` 中的 `apiKey`）缺失或错误。
- **`auth_required`（位于 `message.error`）：** FastAgent 服务已接收请求，但实例内的**模型提供商**缺少有效凭证。请在宿主机注入模型 API Key，或运行 `fastagent login <provider> --remote <name>`。

## 部署问题

### 重新部署后历史会话丢失

**原因：** 实例状态被写入了容器的临时文件系统。
**解决：** 在 `/data`（生成容器的默认 `FASTAGENT_ROOT`）挂载持久化卷，或设置 `FASTAGENT_DATABASE_URL` 指向 PostgreSQL。

### `deploy init` / `deploy check` 失败，或容器启动即退出

- **`persistent storage is not mounted at /data`：** 请在 `/data` 挂载持久化卷（`-v <name>-data:/data`）。即使通过 `FASTAGENT_DATABASE_URL` 将会话存入 PostgreSQL，生成的容器（`FASTAGENT_DEPLOYED=1`）仍要求挂载 `/data` 卷以存放工作文件与部署租约。
- **`FASTAGENT_NAME is required for a deployment`：** 确认 `Dockerfile` 中设置了 `ENV FASTAGENT_NAME=<name>`（或在容器环境变量中传入）。
- **报告构建上下文密钥泄漏：** 缺少 `.dockerignore` 或未排除 `.secrets/`、`.env*`、`.state/`、`.fastagent/`。更新 `.dockerignore`，或运行 `fastagent deploy init <target> --force` 重新生成由 FastAgent 托管的文件。
