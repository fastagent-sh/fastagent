---
title: CLI 参考
description: "完整的 fastagent CLI 参考：按工作流分组的命令、参数、退出码、平台扩展以及脚本/Coding Agent 行为保证。"
status: current
---

# CLI 参考

```bash
fastagent [-C <dir>] <command> [args] [options]
fastagent <command> --help     # 由源码生成的权威参数与示例
```

## 命令清单

### 创建、开发与构建

| 命令 | 说明 |
| --- | --- |
| `init [dir]` | 创建新 Agent、就地初始化已有 Agent 目录（默认 `.`）或安全重试依赖安装（`--no-install` 跳过） |
| `dev` | 本地热重载服务（`--no-watch` 关闭文件监听） |
| `build` | 执行类型检查并将 Agent 编译打包至 `dist/`（`--no-check`、`--json`） |
| `start` | 以生产姿态运行编译后的 `dist/`；拒绝缺失或陈旧构建 |
| `info` | 只读检查解析后的 Harness、沙箱、模型、工具、MCP 服务器、扩展、命令、密钥与存储（`--json`） |
| `models [search]` | 列出可用 `provider/modelId`（`-g` 仅内置模型；`--json`） |

### 调用、认证与远程管理

| 命令 | 说明 |
| --- | --- |
| `invoke [message]` | 发送单条消息（位置参数、`-` 或管道 `stdin`），将回复流式输出到 `stdout` 后退出（`--session`、`--conversation`、`--url`、`--remote`、`--json`） |
| `login [provider]` | 在本地、全局（`-g`）或远程部署（`--url` / `--remote`）登录模型提供商；搭配 `--check` 检查就绪状态（`ready`、`not_ready`、`invalid`） |
| `logout [provider]` | 移除本地、全局（`-g`）或远程部署（`--url` / `--remote`）中存储的提供商凭证 |
| `remote list\|add\|remove\|default` | 管理 `~/.config/fastagent/remotes.json` 中的远程端点（见[远程实例与客户端](remotes.md)） |

### 部署准备与安全检查

| 命令 | 说明 |
| --- | --- |
| `deploy init <target>` | 生成容器与平台声明文件（`docker`、`compose`、`fly`、`railway` 或已安装扩展如 `agentcore`；`--force`、`--no-install`）（见[部署指南](deploy.md)） |
| `deploy check` | 只读 CI 门禁，验证 Agent 可正常加载且构建上下文不泄漏本地密钥或状态（`--json`） |

### 平台扩展命令

安装 `@fastagent-sh/<name>` 平台扩展包后，会自动注册 `fastagent deploy init <name>` 与 `fastagent <name> ...`（例如 `npm i @fastagent-sh/agentcore` 会增加 `fastagent deploy init agentcore` 和 `fastagent agentcore init|start|invoke`）。运行 `fastagent <name> --help` 查看扩展参数。调用未安装的扩展会返回退出码 `2` 并提示所需安装的包名。

## 常用参数

全局参数（`-C <dir>`、`-v`/`--version`）放在子命令之前；命令参数放在子命令之后。所有命令均支持 `-h`/`--help`。

