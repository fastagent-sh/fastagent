---
title: Amazon Bedrock AgentCore
description: "在 Amazon Bedrock AgentCore 上部署每用户隔离的 FastAgent MicroVM，集成 Aurora DSQL 持久化、Secrets Manager 与零服务端依赖客户端。"
status: current
---

# Amazon Bedrock AgentCore

当你需要自动化的**每用户 MicroVM 隔离**、按活跃计费的空闲休眠（scale-to-zero）以及零服务器运维的全托管持久化时，请选择 **Amazon Bedrock AgentCore**。

每个 AgentCore 会话运行在独立的 MicroVM 中。FastAgent 将每个会话映射到一个独立的 Agent 实例（每用户或每工作区一个），并将历史会话、持久化提供商凭证与命名对话映射存入 **Amazon Aurora DSQL**。当 AgentCore 回收空闲 MicroVM 后，下一次请求会自动从上次中断处无缝续接。

按角色安装对应的两个独立包：
- **`@fastagent-sh/agentcore`**：安装在 Agent 仓库内（构建和运行容器 + CDK 基础设施）。
- **`@fastagent-sh/client-agentcore`**：安装在业务后端或运维机器上（零服务端、数据库或 CDK 依赖；通过 AWS IAM 调用运行时）。

## 1. 在 Agent 中初始化 AgentCore

```bash
npm i @fastagent-sh/agentcore
fastagent deploy init agentcore
```

生成的提交文件如下：

| 文件 | 用途 |
| --- | --- |
| `Dockerfile`、`.dockerignore` | 运行 `fastagent agentcore start` 的 ARM64 容器，自动排除 `.secrets/`、`.env*`、`.state/` 与 `agentcore/` |
| `agentcore/agentcore.json` | 声明基于 `Dockerfile` 构建运行时的 AgentCore 项目配置 |
| `agentcore/cdk/` | 引入 `FastAgentResources`（Aurora DSQL 集群 + Secrets Manager 只读授权）的 CDK 应用 |

`init` 会自动安装 CDK 依赖（传入 `--no-install` 可跳过）并打印 Agent 所需的密钥名称。一旦生成，`agentcore/` 归你永久维护，不会再被覆盖（`--force` 仅重新生成由 FastAgent 托管的容器文件）。

## 2. 在 Secrets Manager 中存放运行时密钥

在目标 AWS 账号与区域下，以 Agent 名称创建一个 Secrets Manager 密钥，值为包含键值对字符串的 JSON 对象（模型 API Key 与所有 `needs()` 声明的密钥）：

```bash
aws secretsmanager create-secret --name copilot --secret-string file://values.json
```

- 每个实例在 MicroVM 启动后的首次调用时读取该密钥。
- 若密钥尚未创建或无法读取，调用会显式返回 `internal` 并在下次调用重试（部署后再创建密钥无需重新部署）。
- 若同一个 key 同时出现在 Secrets Manager 与环境变量中，运行时会直接拒绝以防优先级静默冲突。
- Amazon Bedrock 模型与其他提供商一致，在密钥中配置 `AWS_BEARER_TOKEN_BEDROCK`。
- 如需自定义密钥名称，编辑 `agentcore/cdk/lib/cdk-stack.ts` 中的 `secretName`。

## 3. 执行部署

```bash
npx -y @aws/agentcore@1.0.3 deploy
```

