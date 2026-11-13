import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapFeishuVerificationToken } from "../../../src/channels/feishu/bootstrap-token.ts";
import { FEISHU_AGENT_SCOPES, FEISHU_APP_CONFIG_SCOPE } from "../../../src/channels/feishu/setup-mode.ts";
import { registerFeishuApp } from "../../../src/channels/feishu/register-app.ts";
import { type SetUpChannelInput, setUpChannel } from "../../../src/cli/channel-setup.ts";

vi.mock("../../../src/git.ts", () => import("../../doubles/git-double.ts"));

/** The real `fetch`, for reaching a setup's own page while the platform's API is a stand-in. */
const realFetch = globalThis.fetch;

const prompts = vi.hoisted(() => ({ answers: [] as (string | symbol)[], asked: [] as string[] }));
vi.mock("@clack/prompts", () => {
  const answer = async ({ message }: { message: string }) => {
    prompts.asked.push(message);
    return prompts.answers.shift() ?? Symbol("cancel");
  };
  return {
    isCancel: (value: unknown) => typeof value === "symbol",
    password: answer,
    text: answer,
    log: { info: () => {}, error: () => {} },
  };
});
const opened: string[] = [];
vi.mock("../../../src/open-url.ts", () => ({ openExternalUrl: (url: string) => opened.push(url) }));
vi.mock("../../../src/channels/feishu/bootstrap-token.ts", () => ({ bootstrapFeishuVerificationToken: vi.fn() }));
vi.mock("../../../src/channels/feishu/register-app.ts", async (original) => {
  const actual = await original<typeof import("../../../src/channels/feishu/register-app.ts")>();
  return { ...actual, registerFeishuApp: vi.fn(actual.registerFeishuApp) };
});

const AGENT_SCOPES = FEISHU_AGENT_SCOPES.map((entry) => entry.request);
const WEBHOOK_SCOPES = [...AGENT_SCOPES, FEISHU_APP_CONFIG_SCOPE];

/** What the platform's Open API answers: the granted scopes, whether it takes a Secret, and its config route. */
interface Platform {
  granted: (string | { name: string; type: "tenant" | "user" })[] | "refused";
  /** The one Secret a pasted pair is accepted with; unset: every pair. */
  goodSecret?: string;
  /** Answer to reading the app's config: its token, a route that is not there, or a refusal. */
  config: { verificationToken: string } | "missing" | "denied";
  /** What the credential check meets instead of an answer (the network, an outage). */
  credentials?: () => Response;
}

let platform: Platform;
let dir: string;
let file: string;
let said: string[];

