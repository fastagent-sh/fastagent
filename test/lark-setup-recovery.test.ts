import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { onboardFeishuCloudApp } from "../src/cli/add-feishu.ts";
import type { Person } from "../src/cli/person.ts";
import { createFeishuApi } from "../src/channels/feishu/feishu-api.ts";
import { bootstrapFeishuVerificationToken } from "../src/channels/feishu/bootstrap-token.ts";
import { dotEnvPath } from "../src/value-file.ts";
import { AGENT_ENVIRONMENT_ENV } from "../src/paths.ts";

vi.mock("../src/channels/feishu/bootstrap-token.ts", () => ({ bootstrapFeishuVerificationToken: vi.fn() }));
const browserFetch = globalThis.fetch;
let dir: string;
let waits: { url: string; instructions: string }[];
let person: Person;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fa-lark-recovery-"));
  waits = [];
  person = {
    waitsOn: (url, instructions) => {
      waits.push({ url, instructions });
    },
    carriesOn() {},
    afterwards() {},
  };
  vi.stubEnv("FASTAGENT_SECRETS_DIR", "");
  vi.stubEnv(AGENT_ENVIRONMENT_ENV, "production");
  vi.mocked(bootstrapFeishuVerificationToken).mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = String(input);
    if (url.includes("tenant_access_token")) return Response.json({ code: 0, tenant_access_token: "T", expire: 7200 });
    if (url.includes("/application/v6/scopes")) return Response.json({ code: 0, data: { scopes: [] } });
    // The real API adapter classifies this as a missing config route.
    if (url.includes("/application/v6/applications/")) return new Response("not found", { status: 404 });
    throw new Error(`unexpected request ${url}`);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

function setup(ingress: "connection" | "webhook" = "webhook") {
  return onboardFeishuCloudApp(dir, "lark", ingress, "fastagent deploy fly --run --json", person);
}

async function page(index = 0) {
  return vi.waitFor(() => {
    expect(waits.length).toBeGreaterThan(index);
    return waits[index]!;
  });
}

async function paste(url: string, fields = { app_id: "cli_production", app_secret: "secret" }) {
  return (await browserFetch(url, { method: "POST", body: new URLSearchParams(fields) })).text();
}

it("persists a production pair before bootstrap fails, and reruns without collecting it again", async () => {
  await mkdir(join(dir, ".secrets", "production"), { recursive: true });
  await writeFile(dotEnvPath(dir), "LARK_VERIFICATION_TOKEN=orphaned-token\n", { mode: 0o600 });
  const failure = new Error("tunnel unavailable");
  vi.mocked(bootstrapFeishuVerificationToken).mockImplementationOnce(async () => {
    const saved = await readFile(dotEnvPath(dir), "utf8");
    expect(saved).toContain("LARK_APP_ID=cli_production");
    expect(saved).toContain("LARK_APP_SECRET=secret");
    expect(saved).not.toContain("orphaned-token");
    expect((await stat(dotEnvPath(dir))).mode & 0o077).toBe(0);
    throw failure;
  });
  const result = setup().then(
    () => undefined,
    (error: unknown) => error,
  );
  const first = await page();
  expect(await paste(first.url)).toContain("credentials verified");
  expect(await result).toBe(failure);
  expect(dotEnvPath(dir)).toBe(join(dir, ".secrets", "production", ".env"));
  await expect(readFile(join(dir, ".secrets", ".env"))).rejects.toMatchObject({ code: "ENOENT" });

  vi.mocked(bootstrapFeishuVerificationToken).mockResolvedValueOnce("automatic-token");
  await expect(setup()).resolves.toMatchObject({
    LARK_APP_ID: "cli_production",
    LARK_VERIFICATION_TOKEN: "automatic-token",
  });
  expect(waits).toHaveLength(1);
});

