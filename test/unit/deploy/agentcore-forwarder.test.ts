/**
 * EXECUTES the generated forwarder Lambda (not substring assertions): the source is evaluated with a
 * fake `require` handing back fake AWS clients, then driven through real event shapes. This is the
 * deployment's single riskiest generated component — behavior (upsert/conflict/failure propagation,
 * query round-trip, secret gate) must be under test, not trusted.
 */
import { Buffer } from "node:buffer";
import * as nodeCrypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MAX_WEBHOOK_BODY_BYTES } from "../../../src/deploy/agentcore/limits.ts";
import { forwarderSource } from "../../../src/deploy/agentcore/plan.ts";

type Envelope = Record<string, unknown> & { kind?: string; wake?: { url: string } };

interface HarnessOptions {
  env?: Record<string, string | undefined>;
  /** What the container's /invocations returns for a given envelope (transport status + JSON body). */
  containerReply?: (envelope: Envelope) => { statusCode?: number; body: unknown };
  /** Scheduler behavior per mutating call — throw to simulate an API error. */
  onSchedule?: (type: ScheduleCall["type"], input: Record<string, unknown>) => void;
  /** Schedules EventBridge already holds, by name (what ListSchedules and GetSchedule answer from). */
  held?: Record<string, Record<string, unknown>>;
}

/** A call that changes what EventBridge holds; reads (list, get) are answered, not recorded. */
interface ScheduleCall {
  type: "create" | "update" | "delete";
  input: Record<string, unknown>;
}

function awsError(name: string): Error {
  return Object.assign(new Error(name), { name });
}

function loadForwarder(options: HarnessOptions = {}) {
  const env = {
    RUNTIME_ARN: "arn:aws:bedrock-agentcore:us-east-1:1:runtime/x",
    INGRESS_SESSION_ID: "fastagent-ingress-x-0000000000000000",
    INGRESS_SECRET: "ingress-s3cret",
    WEBHOOKS_ENABLED: "1",
    MAX_WEBHOOK_BODY_BYTES: String(MAX_WEBHOOK_BODY_BYTES),
    ...options.env,
  };
  const envelopes: Envelope[] = [];
  const scheduleCalls: ScheduleCall[] = [];
  const held = new Map(Object.entries(options.held ?? {}));
  let urlLookups = 0;

  const reply: (envelope: Envelope) => { statusCode?: number; body: unknown } =
    options.containerReply ??
    ((envelope: Envelope) =>
      envelope.kind === "webhook"
        ? {
            body: {
              status: 200,
              headers: { "content-type": "text/plain" },
              bodyB64: Buffer.from("ok\n").toString("base64"),
            },
          }
        : { body: { ok: true } });

  class InvokeAgentRuntimeCommand {
    constructor(public input: { payload: Uint8Array }) {}
  }
  class CreateScheduleCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class UpdateScheduleCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class DeleteScheduleCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class GetScheduleCommand {
    constructor(public input: { Name: string }) {}
  }
  class ListSchedulesCommand {
    constructor(public input: { NamePrefix: string; NextToken?: string }) {}
  }
  class GetFunctionUrlConfigCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  const modules: Record<string, unknown> = {
    "@aws-sdk/client-bedrock-agentcore": {
      InvokeAgentRuntimeCommand,
      BedrockAgentCoreClient: class {
        async send(cmd: InvokeAgentRuntimeCommand) {
          const envelope = JSON.parse(Buffer.from(cmd.input.payload).toString()) as Envelope;
          envelopes.push(envelope);
          const r = reply(envelope);
          return {
            statusCode: r.statusCode ?? 200,
            response: { transformToByteArray: async () => Buffer.from(JSON.stringify(r.body)) },
          };
        }
      },
    },
    "@aws-sdk/client-lambda": {
      GetFunctionUrlConfigCommand,
      LambdaClient: class {
        async send(_cmd: GetFunctionUrlConfigCommand) {
          urlLookups += 1;
          return { FunctionUrl: "https://self.lambda-url.on.aws/" };
        }
      },
    },
    "@aws-sdk/client-scheduler": {
      CreateScheduleCommand,
      UpdateScheduleCommand,
      DeleteScheduleCommand,
      GetScheduleCommand,
      ListSchedulesCommand,
      SchedulerClient: class {
        async send(
          cmd:
            | CreateScheduleCommand
            | UpdateScheduleCommand
            | DeleteScheduleCommand
            | GetScheduleCommand
            | ListSchedulesCommand,
        ) {
          if (cmd instanceof ListSchedulesCommand) {
            // Two pages, so the forwarder has to follow NextToken to see the whole set.
            const names = [...held.keys()].filter((name) => name.startsWith(cmd.input.NamePrefix));
            const page = cmd.input.NextToken ? names.slice(1) : names.slice(0, 1);
            return {
              Schedules: page.map((Name) => ({ Name })),
              ...(!cmd.input.NextToken && names.length > 1 ? { NextToken: "2" } : {}),
            };
          }
          if (cmd instanceof GetScheduleCommand) {
            const found = held.get(cmd.input.Name);
            if (!found) throw awsError("ResourceNotFoundException");
            return found;
          }
          const type =
            cmd instanceof CreateScheduleCommand
              ? "create"
              : cmd instanceof UpdateScheduleCommand
                ? "update"
                : "delete";
          scheduleCalls.push({ type, input: cmd.input });
          options.onSchedule?.(type, cmd.input);
          const name = cmd.input.Name as string;
          if (type === "delete") held.delete(name);
          else held.set(name, cmd.input);
          return {};
        }
      },
    },
  };
  const fakeRequire = (name: string): unknown => {
    // node:crypto is the REAL module: the forwarder's SigV4 presigning must be exercised, not faked.
    if (name === "node:crypto") return nodeCrypto;
    const mod = modules[name];
    if (!mod) throw new Error(`unexpected require("${name}")`);
    return mod;
  };
  const exportsObject: { handler?: (event: unknown, ctx?: unknown) => Promise<Record<string, unknown>> } = {};
  const quietConsole = { log: vi.fn() };
  new Function("require", "exports", "process", "console", "Buffer", "TextEncoder", forwarderSource())(
    fakeRequire,
    exportsObject,
    { env },
    quietConsole,
    Buffer,
    TextEncoder,
  );
  const handler = exportsObject.handler;
  if (!handler) throw new Error("forwarder source exported no handler");
  const ctx = { invokedFunctionArn: "arn:aws:lambda:us-east-1:1:function:fwd" };
  return {
    handler: (event: unknown) => handler(event, ctx),
    envelopes,
    scheduleCalls,
    logs: quietConsole.log,
    urlLookups: () => urlLookups,
  };
}

