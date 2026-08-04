/**
 * `fastagent deploy agentcore` — the AWS Bedrock AgentCore deploy PLAN, computed from the resolved
 * definition. Pure: facts in, artifact contents + an ordered runbook out; the CLI writes the files
 * and prints the runbook. AgentCore is the fourth target, and its shape differs from Fly/Railway in
 * kind, not degree:
 *
 *  1. **No public URL, no resident process.** The Runtime's only ingress is the SigV4
 *     `InvokeAgentRuntime` API, and compute is per-session microVMs that stop when idle. So the
 *     topology carries TWO extra pieces a Fly box never needs: a forwarder Lambda (public Function
 *     URL → envelope → InvokeAgentRuntime) fronting the webhooks, and EventBridge Scheduler rules
 *     delivering each cron slot (the container arms no resident timers — serve's externalClock mode).
 *  2. **One template is the whole topology.** CloudFormation (`AWS::BedrockAgentCore::Runtime` is a
 *     first-class resource type) declares Runtime + roles + forwarder + schedules in one stack —
 *     unlike Railway, identity DOES live in a committed file; the stack name pins it.
 *  3. **All ingress traffic shares ONE fixed runtime session** (`ingressSessionId`): fastagent's
 *     channel state is single-writer by design, and one session = at most one microVM at a time.
 *     AgentCore keeps a stopped session's id valid until the Runtime is deleted (a new compute is
 *     provisioned on the next invoke), so the fixed id needs no rotation. State lives on the
 *     platform's SessionStorage mount (`/mnt/state`) — persistent across compute stop/resume, no
 *     VPC/EFS required. Named trade-off: that state is tied to THIS Runtime resource — a stack
 *     replacement (renaming the runtime) starts blank. EFS (VPC mode) is the upgrade path when
 *     state must outlive the runtime; the runbook says so instead of silently shipping a VPC+NAT
 *     bill (~$35/mo) every deployment.
 *
 *  The image is the SAME portable container every host ships (containerArtifacts) — AgentCore's
 *  extras (PORT=8080, FASTAGENT_AGENTCORE=1, the state dir) ride the Runtime resource's environment,
 *  never a forked Dockerfile. The build must be linux/arm64 (the platform requirement) — the ONE
 *  host where the build runs on the operator's machine (docker buildx) instead of remotely.
 */
import { createHash } from "node:crypto";
import { MAX_WEBHOOK_BODY_BYTES } from "../../channels/agentcore-limits.ts";
import { SECRETS_DIRNAME } from "../../paths.ts";
import type { ChannelKind } from "../../scaffold/add-channel.ts";
import { type Artifact, type ContainerInput, containerArtifacts } from "../container.ts";
import { deploymentSecrets, isEnvKey } from "../secrets.ts";

/** The one schedule fact the plan needs (from loadSchedules) — name + cron + tz. */
export interface ScheduleFact {
  name: string;
  cron: string;
  tz?: string;
}

export interface AgentcorePlanInput extends ContainerInput {
  /** Base name (dir basename) — shapes the runtime name, stack name, ECR repo, session id. */
  name: string;
  /** What satisfies model auth locally: an env-var name, an OAuth/stored label, or undefined. */
  modelAuth: string | undefined;
  /** Known first-party channels — each contributes its secret metadata + webhook step. */
  channels: ChannelKind[];
  /** ALL route-channel basenames (customs included) — any of them requires the forwarder. */
  routeChannels: string[];
  /** Extra secret env-var names (fastagent.config deploy.secrets). */
  extraSecrets?: string[];
  /** Static schedules — each becomes an EventBridge Scheduler rule targeting the forwarder. */
  schedules: ScheduleFact[];
  /** Wake tool enabled — DEGRADED here (fires only while a session happens to be awake); warned. */
  selfSchedule: boolean;
}

export interface AgentcorePlan {
  /** template + forwarder + Dockerfile/.dockerignore — written by the CLI (kept unless --force). */
  artifacts: Artifact[];
  /** The ordered, values-resolved deploy runbook — printed to stdout. */
  runbook: string[];
  /** Cron expressions EventBridge cannot express — surfaced as runbook warnings, not silent drops. */
  untranslatableSchedules: { name: string; reason: string }[];
}

/** SessionStorage mount = FASTAGENT_STATE_DIR (AgentCore requires exactly `/mnt/<one-level>`). It is
 *  a fast LOCAL disk only: the platform wipes it on every runtime version update (= every deploy).
 *  Durability across deploys comes from the S3 snapshot (channels/agentcore-state.ts). */
export const MOUNT = "/mnt/state";

/**
 * FASTAGENT_SECRETS_DIR — the seeded-then-ROTATED auth.json, deliberately INSIDE the state root
 * rather than beside it.
 *
 * Every other host mounts a real volume and puts the two machinery dirs side by side (`/data/.state`
 * + `/data/.secrets`), because there the persistence boundary is the MOUNT POINT: anything under it
 * survives. AgentCore has no volume. Its persistence boundary is `packStateRoot(stateRoot)` — the one
 * directory tree the S3 snapshot copies out and back (channels/agentcore-state.ts) — while {@link MOUNT}
 * itself is wiped on every runtime version update, i.e. on every deploy.
 *
 * So the sibling layout would put credentials INSIDE the mount but OUTSIDE the snapshot: nothing
 * copies them out, the platform wipes them, and the next microVM re-seeds the deploy-time copy. With
 * single-use OAuth refresh tokens that is a slow-motion outage — the box works until the seeded token
 * is rotated away, then loses model access with only a redeploy to restore it.
 *
 * Nesting is what makes agentcore-state.ts's stated contract ("restores VERBATIM — including
 * auth.json") reachable at all; `packStateRoot` walks the whole tree, so no snapshot code knows about
 * this. Tests assert the containment, not just the two names — the sibling spelling looks tidier and
 * reintroduces the outage silently.
 */
export const SECRETS_DIR = `${MOUNT}/${SECRETS_DIRNAME}`;

/**
 * How long an idle session keeps its microVM. Memory is billed per second across the WHOLE session
 * — idle included, at the peak level reached — so this tail is the standing cost of every burst of
 * activity, while CPU stops billing the moment the agent stops working. 3 minutes rather than the
 * platform's 15: the tail shrinks 5×, and the cost is a cold start (image + Node + snapshot restore)
 * for anyone who returns after a longer gap. `/ping` reports HealthyBusy + time_of_last_update while
 * work is in flight (the FIELD is what the platform's idle measurement actually reads — agentcore.ts),
 * so this timer only ever starts once the agent has genuinely settled — a long turn is never cut short.
 * AWS accepts 60–28800.
 */
export const IDLE_TIMEOUT_SECONDS = 180;

/** The platform ceiling on one session's compute (8 h). The session ID outlives it: the next invoke
 *  simply gets fresh compute with the same storage. */
export const MAX_LIFETIME_SECONDS = 28800;

/** The state snapshot's object key in the deployment bucket (one object; see agentcore-state.ts). */
export const STATE_KEY = "state/snapshot.json.gz";

/** The forwarder artifact. Named `index.js` because it IS the Lambda deployment package's entry:
 *  zipping it as-is produces a valid package (`Handler: index.handler`), with nothing to rename. */
export const FORWARDER_FILE = "lambda/index.js";

/** The deployment bucket: forwarder code + the state snapshot. Account-suffixed for S3's GLOBAL
 *  namespace, and created OUTSIDE the stack (like the ECR repo) so a `delete-stack` cannot take the
 *  agent's memory with it. Bucket names cap at 63 chars; `name` is already gated to 40. */
