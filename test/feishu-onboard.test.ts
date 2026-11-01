import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkAgentScopes, onboardFeishuCloudApp } from "../src/cli/add-feishu.ts";
import type { Person } from "../src/cli/person.ts";
import type { FeishuAppScope, FeishuApi } from "../src/channels/feishu/feishu-api.ts";
import {
  FEISHU_AGENT_SCOPES,
  FEISHU_APP_CONFIG_SCOPE,
  FEISHU_MESSAGE_RECEIVE_EVENT,
  feishuAppAddons,
} from "../src/channels/feishu/setup-mode.ts";

/** The real `fetch`, for reaching the setup's own page while the platform's API is a stand-in. */
const realFetch = globalThis.fetch;

const AGENT_SCOPES = FEISHU_AGENT_SCOPES.map((entry) => entry.request);
const grantedAll = (): FeishuAppScope[] => AGENT_SCOPES.map((name) => ({ name, grantStatus: 1, type: "tenant" }));

async function check(
  kind: "feishu" | "lark",
  listAppScopes: Pick<FeishuApi, "listAppScopes">["listAppScopes"],
  ingress: "webhook" | "websocket" = "websocket",
) {
  const notes: string[] = [];
  const opened: string[] = [];
  const result = await checkAgentScopes({
    kind,
    appId: "cli_a",
    apiBase: kind === "feishu" ? "https://open.feishu.cn" : "https://open.larksuite.com",
    ingress,
    api: { listAppScopes },
    note: (message) => notes.push(message),
    person: {
      waitsOn: () => {},
      carriesOn: () => {},
      afterwards: (instructions, url) => {
        notes.push(instructions);
        if (url !== undefined) opened.push(url);
      },
    },
  });
  return { result, notes: notes.join("\n"), opened };
}

/** The `q` of a pre-filled scope-request link, as the list of scopes it asks for. */
const requested = (url: string | undefined): string[] => new URL(url ?? "").searchParams.get("q")?.split(",") ?? [];