it("collects and saves a manual webhook token on a second page, then reuses the whole app on rerun", async () => {
  vi.mocked(bootstrapFeishuVerificationToken).mockImplementationOnce(async () => {
    await createFeishuApi({
      kind: "lark",
      baseUrl: "https://open.larksuite.com",
      appId: "cli_production",
      appSecret: "secret",
    }).getAppConfig("cli_production");
    throw new Error("expected config API to reject");
  });
  const result = setup();
  expect(await paste((await page()).url)).toContain("credentials verified");
  const tokenPage = await page(1);
  expect(tokenPage.instructions).toContain("Verification Token");
  const form = await (await browserFetch(tokenPage.url)).text();
  expect(form).toContain('name="verification_token"');
  expect(form).toContain("cli_production/event");
  expect(await readFile(dotEnvPath(dir), "utf8")).toContain("LARK_APP_SECRET=secret");
  const blank = await browserFetch(tokenPage.url, {
    method: "POST",
    body: new URLSearchParams({ verification_token: " " }),
  });
  expect(await blank.text()).toContain("Verification Token is required.");
  const response = await browserFetch(tokenPage.url, {
    method: "POST",
    body: new URLSearchParams({ verification_token: "manual-token" }),
  });
  expect(await response.text()).toContain("Verification Token saved");
  await expect(result).resolves.toMatchObject({ LARK_VERIFICATION_TOKEN: "manual-token" });
  expect(await readFile(dotEnvPath(dir), "utf8")).toContain("LARK_VERIFICATION_TOKEN=manual-token");
  await setup();
  expect(waits).toHaveLength(2);
  expect(bootstrapFeishuVerificationToken).toHaveBeenCalledOnce();
});

it("fails before webhook setup when saving the verified pair fails", async () => {
  const result = setup().then(
    () => undefined,
    (error: unknown) => error,
  );
  const first = await page();
  await mkdir(join(dir, ".secrets"), { recursive: true });
  await writeFile(join(dir, ".secrets", "production"), "not a directory");
  const html = await paste(first.url);
  expect(html).toContain("Setup stopped");
  expect(html).not.toContain("Lark refused");
  expect(await result).toBeInstanceOf(Error);
  expect(bootstrapFeishuVerificationToken).not.toHaveBeenCalled();
});

it("gives remote users port forwarding instructions without requesting a file edit", async () => {
  const result = setup("connection");
  const first = await page();
  const port = new URL(first.url).port;
  expect(first.instructions).toContain(`ssh -N -L ${port}:127.0.0.1:${port} user@host`);
  expect(first.instructions).not.toContain(".env");
  await paste(first.url);
  await result;
});

it("reports the dev/production conflict and fails the run without saving the pair", async () => {
  await mkdir(join(dir, ".secrets"));
  await writeFile(join(dir, ".secrets", ".env"), "LARK_APP_ID=cli_production\n");
  const result = setup().then(
    () => undefined,
    (error: unknown) => error,
  );
  const html = await paste((await page()).url);
  expect(html).toContain("dev and production use the same app");
  expect(html).not.toContain("Copy both again");
  expect(await result).toMatchObject({ message: expect.stringContaining("same app") });
  expect(bootstrapFeishuVerificationToken).not.toHaveBeenCalled();
  await expect(readFile(dotEnvPath(dir))).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([
  {
    name: "network timeout",
    response: () => {
      throw new Error("network timeout");
    },
  },
  { name: "rate limited", response: () => Response.json({ code: 10003, msg: "rate limited" }, { status: 429 }) },
  { name: "platform outage", response: () => Response.json({ code: 10003, msg: "platform outage" }, { status: 503 }) },
  { name: "unexpected response", response: () => new Response("not json") },
])("does not classify $name as a credential refusal", async ({ response }) => {
  vi.stubGlobal("fetch", response);
  const result = setup().then(
    () => undefined,
    (error: unknown) => error,
  );
  const html = await paste((await page()).url);
  expect(html).toContain("Setup stopped");
  expect(html).not.toContain("Lark refused that App ID or Secret");
  expect(await result).toBeInstanceOf(Error);
});
