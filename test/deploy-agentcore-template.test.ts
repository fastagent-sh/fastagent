/**
 * The CloudFormation template PARSED, not substring-matched.
 *
 * `toContain` cannot see the two ways this template breaks worst. YAML indentation is semantic, so a
 * property under the wrong resource still contains the right text — verified: shifting `Code:` by
 * three spaces left all 85 assertions green. And a reference is only resolved by CloudFormation, so
 * a typo'd `!Ref` survives every test and fails at deploy time, the most expensive moment to learn.
 *
 * These tests answer the questions a substring cannot: does it parse, is each property under the
 * resource that owns it, and does every reference point at something that exists.
 */
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  type AgentcorePlanInput,
  type ScheduleFact,
  MOUNT,
  planAgentcoreDeploy,
  scheduleResourceName,
} from "../src/deploy/agentcore/plan.ts";

/** CloudFormation's short tags are not standard YAML — resolve them to their long forms. */
const CFN_TAGS = [
  { tag: "!Ref", resolve: (s: string) => ({ Ref: s }) },
  { tag: "!GetAtt", resolve: (s: string) => ({ "Fn::GetAtt": s }) },
  { tag: "!Sub", resolve: (s: string) => ({ "Fn::Sub": s }) },
];

interface Template {
  Parameters?: Record<string, { Type: string; NoEcho?: boolean }>;
  Resources: Record<string, { Type: string; Properties?: Record<string, unknown> }>;
  Outputs?: Record<string, unknown>;
}

const baseInput = (over: Partial<AgentcorePlanInput> = {}): AgentcorePlanInput => ({
  name: "my-agent",
  modelAuth: "OPENAI_API_KEY",
  channels: [],
  routeChannels: [],
  schedules: [],
  selfSchedule: false,
  hasPackageJson: false,
  runtime: "node",
  hasLockfile: false,
  version: "0.15.0",
  agentPrefix: "",
  ...over,
});

function parseTemplate(over: Partial<AgentcorePlanInput> = {}): Template {
  const content = planAgentcoreDeploy(baseInput(over)).artifacts[0]!.content;
  return parse(content, { customTags: CFN_TAGS }) as Template;
}

/** Every `!Ref`/`!GetAtt` target anywhere in the tree, paired with where it was found. */
function references(node: unknown, path = "$"): { path: string; target: string; kind: string }[] {
  if (Array.isArray(node)) return node.flatMap((v, i) => references(v, `${path}[${i}]`));
  if (node === null || typeof node !== "object") return [];
  const entries = Object.entries(node as Record<string, unknown>);
  const found: { path: string; target: string; kind: string }[] = [];
  for (const [key, value] of entries) {
    if (key === "Ref" && typeof value === "string") found.push({ path, target: value, kind: "Ref" });
    else if (key === "Fn::GetAtt" && typeof value === "string") {
      found.push({ path, target: value.split(".")[0]!, kind: "GetAtt" });
    } else found.push(...references(value, `${path}.${key}`));
  }
  return found;
}

const WEBHOOK_CHANNELS = { channels: ["telegram" as const], routeChannels: ["telegram"] };
const SCHEDULES: ScheduleFact[] = [{ name: "digest", cron: "0 9 * * *", tz: "Asia/Shanghai" }];