[AgentCore CLI](https://github.com/aws/agentcore-cli) 会通过 CodeBuild 远程构建 `linux/arm64` 镜像（本地无需 Docker 或 ARM64 机器），并自动创建或更新运行时、Aurora DSQL 集群与 IAM 角色。

每次 CDK 合成都会自动运行 FastAgent 的构建上下文防泄漏检查，一旦 `.secrets/`、`.env*` 或 `.state/` 可能进入镜像即阻断部署。

### 从 CI 部署

配置好 AWS OIDC 凭证后：

```bash
npm ci
npm ci --prefix agentcore/cdk
npx -y @aws/agentcore@1.0.3 deploy --target prod
```

若 CDK bootstrap 由中心团队统一管理，请传入 `--skip-bootstrap`。

### 自定义 CDK 或 Terraform

可在任意 CDK 栈中直接导入 `@fastagent-sh/agentcore/cdk` 的 `FastAgentResources`。如果直接使用 Terraform 或 CloudFormation 部署：

| 配置项 | 要求 |
| --- | --- |
| 镜像 | 推送到 ECR 的 `linux/arm64` `Dockerfile` 镜像 |
| 协议与端口 | HTTP `8080` 端口 |
| `FASTAGENT_DSQL_ENDPOINT` | Aurora DSQL 集群端点 |
| `FASTAGENT_SECRETS` | Secrets Manager 密钥名 |
| 执行角色权限 | 集群 `dsql:DbConnectAdmin`、密钥 `secretsmanager:GetSecretValue`、ECR 拉取、CloudWatch Logs |

在非 AWS 本地测试该容器时，可用 `FASTAGENT_DATABASE_URL=postgres://...` 替代 `FASTAGENT_DSQL_ENDPOINT`，并通过环境变量传入密钥；服务监听在 `8080` 端口。

## 4. 调用与运维已部署的运行时

### 从业务后端调用（`@fastagent-sh/client-agentcore`）

```bash
npm i @fastagent-sh/client-agentcore
```

```ts
import { connectAgentCore, connectAgentCoreAuth } from "@fastagent-sh/client-agentcore";

const connection = {
  runtimeArn: "arn:aws:bedrock-agentcore:<region>:<account>:runtime/<id>",
  sessionId: sessionOf(user), // 33–256 字符：字母、数字、"-" 与 "_"，以字母或数字开头
  qualifier: "prod",
};

const agent = connectAgentCore(connection);
const msg = await agent.invoke({ conversation: "main", content: "hi" }, { wait: 120 });

// 可选：管理持久化在 Aurora DSQL 中的提供商凭证
const auth = connectAgentCoreAuth(connection);
const providers = await auth.providers();
```

`@fastagent-sh/client-agentcore` 同时重新导出 `connectAgent`、`connectAuth` 与 `AgentError`，让同一套后端代码在本地对接 `fastagent dev`（HTTP），上线无缝切到 AgentCore。调用方仅需 IAM 权限 `bedrock-agentcore:InvokeAgentRuntime`，无需 `FASTAGENT_API_KEY`。

### 从终端调用（`fastagent agentcore invoke`）

在调用机上安装 `@fastagent-sh/client-agentcore` 后：

```bash
export FASTAGENT_AGENTCORE_ARN="arn:aws:bedrock-agentcore:<region>:<account>:runtime/<id>"

fastagent agentcore invoke "hello"
echo "summarize this" | fastagent agentcore invoke --json
fastagent agentcore invoke "follow up" --instance <id> --session <sessionId>
```

支持 `--arn <arn>`、`--instance <id>`、`--session <id>`、`--qualifier <name>`（默认 `DEFAULT`）、`--model <provider/modelId>` 与 `--json`。

### 通过已保存的远程端点（CLI `--remote` 与 `@fastagent-sh/pi-remote`）

安装 `@fastagent-sh/client-agentcore` 后，在 `~/.config/fastagent/remotes.json` 添加 `agentcore` 条目：

```json
{
  "remotes": {
    "bedrock": {
      "type": "agentcore",
      "runtimeArn": "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/my_agent",
      "sessionId": "ops-session-id-at-least-33-characters",
      "qualifier": "prod"
    }
  }
}
```

此后可像普通 HTTP 远程一样统一使用 `fastagent invoke --remote bedrock`、`fastagent login --remote bedrock`、`fastagent logout --remote bedrock` 以及 [`@fastagent-sh/pi-remote`](remotes.md#4-从终端实时交互fastagent-shpi-remote)。

## 安全、重试与限制

- **MicroVM 隔离 vs 执行角色：** 每个 `sessionId` 运行在独立 MicroVM 和独立数据库分区中。但如 AWS 官方文档所述，MicroVM 内运行的任意代码可以访问其执行角色（进而访问共享的 Aurora DSQL 集群和 Secrets Manager 密钥）。如需严格的多租户防逃逸隔离，请关闭 `bash`/任意代码执行（`codingTools: false`），或按租户隔离 AWS 角色。
- **重试语义：** 平台临时故障（限流、冷启动、MicroVM 切换、DSQL/Secrets Manager 短暂抖动）会返回 `AgentError("unavailable")`（`retryable: true`）。权限或配置错误（`unauthorized`、缺密钥、非法配置）不可重试且显式报错。
- **限制：** 单条消息最大 **6.4 MiB**（`details.reason: "too_large"`）。写入 MicroVM 本地磁盘的文件不会在 MicroVM 回收后保留。删除 CDK 栈时默认保留 Aurora DSQL 集群并开启删除保护，防止误删会话历史。
