/**
 * One EventBridge Scheduler alarm per AgentCore session, in the runtime's own schedule group (`cdk.ts`).
 *
 * Each session has one deterministic schedule name (`alarmNameOf`), set to `at(T)` with `ActionAfterCompletion: "NONE"`
 * so an update inside an alarm invocation never races with EventBridge deleting the schedule after it returns; when an
 * instance has nothing left scheduled (`at === undefined`), it deletes its own schedule.
 *
 * The group also holds `.deploy`, created by CloudFormation: its `Target` gives the runtime its own ARN and the
 * invocation role's ARN without a CloudFormation self-reference on `Runtime`, and after each deploy of an agent with
 * schedules (or pre-configured `instances`) `.deploy` fires `{ rearm: true }`, which moves existing instances' alarms to
 * `min(currentAlarm, earliestNewSchedule)` without waking their microVMs and then disables `.deploy`.
 */
import { createHash } from "node:crypto";
import {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  GetScheduleCommand,
  type GetScheduleCommandOutput,
  SchedulerClient,
  UpdateScheduleCommand,
} from "@aws-sdk/client-scheduler";
import { SESSION_ID_PATTERN } from "@fastagent-sh/client/agentcore/contract";
import type { AgentDefinition, PostgresDatabase } from "@fastagent-sh/fastagent";
import {
  Unavailable,
  definitionSchedules,
  earliestScheduleRun,
  listDatabaseInstances,
} from "@fastagent-sh/fastagent/platform";
import { DEPLOY_SCHEDULE_NAME } from "./variables.ts";

const REARM_CONCURRENCY = 16;

type SchedulerSender = Pick<SchedulerClient, "send">;

export interface AlarmGroupOptions {
  group: string;
  /** Session ids armed on deploy even before a Caller invokes them (`FASTAGENT_ALARM_INSTANCES`). */
  instances?: readonly string[];
  client?: SchedulerSender;
  now?: () => Date;
}

export interface AlarmGroup {
  /** The `ServeAgentOptions.alarm` callback for one session's open instance. */
  forSession(sessionId: string): (at: Date | undefined) => Promise<void>;
  /** Move existing (and pre-configured) instances' alarms to the new definition's first fire, then disable `.deploy`. */
  rearm(definition: AgentDefinition, database: PostgresDatabase): Promise<void>;
}

interface DeployTarget {
  runtimeArn: string;
  roleArn: string;
  targetArn: string;
}

/** Up to 63 chars (`[A-Za-z0-9_.-]`), starting alphanumeric (so never `.deploy`), collision-free over 256-char ids. */
export function alarmNameOf(sessionId: string): string {
  const prefix = sessionId.slice(0, 19);
  const digest = createHash("sha256").update(sessionId).digest("base64url");
  return `${prefix}.${digest}`;
}

/**
 * EventBridge `at(yyyy-mm-ddThh:mm:ss)` has 1-second resolution: round UP so the alarm never fires hundreds of
 * milliseconds before `at` and finds nothing due yet, and stay at least 1 second ahead of `now`.
 */
export function atExpression(at: Date, now: Date): { expression: string; targetMs: number } {
  const dueSeconds = Math.ceil(at.getTime() / 1000);
  const minSeconds = Math.floor(now.getTime() / 1000) + 1;
  const epochSeconds = Math.max(dueSeconds, minSeconds);
  const targetMs = epochSeconds * 1000;
  return {
    expression: `at(${new Date(targetMs).toISOString().slice(0, 19)})`,
    targetMs,
  };
}