const webhookEvent = (over: Record<string, unknown> = {}) => ({
  requestContext: { http: { method: "POST" } },
  rawPath: "/telegram",
  rawQueryString: "",
  headers: { "x-telegram-bot-api-secret-token": "s" },
  body: JSON.stringify({ update_id: 1 }),
  isBase64Encoded: false,
  ...over,
});

describe("agentcore forwarder (executed)", () => {
  it("forwards a webhook verbatim — method/path/QUERY/headers/body — and re-emits the reply", async () => {
    const f = loadForwarder();
    const res = await f.handler(webhookEvent({ rawQueryString: "code=abc&x=1" }));
    expect(f.envelopes[0]).toMatchObject({
      kind: "webhook",
      method: "POST",
      path: "/telegram",
      query: "code=abc&x=1",
      headers: { "x-telegram-bot-api-secret-token": "s" },
      bodyB64: Buffer.from(JSON.stringify({ update_id: 1 })).toString("base64"),
    });
    expect(res).toMatchObject({ statusCode: 200, isBase64Encoded: true });
    expect(Buffer.from(res.body as string, "base64").toString()).toBe("ok\n");
  });

  describe("wake alarms", () => {
    const env = {
      WAKE_SECRET: "s3cret",
      WAKE_ROLE_ARN: "arn:role",
      WAKE_PREFIX: "fa-x-wk-",
      SCHEDULE_PREFIX: "fa-x-sc-",
    };
    const alarmEvent = (secret: string, alarms: unknown[], schedules: unknown[] = []) =>
      webhookEvent({ rawPath: "/__fastagent/wake-alarm", body: JSON.stringify({ secret, alarms, schedules }) });
    const alarm = { id: "abcd1234-rest-of-uuid", at: "2026-07-28T10:30:00.000Z" };

    it("gates on the shared secret — wrong or unconfigured is 403, never forwarded", async () => {
      const f = loadForwarder({ env });
      expect((await f.handler(alarmEvent("wrong", [alarm]))).statusCode).toBe(403);
      const unconfigured = loadForwarder(); // no WAKE_SECRET in env
      expect((await unconfigured.handler(alarmEvent("s3cret", [alarm]))).statusCode).toBe(403);
      expect(f.envelopes).toHaveLength(0); // handled locally, never sent to the container
    });
  });
});
