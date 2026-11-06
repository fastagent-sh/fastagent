import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapFeishuVerificationToken } from "../src/channels/feishu/bootstrap-token.ts";
import {
  FEISHU_AGENT_SCOPES,
  FEISHU_APP_CONFIG_SCOPE,
  FEISHU_MESSAGE_RECEIVE_EVENT,
  feishuAppAddons,
} from "../src/channels/feishu/setup-mode.ts";
import { registerFeishuApp } from "../src/channels/feishu/register-app.ts";
import { larkLauncherUrl } from "../src/channels/lark/setup.ts";
import { type SetUpChannelInput, setUpChannel } from "../src/cli/channel-setup.ts";
import type { Person } from "../src/cli/person.ts";
import { loadEnvValues } from "../src/value-file.ts";

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
vi.mock("../src/open-url.ts", () => ({ openExternalUrl: () => {} }));
vi.mock("../src/channels/feishu/bootstrap-token.ts", () => ({ bootstrapFeishuVerificationToken: vi.fn() }));
vi.mock("../src/channels/feishu/register-app.ts", async (original) => {
  const actual = await original<typeof import("../src/channels/feishu/register-app.ts")>();
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
let waits: { url: string; instructions: string; until?: number }[];
let afterwards: { instructions: string; url?: string }[];
let carried: number;

const person: Person = {
  waitsOn: (url, instructions, until) => {
    waits.push({ url, instructions, ...(until === undefined ? {} : { until }) });
  },
  carriesOn: () => {
    carried++;
  },
  afterwards: (instructions, url) => {
    afterwards.push({ instructions, ...(url === undefined ? {} : { url }) });
  },
};

beforeEach(async () => {
  platform = { granted: WEBHOOK_SCOPES, config: "missing" };
  dir = await mkdtemp(join(tmpdir(), "fa-feishu-setup-"));
  file = join(dir, ".secrets", ".env");
  said = [];
  waits = [];
  afterwards = [];
  carried = 0;
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
    ...extra,
  });

const written = async () => (await readFile(file, "utf8").catch(() => "")) as string;
const requested = (url: string | undefined): string[] => new URL(url ?? "").searchParams.get("q")?.split(",") ?? [];
const urlIn = (text: string): string => text.match(/https:\/\/\S+/)?.[0] as string;

/** The page a setup sent its person to, once it is up. */
const page = (index = 0) =>
  vi.waitFor(() => {
    expect(waits.length).toBeGreaterThan(index);
    return waits[index] as (typeof waits)[number];
  });
const paste = async (url: string, fields: Record<string, string>) =>
  (await realFetch(url, { method: "POST", body: new URLSearchParams(fields) })).text();
const pair = { LARK_APP_ID: "cli_lark", LARK_APP_SECRET: "good-secret" };

describe("what is left once an app has its credentials: the permission check and the publish", () => {
  const held = "FEISHU_APP_ID=cli_a\nFEISHU_APP_SECRET=s\n";
  async function leftAfter(way: "webhook" | "connection", kind: "feishu" | "lark" = "feishu") {
    const prefix = kind.toUpperCase();
    await mkdir(join(dir, ".secrets"), { recursive: true });
    await writeFile(
      file,
      held.replaceAll("FEISHU", prefix) + (way === "webhook" ? `${prefix}_VERIFICATION_TOKEN=t\n` : ""),
    );
    return (await setup(kind, way)).after;
  }

  it("a Feishu app holding every agent scope is told only to publish: scan-to-create leaves it on a long connection", async () => {
    platform.granted = AGENT_SCOPES;
    expect(await leftAfter("connection")).toEqual([
      "CREATE + PUBLISH a version: https://open.feishu.cn/app/cli_a/version",
    ]);
    expect(said.join("\n")).toContain("granted");
  });

  it("a Lark app is told to choose the long connection and subscribe the event, then publish", async () => {
    platform.granted = AGENT_SCOPES;
    const lines = await leftAfter("connection", "lark");
    expect(lines).toEqual([expect.stringContaining("choose long connection")]);
    expect(lines[0]).toContain(`make sure ${FEISHU_MESSAGE_RECEIVE_EVENT} is subscribed`);
    expect(lines[0]).toContain("https://open.larksuite.com/app/cli_a/event?tab=safe");
    expect(lines[0]).toContain("CREATE + PUBLISH a version: https://open.larksuite.com/app/cli_a/version");
  });

  it("names each missing scope with what it costs, and links the console pre-filled with exactly those", async () => {
    // A tenant can withhold a scope the confirm page asked for (its approval policy), or an app made by hand never
    // had it. A listed but ungranted scope is missing too.
    platform.granted = AGENT_SCOPES.filter((scope) => scope !== "im:chat.members:read");
    const lines = await leftAfter("connection");
    expect(lines[0]).toContain(
      "im:chat.members:read: without it people in the discussion the agent reads are shown by open_id",
    );
    expect(lines[0]).toContain("Tick and enable them");
    const link = urlIn(lines[0] as string);
    expect(new URL(link).pathname).toBe("/app/cli_a/auth");
    expect(requested(link)).toEqual(["im:chat.members:read"]);
    expect(lines[1]).toContain("after the permission work above, CREATE + PUBLISH");
  });

  it("a broader scope satisfies a narrower one, and a user-type entry satisfies nothing", async () => {
    platform.granted = [
      ...AGENT_SCOPES.filter((scope) => scope !== "im:message:readonly" && scope !== "im:chat.members:read"),
      { name: "im:message", type: "tenant" },
      { name: "im:chat.members:read", type: "user" },
    ];
    const lines = await leftAfter("connection", "lark");
    expect(requested(urlIn(lines[0] as string))).toEqual(["im:chat.members:read"]);
    expect(new URL(urlIn(lines[0] as string)).origin).toBe("https://open.larksuite.com");
  });

  it("a webhook app also needs the app-config scope, which a long connection never asks for", async () => {
    platform.granted = AGENT_SCOPES;
    const webhook = await leftAfter("webhook");
    expect(webhook[0]).toContain(`${FEISHU_APP_CONFIG_SCOPE}: without it the Verification Token`);
    expect(requested(urlIn(webhook[0] as string))).toEqual([FEISHU_APP_CONFIG_SCOPE]);
    expect(await leftAfter("connection")).toHaveLength(1);
  });

  it("an unreadable permission list is said, with the console link for every agent scope", async () => {
    platform.granted = "refused";
    const lines = await leftAfter("connection");
    expect(lines[0]).toMatch(/could not read the feishu app's permissions/);
    expect(requested(urlIn(lines[0] as string))).toEqual(AGENT_SCOPES);
  });
});

describe("a Feishu app is created by scan-to-create", () => {
  it("waits on the person to confirm it, carries on once they have, keeps the credentials, and leaves them publishing it", async () => {
    platform.granted = AGENT_SCOPES;
    const outcome = await setup("feishu", "connection", { person });
    expect(waits).toEqual([
      expect.objectContaining({
        instructions: expect.stringContaining("confirm the new Feishu app"),
        url: expect.stringContaining("https://open.feishu.cn/page/launcher?user_code=AB-CD"),
      }),
    ]);
    expect(carried).toBe(1);
    expect(outcome.written).toEqual(["FEISHU_APP_ID", "FEISHU_APP_SECRET"]);
    expect(outcome.after).toEqual(["CREATE + PUBLISH a version: https://open.feishu.cn/app/cli_new/version"]);
    expect(await written()).toMatch(/^FEISHU_APP_ID=cli_new$/m);
    // The link's own lapse (Feishu's expires_in), which can come before the ticket's.
    const until = (waits[0] as { until: number }).until;
    expect(until - Date.now()).toBeGreaterThan(590_000);
    expect(until - Date.now()).toBeLessThanOrEqual(600_000);
  });

  it("asks for the webhook's scopes, keeps the credentials before anything can fail, and creates no second app on a rerun", async () => {
    // The tenant has not approved the app-config scope yet, and its config cannot be read: the token cannot be had.
    platform.granted = AGENT_SCOPES;
    platform.config = "denied";
    prompts.answers.push(Symbol("walks away"));
    await expect(setup("feishu", "webhook")).rejects.toThrow("setup cancelled");
    expect(registerFeishuApp).toHaveBeenCalledWith(expect.objectContaining({ addons: feishuAppAddons("webhook") }));
    const values = loadEnvValues(file);
    expect(values.get("FEISHU_APP_ID")).toBe("cli_new");
    expect(values.get("FEISHU_APP_SECRET")).toBe("s3cret");
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    // Approved since: the same app is resumed, and its token read.
    platform.granted = WEBHOOK_SCOPES;
    platform.config = { verificationToken: "read-token" };
    const again = await setup("feishu", "webhook");
    expect(registerFeishuApp).toHaveBeenCalledOnce();
    expect(again.written).toEqual(["FEISHU_VERIFICATION_TOKEN"]);
    expect(again.kept).toEqual(["FEISHU_APP_ID", "FEISHU_APP_SECRET"]);
    expect(loadEnvValues(file).get("FEISHU_VERIFICATION_TOKEN")).toBe("read-token");
    expect(bootstrapFeishuVerificationToken).not.toHaveBeenCalled();
  });

  it("a webhook the app-config scope blocks names the command that started the setup, and asks for the token", async () => {
    platform.granted = AGENT_SCOPES;
    platform.config = "denied";
    await mkdir(join(dir, ".secrets"), { recursive: true });
    await writeFile(file, "FEISHU_APP_ID=cli_1\nFEISHU_APP_SECRET=s\n");
    prompts.answers.push("pasted-token");
    const outcome = await setup("feishu", "webhook");
    expect(said.join("\n")).toContain(`have the permission approved and run \`fastagent deploy fly --run\` again`);
    expect(bootstrapFeishuVerificationToken).not.toHaveBeenCalled();
    expect(prompts.asked).toEqual(["Verification Token"]);
    expect(loadEnvValues(file).get("FEISHU_VERIFICATION_TOKEN")).toBe("pasted-token");
    expect(outcome.after.join("\n")).toContain("set the Request URL to https://<where it is served>/feishu");
  });

  it("captures the token through a throwaway webhook registration, and leaves the switch to webhook to be published", async () => {
    platform.config = "denied";
    await mkdir(join(dir, ".secrets"), { recursive: true });
    await writeFile(file, "FEISHU_APP_ID=cli_1\nFEISHU_APP_SECRET=s\n");
    vi.mocked(bootstrapFeishuVerificationToken).mockResolvedValue("captured-token");
    const outcome = await setup("feishu", "webhook");
    expect(loadEnvValues(file).get("FEISHU_VERIFICATION_TOKEN")).toBe("captured-token");
    expect(prompts.asked).toEqual([]);
    expect(outcome.after).toEqual([
      expect.stringContaining(
        "takes effect on publish: CREATE + PUBLISH a version: https://open.feishu.cn/app/cli_1/version",
      ),
    ]);
  });
});

describe("a Lark app's credentials are pasted, and checked as a pair", () => {
  it("links the launcher with what the channel needs on the app it creates", () => {
    const link = new URL(larkLauncherUrl("connection"));
    expect(`${link.origin}${link.pathname}`).toBe("https://open.larksuite.com/page/launcher");
    expect(link.searchParams.get("from")).toBe("backend_oneclick");
    const addons = JSON.parse(
      gunzipSync(Buffer.from(link.searchParams.get("addons") as string, "base64url")).toString(),
    );
    // The same request Feishu's scan-to-create carries: one place says what a Feishu or Lark app needs.
    expect(addons).toEqual(feishuAppAddons("connection"));
  });

  it("at a terminal, the App ID is asked in the open and the Secret hidden, and both go through one check", async () => {
    platform.granted = AGENT_SCOPES;
    platform.goodSecret = "good-secret";
    prompts.answers.push("cli_lark", "wrong", "cli_lark", "good-secret");
    const outcome = await setup("lark", "connection");
    // A refused pair is asked again whole: the ID may be the wrong half.
    expect(prompts.asked).toEqual(["App ID", "App Secret", "App ID", "App Secret"]);
    expect(outcome.written).toEqual(["LARK_APP_ID", "LARK_APP_SECRET"]);
    expect(loadEnvValues(file).get("LARK_APP_SECRET")).toBe("good-secret");
  });

  it("on a page: Lark's refusal is shown and nothing is kept; the right pair is, then the page is gone", async () => {
    platform.granted = AGENT_SCOPES;
    platform.goodSecret = "good-secret";
    const run = setup("lark", "connection", { person });
    const first = await page();
    expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/setup\/[0-9a-f]{48}$/);
    expect(first.instructions).toContain("App ID and App Secret");
    expect(carried).toBe(0); // the run waits on them until the pair is good
    const html = await (await realFetch(first.url)).text();
    expect(html).toContain("backend_oneclick");
    expect(html).toContain("addons=");

    const refused = await paste(first.url, { LARK_APP_ID: "cli_lark", LARK_APP_SECRET: "wrong" });
    expect(refused).toContain("Lark refused that App ID or Secret.");
    expect(refused).not.toContain("wrong");
    expect(await written()).not.toContain("LARK_APP_SECRET");

    expect(await paste(first.url, pair)).toContain("Lark connected");
    const outcome = await run;
    expect(outcome.written).toEqual(["LARK_APP_ID", "LARK_APP_SECRET"]);
    expect(await written()).toContain("LARK_APP_SECRET=good-secret");
    expect(carried).toBe(1);
    await expect(realFetch(first.url)).rejects.toThrow();
    // What is left is the person's step in the console, not a value to type anywhere.
    expect(outcome.after).toEqual([expect.stringContaining("https://open.larksuite.com/app/cli_lark/event?tab=safe")]);
  });

  it("tells a remote user how to reach the page, without asking for a file edit", async () => {
    platform.granted = AGENT_SCOPES;
    const run = setup("lark", "connection", { person });
    const first = await page();
    const port = new URL(first.url).port;
    expect(first.instructions).toContain(`ssh -N -L ${port}:127.0.0.1:${port} user@host`);
    expect(first.instructions).not.toContain(".env");
    await paste(first.url, pair);
    await run;
  });

  it.each([
    {
      name: "network timeout",
      response: () => {
        throw new Error("network timeout");
      },
    },
    { name: "rate limited", response: () => Response.json({ code: 10003, msg: "rate limited" }, { status: 429 }) },
    {
      name: "platform outage",
      response: () => Response.json({ code: 10003, msg: "platform outage" }, { status: 503 }),
    },
    { name: "unexpected response", response: () => new Response("not json") },
  ])("does not take $name for a refused credential: it ends the setup", async ({ response }) => {
    platform.credentials = response;
    const run = setup("lark", "connection", { person });
    run.catch(() => {});
    const html = await paste((await page()).url, pair);
    expect(html).toContain("Setup stopped");
    expect(html).not.toContain("Lark refused that App ID or Secret");
    await expect(run).rejects.toBeInstanceOf(Error);
    expect(await written()).toBe("");
  });

  it("keeps a held pair that Lark still accepts, and asks again for one it refuses", async () => {
    platform.granted = AGENT_SCOPES;
    platform.goodSecret = "good-secret";
    await mkdir(join(dir, ".secrets"), { recursive: true });
    await writeFile(file, "LARK_APP_ID=cli_lark\nLARK_APP_SECRET=good-secret\n");
    expect((await setup("lark", "connection")).kept).toEqual(["LARK_APP_ID", "LARK_APP_SECRET"]);
    expect(prompts.asked).toEqual([]);

    await writeFile(file, "LARK_APP_ID=cli_lark\nLARK_APP_SECRET=rotated\n");
    prompts.answers.push("cli_lark", "good-secret");
    expect((await setup("lark", "connection")).written).toEqual(["LARK_APP_ID", "LARK_APP_SECRET"]);
    expect(said.join("\n")).toContain("is refused (Lark refused that App ID or Secret.) — asking for another");
  });
});

describe("a Lark webhook's Verification Token", () => {
  beforeEach(() => {
    platform.goodSecret = "good-secret";
  });

  it("is kept with the pair before anything is captured, and a token held for another app is never kept with it", async () => {
    await mkdir(join(dir, ".secrets"), { recursive: true });
    await writeFile(file, "LARK_VERIFICATION_TOKEN=orphaned-token\n");
    platform.config = "denied";
    vi.mocked(bootstrapFeishuVerificationToken).mockImplementationOnce(async () => {
      const saved = await written();
      expect(saved).toContain("LARK_APP_ID=cli_lark");
      expect(saved).toContain("LARK_APP_SECRET=good-secret");
      return "automatic-token";
    });
    const run = setup("lark", "webhook", { person });
    expect(await paste((await page()).url, pair)).toContain("Lark connected");
    const outcome = await run;
    expect(bootstrapFeishuVerificationToken).toHaveBeenCalledOnce();
    expect(outcome.written).toEqual(["LARK_APP_ID", "LARK_APP_SECRET", "LARK_VERIFICATION_TOKEN"]);
    expect(loadEnvValues(file).get("LARK_VERIFICATION_TOKEN")).toBe("automatic-token");
    expect(waits).toHaveLength(1);
  });

  it("is pasted on a page of its own where the config API is not there, then the whole app is reused on a rerun", async () => {
    platform.config = "missing";
    const run = setup("lark", "webhook", { person });
    expect(await paste((await page()).url, pair)).toContain("Lark connected");
    const tokenPage = await page(1);
    expect(tokenPage.instructions).toContain("Verification Token");
    const form = await (await realFetch(tokenPage.url)).text();
    expect(form).toContain('name="LARK_VERIFICATION_TOKEN"');
    expect(form).toContain("cli_lark/event");
    expect(await written()).toContain("LARK_APP_SECRET=good-secret");
    expect(await paste(tokenPage.url, { LARK_VERIFICATION_TOKEN: " " })).toContain("Verification Token is needed.");
    expect(await paste(tokenPage.url, { LARK_VERIFICATION_TOKEN: "manual-token" })).toContain("Lark connected");
    const outcome = await run;
    expect(loadEnvValues(file).get("LARK_VERIFICATION_TOKEN")).toBe("manual-token");
    expect(outcome.after.join("\n")).toContain("set the Request URL to https://<where it is served>/lark");
    expect(said.join("\n")).toContain("returned HTTP 404 for the application-config API");

    await setup("lark", "webhook", { person });
    expect(waits).toHaveLength(2);
    expect(bootstrapFeishuVerificationToken).not.toHaveBeenCalled();
  });

  it("a capture that fails is said, and the token is asked for instead", async () => {
    platform.config = "denied";
    vi.mocked(bootstrapFeishuVerificationToken).mockRejectedValue(new Error("tunnel unavailable"));
    await mkdir(join(dir, ".secrets"), { recursive: true });
    await writeFile(file, "LARK_APP_ID=cli_lark\nLARK_APP_SECRET=good-secret\n");
    prompts.answers.push("typed-token");
    await setup("lark", "webhook");
    expect(said.join("\n")).toContain("could not capture the Verification Token: Error: tunnel unavailable");
    expect(loadEnvValues(file).get("LARK_VERIFICATION_TOKEN")).toBe("typed-token");
  });

  it.skipIf(process.getuid?.() === 0)("fails before any capture when keeping the verified pair fails", async () => {
    await mkdir(join(dir, ".secrets"), { recursive: true, mode: 0o500 });
    const run = setup("lark", "webhook", { person });
    run.catch(() => {});
    const html = await paste((await page()).url, pair);
    expect(html).toContain("Setup stopped");
    expect(html).not.toContain("Lark refused");
    await expect(run).rejects.toBeInstanceOf(Error);
    expect(bootstrapFeishuVerificationToken).not.toHaveBeenCalled();
  });
});

describe("Feishu app creation addons", () => {
  it("asks for every agent scope on the confirm page, so a tenant that grants them needs no console visit", () => {
    for (const way of ["webhook", "connection"] as const) {
      expect(feishuAppAddons(way).scopes.tenant).toEqual(expect.arrayContaining(AGENT_SCOPES));
    }
  });

  it("asks for the app-config scope only for webhook, the one way that uses it", () => {
    // A tenant that reviews it holds the app's whole first version in review: a long connection would wait on an
    // admin for a scope it never calls.
    expect(feishuAppAddons("webhook").scopes.tenant).toContain(FEISHU_APP_CONFIG_SCOPE);
    expect(feishuAppAddons("connection").scopes.tenant).not.toContain(FEISHU_APP_CONFIG_SCOPE);
  });

  it("subscribes the inbound message event: an app that cannot hear one serves nothing", () => {
    expect(feishuAppAddons("connection").events.items.tenant).toContain(FEISHU_MESSAGE_RECEIVE_EVENT);
  });
});
