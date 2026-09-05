import { Buffer } from "node:buffer";
import { crc32 } from "node:zlib";
import { Cron } from "croner";
import { declaredChannels } from "../src/channels/discover.ts";
import { cronError } from "../src/schedule/cron.ts";
import { describe, expect, it } from "vitest";
import {
  type AgentcorePlanInput,
  MOUNT,
  SECRETS_DIR,
  type ScheduleFact,
  TEMPLATE_FILE,
  GENERATED_TEMPLATE_MARKER,
  FORWARDER_FILE,
  IDLE_TIMEOUT_SECONDS,
  MAX_LIFETIME_SECONDS,
  STATE_KEY,
  agentcoreName,
  cfnParamName,
  forwarderSource,
  isGeneratedAgentcoreTemplate,
  ingressSessionId,
  planAgentcoreDeploy,
  scheduleResourceName,
  stateBucketName,
  toEventBridgeCron,
  toRuntimeName,
} from "../src/deploy/agentcore/plan.ts";
import { zipSingleFile } from "../src/deploy/agentcore/zip.ts";

const baseInput = (over: Partial<AgentcorePlanInput> = {}): AgentcorePlanInput => ({
  name: "my-agent",
  modelAuth: "OPENAI_API_KEY",
  channels: [],
  schedules: [],
  selfSchedule: false,
  hasPackageJson: false,
  runtime: "node",
  hasLockfile: false,
  version: "0.15.0",
  agentPrefix: "",
  ...over,
});

describe("deploy agentcore: name/id helpers", () => {
  it("agentcoreName is the stable workspace-basename → stack-name mapping", () => {
    expect(agentcoreName("My Agent!!")).toBe("my-agent");
    expect(agentcoreName("---")).toBe("agent");
  });

  it("toRuntimeName produces [a-zA-Z][a-zA-Z0-9_]{0,47}", () => {
    expect(toRuntimeName("my-agent")).toBe("my_agent");
    expect(toRuntimeName("123 weird!!name")).toBe("agent_123_weird_name");
    expect(toRuntimeName("x".repeat(60))).toHaveLength(48);
    for (const name of ["my-agent", "123", "---"]) {
      expect(toRuntimeName(name)).toMatch(/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/);
    }
  });

  it("ingressSessionId clears the API's 33-char floor for any name", () => {
    expect(ingressSessionId("a").length).toBeGreaterThanOrEqual(33);
    expect(ingressSessionId("my-agent")).toContain("fastagent-ingress-my-agent");
    expect(ingressSessionId("x".repeat(200)).length).toBeLessThanOrEqual(128);
  });

  it("cfnParamName maps env names to alphanumeric parameter ids", () => {
    expect(cfnParamName("TELEGRAM_BOT_TOKEN")).toBe("TelegramBotToken");
    expect(cfnParamName("OPENAI_API_KEY")).toBe("OpenaiApiKey");
    expect(cfnParamName("FASTAGENT_AUTH_SEED")).toBe("FastagentAuthSeed");
  });
});