describe("Feishu/Lark agent permission check", () => {
  it("an app holding every agent scope is ready to publish, and no console page opens", async () => {
    const { result, notes, opened } = await check("feishu", async () => grantedAll());
    expect(result).toEqual({ publishReady: true, missing: [] });
    expect(notes).toContain("granted");
    expect(opened).toEqual([]);
  });

  it("names each missing scope with what it costs, and opens the console pre-filled with exactly those", async () => {
    // A tenant can withhold a scope the confirm page asked for (its approval policy), or an app made by hand never
    // had it; the author is sent to request precisely what is missing. A listed but ungranted scope is missing too.
    const scopes = grantedAll()
      .filter((scope) => scope.name !== "im:chat.members:read")
      .map((scope) => (scope.name === "im:message.group_msg" ? { ...scope, grantStatus: 0 } : scope));
    const { result, notes, opened } = await check("feishu", async () => scopes);
    expect(result).toEqual({ publishReady: false, missing: ["im:message.group_msg", "im:chat.members:read"] });
    expect(notes).toContain("im:message.group_msg: without it only @mentions arrive");
    expect(notes).toContain(
      "im:chat.members:read: without it people in the discussion the agent reads are shown by open_id",
    );
    expect(notes).toContain("Tick and enable them on that page");
    expect(opened).toHaveLength(1);
    expect(new URL(opened[0] as string).pathname).toBe("/app/cli_a/auth");
    expect(requested(opened[0])).toEqual(["im:message.group_msg", "im:chat.members:read"]);
  });

  it("a broader scope satisfies a narrower one, and a user-type entry satisfies nothing", async () => {
    const scopes: FeishuAppScope[] = [
      ...grantedAll().filter((scope) => scope.name !== "im:message:readonly" && scope.name !== "im:chat.members:read"),
      { name: "im:message", grantStatus: 1, type: "tenant" },
      { name: "im:chat.members:read", grantStatus: 1, type: "user" },
    ];
    const { opened } = await check("lark", async () => scopes);
    expect(requested(opened[0])).toEqual(["im:chat.members:read"]);
    expect(new URL(opened[0] as string).origin).toBe("https://open.larksuite.com");
  });

  it("a webhook app also needs the app-config scope, and its absence is named; a WebSocket app never asks for it", async () => {
    // The webhook bootstrap and every Request URL registration go through it: an app without it (a tenant that
    // reviews it, or one born WebSocket) is told so here rather than failing later as tunnel weather.
    const webhook = await check("feishu", async () => grantedAll(), "webhook");
    expect(webhook.result).toEqual({ publishReady: false, missing: [FEISHU_APP_CONFIG_SCOPE] });
    expect(webhook.notes).toContain(`${FEISHU_APP_CONFIG_SCOPE}: without it the Verification Token`);
    expect(requested(webhook.opened[0])).toEqual([FEISHU_APP_CONFIG_SCOPE]);

    const websocket = await check("feishu", async () => grantedAll(), "websocket");
    expect(websocket.result).toEqual({ publishReady: true, missing: [] });
  });

  it("an unreadable permission list is said, and the console opens with every agent scope", async () => {
    const { result, notes, opened } = await check("feishu", async () => {
      throw new Error("HTTP 403");
    });
    expect(result).toEqual({ publishReady: false, missing: [] });
    expect(notes).toMatch(/could not read the feishu app's permissions: Error: HTTP 403/);
    expect(requested(opened[0])).toEqual(AGENT_SCOPES);
  });
});

describe("a new Feishu app through a coding agent's person", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("waits on them to confirm it, carries on once they have, and leaves them publishing it", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "fa-feishu-person-")), "fastagent");
    await mkdir(join(dir, ".secrets"), { recursive: true });
    vi.stubEnv("FASTAGENT_SECRETS_DIR", "");
    vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input);
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
      if (url.includes("tenant_access_token"))
        return Response.json({ code: 0, tenant_access_token: "T", expire: 7200 });
      if (url.includes("/application/v6/scopes")) {
        const scopes = AGENT_SCOPES.map((scope_name) => ({ scope_name, grant_status: 1 }));
        return Response.json({ code: 0, data: { scopes } });
      }
      throw new Error(`unexpected request ${url}`);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const said: string[] = [];
    let until: number | undefined;
    const person: Person = {
      waitsOn: (url, instructions, lapses) => {
        until = lapses;
        said.push(`waits on: ${instructions} at ${url}`);
      },
      carriesOn: () => said.push("carries on"),
      afterwards: (instructions, url) => said.push(`afterwards: ${instructions} at ${url}`),
    };
    try {
      await onboardFeishuCloudApp(dir, "feishu", "websocket", "fastagent add feishu", person);
      expect(said).toEqual([
        expect.stringMatching(
          /^waits on: confirm the new Feishu app .* at https:\/\/open\.feishu\.cn\/.*user_code=AB-CD/,
        ),
        "carries on",
        expect.stringMatching(
          /^afterwards: .*CREATE \+ PUBLISH a version at https:\/\/open\.feishu\.cn\/app\/cli_new\/version$/,
        ),
      ]);
      expect(await readFile(join(dir, ".secrets", ".env"), "utf8")).toMatch(/^FEISHU_APP_ID=cli_new$/m);
      // The link's own lapse (Feishu's expires_in), which can come before the ticket's.
      expect((until as number) - Date.now()).toBeGreaterThan(590_000);
      expect((until as number) - Date.now()).toBeLessThanOrEqual(600_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("a Lark app through a coding agent's person", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /** A person whose steps are recorded, and an agent dir whose dev value file holds `env`. */
  async function larkSetup(env: string, options: { pasted?: boolean } = {}) {
    const dir = join(await mkdtemp(join(tmpdir(), "fa-lark-person-")), "fastagent");
    await mkdir(join(dir, ".secrets"), { recursive: true });
    await writeFile(join(dir, ".secrets", ".env"), env);
    vi.stubEnv("FASTAGENT_SECRETS_DIR", "");
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("tenant_access_token")) {
        // Lark takes the pasted pair only with its right Secret.
        const body = JSON.parse(String(init?.body ?? "{}")) as { app_secret?: string };
        if (options.pasted && body.app_secret !== "good-secret")
          return Response.json({ code: 10003, msg: "invalid param" });
        return Response.json({ code: 0, tenant_access_token: "T", expire: 7200 });
      }
      if (url.includes("/application/v6/scopes")) {
        const scopes = AGENT_SCOPES.map((scope_name) => ({ scope_name, grant_status: 1 }));
        return Response.json({ code: 0, data: { scopes } });
      }
      throw new Error(`unexpected request ${url}`);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const left: { instructions: string; url?: string }[] = [];
    const waited: { url: string; instructions: string }[] = [];
    let carriedOn = false;
    const person: Person = {
      waitsOn: (url, instructions) => waited.push({ url, instructions }),
      carriesOn: () => {
        carriedOn = true;
      },
      afterwards: (instructions, url) => left.push({ instructions, ...(url === undefined ? {} : { url }) }),
    };
    return { dir, person, lark: person, left, waited, carried: () => carriedOn };
  }

  it("leaves the person what they do on each page, not what the setup said it did", async () => {
    const { dir, person, left } = await larkSetup("LARK_APP_ID=cli_lark\nLARK_APP_SECRET=s\n");
    try {
      await onboardFeishuCloudApp(dir, "lark", "websocket", "fastagent add lark", person);
      expect(left).toEqual([
        {
          instructions: expect.stringMatching(/^in Events & Callbacks, choose long connection/),
          url: "https://open.larksuite.com/app/cli_lark/event?tab=safe",
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("the person pastes the App ID and Secret on a page of this machine's own; they are checked, then written", async () => {
    const { dir, left, waited, carried, lark } = await larkSetup("", { pasted: true });
    try {
      const run = onboardFeishuCloudApp(dir, "lark", "websocket", "fastagent add lark", lark);
      const page = await vi.waitFor(() => waited[0] ?? Promise.reject(new Error("not yet")));
      expect(page.instructions).toContain("App ID and App Secret");
      expect(page.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/lark\/credentials\//);
      expect(carried()).toBe(false); // the run waits on them until the pair is good

      const first = await realFetch(page.url);
      const html = await first.text();
      // The link to create the app carries what the channel needs, as `add feishu`'s does.
      expect(html).toContain("backend_oneclick");
      expect(html).toContain("addons=");

      // Lark refuses a wrong Secret: the page says so, and nothing is written.
      const refused = await realFetch(page.url, {
        method: "POST",
        body: new URLSearchParams({ app_id: "cli_pasted", app_secret: "wrong" }),
      });
      expect(await refused.text()).toContain("Lark refused that App ID or Secret.");
      expect(
        existsSync(join(dir, ".secrets", ".env")) ? await readFile(join(dir, ".secrets", ".env"), "utf8") : "",
      ).not.toContain("LARK_APP_SECRET");

      const taken = await realFetch(page.url, {
        method: "POST",
        body: new URLSearchParams({ app_id: "cli_pasted", app_secret: "good-secret" }),
      });
      expect(await taken.text()).toContain("Lark credentials verified");
      expect(await run).toMatchObject({ LARK_APP_ID: "cli_pasted", LARK_APP_SECRET: "good-secret" });
      expect(
        existsSync(join(dir, ".secrets", ".env")) ? await readFile(join(dir, ".secrets", ".env"), "utf8") : "",
      ).toContain("LARK_APP_SECRET=good-secret");
      expect(carried()).toBe(true);
      // The page is gone once it has done its job.
      await expect(realFetch(page.url)).rejects.toThrow();
      // What is left is the person's step in the console, not a value to type anywhere.
      expect(left).toEqual([
        {
          instructions: expect.stringMatching(/^in Events & Callbacks, choose long connection/),
          url: "https://open.larksuite.com/app/cli_pasted/event?tab=safe",
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Feishu app creation addons", () => {
  it("asks for every agent scope on the confirm page, so a tenant that grants them needs no console visit", () => {
    for (const ingress of ["webhook", "websocket"] as const) {
      expect(feishuAppAddons(ingress).scopes.tenant).toEqual(expect.arrayContaining(AGENT_SCOPES));
    }
  });

  it("asks for the app-config scope only for webhook, the one ingress that uses it", () => {
    // A tenant that reviews it holds the app's whole first version in review: a WebSocket app would wait on an
    // admin for a scope it never calls.
    expect(feishuAppAddons("webhook").scopes.tenant).toContain(FEISHU_APP_CONFIG_SCOPE);
    expect(feishuAppAddons("websocket").scopes.tenant).not.toContain(FEISHU_APP_CONFIG_SCOPE);
  });

  it("subscribes the inbound message event — an app that cannot hear one serves nothing", () => {
    expect(feishuAppAddons("websocket").events.items.tenant).toContain(FEISHU_MESSAGE_RECEIVE_EVENT);
  });
});