export function stateBucketName(name: string, account: string): string {
  return `fa-${name}-${account}`;
}
/** AgentCore env values max 2048 chars — a real OAuth auth.json's base64 exceeds it, so the seed is
 *  CHUNKED across FASTAGENT_AUTH_SEED + _2… (collectAuthSeed reassembles at boot). 2000 keeps margin. */
export const AUTH_SEED_CHUNK_SIZE = 2000;
export const AUTH_SEED_MAX_CHUNKS = 4;
/** The generated template's filename (namespaced under the kit in the agentDir layout). */
export const TEMPLATE_FILE = "agentcore.template.yaml";

/** The generated template's first-line marker — the ONE source for both the generator and the
 *  "did fastagent generate this?" check (deploy's drift gate), so they cannot drift apart. */
export const GENERATED_TEMPLATE_MARKER = "# Generated by `fastagent deploy agentcore`";

/** Whether an on-disk template is fastagent-generated (vs hand-written — kept, never gated). */
export function isGeneratedAgentcoreTemplate(content: string): boolean {
  return content.startsWith(GENERATED_TEMPLATE_MARKER);
}

/** Deployment base name from the workspace basename — the ONE mapping used to find its stack later. */
export function agentcoreName(workspaceBasename: string): string {
  return (
    workspaceBasename
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "agent"
  );
}

/** Runtime name (`[a-zA-Z][a-zA-Z0-9_]{0,47}`) from a dir basename. */
export function toRuntimeName(basename: string): string {
  const slug = basename.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return (/^[a-zA-Z]/.test(slug) ? slug : `agent_${slug || "fastagent"}`).slice(0, 48);
}

/** The ONE fixed ingress session id (webhooks + schedule fires) — ≥ 33 chars (the API minimum),
 *  deterministic (the Lambda holds it in env), padded so any name clears the floor. */
export function ingressSessionId(name: string): string {
  return `fastagent-ingress-${name}`.padEnd(33, "0").slice(0, 128);
}

/** CFN parameter logical id for a secret env-var name: TELEGRAM_BOT_TOKEN → TelegramBotToken
 *  (parameter names must be alphanumeric). Deterministic — run.ts builds the same mapping. */