describe("deploy agentcore: cron translation", () => {
  const expression = (cron: string): string => {
    const r = toEventBridgeCron(cron);
    if ("error" in r) throw new Error(r.error);
    return r.expression;
  };
  const error = (cron: string): string => {
    const r = toEventBridgeCron(cron);
    if ("expression" in r) throw new Error(`unexpectedly translated: ${r.expression}`);
    return r.error;
  };

  it("hourly: both wildcards → dow becomes ?", () => {
    expect(expression("0 * * * *")).toBe("cron(0 * * * ? *)");
  });

  it("day-of-week numbering is remapped (standard 0/7=Sun → EventBridge 1=Sun)", () => {
    expect(expression("0 9 * * 1")).toBe("cron(0 9 ? * 2 *)"); // Monday
    expect(expression("0 9 * * 0")).toBe("cron(0 9 ? * 1 *)"); // Sunday as 0
    expect(expression("0 9 * * 7")).toBe("cron(0 9 ? * 1 *)"); // Sunday as 7
    expect(expression("0 9 * * 1-5")).toBe("cron(0 9 ? * 2-6 *)"); // weekday range
  });

  it("day-of-month restriction keeps dom, dow becomes ?", () => {
    expect(expression("30 6 1 * *")).toBe("cron(30 6 1 * ? *)");
  });

  it("names pass through unmapped", () => {
    expect(expression("0 9 * * MON")).toBe("cron(0 9 ? * MON *)");
  });

  it("steps are COUNTS, not weekdays — preserved verbatim while values/endpoints remap", () => {
    expect(expression("0 9 * * */2")).toBe("cron(0 9 ? * */2 *)");
    expect(expression("0 9 * * 1-5/2")).toBe("cron(0 9 ? * 2-6/2 *)");
  });

  it("lists remap per element; a range that wraps under renumbering is refused", () => {
    expect(expression("0 9 * * 1,3,5")).toBe("cron(0 9 ? * 2,4,6 *)");
    expect(expression("0 9 * * MON,3")).toBe("cron(0 9 ? * MON,4 *)");
    expect(error("0 9 * * 5-7")).toMatch(/wraps across the week/); // Fri–Sun → 6-1: not a valid range
    expect(error("0 9 * * 1-")).toMatch(/malformed/);
    expect(error("0 9 * * 1/")).toMatch(/malformed/);
  });

  it("refuses what EventBridge cannot express, with the reason", () => {
    expect(error("0 9 1 * 1")).toMatch(/BOTH day-of-month and day-of-week/);
    expect(error("0 0 9 * * 1")).toMatch(/5-field/);
    expect(error("0 9 * * 5L")).toMatch(/L\/#/);
  });
});

describe("deploy agentcore: the plan", () => {
  it("pure-invoke shape: template only (no forwarder, no schedules), lean runbook", () => {
    const plan = planAgentcoreDeploy(baseInput());
    expect(plan.artifacts.map((a) => a.path)).toEqual([
      TEMPLATE_FILE,
      "Dockerfile",
      ".dockerignore",
      "Dockerfile.dockerignore",
    ]);
    const template = plan.artifacts[0]!.content;
    expect(template).toContain("Type: AWS::BedrockAgentCore::Runtime");
    expect(template).toContain("AgentRuntimeName: my_agent");
    expect(template).toContain(`SessionStorage: { MountPath: ${MOUNT} }`);
    expect(template).toContain('FASTAGENT_AGENTCORE: "1"');
    expect(template).toContain('PORT: "8080"');
    expect(template).toContain(`FASTAGENT_STATE_DIR: ${MOUNT}`);
    expect(template).toContain(`FASTAGENT_SECRETS_DIR: ${SECRETS_DIR}`);
    expect(template).not.toContain("AWS::Lambda::Function");
    expect(template).not.toContain("AWS::Scheduler::Schedule");
    expect(plan.untranslatableSchedules).toEqual([]);
    expect(plan.runbook.join("\n")).not.toContain("stop-runtime-session"); // no forwarder → no ingress session
    expect(plan.runbook.join("\n")).toContain("fastagent logs agentcore --follow");
    expect(plan.runbook.join("\n")).not.toContain("--source forwarder");
  });

  it("puts the secrets dir INSIDE the state root — the snapshot is this host's only durable store", () => {
    // The regression this exists for looks like a tidy-up: every volume-backed host spells the two
    // machinery dirs as siblings (`/data/.state` + `/data/.secrets`), and copying that here reads as
    // consistency. It is not — AgentCore has no volume. Durability is packStateRoot(stateRoot), which
    // copies ONE tree, so a sibling secrets dir sits inside the wiped mount and outside the snapshot:
    // the rotated OAuth credential is discarded with the microVM and the box eventually cannot
    // authenticate. Assert the CONTAINMENT, not the two spellings — only containment fails on that.
    expect(SECRETS_DIR.startsWith(`${MOUNT}/`)).toBe(true);

    const template = planAgentcoreDeploy(baseInput()).artifacts[0]!.content;
    const stateDir = /FASTAGENT_STATE_DIR: (\S+)/.exec(template)?.[1];
    const secretsDir = /FASTAGENT_SECRETS_DIR: (\S+)/.exec(template)?.[1];
    expect(stateDir).toBe(MOUNT);
    expect(secretsDir?.startsWith(`${stateDir}/`)).toBe(true);
  });

  it("a route channel brings the forwarder (Lambda + URL + permission) and the webhook step", () => {
    const plan = planAgentcoreDeploy(baseInput({ channels: declaredChannels(["telegram"]) }));
    expect(plan.artifacts.map((a) => a.path)).toContain(FORWARDER_FILE);
    const template = plan.artifacts[0]!.content;
    expect(template).toContain("Type: AWS::Lambda::Function");
    expect(template).toContain("Type: AWS::Lambda::Url");
    expect(template).toContain("AuthType: NONE");
    // BOTH url permissions — post-Oct-2025 Function URLs 403 with only InvokeFunctionUrl.
    expect(template).toContain("Action: lambda:InvokeFunctionUrl");
    expect(template).toContain("Action: lambda:InvokeFunction\n");
    // Background turns refresh short-lived S3 capabilities through this same authenticated URL.
    expect(template).toContain("STATE_REFRESH_SECRET: !Ref FastagentIngressSecret");
    expect(template).toContain("Action: lambda:GetFunctionUrlConfig");
    // CommonJS on purpose — CFN inline code lands as index.js where ESM import is a syntax error.
    expect(forwarderSource()).toContain('require("@aws-sdk/client-bedrock-agentcore")');
    expect(forwarderSource()).toContain("exports.handler");
    expect(forwarderSource()).not.toMatch(/^import /m);
    expect(template).toContain(`INGRESS_SESSION_ID: ${ingressSessionId("my-agent")}`);
    // Secrets ride NoEcho parameters, mapped into the runtime environment.
    expect(template).toContain("TelegramBotToken:");
    expect(template).toContain("TELEGRAM_BOT_TOKEN: !Ref TelegramBotToken");
    expect(plan.runbook.join("\n")).toContain("setWebhook");
    // The redeploy-immediacy step is in the manual runbook too (— --run automates it).
    expect(plan.runbook.join("\n")).toContain("stop-runtime-session");
    expect(plan.runbook.join("\n")).toContain("fastagent logs agentcore --source forwarder --follow");
    // The shipped artifact IS the forwarder source (it becomes the Lambda package verbatim).
    const forwarder = plan.artifacts.find((a) => a.path === FORWARDER_FILE)!;
    expect(forwarder.content).toBe(forwarderSource());
    expect(forwarder.content).toContain("InvokeAgentRuntimeCommand");
  });

  it("schedules become EventBridge rules with tz + slot-carrying input; untranslatable ones warn", () => {
    const schedules: ScheduleFact[] = [
      { name: "digest", cron: "0 9 * * 1-5", tz: "Asia/Shanghai" },
      { name: "impossible", cron: "0 9 1 * 1" },
    ];
    const plan = planAgentcoreDeploy(baseInput({ schedules }));
    const template = plan.artifacts[0]!.content;
    expect(template).toContain("ScheduleDigest:");
    expect(template).toContain("ScheduleExpression: cron(0 9 ? * 2-6 *)");
    expect(template).toContain("ScheduleExpressionTimezone: Asia/Shanghai");
    expect(template).toContain('\'{"scheduleFire":{"name":"digest","slot":"<aws.scheduler.scheduled-time>"}}\'');
    expect(template).not.toContain("impossible");
    expect(plan.untranslatableSchedules).toEqual([
      { name: "impossible", reason: expect.stringMatching(/BOTH day-of-month/) },
    ]);
    expect(plan.runbook.join("\n")).toContain('schedule "impossible" has NO EventBridge rule');
    // Schedules alone (no route channels) still need the forwarder — it is the fire path.
    expect(template).toContain("Type: AWS::Lambda::Function");
    expect(plan.topology).toEqual({ webhooks: false, forwarder: true, wakeAlarms: false });
  });

  it("the topology counts the schedules EventBridge CAN express — an untranslatable one alone buys no forwarder", () => {
    // The CLI used to count every loaded schedule while the template counted the translated ones, so
    // this definition deployed a bucket and forwarder parameters into a stack that declared neither.
    const plan = planAgentcoreDeploy(baseInput({ schedules: [{ name: "impossible", cron: "0 9 1 * 1" }] }));
    expect(plan.topology).toEqual({ webhooks: false, forwarder: false, wakeAlarms: false });
    expect(plan.artifacts.map((a) => a.path)).not.toContain(FORWARDER_FILE);
    expect(plan.artifacts[0]!.content).not.toContain("Type: AWS::Lambda::Function");
  });

  it("identifier collisions fail the plan visibly (a silently wrong stack is worse)", () => {
    expect(() =>
      planAgentcoreDeploy(
        baseInput({
          schedules: [
            { name: "foo-bar", cron: "0 * * * *" },
            { name: "foobar", cron: "30 * * * *" },
          ],
        }),
      ),
    ).toThrow(/same CloudFormation logical id/);
    expect(() => planAgentcoreDeploy(baseInput({ extraSecrets: ["FOO_BAR", "FOO__BAR"] }))).toThrow(
      /same CloudFormation parameter/,
    );
  });

  it("a schedule name with a quote cannot break the EventBridge Input YAML/JSON", () => {
    const plan = planAgentcoreDeploy(baseInput({ schedules: [{ name: "it's-daily", cron: "0 9 * * *" }] }));
    const template = plan.artifacts[0]!.content;
    expect(template).toContain(`'{"scheduleFire":{"name":"it''s-daily","slot":"<aws.scheduler.scheduled-time>"}}'`);
  });

  it("the forwarder Lambda timeout covers a whole schedule turn (EventBridge invokes async)", () => {
    const template = planAgentcoreDeploy(baseInput({ channels: declaredChannels(["telegram"]) })).artifacts[0]!.content;
    expect(template).toContain("Timeout: 900");
  });

  it("kit layout namespaces the template + forwarder under the kit", () => {
    const plan = planAgentcoreDeploy(baseInput({ agentPrefix: "agent/", channels: declaredChannels(["telegram"]) }));
    const paths = plan.artifacts.map((a) => a.path);
    expect(paths).toContain(`agent/${TEMPLATE_FILE}`);
    expect(paths).toContain(`agent/${FORWARDER_FILE}`);
    expect(plan.runbook.join("\n")).toContain("-f agent/Dockerfile");
  });

  it("selfSchedule brings the full wake-alarm topology: forwarder, secret param, roles, env", () => {
    const plan = planAgentcoreDeploy(baseInput({ selfSchedule: true }));
    const template = plan.artifacts[0]!.content;
    // selfSchedule alone needs the forwarder — it is the alarm registrar and the poke target.
    expect(template).toContain("Type: AWS::Lambda::Function");
    expect(template).toContain("WakeSchedulerRole:");
    expect(template).toContain("FastagentWakeSecret:");
    expect(template).toContain("FASTAGENT_WAKE_SECRET: !Ref FastagentWakeSecret");
    expect(template).toContain("WAKE_SECRET: !Ref FastagentWakeSecret");
    expect(template).toContain("WAKE_PREFIX: fa-my-agent-wk-");
    expect(template).toContain("scheduler:CreateSchedule");
    expect(template).toContain("lambda:GetFunctionUrlConfig");
    const runbook = plan.runbook.join("\n");
    expect(runbook).toContain("EventBridge-backed");
    expect(runbook).toContain("FastagentWakeSecret=<any random string>");
    expect(runbook).not.toContain("DEGRADED");
    // The forwarder carries the alarm + poke machinery.
    expect(forwarderSource()).toContain("wake-alarm");
    expect(forwarderSource()).toContain("wakePoke");
  });

  it("the template opens with the generated marker (the drift gate's predicate)", () => {
    const template = planAgentcoreDeploy(baseInput()).artifacts[0]!.content;
    expect(template.startsWith(GENERATED_TEMPLATE_MARKER)).toBe(true);
    expect(isGeneratedAgentcoreTemplate(template)).toBe(true);
    expect(isGeneratedAgentcoreTemplate("# my hand-written template\n")).toBe(false);
  });

  describe("cron translation vs the Croner dialect the workspace actually accepts", () => {
    /**
     * The property that matters is not "the string looks right" but "the DEPLOYED rule fires on the
     * same days the workspace's own scheduler fires on". So: expand both sides and compare.
     * EventBridge's cron is Quartz-flavoured 6-field — day-of-week names, exactly one of DOM/DOW as
     * `?` — which for the day-selection question this checks maps onto croner once the trailing year
     * field is dropped and the `?` field is read as `*` (EventBridge has no OR semantics: the `?`
     * field is genuinely unrestricted).
     */
    const firingDays = (cron: string, count: number): string[] => {
      const c = new Cron(cron, { timezone: "UTC" });
      const out: string[] = [];
      let prev: Date | null = null;
      for (let i = 0; i < count; i++) {
        prev = c.nextRun(prev ?? new Date("2026-07-29T00:00:00Z"));
        if (!prev) break;
        out.push(prev.toISOString().slice(0, 16));
      }
      return out;
    };
    const eventBridgeDays = (expression: string, count: number): string[] => {
      const [min, hour, dom, mon, dowRaw] = expression.slice(5, -1).split(" ") as [
        string,
        string,
        string,
        string,
        string,
      ];
      // `?` = unrestricted; croner reads `*` for that, without the OR quirk (only one can be `?`).
      const dow = dowRaw === "?" ? "*" : dowRaw;
      return firingDays(`${min} ${hour} ${dom === "?" ? "*" : dom} ${mon} ${dow}`, count);
    };

    it.each([
      "0 9 * * MON", // the plain weekly form
      "0 9 1 * *", // day-of-month
      "*/5 * * * *", // the every-N form a deploy test actually uses
      "0 9 ? * MON", // `?` is NOT `*` in croner: this fires DAILY, whatever MON suggests
      "0 9 1 * ?", // …and here too, whatever the 1st suggests
      "0 9 * * ?",
      "0 9 ? * *",
    ])("%s fires on the same days locally and on EventBridge", (cron) => {
      expect(cronError(cron, undefined)).toBeUndefined();
      const out = toEventBridgeCron(cron);
      expect("expression" in out).toBe(true);
      const expression = (out as { expression: string }).expression;
      // 10 occurrences is enough to separate daily / weekly / monthly patterns.
      expect(eventBridgeDays(expression, 10)).toEqual(firingDays(cron, 10));
    });

    it("refuses what EventBridge genuinely cannot express, rather than deploying a different schedule", () => {
      // Cron ORs two RESTRICTED day fields (the 15th OR any Wednesday); EventBridge has no such form.
      expect(cronError("0 9 15 * WED", undefined)).toBeUndefined();
      expect(toEventBridgeCron("0 9 15 * WED")).toMatchObject({ error: expect.stringContaining("BOTH") });
    });

    it.each([
      ["0 9 * * MON", "cron(0 9 ? * MON *)"],
      ["0 9 1 * *", "cron(0 9 1 * ? *)"],
      // A `?` means daily in croner, so the deployed rule must say daily — NOT carry MON/1 across.
      ["0 9 ? * MON", "cron(0 9 * * ? *)"],
      ["0 9 1 * ?", "cron(0 9 * * ? *)"],
      ["0 9 * * ?", "cron(0 9 * * ? *)"],
      ["0 9 ? * *", "cron(0 9 * * ? *)"],
    ])("%s → %s", (cron, expression) => {
      expect(toEventBridgeCron(cron)).toEqual({ expression });
    });

    it("emits exactly one `?` — EventBridge rejects both fields wildcarded or both restricted", () => {
      for (const cron of ["0 9 * * MON", "0 9 1 * *", "0 9 ? * MON", "0 9 * * ?", "*/5 * * * *"]) {
        const out = toEventBridgeCron(cron);
        expect("expression" in out).toBe(true);
        const fields = (out as { expression: string }).expression.slice(5, -1).split(" ");
        expect([fields[2], fields[4]].filter((f) => f === "?")).toHaveLength(1);
      }
    });
  });

  it("says in the artifact itself that it is a mirror, not an input", () => {
    // `--run` zips fastagent's own copy of this source, so a kept/edited file would be a stale mirror
    // of what runs — and the manual runbook, which zips this very file, would ship the OLD code.
    expect(forwarderSource()).toContain("REGENERATED ON EVERY DEPLOY");
  });

  it("ships the forwarder as a REAL Lambda entry (index.js) loaded from S3 by content-hashed key", () => {
    const plan = planAgentcoreDeploy(baseInput({ channels: declaredChannels(["telegram"]) }));
    // The artifact IS the deployment package's entry: zipping it as-is matches `Handler: index.handler`.
    expect(FORWARDER_FILE).toBe("lambda/index.js");
    expect(plan.artifacts.map((a) => a.path)).toContain("lambda/index.js");
    const template = plan.artifacts[0]!.content;
    expect(template).not.toContain("ZipFile"); // presigning pushed it past CFN's 4096-byte inline cap
    expect(template).toContain("S3Bucket: !Ref StateBucket");
    expect(template).toContain("S3Key: !Ref ForwarderS3Key");
    expect(template).toContain("  StateBucket:");
    expect(template).toContain("  ForwarderS3Key:");
  });

  it("grants the forwarder ONLY the one snapshot object, and hands the container its bucket/key", () => {
    const template = planAgentcoreDeploy(baseInput({ channels: declaredChannels(["telegram"]) })).artifacts[0]!.content;
    expect(template).toContain("Action: [s3:GetObject, s3:PutObject]");
    expect(template).toContain(`Resource: !Sub arn:aws:s3:::\${StateBucket}/${STATE_KEY}`);
    expect(template).toContain("STATE_BUCKET: !Ref StateBucket");
    expect(template).toContain(`STATE_KEY: ${STATE_KEY}`);
  });

  it("grants s3:ListBucket on the snapshot prefix — without it a MISSING first-deploy snapshot reads 403, not 404", () => {
    // S3 folds "key absent" into 403 unless the caller may list (anti-enumeration), and the restore
    // contract accepts ONLY 404 as first deploy — dropping this statement deadlocks every first boot.
    const template = planAgentcoreDeploy(baseInput({ channels: declaredChannels(["telegram"]) })).artifacts[0]!.content;
    expect(template).toContain("Action: s3:ListBucket");
    expect(template).toContain(`Resource: !Sub arn:aws:s3:::\${StateBucket}\n`); // the BUCKET arn, not an object
    expect(template).toContain("StringLike: { s3:prefix: state/* }"); // scoped: existence of the snapshot, not a full listing
  });

  it("an invoke-only deployment (no forwarder) carries no bucket wiring at all", () => {
    const template = planAgentcoreDeploy(baseInput()).artifacts[0]!.content;
    expect(template).not.toContain("StateBucket");
    expect(template).not.toContain("s3:GetObject");
    expect(template).not.toContain("s3:ListBucket");
  });

  it("holds an idle session for 3 minutes — within the platform's 60–28800 range, and only after work settles", () => {
    // The idle tail is what memory bills for after the agent stops working (CPU stops immediately),
    // so it is the deployment's main standing cost. HealthyBusy keeps a BUSY session alive whatever
    // this says, so shortening it cannot cut a turn short — it only shortens the wait before sleep.
    expect(IDLE_TIMEOUT_SECONDS).toBe(180);
    expect(IDLE_TIMEOUT_SECONDS).toBeGreaterThanOrEqual(60);
    expect(MAX_LIFETIME_SECONDS).toBeLessThanOrEqual(28800);
    expect(planAgentcoreDeploy(baseInput()).artifacts[0]!.content).toContain(
      `LifecycleConfiguration: { IdleRuntimeSessionTimeout: 180, MaxLifetime: 28800 }`,
    );
  });

  it("tells the truth about state: the mount is wiped per deploy, the S3 snapshot is what survives", () => {
    const plan = planAgentcoreDeploy(baseInput({ channels: declaredChannels(["telegram"]) }));
    const template = plan.artifacts[0]!.content;
    expect(template).toContain("wipes it on every VERSION UPDATE");
    expect(template).not.toMatch(/SessionStorage: platform-persistent/);
    const runbook = plan.runbook.join("\n");
    expect(runbook).toContain(stateBucketName("my-agent", "<account-id>"));
    expect(runbook).toContain(STATE_KEY);
    expect(runbook).toContain("every runtime version update");
  });

  describe("the forwarder deployment package", () => {
    /** Parse the single stored entry back out — proves the archive is real, not just plausible. */
    const readSingleEntry = (zip: Buffer) => {
      expect(zip.readUInt32LE(0)).toBe(0x04034b50); // local file header
      expect(zip.readUInt16LE(8)).toBe(0); // method 0 = stored
      const nameLength = zip.readUInt16LE(26);
      const size = zip.readUInt32LE(22);
      const name = zip.subarray(30, 30 + nameLength).toString();
      const content = zip.subarray(30 + nameLength, 30 + nameLength + size);
      expect(zip.readUInt32LE(14)).toBe(crc32(content)); // the CRC an unzipper will verify
      expect(zip.readUInt32LE(zip.byteLength - 22)).toBe(0x06054b50); // end of central directory
      expect(zip.readUInt16LE(zip.byteLength - 12)).toBe(1); // exactly one entry
      return { name, content: content.toString() };
    };

    it("packages the forwarder as a valid, self-consistent archive", () => {
      const entry = readSingleEntry(zipSingleFile("index.js", Buffer.from(forwarderSource())));
      expect(entry.name).toBe("index.js");
      expect(entry.content).toBe(forwarderSource());
    });

    it("is byte-deterministic — the S3 key is content-hashed, so identical source must not look new", () => {
      const once = zipSingleFile("index.js", Buffer.from("exports.handler = 1;"));
      const twice = zipSingleFile("index.js", Buffer.from("exports.handler = 1;"));
      expect(once.equals(twice)).toBe(true);
      expect(once.equals(zipSingleFile("index.js", Buffer.from("exports.handler = 2;")))).toBe(false);
    });
  });

  describe("the public attack surface", () => {
    it("a schedule-only deployment exposes ONLY the authenticated state-URL refresh channel", () => {
      // Long cron turns can outlive the credentials that signed their initial snapshot URL. The URL
      // exists to re-mint it, while WEBHOOKS_ENABLED remains absent so arbitrary HTTP never wakes
      // AgentCore; start also suppresses the builtin /invoke under AgentCore.
      const template = planAgentcoreDeploy(baseInput({ schedules: [{ name: "digest", cron: "0 9 * * *" }] }))
        .artifacts[0]!.content;
      expect(template).toContain("AWS::Lambda::Function");
      expect(template).toContain("AWS::Scheduler::Schedule");
      expect(template).toContain("AWS::Lambda::Url");
      expect(template).toContain("STATE_REFRESH_SECRET: !Ref FastagentIngressSecret");
      expect(template).not.toContain('WEBHOOKS_ENABLED: "1"');
    });

    it("a webhook channel mints one, and scopes the second permission to URL traffic", () => {
      const template = planAgentcoreDeploy(baseInput({ channels: declaredChannels(["telegram"]) })).artifacts[0]!
        .content;
      expect(template).toContain("AWS::Lambda::Url");
      expect(template).toContain('WEBHOOKS_ENABLED: "1"');
      expect(template).toContain("Action: lambda:InvokeFunctionUrl");
      // Without this the bare * principal would also permit direct Lambda API calls from any AWS
      // account — bypassing the Function URL event shape to forge internal events.
      expect(template).toContain("InvokedViaFunctionUrl: true");
    });

    it("declares the ingress secret whenever a forwarder exists, and stamps it on both sides", () => {
      const template = planAgentcoreDeploy(baseInput({ channels: declaredChannels(["telegram"]) })).artifacts[0]!
        .content;
      expect(template).toContain("  FastagentIngressSecret:");
      expect(template).toContain("FASTAGENT_INGRESS_SECRET: !Ref FastagentIngressSecret"); // runtime
      expect(template).toContain("INGRESS_SECRET: !Ref FastagentIngressSecret"); // forwarder
      // An invoke-only deployment has no forwarder, so nothing to authenticate.
      expect(planAgentcoreDeploy(baseInput()).artifacts[0]!.content).not.toContain("FastagentIngressSecret");
    });
  });

  describe("EventBridge physical names", () => {
    it("sanitizes, bounds and disambiguates a schedule's module name", () => {
      const names = (n: string) => scheduleResourceName("agentcore-test", n);
      expect(names("digest")).toMatch(/^fa-agentcore-test-digest-[0-9a-f]{8}$/);
      // AWS requires [0-9A-Za-z-_.] within 64 chars; a module file name guarantees neither.
      for (const raw of ["晨报", "deploy check", "a".repeat(120), "x/y"]) {
        const out = names(raw);
        expect(out).toMatch(/^[0-9A-Za-z\-_.]+$/);
        expect(out.length).toBeLessThanOrEqual(64);
      }
      // Names that sanitize or truncate to the same readable part stay distinct — otherwise one rule
      // would silently serve two schedules.
      expect(names("deploy check")).not.toBe(names("deploy-check"));
      expect(names(`${"a".repeat(120)}1`)).not.toBe(names(`${"a".repeat(120)}2`));
    });
  });

  it("OAuth model auth (non-env) gets the FastagentAuthSeed guidance instead of a fake secret", () => {
    const plan = planAgentcoreDeploy(baseInput({ modelAuth: "OAuth" }));
    const template = plan.artifacts[0]!.content;
    expect(template).not.toContain("Oauth:"); // no fabricated parameter from the label
    expect(plan.runbook.join("\n")).toContain("FastagentAuthSeed");
  });
});
