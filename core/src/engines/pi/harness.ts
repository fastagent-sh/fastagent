/**
 * pi 连续性 wiring:用 open-or-create 兜出"同 session 多 turn 有记忆"。
 *
 * 无状态设计下,harness 用完即弃;连续性不靠让 harness 活着,而靠
 * **session 持久(存 repo)、每 invoke 重新 open**——pi 的 prompt() 会
 * buildContext()(getPathToRoot + buildSessionContext)把历史 entry 折成上下文。
 * 这正是 SPEC portable conformance(无位置依赖)的落地。
 */
import { AgentHarness } from "@earendil-works/pi-agent-core";
import type {
  AgentTool,
  ExecutionEnv,
  Session,
  SessionMetadata,
  Skill,
} from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { type AuthResolver, resolvePiAuth } from "./auth.ts";

/** 给定 session 造一个绑该 session 的 pi harness。env/model/tools 在工厂内部注入。 */
export type BuildHarness = (session: string) => AgentHarness | Promise<AgentHarness>;

/**
 * Minimal repo shape needed for open-or-create (structurally satisfied by InMemorySessionRepo).
 *
 * KNOWN DEBT: this is a single-sample abstraction. pi's JsonlSessionRepo does NOT fit
 * (its create() requires { cwd }). The hosting/K knife will reshape this interface when
 * the first persistent backend lands; do not generalize it before then.
 */
export interface SessionRepoLike {
  list(): Promise<SessionMetadata[]>;
  open(metadata: SessionMetadata): Promise<Session>;
  create(options: { id?: string }): Promise<Session>;
}

export interface PiHarnessConfig {
  /** session 持久化后端;**跨 invoke 复用同一实例**才有连续性。 */
  repo: SessionRepoLike;
  env: ExecutionEnv;
  model: Model<any>;
  tools?: AgentTool[];
  systemPrompt?: string;
  /** 可显式调用/模型可见的 skills(作为 harness resources 注入)。 */
  skills?: Skill[];
  /** 解析模型认证。缺省 {@link resolvePiAuth}:先 pi OAuth(~/.pi/agent/auth.json),再退环境变量。 */
  getApiKeyAndHeaders?: AuthResolver;
}

/**
 * 造一个具备连续性的 BuildHarness:每 invoke open-or-create session。
 * 已有 → open(harness 经 buildContext 看得到历史);没有 → create。
 */
export function piHarnessFactory(config: PiHarnessConfig): BuildHarness {
  return async (sessionId) => {
    const session = await openOrCreate(config.repo, sessionId);
    return new AgentHarness({
      env: config.env,
      session,
      model: config.model,
      tools: config.tools,
      systemPrompt: config.systemPrompt,
      resources: config.skills ? { skills: config.skills } : undefined,
      getApiKeyAndHeaders: config.getApiKeyAndHeaders ?? resolvePiAuth(),
    });
  };
}

async function openOrCreate(repo: SessionRepoLike, sessionId: string): Promise<Session> {
  const existing = (await repo.list()).find((m) => m.id === sessionId);
  return existing ? repo.open(existing) : repo.create({ id: sessionId });
}