| 参数 | 适用命令 | 用途 |
| --- | --- | --- |
| `-C <dir>` | 任意命令之前 | 切换到 `<dir>` 运行（包含版本委托与扩展查找） |
| `--model <provider/modelId>` | `dev`、`start`、`invoke`、`info` | 覆盖模型（`--model` > `FASTAGENT_MODEL` > 配置文件） |
| `--harness <pi-durable\|dsh>` | `dev`、`start`、`invoke`、`info` | 覆盖运行时 Harness（`--harness` > `FASTAGENT_HARNESS` > 配置 > `pi-durable`） |
| `--sandbox <workspace\|read-only\|off>` | `dev`、`start`、`invoke`、`info` | `harness: "dsh"` 下的 OS 沙箱模式 |
| `--port <n>` | `dev`、`start` | HTTP 端口（`dev` 默认 `8787`；`start`：`--port` > `PORT` > `8787`） |
| `--bind <addr>` | `dev`、`start` | 绑定 IP 或 `localhost`（`dev`：`127.0.0.1`；`start`：`0.0.0.0`） |
| `--root <dir>` | `dev`、`start`、`invoke`、`info` | 覆盖实例根目录（`--root` > `FASTAGENT_ROOT` > `.fastagent/<mode>`） |
| `--name <name>` | `dev`、`start`、`invoke`、`info` | 覆盖实例名称（`--name` > `FASTAGENT_NAME`） |
| `--env-file <file>` | `dev`、`start`、`invoke`、`info`、`login`、`logout` | 覆盖环境密钥文件（默认 `.secrets/.env`；文件必须存在） |
| `--session <id>` | `invoke`、`remote add` | 续接指定会话 ID（`invoke`）或设置远程默认会话 ID（`remote add`） |
| `--conversation <name>` | `invoke` | 复用或创建调用方命名对话会话 |
| `--url <base>`、`--remote <name>`、`--key <key>` | `invoke`、`login`、`logout`、`remote add`（`--key`） | 指向线上部署而非本地目录（或用 `remote add` 保存 API Key / `$ENV_VAR` 引用）。推荐优先使用 `FASTAGENT_API_KEY` 或 `$ENV_VAR` 而非明文 `--key` |
| `--default` | `remote add` | 将新增或更新的远程端点设为默认 |
| `-g, --global` | `login`、`logout`、`models` | 操作全局 `~/.fastagent/.secrets/auth.json`（`login`/`logout`）或仅列出内置模型（`models`） |
| `--check` | `login` | 仅检查提供商/模型认证就绪状态，不触发登录（退出码 `0` 就绪、`1` 未就绪、`2` 无效） |
| `--method <account\|api-key>` | `login` | 非交互式指定登录方式 |
| `--timeout <seconds>` | `login` | 交互式登录超时秒数 |
| `--no-input` | `dev`、`start`、`invoke`、`login`、`logout` | 绝不等待终端交互；缺少必填项或需人工认证时直接退出码 `2` |
| `--json` | `info`、`models`、`invoke`、`login`、`build`、`deploy check`、`remote list` | 向 `stdout` 输出机器可读 JSON（`invoke` 为 NDJSON） |

## 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 成功（包括 `--help`、`--version` 与 `login --check` 就绪） |
| `1` | 运行时失败：消息未以 `completed` 结束、打开失败、部署检查未通过、配置无效，或 `login --check` 返回 `not_ready` |
| `2` | 用法或非交互输入错误：未知命令/参数、参数冲突、非交互模式下缺少必选项，或需要人工在终端完成的交互步骤 |

## CLI 解析机制

- **版本自动委托：** 在 Agent 目录内，全局安装的 `fastagent` 会自动委托给该项目本地安装的版本。未全局安装时，可使用 `npm run dev`/`build`/`start` 或 `npx @fastagent-sh/fastagent <command>`（切勿使用 `npx fastagent`，那是另一个包）。
- **自动共享运行中的 `dev` 服务：** 本地运行着 `fastagent dev` 时，`fastagent invoke` 会自动通过其 Agent API 通信，共享同一会话且无锁冲突。
- **显式目录定位：** 命令作用于当前目录（或 `-C <dir>`）。若在 Agent 的子目录中执行，会明确拒绝并提示 Agent 根目录位置，绝不猜测。

## 面向脚本与 Coding Agent 的工程保障

每条命令都为 CI 脚本与 Coding Agent 自动化闭环可靠运行而设计：

- **绝不卡在终端等待。** 缺少选择时直接退出码 `2` 并指明所需参数（`login --json` 返回结构化 `need_choice` 与可执行命令）。
- **人工步骤立即返回。** 浏览器 OAuth 登录绝不阻塞非交互调用：`login --json` 以退出码 `2` 返回 `need_user_action`、供负责人在终端执行的 `terminal_command` 与校验命令 `check_command`。
- **密钥绝不进入对话记录。** 凭证仅由负责人在自己终端输入，或存放于 `.secrets/.env` 与宿主机密钥管理服务中。
- **输出流可预测。** 结果数据写入 `stdout`；进度、会话提示、警告与错误全部写入 `stderr`。