export function cfnParamName(envName: string): string {
  return envName
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/**
 * Remap ONE day-of-week field from standard cron numbering (0–7, 0/7 = Sunday) to EventBridge's
 * (1–7, 1 = Sunday). Parsed, not regex-replaced: only VALUES and RANGE ENDPOINTS are renumbered — a
 * step divisor (`*\/2`, `1-5/2`) is a count, not a weekday, and must pass through untouched. Names
 * (SUN..SAT) pass through. A numeric range whose endpoints INVERT under renumbering (`5-7` → `6-1`)
 * wraps across the week — not expressible as an EventBridge range — and is refused, never silently
 * reordered.
 */
function mapDowField(dow: string): { value: string } | { error: string } {
  const items: string[] = [];
  for (const item of dow.split(",")) {
    const slash = item.split("/");
    if (slash.length > 2 || slash.some((part) => part === "")) {
      return { error: `malformed day-of-week token "${item}"` };
    }
    const [body, step] = slash as [string, string?];
    if (step !== undefined && !/^\d+$/.test(step)) return { error: `malformed day-of-week step "${item}"` };
    let mapped: string;
    if (body === "*") {
      mapped = "*";
    } else {
      const endpoints = body.split("-");
      if (endpoints.length > 2 || endpoints.some((part) => part === "")) {
        return { error: `malformed day-of-week token "${item}"` };
      }
      const remapped = endpoints.map((p) => (/^\d+$/.test(p) ? String((Number(p) % 7) + 1) : p));
      if (
        remapped.length === 2 &&
        remapped.every((p) => /^\d+$/.test(p)) &&
        Number(remapped[0]) > Number(remapped[1])
      ) {
        return {
          error:
            `day-of-week range "${body}" wraps across the week under EventBridge numbering (1 = Sunday) — ` +
            `split it into an explicit list`,
        };
      }
      mapped = remapped.join("-");
    }
    items.push(step !== undefined ? `${mapped}/${step}` : mapped);
  }
  return { value: items.join(",") };
}

/**
 * Translate a 5-field cron into EventBridge Scheduler's `cron(m h dom mon dow *)`, or say why it
 * can't be. The two dialects disagree exactly where silent translation would misfire:
 *  - EventBridge numbers day-of-week 1–7 (1 = Sunday); standard cron uses 0–6 (0/7 = Sunday) —
 *    numeric dow values and range endpoints are remapped ({@link mapDowField}); steps and names
 *    pass through; a range that wraps under renumbering is refused.
 *  - EventBridge requires `?` in dom or dow: a `*` on either side becomes `?`; BOTH restricted is
 *    standard cron's OR semantics, which EventBridge cannot express — refused, never approximated.
 *  - A 6-field (seconds) expression and L/# day-of-week forms are refused for the same reason.
 */
export function toEventBridgeCron(cron: string): { expression: string } | { error: string } {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    return { error: `EventBridge supports 5-field cron only (got ${fields.length} fields)` };
  }
  const [min, hour, dom, mon, dow] = fields as [string, string, string, string, string];
  if (/[L#]/i.test(dow) || /[L#]/i.test(dom)) {
    return { error: "L/# day forms don't translate to EventBridge numbering — set this schedule up manually" };
  }
  // `?` FIRST, and not as a synonym for `*`. Croner treats it as a day field that matches everything
  // and — unlike `*` — does NOT trigger cron's "one field is unrestricted, so the other governs"
  // special case. It therefore ORs with the other field to mean EVERY DAY, whatever that field says.
  // Measured against croner: `0 9 ? * MON` and `0 9 1 * ?` both fire daily, while `0 9 * * MON`
  // fires on Mondays. Translating `?` to `*` would deploy a rule that fires on a DIFFERENT set of
  // days than the same file fires on locally — the silent divergence this whole target exists to
  // avoid — so a `?` in either field becomes an explicitly daily EventBridge rule.
  if (dom === "?" || dow === "?") {
    return { expression: `cron(${min} ${hour} * ${mon} ? *)` };
  }
  if (dom !== "*" && dow !== "*") {
    return {
      error: "restricting BOTH day-of-month and day-of-week (cron OR semantics) is not expressible in EventBridge",
    };
  }
  if (dow === "*") {
    return { expression: `cron(${min} ${hour} ${dom} ${mon} ? *)` };
  }
  const mapped = mapDowField(dow);
  if ("error" in mapped) return mapped;
  return { expression: `cron(${min} ${hour} ? ${mon} ${mapped.value} *)` };
}

/** CFN logical id fragment from a schedule name (alphanumeric only, capitalized). */
function logicalId(name: string): string {
  const slug = name.replace(/[^a-zA-Z0-9]+/g, "");
  return slug.charAt(0).toUpperCase() + slug.slice(1) || "Schedule";
}

/** YAML single-quoted scalar (the one escape: `'` doubles). Used for values carrying user input. */
function yamlSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The forwarder Lambda source — the ONLY string both the template's inline ZipFile and the readable
 * `lambda/forwarder.js` artifact are generated from (one source, no drift). Zero-dependency: the
 * Lambda Node runtime bundles AWS SDK v3. CommonJS ON PURPOSE: CloudFormation inline code always
 * lands as `index.js`, where ESM `import` is a syntax error (found by the first real deploy). Two
 * event shapes: a Function URL webhook (reconstructed verbatim into a `webhook` envelope; the
 * channel's REAL response rides back inside the transport reply and is re-emitted byte-exact —
 * Feishu's URL-verification challenge depends on it), and an EventBridge Scheduler fire
 * (`{ scheduleFire }`, slot = the scheduled instant — the container's idempotency key). MUST stay
 * under CloudFormation's 4096-byte inline-code cap.
 */
export function forwarderSource(): string {
  return `// Generated by \`fastagent deploy agentcore\` — the deployment's only ingress.
// REGENERATED ON EVERY DEPLOY; edits here are overwritten and never deployed. \`--run\` builds the
// Lambda package from fastagent's own copy of this source, so this file is the readable MIRROR of
// what runs (and what the manual runbook zips) — not an input you can change.
// Webhooks (Function URL) and EventBridge Scheduler fires are forwarded as envelopes to the
// AgentCore Runtime over SigV4 InvokeAgentRuntime, all on ONE fixed ingress session (fastagent
// channel state is single-writer; one session = at most one microVM). With selfSchedule, this
// Lambda also OWNS the wake alarms: the container POSTs its pending wake-ups to /__fastagent/
// wake-alarm (shared secret) and each becomes a self-deleting one-shot EventBridge schedule that
// pokes this Lambda — which wakes the container, whose wake pump fires the due entry.
// CommonJS on purpose: the deployment package's entry lands as index.js, where ESM import is invalid.
"use strict";
const crypto = require("node:crypto");
const { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } = require("@aws-sdk/client-bedrock-agentcore");
const client = new BedrockAgentCoreClient({});
let ownUrl; // self-resolved once per cold start; rides on every envelope for the wake-alarm callback

// Presigned S3 URLs for the container's state snapshot. AgentCore wipes the /mnt/state mount on
// every runtime version update (= every deploy), so the durable copy lives in S3 — but the
// container is given NO AWS credentials by the platform, so the only reachable form is a URL that
// carries its own authorization. SigV4 query signing, node:crypto only (no SDK, nothing to install).
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => \`%\${c.charCodeAt(0).toString(16).toUpperCase()}\`);
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();

function presign(method, seconds) {
  const bucket = process.env.STATE_BUCKET, key = process.env.STATE_KEY, region = process.env.AWS_REGION;
  const host = \`\${bucket}.s3.\${region}.amazonaws.com\`;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\\.\\d+/, "");
  const scope = \`\${stamp.slice(0, 8)}/\${region}/s3/aws4_request\`;
  const pairs = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", \`\${process.env.AWS_ACCESS_KEY_ID}/\${scope}\`],
    ["X-Amz-Date", stamp],
    ["X-Amz-Expires", String(seconds)],
    ["X-Amz-SignedHeaders", "host"],
  ];
  if (process.env.AWS_SESSION_TOKEN) pairs.push(["X-Amz-Security-Token", process.env.AWS_SESSION_TOKEN]);
  // The canonical query must be byte-identical to the one on the wire — build it ONCE, reuse below.
  const query = pairs
    .map(([k, v]) => [enc(k), enc(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map((p) => p.join("="))
    .join("&");
  const path = \`/\${key.split("/").map(enc).join("/")}\`;
  const canonical = [method, path, query, \`host:\${host}\\n\`, "host", "UNSIGNED-PAYLOAD"].join("\\n");
  const sts = ["AWS4-HMAC-SHA256", stamp, scope, crypto.createHash("sha256").update(canonical).digest("hex")].join("\\n");
  let k = hmac(\`AWS4\${process.env.AWS_SECRET_ACCESS_KEY}\`, stamp.slice(0, 8));
  for (const part of [region, "s3", "aws4_request"]) k = hmac(k, part);
  return \`https://\${host}\${path}?\${query}&X-Amz-Signature=\${hmac(k, sts).toString("hex")}\`;
}

async function invoke(envelope) {
  if ((process.env.WAKE_SECRET || process.env.STATE_REFRESH_SECRET) && !ownUrl) {
    const { LambdaClient, GetFunctionUrlConfigCommand } = require("@aws-sdk/client-lambda");
    ownUrl = (await new LambdaClient({}).send(
      new GetFunctionUrlConfigCommand({ FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME }),
    )).FunctionUrl;
  }
  if (ownUrl) envelope.wake = { url: ownUrl };
  // Authenticates this envelope as coming from the forwarder (see the template's FastagentIngressSecret).
  envelope.auth = process.env.INGRESS_SECRET;
  // Keep each capability short-lived. Function-URL deployments also carry an authenticated refresh
  // endpoint, so a background turn settling hours after its webhook never depends on the temporary
  // Lambda credentials that signed the original pair still being alive.
  if (process.env.STATE_BUCKET) envelope.state = {
    getUrl: presign("GET", 3600),
    putUrl: presign("PUT", 3600),
    ...(ownUrl && process.env.STATE_REFRESH_SECRET ? {
      refresh: { url: ownUrl.replace(/\\/$/, "") + "/__fastagent/state-urls", auth: process.env.STATE_REFRESH_SECRET },
    } : {}),
  };
  const res = await client.send(new InvokeAgentRuntimeCommand({
    agentRuntimeArn: process.env.RUNTIME_ARN,
    runtimeSessionId: process.env.INGRESS_SESSION_ID,
    contentType: "application/json",
    accept: "application/json",
    payload: new TextEncoder().encode(JSON.stringify(envelope)),
  }));
  const body = Buffer.from(await res.response.transformToByteArray());
  return { status: res.statusCode ?? 200, body };
}

// Mirror the container's pending wake-ups into one-shot schedules: at(fireAt), poke me, delete
// after firing. Upsert (create → conflict → update). The container pre-filters DUE alarms (it is
// awake handling those), so every failure here is REAL — counted and propagated: a swallowed error
// would leave a pending wake with no alarm, exactly the reliability hole this mechanism closes.
// Cancelled wakes are NOT deleted here: their poke fires, finds nothing due, and the schedule
// self-deletes (lazy cleanup by design).
async function syncAlarms(alarms, ctx) {
  const { SchedulerClient, CreateScheduleCommand, UpdateScheduleCommand } = require("@aws-sdk/client-scheduler");
  const sch = new SchedulerClient({});
  let failed = 0;
  // Alarm name = a stable hash of the WHOLE wake id. A prefix of the id would collide (two wakes
  // sharing 8 hex chars), and a collision is INDISTINGUISHABLE from the legitimate re-arm below:
  // the second wake would "update" the first's alarm and silently steal its fire time.
  const names = new Map();
  for (const a of alarms) {
    const name = process.env.WAKE_PREFIX + crypto.createHash("sha256").update(a.id).digest("hex").slice(0, 16);
    if (names.has(name)) {
      failed += 1;
      console.log(\`alarm name collision \${name}: \${names.get(name)} vs \${a.id}\`);
      continue;
    }
    names.set(name, a.id);
    const p = {
      Name: name,
      ScheduleExpression: \`at(\${a.at.slice(0, 19)})\`,
      ScheduleExpressionTimezone: "UTC",
      FlexibleTimeWindow: { Mode: "OFF" },
      ActionAfterCompletion: "DELETE",
      Target: { Arn: ctx.invokedFunctionArn, RoleArn: process.env.WAKE_ROLE_ARN, Input: '{"wakePoke":true}' },
    };
    try {
      await sch.send(new CreateScheduleCommand(p));
    } catch (e) {
      try {
        if (e.name !== "ConflictException") throw e;
        await sch.send(new UpdateScheduleCommand(p));
      } catch (u) {
        failed += 1;
        console.log(\`alarm \${p.Name}: \${u}\`);
      }
    }
  }
  return failed;
}

exports.handler = async (event, ctx) => {
  // EventBridge wake-up poke: the invocation itself wakes the container; its pump does the rest.
  if (event && event.wakePoke) {
    const r = await invoke({ kind: "wake-poke" });
    console.log(\`wake-poke: \${r.status}\`);
    return { status: r.status };
  }
  // EventBridge Scheduler fire — throw on failure so the miss lands in CloudWatch, never silently.
  if (event && event.scheduleFire) {
    const { name, slot } = event.scheduleFire;
    const r = await invoke({ kind: "schedule-fire", name, slot });
    const out = r.body.toString();
    console.log(\`schedule-fire \${name} (\${slot}): \${r.status} \${out}\`);
    if (r.status >= 400) throw new Error(\`schedule-fire \${name} failed: \${r.status} \${out}\`);
    return { status: r.status };
  }
  const http = event && event.requestContext && event.requestContext.http;
  if (!http) throw new Error("unrecognized event shape");
  // Refresh the snapshot capabilities with THIS Lambda invocation's current temporary credentials.
  // The container may settle long after the webhook Lambda (and its credentials) expired.
  if (event.rawPath === "/__fastagent/state-urls") {
    const req = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString() : event.body || "{}");
    const actual = Buffer.from(typeof req.auth === "string" ? req.auth : "");
    const expected = Buffer.from(process.env.STATE_REFRESH_SECRET || "");
    if (!expected.length || actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      return { statusCode: 403, body: "forbidden\\n" };
    }
    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ getUrl: presign("GET", 3600), putUrl: presign("PUT", 3600) }),
    };
  }
  // The container's wake-alarm callback (reserved path, shared secret) — handled HERE, never forwarded.
  if (event.rawPath === "/__fastagent/wake-alarm") {
    const req = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString() : event.body || "{}");
    if (!process.env.WAKE_SECRET || req.secret !== process.env.WAKE_SECRET) return { statusCode: 403, body: "forbidden\\n" };
    const failed = await syncAlarms(req.alarms || [], ctx);
    // Partial failure IS failure: the container retries the whole (idempotent) set until every
    // pending wake really has its alarm.
    if (failed > 0) return { statusCode: 500, body: \`\${failed} alarm(s) failed\\n\` };
    return { statusCode: 200, body: "ok\\n" };
  }
  // Enforce the advertised ORIGINAL-body ceiling before base64 adds another 4/3 inside the runtime
  // envelope. This also leaves deterministic room for headers/query/JSON under Lambda's 6 MB cap.
  const webhookBytes = event.body === undefined ? 0
    : event.isBase64Encoded ? Buffer.byteLength(event.body, "base64") : Buffer.byteLength(event.body);
  if (webhookBytes > ${MAX_WEBHOOK_BODY_BYTES}) return { statusCode: 413, body: "payload too large\\n" };
  // A schedule-only deployment has a Function URL solely for the authenticated refresh callback.
  // Reject arbitrary public traffic BEFORE it can wake AgentCore (cost/DoS) or reach an inner route.
  if (process.env.WEBHOOKS_ENABLED !== "1") return { statusCode: 404, body: "not found\\n" };
  // Function URL webhook — forward the original request verbatim (signature material included).
  const r = await invoke({
    kind: "webhook",
    method: http.method,
    path: event.rawPath || "/",
    query: event.rawQueryString || undefined,
    headers: event.headers || {},
    bodyB64: event.body === undefined ? undefined
      : event.isBase64Encoded ? event.body : Buffer.from(event.body).toString("base64"),
  });
  if (r.status !== 200) {
    console.log(\`transport error \${r.status}: \${r.body}\`);
    return { statusCode: 502, body: "upstream error\\n" };
  }
  const reply = JSON.parse(r.body.toString()); // { status, headers, bodyB64 } from the adapter
  for (const k of Object.keys(reply.headers)) {
    if (/^(content-length|transfer-encoding|connection)$/i.test(k)) delete reply.headers[k];
  }
  return { statusCode: reply.status, headers: reply.headers, body: reply.bodyB64, isBase64Encoded: true };
};
`;
}

/**
 * The EventBridge physical name for a schedule. A schedule's local name is an arbitrary MODULE FILE
 * NAME (`schedules/晨报.ts`, `schedules/deploy check.ts`), while AWS requires `[0-9A-Za-z-_.]+` within
 * 64 chars — and the `fa-<agent>-` prefix already eats up to 44 of them. So: sanitize, bound the
 * readable part, and end with a hash of the ORIGINAL name, which keeps distinct schedules distinct
 * where sanitizing or truncation would have merged them (one rule silently firing for two).
 */
export function scheduleResourceName(agent: string, schedule: string): string {
  const prefix = `fa-${agent}-`;
  const hash = createHash("sha256").update(schedule).digest("hex").slice(0, 8);
  const safe = schedule.replace(/[^0-9A-Za-z\-_.]+/g, "-").replace(/^-+|-+$/g, "");
  const room = Math.max(0, 64 - prefix.length - hash.length - 1);
  return `${prefix}${safe.slice(0, room)}-${hash}`;
}

/** The CloudFormation template — the whole topology in one stack. */
function template(input: AgentcorePlanInput, translated: { fact: ScheduleFact; expression: string }[]): string {
  const runtimeName = toRuntimeName(input.name);
  // selfSchedule needs the forwarder too: it is both the wake-alarm registrar and the poke target.
  // Every forwarder also gets a Function URL as the authenticated state-capability refresh channel:
  // a schedule turn can outlive both its original presigned URL and the Lambda credentials that signed
  // it. Schedule-only URLs reject every non-reserved HTTP path before invoking AgentCore, so they do
  // not expose a webhook/data plane (and start never mounts the builtin /invoke under AgentCore).
  const needsForwarder = input.routeChannels.length > 0 || translated.length > 0 || input.selfSchedule;
  const needsFunctionUrl = needsForwarder;
  const secrets = deploymentSecrets(input.modelAuth, input.channels, input.extraSecrets);
  const forwarderFnArn = `!Sub arn:aws:lambda:\${AWS::Region}:\${AWS::AccountId}:function:fastagent-${input.name}-forwarder`;

  // Secret env vars ride CFN NoEcho parameters. FASTAGENT_AUTH_SEED is always declared (Default "")
  // so a `--run` OAuth carry has a slot; required secrets have NO default — `cloudformation deploy`
  // fails loudly without a value instead of booting a half-configured box.
  const params: string[] = [
    `  ImageUri:`,
    `    Type: String`,
    `    Description: ECR image URI (linux/arm64) — <account>.dkr.ecr.<region>.amazonaws.com/<repo>:<tag>`,
  ];
  if (needsForwarder) {
    params.push(
      `  StateBucket:`,
      `    Type: String`,
      `    Description: S3 bucket holding the forwarder deployment package + the agent's state snapshot (created outside this stack)`,
      `  ForwarderS3Key:`,
      `    Type: String`,
      `    Description: key of the forwarder .zip in StateBucket — CONTENT-HASHED, so new code is a new value and CloudFormation rolls the function`,
    );
  }
  const envLines: string[] = [
    `        PORT: "8080"`, // the Runtime service contract's fixed port (config.http.port does not apply here)
    `        FASTAGENT_AGENTCORE: "1"`, // serve mounts /invocations + /ping, arms no resident cron
    `        FASTAGENT_STATE_DIR: ${MOUNT}`,
    // Inside the state root on purpose — the snapshot is this host's only durable store, and it copies
    // exactly one tree. See {@link SECRETS_DIR}: the sibling layout every other host uses would leave a
    // rotated OAuth credential outside it, i.e. discarded with the microVM.
    `        FASTAGENT_SECRETS_DIR: ${SECRETS_DIR}`,
  ];
  // The auth seed is chunked (env values max 2048 chars — see AUTH_SEED_CHUNK_SIZE): N parameters,
  // each riding its own env var; `start` reassembles them (collectAuthSeed). Empty defaults = unused.
  for (let i = 1; i <= AUTH_SEED_MAX_CHUNKS; i++) {
    const param = i === 1 ? "FastagentAuthSeed" : `FastagentAuthSeed${i}`;
    const envName = i === 1 ? "FASTAGENT_AUTH_SEED" : `FASTAGENT_AUTH_SEED_${i}`;
    params.push(
      `  ${param}:`,
      `    Type: String`,
      `    Default: ""`,
      `    NoEcho: true`,
      `    Description: base64 auth.json carried by --run, chunk ${i}/${AUTH_SEED_MAX_CHUNKS} (env values cap at 2048 chars); empty = unused`,
    );
    envLines.push(`        ${envName}: !Ref ${param}`);
  }
  for (const s of secrets) {
    const p = cfnParamName(s.name);
    params.push(`  ${p}:`, `    Type: String`);
    if (!s.required) params.push(`    Default: ""`);
    params.push(`    NoEcho: true`, `    Description: ${s.hint}`);
    envLines.push(`        ${s.name}: !Ref ${p}`);
  }
  if (needsForwarder) {
    // The INGRESS secret authenticates forwarder→runtime envelopes. Without it the envelope union is
    // an unauthenticated control plane: `InvokeAgentRuntime` is an ordinary IAM action, so any
    // principal holding it could forge a `schedule-fire`, or ride `state`/`wake` on a public `invoke`
    // to redirect the state snapshot (exfiltrating auth.json) or the wake-alarm callback (leaking the
    // wake secret) to an address of their choosing. Public `invoke` stays unauthenticated by design —
    // it is the programmatic data plane — but it may not carry internal fields.
    params.push(
      `  FastagentIngressSecret:`,
      `    Type: String`,
      `    NoEcho: true`,
      `    Description: shared secret authenticating forwarder→runtime envelopes (any random string; --run mints one)`,
    );
    envLines.push(`        FASTAGENT_INGRESS_SECRET: !Ref FastagentIngressSecret`);
  }
  if (input.selfSchedule) {
    // The wake-alarm shared secret: the container authenticates its alarm callbacks to the forwarder
    // with it. Required (no default) — a selfSchedule deployment without it would silently degrade.
    params.push(
      `  FastagentWakeSecret:`,
      `    Type: String`,
      `    NoEcho: true`,
      `    Description: shared secret between the container and the forwarder's wake-alarm callback (any random string; --run mints one)`,
    );
    envLines.push(`        FASTAGENT_WAKE_SECRET: !Ref FastagentWakeSecret`);
  }

  const lines: string[] = [
    `${GENERATED_TEMPLATE_MARKER}. Edit freely — deploy then treats it as hand-written and never gates on drift.`,
    `AWSTemplateFormatVersion: "2010-09-09"`,
    `Description: fastagent agent "${input.name}" on AWS Bedrock AgentCore Runtime`,
    ``,
    `Parameters:`,
    ...params,
    ``,
    `Resources:`,
    `  ExecutionRole:`,
    `    Type: AWS::IAM::Role`,
    `    Properties:`,
    `      AssumeRolePolicyDocument:`,
    `        Version: "2012-10-17"`,
    `        Statement:`,
    `          - Effect: Allow`,
    `            Principal: { Service: bedrock-agentcore.amazonaws.com }`,
    `            Action: sts:AssumeRole`,
    `            Condition:`,
    `              StringEquals: { aws:SourceAccount: !Ref AWS::AccountId }`,
    `      Policies:`,
    `        - PolicyName: runtime`,
    `          PolicyDocument:`,
    `            Version: "2012-10-17"`,
    `            Statement:`,
    `              - Effect: Allow # pull the agent image`,
    `                Action: [ecr:GetAuthorizationToken]`,
    `                Resource: "*"`,
    `              - Effect: Allow`,
    `                Action: [ecr:BatchGetImage, ecr:GetDownloadUrlForLayer]`,
    `                Resource: !Sub arn:aws:ecr:\${AWS::Region}:\${AWS::AccountId}:repository/*`,
    `              - Effect: Allow # runtime logs + traces + metrics`,
    `                Action: [logs:CreateLogGroup, logs:CreateLogStream, logs:PutLogEvents, logs:DescribeLogGroups, logs:DescribeLogStreams]`,
    `                Resource: "*"`,
    `              - Effect: Allow`,
    `                Action: [xray:PutTraceSegments, xray:PutTelemetryRecords, cloudwatch:PutMetricData]`,
    `                Resource: "*"`,
    `              - Effect: Allow # AgentCore workload identity (the platform mints one per runtime)`,
    `                Action: [bedrock-agentcore:GetWorkloadAccessToken]`,
    `                Resource: "*"`,
    ``,
    `  Runtime:`,
    `    Type: AWS::BedrockAgentCore::Runtime`,
    `    Properties:`,
    `      AgentRuntimeName: ${runtimeName}`,
    `      Description: fastagent agent "${input.name}" (deploy agentcore)`,
    `      AgentRuntimeArtifact:`,
    `        ContainerConfiguration: { ContainerUri: !Ref ImageUri }`,
    `      RoleArn: !GetAtt ExecutionRole.Arn`,
    `      ProtocolConfiguration: HTTP`,
    `      NetworkConfiguration: { NetworkMode: PUBLIC }`,
    `      # SessionStorage is the agent's LOCAL disk: it survives compute stop/resume within a runtime`,
    `      # version, but AWS wipes it on every VERSION UPDATE (= every deploy) and after 14 idle days.`,
    `      # Durability therefore comes from the S3 snapshot the container pulls on its first`,
    `      # invocation and pushes when work settles (presigned by the forwarder — the container holds`,
    `      # no AWS credentials). A persistent MOUNT instead needs EfsAccessPoint + VPC mode, which`,
    `      # forces a NAT gateway for model/channel egress (~$33/mo) — deliberately not the default.`,
    `      FilesystemConfigurations:`,
    `        - SessionStorage: { MountPath: ${MOUNT} }`,
    `      # Idle ${IDLE_TIMEOUT_SECONDS}s (the ping's HealthyBusy + time_of_last_update keeps BUSY sessions alive), max compute`,
    `      # lifetime ${MAX_LIFETIME_SECONDS}s — the platform ceiling; the session id stays valid, so the next invoke`,
    `      # just gets fresh compute with the same storage. Memory bills per second for the whole`,
    `      # session INCLUDING the idle tail, so a shorter tail is the main cost lever here.`,
    `      LifecycleConfiguration: { IdleRuntimeSessionTimeout: ${IDLE_TIMEOUT_SECONDS}, MaxLifetime: ${MAX_LIFETIME_SECONDS} }`,
    `      EnvironmentVariables:`,
    ...envLines,
  ];

  if (needsForwarder) {
    lines.push(
      ``,
      `  ForwarderRole:`,
      `    Type: AWS::IAM::Role`,
      `    Properties:`,
      `      AssumeRolePolicyDocument:`,
      `        Version: "2012-10-17"`,
      `        Statement:`,
      `          - Effect: Allow`,
      `            Principal: { Service: lambda.amazonaws.com }`,
      `            Action: sts:AssumeRole`,
      `      ManagedPolicyArns: [arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]`,
      `      Policies:`,
      `        - PolicyName: invoke-runtime`,
      `          PolicyDocument:`,
      `            Version: "2012-10-17"`,
      `            Statement:`,
      `              - Effect: Allow`,
      `                Action: bedrock-agentcore:InvokeAgentRuntime`,
      `                Resource:`,
      `                  - !GetAtt Runtime.AgentRuntimeArn`,
      `                  - !Sub "\${Runtime.AgentRuntimeArn}/*"`,
      `              - Effect: Allow # mint the presigned URLs the container uses for its state snapshot`,
      `                Action: [s3:GetObject, s3:PutObject]`,
      `                Resource: !Sub arn:aws:s3:::\${StateBucket}/${STATE_KEY}`,
      `              # Without s3:ListBucket, S3 folds "key absent" into 403 (anti-enumeration), which is`,
      `              # indistinguishable from a broken signature — so the container's restore contract`,
      `              # (agentcore-state.ts: ONLY 404 means first deploy) would dead-end every first deploy.`,
      `              # Scoped to the snapshot prefix: this grants "may know whether the snapshot exists",`,
      `              # not a listing of the whole deployment bucket.`,
      `              - Effect: Allow`,
      `                Action: s3:ListBucket`,
      `                Resource: !Sub arn:aws:s3:::\${StateBucket}`,
      `                Condition:`,
      `                  StringLike: { s3:prefix: state/* }`,
      ...(input.selfSchedule
        ? [
            `              - Effect: Allow # wake alarms: mirror pending wake-ups into one-shot schedules`,
            `                Action: [scheduler:CreateSchedule, scheduler:UpdateSchedule]`,
            `                Resource: !Sub arn:aws:scheduler:\${AWS::Region}:\${AWS::AccountId}:schedule/default/fa-${input.name}-wk-*`,
            `              - Effect: Allow # hand the poke schedules their invoke role`,
            `                Action: iam:PassRole`,
            `                Resource: !GetAtt WakeSchedulerRole.Arn`,
          ]
        : []),
      ...(needsFunctionUrl
        ? [
            `              - Effect: Allow # self-resolve callback URL for state-URL refresh / wake alarms`,
            `                Action: lambda:GetFunctionUrlConfig`,
            `                Resource: ${forwarderFnArn}`,
          ]
        : []),
      ``,
      `  Forwarder:`,
      `    Type: AWS::Lambda::Function`,
      `    Properties:`,
      `      FunctionName: fastagent-${input.name}-forwarder`,
      `      Runtime: nodejs22.x`,
      `      Handler: index.handler`,
      `      # Webhook ACKs are fast, but schedule-fire holds the connection for the WHOLE agent turn`,
      `      # (claim-before-run means a timeout never double-fires; the turn also continues and is`,
      `      # audited container-side). EventBridge→Lambda is async, so the long timeout costs nothing.`,
      `      Timeout: 900`,
      `      MemorySize: 256`,
      `      Role: !GetAtt ForwarderRole.Arn`,
      `      Environment:`,
      `        Variables:`,
      `          RUNTIME_ARN: !GetAtt Runtime.AgentRuntimeArn`,
      `          INGRESS_SESSION_ID: ${ingressSessionId(input.name)}`,
      ...(needsFunctionUrl ? [`          STATE_REFRESH_SECRET: !Ref FastagentIngressSecret`] : []),
      ...(input.routeChannels.length > 0 ? [`          WEBHOOKS_ENABLED: "1"`] : []),
      ...(input.selfSchedule
        ? [
            `          WAKE_SECRET: !Ref FastagentWakeSecret`,
            `          WAKE_ROLE_ARN: !GetAtt WakeSchedulerRole.Arn`,
            `          WAKE_PREFIX: fa-${input.name}-wk-`,
          ]
        : []),
      `          INGRESS_SECRET: !Ref FastagentIngressSecret`,
      `          STATE_BUCKET: !Ref StateBucket`,
      `          STATE_KEY: ${STATE_KEY}`,
      `      # From S3, not inline: the forwarder mints SigV4-presigned URLs for the state snapshot and`,
      `      # no longer fits CloudFormation's 4096-byte inline cap. The key is content-hashed, so a`,
      `      # code change is a parameter change — CloudFormation cannot miss it.`,
      `      Code:`,
      `        S3Bucket: !Ref StateBucket`,
      `        S3Key: !Ref ForwarderS3Key`,
    );
  }
  if (needsFunctionUrl) {
    lines.push(
      ``,
      `  ForwarderUrl:`,
      `    Type: AWS::Lambda::Url`,
      `    Properties:`,
      `      TargetFunctionArn: !GetAtt Forwarder.Arn`,
      `      # NONE is deliberate: webhook callers (Telegram/Feishu) cannot SigV4-sign. Authenticity is`,
      `      # verified downstream by each channel (secret token / signature), exactly as on every host.`,
      `      AuthType: NONE`,
      ``,
      `  ForwarderUrlPermission:`,
      `    Type: AWS::Lambda::Permission`,
      `    Properties:`,
      `      FunctionName: !Ref Forwarder`,
      `      Action: lambda:InvokeFunctionUrl`,
      `      Principal: "*"`,
      `      FunctionUrlAuthType: NONE`,
      ``,
      `  # Function URLs created after Oct 2025 require lambda:InvokeFunction IN ADDITION to`,
      `  # lambda:InvokeFunctionUrl for public (NONE) access — with only the first, every request 403s`,
      `  # (found by the first real deploy). InvokedViaFunctionUrl scopes it to URL traffic: without it`,
      `  # the bare * principal would also let any AWS principal call the Lambda API directly, bypassing`,
      `  # the Function URL event shape to forge internal events.`,
      `  ForwarderInvokePermission:`,
      `    Type: AWS::Lambda::Permission`,
      `    Properties:`,
      `      FunctionName: !Ref Forwarder`,
      `      Action: lambda:InvokeFunction`,
      `      Principal: "*"`,
      `      InvokedViaFunctionUrl: true`,
    );
    if (input.selfSchedule) {
      lines.push(
        ``,
        `  # The role the wake-poke schedules assume to invoke the forwarder. Its policy names the`,
        `  # function by CONSTRUCTED arn (not !Ref) — the forwarder's env references this role, so a`,
        `  # !Ref back would be a circular dependency.`,
        `  WakeSchedulerRole:`,
        `    Type: AWS::IAM::Role`,
        `    Properties:`,
        `      AssumeRolePolicyDocument:`,
        `        Version: "2012-10-17"`,
        `        Statement:`,
        `          - Effect: Allow`,
        `            Principal: { Service: scheduler.amazonaws.com }`,
        `            Action: sts:AssumeRole`,
        `            Condition:`,
        `              StringEquals: { aws:SourceAccount: !Ref AWS::AccountId }`,
        `      Policies:`,
        `        - PolicyName: poke-forwarder`,
        `          PolicyDocument:`,
        `            Version: "2012-10-17"`,
        `            Statement:`,
        `              - Effect: Allow`,
        `                Action: lambda:InvokeFunction`,
        `                Resource: ${forwarderFnArn}`,
      );
    }
  }

  if (translated.length > 0) {
    lines.push(
      ``,
      `  SchedulerRole:`,
      `    Type: AWS::IAM::Role`,
      `    Properties:`,
      `      AssumeRolePolicyDocument:`,
      `        Version: "2012-10-17"`,
      `        Statement:`,
      `          - Effect: Allow`,
      `            Principal: { Service: scheduler.amazonaws.com }`,
      `            Action: sts:AssumeRole`,
      `            Condition:`,
      `              StringEquals: { aws:SourceAccount: !Ref AWS::AccountId }`,
      `      Policies:`,
      `        - PolicyName: fire-forwarder`,
      `          PolicyDocument:`,
      `            Version: "2012-10-17"`,
      `            Statement:`,
      `              - Effect: Allow`,
      `                Action: lambda:InvokeFunction`,
      `                Resource: !GetAtt Forwarder.Arn`,
    );
    for (const { fact, expression } of translated) {
      lines.push(
        ``,
        `  Schedule${logicalId(fact.name)}:`,
        `    Type: AWS::Scheduler::Schedule`,
        `    Properties:`,
        `      Name: ${scheduleResourceName(input.name, fact.name)}`,
        `      ScheduleExpression: ${expression}`,
        `      ScheduleExpressionTimezone: ${fact.tz ?? "Etc/UTC"}`,
        `      FlexibleTimeWindow: { Mode: "OFF" }`,
        `      Target:`,
        `        Arn: !GetAtt Forwarder.Arn`,
        `        RoleArn: !GetAtt SchedulerRole.Arn`,
        `        # <aws.scheduler.scheduled-time> = the slot instant — the container's idempotency key`,
        `        # (EventBridge delivery is at-least-once; a duplicate slot must not double-fire).`,
        `        Input: ${yamlSingleQuote(JSON.stringify({ scheduleFire: { name: fact.name, slot: "<aws.scheduler.scheduled-time>" } }))}`,
      );
    }
  }

  lines.push(``, `Outputs:`, `  RuntimeArn:`, `    Value: !GetAtt Runtime.AgentRuntimeArn`);
  if (needsFunctionUrl) {
    lines.push(`  ForwarderUrl:`, `    Value: !GetAtt ForwarderUrl.FunctionUrl`);
  }
  return `${lines.join("\n")}\n`;
}

/** Compute the AgentCore deploy plan from the resolved definition. */
export function planAgentcoreDeploy(input: AgentcorePlanInput): AgentcorePlan {
  const { name, channels } = input;
  const stack = `fastagent-${name}`;
  const repo = `fastagent/${name}`;
  const prefix = input.agentPrefix;

  // Translate every schedule; the ones EventBridge cannot express become explicit runbook warnings —
  // a schedule silently missing from the template would be the worst failure mode (nothing ever fires).
  const translated: { fact: ScheduleFact; expression: string }[] = [];
  const untranslatable: { name: string; reason: string }[] = [];
  for (const fact of input.schedules) {
    const result = toEventBridgeCron(fact.cron);
    if ("expression" in result) translated.push({ fact, expression: result.expression });
    else untranslatable.push({ name: fact.name, reason: result.error });
  }

  // Identifier collisions: the author-side → AWS-side name mappings are lossy (logical ids strip
  // punctuation; parameter names collapse underscores), so two DISTINCT legal inputs can land on one
  // CloudFormation key — which would generate a silently wrong stack. Fail visibly at plan time; a
  // rename is the fix (a hash-mangled allocator would trade readability for an edge case).
  const logicalIds = new Map<string, string>();
  for (const { fact } of translated) {
    const id = `Schedule${logicalId(fact.name)}`;
    const clash = logicalIds.get(id);
    if (clash !== undefined) {
      throw new Error(
        `schedules "${clash}" and "${fact.name}" collapse to the same CloudFormation logical id (${id}) — rename one`,
      );
    }
    logicalIds.set(id, fact.name);
  }
  const paramNames = new Map<string, string>();
  for (const s of deploymentSecrets(input.modelAuth, channels, input.extraSecrets)) {
    const p = cfnParamName(s.name);
    const clash = paramNames.get(p);
    if (clash !== undefined && clash !== s.name) {
      throw new Error(
        `secrets "${clash}" and "${s.name}" collapse to the same CloudFormation parameter (${p}) — rename one`,
      );
    }
    paramNames.set(p, s.name);
  }

  // Every forwarder needs its authenticated Function URL to refresh S3 snapshot capabilities during
  // a long turn. Without route channels, ordinary HTTP paths are rejected before AgentCore is invoked.
  const needsForwarder = input.routeChannels.length > 0 || translated.length > 0 || input.selfSchedule;
  const needsFunctionUrl = needsForwarder;
  const artifacts: Artifact[] = [
    { path: `${prefix}${TEMPLATE_FILE}`, content: template(input, translated) },
    ...(needsForwarder ? [{ path: `${prefix}${FORWARDER_FILE}`, content: forwarderSource() }] : []),
    ...containerArtifacts(input),
  ];

  const secrets = deploymentSecrets(input.modelAuth, channels, input.extraSecrets);
  const requiredSecrets = secrets.filter((s) => s.required);
  const optionalSecrets = secrets.filter((s) => !s.required);
  const paramHint = (list: typeof secrets): string => list.map((s) => `${cfnParamName(s.name)}=<value>`).join(" ");

  const image = `<account-id>.dkr.ecr.<region>.amazonaws.com/${repo}:<tag>`;
  const bucketHint = stateBucketName(name, "<account-id>");
  const runbook: string[] = [
    `# Deploy "${name}" to AWS Bedrock AgentCore. ${prefix}${TEMPLATE_FILE} / Dockerfile(.dockerignore) are generated above.`,
    `# Prereqs: AWS CLI v2 with credentials + a region where AgentCore is available, and Docker with buildx`,
    `# (the image MUST be linux/arm64 — the one host whose build runs on YOUR machine, not remotely).`,
    ``,
    `# 1. ECR repository + the deployment bucket (one-time; skip what exists). The bucket lives OUTSIDE`,
    `#    the stack on purpose: it holds the agent's state snapshot, which must survive a delete-stack.`,
    `aws ecr create-repository --repository-name ${repo}`,
    `aws s3api create-bucket --bucket ${bucketHint} --region us-east-1   # us-east-1 ONLY`,
    `aws s3api create-bucket --bucket ${bucketHint} --region <region> \\   # every OTHER region`,
    `  --create-bucket-configuration LocationConstraint=<region>`,
    `aws s3api put-public-access-block --bucket ${bucketHint} \\`,
    `  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true`,
    ``,
    ...(needsForwarder
      ? [
          `# 1b. Package the forwarder and upload it. Name the object by its CONTENT (a hash/date):`,
          `#     CloudFormation rolls the function only when the ForwarderS3Key VALUE changes.`,
          `(cd ${prefix}lambda && zip -q forwarder.zip index.js)`,
          `aws s3 cp ${prefix}lambda/forwarder.zip s3://${bucketHint}/forwarder/<hash>.zip`,
          ``,
        ]
      : []),
    `# 2. Build (linux/arm64) + push. Use a UNIQUE tag per deploy (a git sha / date): CloudFormation only`,
    `#    rolls the runtime when the ImageUri VALUE changes — re-pushing the same tag deploys nothing.`,
    `aws ecr get-login-password | docker login --username AWS --password-stdin <account-id>.dkr.ecr.<region>.amazonaws.com`,
    prefix
      ? `docker buildx build --platform linux/arm64 -f ${prefix}Dockerfile -t ${image} --push .`
      : `docker buildx build --platform linux/arm64 -t ${image} --push .`,
    ``,
    `# 3. Deploy the stack (runtime + ingress + schedules in one template). Secrets ride NoEcho parameters:`,
  ];
  if (requiredSecrets.length > 0) {
    runbook.push(
      `#    Required parameters:`,
      ...requiredSecrets.map((s) => `#      ${cfnParamName(s.name)}: ${s.hint}`),
    );
  }
  if (optionalSecrets.length > 0) {
    runbook.push(
      `#    Optional parameters (set only when the matching feature is configured):`,
      ...optionalSecrets.map((s) => `#      ${cfnParamName(s.name)}: ${s.hint}`),
    );
  }
  const wakeSecretHint = input.selfSchedule ? " FastagentWakeSecret=<any random string>" : "";
  if (input.selfSchedule) {
    runbook.push(`#      FastagentWakeSecret: the wake-alarm shared secret — any random string (\`--run\` mints one)`);
  }
  runbook.push(
    `aws cloudformation deploy --stack-name ${stack} --template-file ${prefix}${TEMPLATE_FILE} \\`,
    `  --capabilities CAPABILITY_IAM \\`,
    `  --parameter-overrides ImageUri=${image}${
      needsForwarder ? ` StateBucket=${bucketHint} ForwarderS3Key=forwarder/<hash>.zip` : ""
    }${requiredSecrets.length > 0 ? ` ${paramHint(requiredSecrets)}` : ""}${wakeSecretHint}`,
    ``,
    needsFunctionUrl
      ? `# 4. Read the outputs (the runtime ARN + callback URL; it serves webhooks only when configured):`
      : `# 4. Read the outputs (the runtime ARN — this topology has NO public URL: nothing outside AWS`,
    ...(needsFunctionUrl
      ? []
      : [`#    sends to it, so no Function URL is created and the agent is reachable only via SigV4).`]),
    `aws cloudformation describe-stacks --stack-name ${stack} --query "Stacks[0].Outputs"`,
    ``,
    `# 5. Tail the Runtime's application stdout/stderr (same fastagent messages + log level as locally).`,
    `#    Discovery resolves the per-endpoint log group from the stack's RuntimeArn:`,
    `fastagent logs agentcore --follow`,
    ...(needsForwarder
      ? [
          `# The ingress transport is a separate Lambda and therefore a separate log source:`,
          `fastagent logs agentcore --source forwarder --follow`,
        ]
      : []),
  );

  // Model-auth guidance mirrors the other hosts: an env key became a parameter above; OAuth/stored
  // can't be read at plan time — `--run` carries it as FastagentAuthSeed.
  if (!isEnvKey(input.modelAuth)) {
    runbook.push(
      ``,
      input.modelAuth === undefined
        ? `# Model auth: none found at the local auth path — pass --auth-path <file>, or \`--run\` carries it`
        : `# Model auth: your local auth is "${input.modelAuth}" — the plan can't read its value; \`--run\` carries it`,
      `#   as the FastagentAuthSeed parameter (base64 of auth.json), materialized on first boot.`,
    );
  }

  // Post-deploy webhook registration — same per-channel steps as every host, pointed at the
  // forwarder's Function URL (read from the stack outputs).
  const post: string[] = [];
  if (channels.includes("telegram")) {
    post.push(
      `# Register the Telegram webhook (default route POST /telegram; secret_token MUST equal TELEGRAM_SECRET_TOKEN):`,
      `curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \\`,
      `  -d url=<ForwarderUrl>/telegram -d secret_token=<TELEGRAM_SECRET_TOKEN>`,
    );
  }
  if (channels.includes("github")) {
    post.push(
      `# Set the GitHub webhook (repo Settings → Webhooks): Payload URL = <ForwarderUrl>/webhook,`,
      `#   content type application/json, secret = GITHUB_WEBHOOK_SECRET.`,
      `# NOTE: github turns are fire-and-forget with no replay — a compute reclaimed mid-review drops it`,
      `#   (the ping's HealthyBusy + time_of_last_update holds the session while turns run, but the 8 h compute ceiling is hard).`,
    );
  }
  if (channels.includes("slack")) {
    post.push(`# Set Slack Event Subscriptions → Request URL = <ForwarderUrl>/slack (scopes per channels/slack.ts).`);
  }
  for (const kind of ["feishu", "lark"] as const) {
    if (!channels.includes(kind)) continue;
    post.push(
      `# Set the ${kind === "feishu" ? "Feishu" : "Lark"} event Request URL (developer console → Events & Callbacks):`,
      `#   Request URL = <ForwarderUrl>/${kind} (the stack must be deployed when you save — the console`,
      `#   sends a challenge, which rides through the forwarder to the channel and back verbatim).`,
    );
  }
  if (post.length > 0) runbook.push(``, ...post);

  for (const u of untranslatable) {
    runbook.push(
      ``,
      `# WARNING: schedule "${u.name}" has NO EventBridge rule — ${u.reason}.`,
      `#   It will NOT fire on this deployment until you create an equivalent trigger yourself.`,
    );
  }
  if (input.selfSchedule) {
    runbook.push(
      ``,
      `# selfSchedule: the agent's wake-ups are EventBridge-backed — each pending wake-up is mirrored`,
      `#   (via the forwarder, authenticated by FastagentWakeSecret) into a self-deleting one-shot`,
      `#   schedule (fa-${name}-wk-*) that wakes the container at the right instant. Reliable even when`,
      `#   the compute is reclaimed. Caveat: only for wake-ups set through the INGRESS surface (chat`,
      `#   channels/schedules); a wake set inside a direct InvokeAgentRuntime session stays in that`,
      `#   session's own storage and fires only while that session is awake.`,
    );
  }

  runbook.push(
    ``,
    `# Invoke the agent programmatically (any session id ≥ 33 chars; the response streams as SSE):`,
    `aws bedrock-agentcore invoke-agent-runtime --agent-runtime-arn <RuntimeArn> \\`,
    `  --runtime-session-id "my-conversation-000000000000000000" \\`,
    `  --payload '{"kind":"invoke","session":"cli","text":"hello"}' --cli-binary-format raw-in-base64-out /dev/stdout`,
  );
  if (needsForwarder) {
    runbook.push(
      ``,
      `# After a REDEPLOY, stop the ingress session so the new image serves immediately — a live session`,
      `# keeps its old compute (and the OLD image) until ${IDLE_TIMEOUT_SECONDS}s idle / the 8 h compute ceiling`,
      `# (\`--run\` does this automatically):`,
      `aws bedrock-agentcore stop-runtime-session --agent-runtime-arn <RuntimeArn> \\`,
      `  --runtime-session-id "${ingressSessionId(name)}"`,
    );
  }
  runbook.push(
    ``,
    `# Redeploy = step 1b (new forwarder key, if its code changed) + step 2 with a NEW tag + step 3.`,
    `# STATE: ${MOUNT} is a LOCAL disk — AWS wipes it on every runtime version update (i.e. every`,
    `# deploy) and after 14 idle days. What survives is the S3 snapshot under s3://${bucketHint}/${STATE_KEY}:`,
    `# the container restores it on its first invocation and pushes it whenever work settles. Keep that`,
    `# bucket and the agent keeps its sessions, channel state and pending wake-ups across deploys;`,
    `# delete it and the agent starts blank. (A persistent MOUNT would need EFS + VPC mode + a NAT`,
    `# gateway for model/channel egress — see the template comment.)`,
    `# CREDENTIALS RIDE THAT SNAPSHOT TOO: FASTAGENT_SECRETS_DIR is ${SECRETS_DIR}, inside the state`,
    `# root, so an OAuth auth.json ROTATED on the box persists (a refresh token is single-use — without`,
    `# this the next microVM would re-seed the deploy-time copy and eventually fail to authenticate).`,
    `# The bucket is therefore credential storage: it is created with public access blocked and`,
    `# versioning on, and deleting it costs model access until the next deploy re-seeds.`,
  );

  return { artifacts, runbook, untranslatableSchedules: untranslatable };
}