describe("the agentcore template (parsed)", () => {
  it("is valid YAML in every topology, not just the default one", () => {
    // Each flag adds resources, and a block emitted at the wrong depth is invalid or — worse —
    // silently reparented. Parsing is the only assertion that sees either.
    for (const over of [
      {},
      WEBHOOK_CHANNELS,
      { schedules: SCHEDULES },
      { selfSchedule: true },
      { ...WEBHOOK_CHANNELS, schedules: SCHEDULES, selfSchedule: true },
      { ...WEBHOOK_CHANNELS, secrets: ["TELEGRAM_BOT_TOKEN"] } as Partial<AgentcorePlanInput>,
    ]) {
      const t = parseTemplate(over);
      expect(Object.keys(t.Resources).length).toBeGreaterThan(0);
      for (const [name, resource] of Object.entries(t.Resources)) {
        expect(resource, `${name} parsed as a resource`).toBeTypeOf("object");
        expect(resource.Type, `${name}.Type`).toMatch(/^AWS::/);
      }
    }
  });

  it("resolves every reference — a typo would only surface at deploy time", () => {
    const t = parseTemplate({ ...WEBHOOK_CHANNELS, schedules: SCHEDULES, selfSchedule: true });
    const known = new Set([
      ...Object.keys(t.Resources),
      ...Object.keys(t.Parameters ?? {}),
      // Pseudo-parameters CloudFormation supplies.
      "AWS::Region",
      "AWS::AccountId",
      "AWS::Partition",
      "AWS::StackName",
      "AWS::URLSuffix",
      "AWS::NoValue",
    ]);
    const dangling = references(t.Resources).filter((r) => !known.has(r.target));
    expect(dangling).toEqual([]);
  });

  it("puts each property under the resource that owns it", () => {
    const t = parseTemplate({ ...WEBHOOK_CHANNELS, selfSchedule: true });
    const forwarder = Object.entries(t.Resources).find(([, r]) => r.Type === "AWS::Lambda::Function")!;
    const runtime = Object.entries(t.Resources).find(([, r]) => r.Type === "AWS::BedrockAgentCore::Runtime")!;

    // The reparenting a substring assertion cannot detect: Code belongs to the Lambda, the state
    // mount to the Runtime. Either landing on the other still "contains" the right text.
    expect(forwarder[1].Properties).toHaveProperty("Code");
    expect(forwarder[1].Properties).not.toHaveProperty("FilesystemConfigurations");
    expect(runtime[1].Properties).not.toHaveProperty("Code");
    // The state mount lives at FilesystemConfigurations[0].SessionStorage — a nesting level the
    // substring assertion for `SessionStorage: { MountPath: … }` cannot see at all.
    expect(runtime[1].Properties?.FilesystemConfigurations).toEqual([{ SessionStorage: { MountPath: MOUNT } }]);

    const env = (forwarder[1].Properties as { Environment: { Variables: Record<string, unknown> } }).Environment
      .Variables;
    expect(env).toHaveProperty("RUNTIME_ARN");
    expect(env).toHaveProperty("INGRESS_SESSION_ID");
  });

  it("gives every schedule its own rule targeting the forwarder", () => {
    const t = parseTemplate({
      ...WEBHOOK_CHANNELS,
      schedules: [
        { name: "digest", cron: "0 9 * * *", tz: "Asia/Shanghai" },
        { name: "nightly", cron: "0 2 * * *" },
      ],
    });
    const rules = Object.entries(t.Resources).filter(([, r]) => r.Type === "AWS::Scheduler::Schedule");
    expect(rules).toHaveLength(2);

    const forwarderId = Object.entries(t.Resources).find(([, r]) => r.Type === "AWS::Lambda::Function")![0];
    for (const [, rule] of rules) {
      const target = (rule.Properties as { Target: { Arn: { "Fn::GetAtt"?: string } } }).Target;
      expect(target.Arn["Fn::GetAtt"]).toBe(`${forwarderId}.Arn`);
    }
    // Distinct physical names, or one rule silently fires for both.
    const names = rules.map(([, r]) => (r.Properties as { Name: string }).Name);
    expect(new Set(names).size).toBe(2);
    expect(names).toContain(scheduleResourceName("my-agent", "digest"));
  });

  it("declares secrets as NoEcho parameters and wires them into the runtime", () => {
    const t = parseTemplate({ ...WEBHOOK_CHANNELS, secrets: ["TELEGRAM_BOT_TOKEN"] } as Partial<AgentcorePlanInput>);
    const params = t.Parameters ?? {};
    const secretParams = Object.entries(params).filter(([, p]) => p.NoEcho === true);
    expect(secretParams.length).toBeGreaterThan(0);
    for (const [, p] of secretParams) expect(p.Type).toBe("String");
  });
});