function parseAtExpression(expression: string | undefined): Date | undefined {
  if (expression === undefined) return undefined;
  const match = /^at\((\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\)$/.exec(expression);
  return match ? new Date(`${match[1]}Z`) : undefined;
}

export function universalTargetArn(partition = "aws"): string {
  return `arn:${partition}:scheduler:::aws-sdk:bedrockagentcore:invokeAgentRuntime`;
}

function schedulerError(what: string, error: unknown): Error {
  const { name, $fault, code } = error as { name?: string; $fault?: string; code?: string };
  const passing =
    $fault === "server" ||
    name === "ThrottlingException" ||
    name === "ServiceQuotaExceededException" ||
    name === "TimeoutError" ||
    (typeof code === "string" && /^(ECONN|ETIMEDOUT|EAI_AGAIN|ENET|EHOST|EPIPE)/.test(code));
  return new (passing ? Unavailable : Error)(`${what}: ${(error as Error).message}`, { cause: error });
}

function isErrorNamed(error: unknown, expected: string): boolean {
  return (error as { name?: string } | null)?.name === expected;
}

function parseDeployTarget(group: string, schedule: GetScheduleCommandOutput): DeployTarget {
  const roleArn = schedule.Target?.RoleArn;
  const inputText = schedule.Target?.Input;
  if (!roleArn || !inputText) {
    throw new Error(`the alarm schedule ${group}/${DEPLOY_SCHEDULE_NAME} has no Target RoleArn or Input`);
  }
  let parsed: { AgentRuntimeArn?: unknown };
  try {
    parsed = JSON.parse(inputText) as { AgentRuntimeArn?: unknown };
  } catch {
    throw new Error(`the alarm schedule ${group}/${DEPLOY_SCHEDULE_NAME} has non-JSON Target Input`);
  }
  if (typeof parsed.AgentRuntimeArn !== "string" || !parsed.AgentRuntimeArn) {
    throw new Error(`the alarm schedule ${group}/${DEPLOY_SCHEDULE_NAME} names no AgentRuntimeArn`);
  }
  const partition = parsed.AgentRuntimeArn.split(":")[1] || "aws";
  return {
    runtimeArn: parsed.AgentRuntimeArn,
    roleArn,
    targetArn: schedule.Target?.Arn ?? universalTargetArn(partition),
  };
}

async function mapConcurrent<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await work(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

export function createAlarmGroup(options: AlarmGroupOptions): AlarmGroup {
  const { group, instances = [], client = new SchedulerClient({}), now = () => new Date() } = options;
  let cachedTarget: Promise<DeployTarget> | undefined;

  const readDeploySchedule = (): Promise<GetScheduleCommandOutput> =>
    client.send(new GetScheduleCommand({ GroupName: group, Name: DEPLOY_SCHEDULE_NAME })).catch((error: unknown) => {
      throw schedulerError(`reading the alarm target ${group}/${DEPLOY_SCHEDULE_NAME} failed`, error);
    });

  const targetOf = (): Promise<DeployTarget> => {
    cachedTarget ??= readDeploySchedule()
      .then((schedule) => parseDeployTarget(group, schedule))
      .catch((error: unknown) => {
        cachedTarget = undefined;
        throw error;
      });
    return cachedTarget;
  };

  const upsertSession = async (
    target: DeployTarget,
    sessionId: string,
    expression: string,
    sinceIso: string,
  ): Promise<void> => {
    const spec = {
      GroupName: group,
      Name: alarmNameOf(sessionId),
      ScheduleExpression: expression,
      ScheduleExpressionTimezone: "UTC",
      FlexibleTimeWindow: { Mode: "OFF" as const },
      ActionAfterCompletion: "NONE" as const,
      State: "ENABLED" as const,
      Target: {
        Arn: target.targetArn,
        RoleArn: target.roleArn,
        Input: JSON.stringify({
          AgentRuntimeArn: target.runtimeArn,
          RuntimeSessionId: sessionId,
          ContentType: "application/json",
          Payload: JSON.stringify({ alarm: true, since: sinceIso }),
        }),
      },
    };
    try {
      await client.send(new UpdateScheduleCommand(spec));
    } catch (error) {
      if (!isErrorNamed(error, "ResourceNotFoundException")) {
        throw schedulerError(`setting the alarm for "${sessionId}" failed`, error);
      }
      try {
        await client.send(new CreateScheduleCommand(spec));
      } catch (createError) {
        if (!isErrorNamed(createError, "ConflictException")) {
          throw schedulerError(`setting the alarm for "${sessionId}" failed`, createError);
        }
        await client.send(new UpdateScheduleCommand(spec)).catch((retryError: unknown) => {
          throw schedulerError(`setting the alarm for "${sessionId}" failed`, retryError);
        });
      }
    }
  };

  const deleteSession = async (sessionId: string): Promise<void> => {
    try {
      await client.send(new DeleteScheduleCommand({ GroupName: group, Name: alarmNameOf(sessionId) }));
    } catch (error) {
      if (isErrorNamed(error, "ResourceNotFoundException")) return;
      throw schedulerError(`clearing the alarm for "${sessionId}" failed`, error);
    }
  };

  return {
    forSession(sessionId: string) {
      let lastSet: string | null | undefined;
      return async (at: Date | undefined): Promise<void> => {
        if (at === undefined) {
          if (lastSet === null) return;
          await deleteSession(sessionId);
          lastSet = null;
          return;
        }
        const current = now();
        const { expression } = atExpression(at, current);
        if (lastSet === expression) return;
        const target = await targetOf();
        await upsertSession(target, sessionId, expression, current.toISOString());
        lastSet = expression;
      };
    },

    async rearm(definition: AgentDefinition, database: PostgresDatabase): Promise<void> {
      const deploySchedule = await readDeploySchedule();
      const target = parseDeployTarget(group, deploySchedule);
      cachedTarget = Promise.resolve(target);

      const schedules = definitionSchedules(definition);
      const existing = await listDatabaseInstances(database, definition.name);
      const sessionIds = [...new Set([...existing, ...instances])].filter((id) => SESSION_ID_PATTERN.test(id));
      const current = now();
      const earliest = earliestScheduleRun(schedules, current);

      if (earliest !== undefined && sessionIds.length > 0) {
        const { expression, targetMs } = atExpression(earliest, current);
        const sinceIso = current.toISOString();
        await mapConcurrent(sessionIds, REARM_CONCURRENCY, async (sessionId) => {
          const existingSchedule = await client
            .send(new GetScheduleCommand({ GroupName: group, Name: alarmNameOf(sessionId) }))
            .catch((error: unknown) => {
              if (isErrorNamed(error, "ResourceNotFoundException")) return undefined;
              throw schedulerError(`reading the alarm for "${sessionId}" failed`, error);
            });
          const activeAt =
            existingSchedule?.State === "ENABLED" ? parseAtExpression(existingSchedule.ScheduleExpression) : undefined;
          // Only an ENABLED alarm still in the future can wake the session; a completed past `NONE` schedule will never
          // fire again and must be replaced.
          if (activeAt !== undefined && activeAt.getTime() > current.getTime() && activeAt.getTime() <= targetMs) {
            return;
          }
          await upsertSession(target, sessionId, expression, sinceIso);
        });
      }

      if (deploySchedule.State !== "DISABLED" && deploySchedule.ScheduleExpression && deploySchedule.Target) {
        await client
          .send(
            new UpdateScheduleCommand({
              GroupName: group,
              Name: DEPLOY_SCHEDULE_NAME,
              ScheduleExpression: deploySchedule.ScheduleExpression,
              ...(deploySchedule.ScheduleExpressionTimezone === undefined
                ? {}
                : { ScheduleExpressionTimezone: deploySchedule.ScheduleExpressionTimezone }),
              FlexibleTimeWindow: deploySchedule.FlexibleTimeWindow ?? { Mode: "OFF" },
              ...(deploySchedule.ActionAfterCompletion === undefined
                ? {}
                : { ActionAfterCompletion: deploySchedule.ActionAfterCompletion }),
              ...(deploySchedule.Description === undefined ? {} : { Description: deploySchedule.Description }),
              State: "DISABLED",
              Target: deploySchedule.Target,
            }),
          )
          .catch((error: unknown) => {
            throw schedulerError(`disabling ${group}/${DEPLOY_SCHEDULE_NAME} after re-arming failed`, error);
          });
      }
    },
  };
}