beforeEach(async () => {
  platform = { granted: WEBHOOK_SCOPES, config: "missing" };
  dir = await mkdtemp(join(tmpdir(), "fa-feishu-setup-"));
  file = join(dir, ".secrets", ".env");
  said = [];
  opened.length = 0;
  prompts.answers.length = 0;
  prompts.asked.length = 0;
  vi.stubEnv("FASTAGENT_SECRETS_DIR", "");
  vi.mocked(bootstrapFeishuVerificationToken).mockReset();
  vi.mocked(registerFeishuApp).mockClear();
  vi.spyOn(console, "error").mockImplementation((line) => void said.push(String(line)));
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("http://127.0.0.1")) return realFetch(input, init);
    if (url.includes("/oauth/v1/app/registration")) {
      return new URLSearchParams(String(init.body)).get("action") === "begin"
        ? Response.json({
            device_code: "dev-1",
            verification_uri_complete: "https://open.feishu.cn/page/launcher?user_code=AB-CD",
            interval: 0.001,
            expires_in: 600,
          })
        : Response.json({ client_id: "cli_new", client_secret: "s3cret", user_info: { tenant_brand: "feishu" } });
    }
    if (url.includes("tenant_access_token")) {
      if (platform.credentials) return platform.credentials();
      const secret = (JSON.parse(String(init.body ?? "{}")) as { app_secret?: string }).app_secret;
      if (platform.goodSecret !== undefined && secret !== platform.goodSecret) {
        return Response.json({ code: 10003, msg: "invalid param" });
      }
      return Response.json({ code: 0, tenant_access_token: "T", expire: 7200 });
    }
    if (url.includes("/application/v6/scopes")) {
      if (platform.granted === "refused") return Response.json({ code: 99991672, msg: "HTTP 403" }, { status: 403 });
      const scopes = platform.granted.map((scope) =>
        typeof scope === "string"
          ? { scope_name: scope, grant_status: 1 }
          : { scope_name: scope.name, grant_status: 1, scope_type: scope.type },
      );
      return Response.json({ code: 0, data: { scopes } });
    }
    if (url.includes("/application/v6/applications/")) {
      if (platform.config === "missing") return new Response("not found", { status: 404 });
      if (platform.config === "denied") return Response.json({ code: 99991672, msg: "permission denied" });
      return Response.json({
        code: 0,
        data: { app: { encryption: { verification_token: platform.config.verificationToken } } },
      });
    }
    throw new Error(`unexpected request ${url}`);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const setup = (kind: "feishu" | "lark", way: "webhook" | "connection", extra: Partial<SetUpChannelInput> = {}) =>
  setUpChannel({
    kind,
    agentDir: dir,
    file,
    way,
    dev: way === "connection",
    rerun: "fastagent deploy fly --run",
    interactive: true,
    ...extra,
  });

const written = async () => (await readFile(file, "utf8").catch(() => "")) as string;

describe("a Feishu app is created by scan-to-create", () => {
  it("opens the confirmation URL, keeps the credentials, and reports remaining publish steps", async () => {
    platform.granted = AGENT_SCOPES;
    const outcome = await setup("feishu", "connection");
    expect(opened).toEqual([expect.stringContaining("https://open.feishu.cn/page/launcher?user_code=AB-CD")]);
    expect(outcome).toEqual({
      status: "done",
      written: ["FEISHU_APP_ID", "FEISHU_APP_SECRET"],
      kept: [],
      after: ["CREATE + PUBLISH a version: https://open.feishu.cn/app/cli_new/version"],
    });
    expect(await written()).toMatch(/^FEISHU_APP_ID=cli_new$/m);
  });

  it("in non-interactive mode, returns missing app credentials without spawning a device flow and accepts pre-set credentials", async () => {
    const missing = await setup("feishu", "connection", { interactive: false });
    expect(registerFeishuApp).not.toHaveBeenCalled();
    expect(missing).toMatchObject({
      status: "need_user_action",
      steps: [
        expect.objectContaining({
          fields: [
            { name: "FEISHU_APP_ID", label: "FEISHU_APP_ID", secret: false },
            { name: "FEISHU_APP_SECRET", label: "FEISHU_APP_SECRET", secret: true },
          ],
        }),
      ],
    });

    // Webhook mode stops before evaluating Verification Token's app-id-dependent guide URL when App ID is absent.
    const webhookMissing = await setup("lark", "webhook", { interactive: false });
    expect(webhookMissing).toMatchObject({
      status: "need_user_action",
      steps: [{ label: "App ID and App Secret" }],
    });
    expect(JSON.stringify(webhookMissing)).not.toContain("undefined");

    platform.granted = AGENT_SCOPES;
    await mkdir(join(dir, ".secrets"), { recursive: true });
    await writeFile(file, "FEISHU_APP_ID=cli_preset\nFEISHU_APP_SECRET=sec\n");
    expect(await setup("feishu", "connection", { interactive: false })).toEqual({
      status: "done",
      written: [],
      kept: ["FEISHU_APP_ID", "FEISHU_APP_SECRET"],
      after: ["CREATE + PUBLISH a version: https://open.feishu.cn/app/cli_preset/version"],
    });
  });
});
