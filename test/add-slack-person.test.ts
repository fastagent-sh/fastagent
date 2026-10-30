/**
 * `add slack` through a coding agent's person: the App Configuration token pair is pasted on a page the setup server
 * shows, and the browser goes straight on to Slack's install page. The setup server is real; the tunnel and Slack's
 * config API are faked at their module boundary.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Person } from "../src/cli/person.ts";

const fake = vi.hoisted(() => ({ port: 0, createFails: undefined as string | undefined }));
vi.mock("../src/tunnel.ts", () => ({
  startCloudflareTunnel: vi.fn(async (port: number) => {
    fake.port = port;
    return { url: "https://t.example", close: vi.fn() };
  }),
}));
vi.mock("../src/open-url.ts", () => ({ openExternalUrl: vi.fn() }));
vi.mock("../src/channels/slack/config-api.ts", async (original) => {
  const { slackBotScopes } = await import("../src/channels/slack/manifest.ts");
  return {
    ...(await original<typeof import("../src/channels/slack/config-api.ts")>()),
    createSlackApp: vi.fn(async () => {
      if (fake.createFails) throw new Error(fake.createFails);
      return { appId: "A1", clientId: "C1", clientSecret: "cs", signingSecret: "sig" };
    }),
    exchangeSlackOAuthCode: vi.fn(async () => ({
      botToken: "xoxb-bot",
      appId: "A1",
      teamId: "T1",
      teamName: "Team",
      scopes: slackBotScopes(),
    })),
  };
});
const { onboardSlackInternalApp } = await import("../src/cli/add-slack.ts");

let target: string;
let stateRoot: string;

beforeEach(async () => {
  target = await mkdtemp(join(tmpdir(), "fa-slack-person-"));
  stateRoot = join(target, ".state");
  await mkdir(join(target, ".secrets"), { recursive: true });
  vi.stubEnv("FASTAGENT_SECRETS_DIR", "");
  vi.spyOn(console, "error").mockImplementation(() => {});
  fake.createFails = undefined;
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(target, { recursive: true, force: true });
});

/** A person whose steps are recorded; `waitedOn` is the latest page the run waits on them at. */
function recordingPerson() {
  const said: string[] = [];
  let waitedOn: string | undefined;
  const person: Person = {
    waitsOn: (url) => {
      waitedOn = url;
      said.push(`waits on ${new URL(url).host}${new URL(url).pathname}`);
    },
    carriesOn: () => said.push("carries on"),
    afterwards: (instructions) => said.push(`afterwards ${instructions}`),
  };
  return { person, said, waitedOn: () => waitedOn };
}

/** What the tunnel would reach: this machine's setup server. */
const local = (url: string) => url.replace("https://t.example", `http://127.0.0.1:${fake.port}`);

const paste = (url: string, access: string, refresh: string) =>
  fetch(url, {
    method: "POST",
    body: new URLSearchParams({ access, refresh }),
    redirect: "manual",
  });

/** The page the pasting browser lands on, read until it moves on (a redirect) or says why it cannot. */
async function nextPage(url: string): Promise<Response> {
  return vi.waitFor(async () => {
    const response = await fetch(url, { redirect: "manual" });
    const text = response.status === 200 ? await response.clone().text() : "";
    if (text.includes("Creating the Slack app")) throw new Error("still creating");
    return response;
  });
}

it("the pair is pasted on the page, the browser goes on to Slack's install page, and the app ends installed", async () => {
  const { person, said, waitedOn } = recordingPerson();
  const run = onboardSlackInternalApp({ target, stateRoot, person });
  const tokensPage = local(await vi.waitFor(() => waitedOn() ?? Promise.reject(new Error("not yet"))));
  expect(await (await fetch(tokensPage)).text()).toContain("api.slack.com/apps");

  // A pair that is not one stays on the page, saying why.
  const refused = await paste(tokensPage, "xoxb-not-config", "xoxe-1");
  expect(refused.status).toBe(200);
  expect(await refused.text()).toContain("invalid Slack configuration token prefix");

  const taken = await paste(tokensPage, "xoxe.xoxp-1", "xoxe-1");
  expect(taken.status).toBe(303);
  const install = await nextPage(new URL(taken.headers.get("location") as string, tokensPage).toString());
  expect(install.status).toBe(303);
  const authorize = new URL(install.headers.get("location") as string);
  expect([authorize.host, authorize.searchParams.get("client_id")]).toEqual(["slack.com", "C1"]);
  // One-time: the pair is taken, and the page is gone.
  expect((await fetch(tokensPage)).status).toBe(404);

  const back = new URL(local(authorize.searchParams.get("redirect_uri") as string));
  back.searchParams.set("code", "c");
  back.searchParams.set("state", authorize.searchParams.get("state") as string);
  await fetch(back);
  await run;

  expect(said).toEqual([
    expect.stringMatching(/^waits on t\.example\/slack\/tokens\/[0-9a-f]{48}$/),
    "carries on",
    "waits on slack.com/oauth/v2/authorize",
    "carries on",
  ]);
  const env = await readFile(join(target, ".secrets", ".env"), "utf8");
  expect(env).toMatch(/^SLACK_BOT_TOKEN=xoxb-bot$/m);
  expect(env).toMatch(/^SLACK_SIGNING_SECRET=sig$/m);
  const state = JSON.parse(await readFile(join(stateRoot, "channels", "slack", "onboarding.json"), "utf8"));
  expect(state).toMatchObject({ configToken: "xoxe.xoxp-1", configRefreshToken: "xoxe-1", appId: "A1" });
  expect(state.installedAt).toBeDefined();
});

it("a setup that fails after the pair is pasted says why on the page the browser waits on", async () => {
  fake.createFails = "invalid_auth <from Slack>";
  const { person, waitedOn } = recordingPerson();
  const run = onboardSlackInternalApp({ target, stateRoot, person });
  const failed = run.then(
    () => undefined,
    (error: Error) => error.message,
  );
  const tokensPage = local(await vi.waitFor(() => waitedOn() ?? Promise.reject(new Error("not yet"))));
  const taken = await paste(tokensPage, "xoxe.xoxp-1", "xoxe-1");
  // The run waits for the page to say it before it stops, which closes the server.
  const said = await nextPage(new URL(taken.headers.get("location") as string, tokensPage).toString());
  const shown = Date.now();
  expect(await said.text()).toContain("invalid_auth &lt;from Slack&gt;");
  expect(await failed).toBe("invalid_auth <from Slack>");
  // Once shown, nothing is left to wait for.
  expect(Date.now() - shown).toBeLessThan(2_000);
});

it("a person who declines on Slack's install page stops it at once: the browser has left the setup's page", async () => {
  const { person, waitedOn } = recordingPerson();
  const run = onboardSlackInternalApp({ target, stateRoot, person });
  const failed = run.then(
    () => undefined,
    (error: Error) => error.message,
  );
  const tokensPage = local(await vi.waitFor(() => waitedOn() ?? Promise.reject(new Error("not yet"))));
  const taken = await paste(tokensPage, "xoxe.xoxp-1", "xoxe-1");
  const install = await nextPage(new URL(taken.headers.get("location") as string, tokensPage).toString());
  const authorize = new URL(install.headers.get("location") as string);
  const back = new URL(local(authorize.searchParams.get("redirect_uri") as string));
  back.searchParams.set("error", "access_denied");
  const declined = Date.now();
  await fetch(back);
  expect(await failed).toBe("Slack OAuth installation was not approved");
  expect(Date.now() - declined).toBeLessThan(2_000);
});

it("a setup refused before it needs the page opens no tunnel to report it", async () => {
  const { startCloudflareTunnel } = await import("../src/tunnel.ts");
  vi.mocked(startCloudflareTunnel).mockClear();
  const { person } = recordingPerson();
  await expect(onboardSlackInternalApp({ target, stateRoot, person, replaceConfig: true })).rejects.toThrow(
    /--replace-config found no local Slack onboarding state/,
  );
  expect(startCloudflareTunnel).not.toHaveBeenCalled();
});

it("a saved pair replaced through the page ends there: the browser is told, not left waiting on a closing tunnel", async () => {
  await writeFile(join(target, ".secrets", ".env"), "SLACK_BOT_TOKEN=xoxb-runtime\nSLACK_SIGNING_SECRET=sig\n");
  const { writeSlackOnboardingState } = await import("../src/channels/slack/onboarding-state.ts");
  writeSlackOnboardingState(stateRoot, {
    version: 1,
    appName: "App",
    appId: "A1",
    configToken: "xoxe.xoxp-old",
    configRefreshToken: "xoxe-old",
    configTokenExpiresAt: 1,
    installedAt: "2026-01-01T00:00:00.000Z",
  });
  const { person, waitedOn } = recordingPerson();
  const run = onboardSlackInternalApp({ target, stateRoot, person, replaceConfig: true });
  const tokensPage = local(await vi.waitFor(() => waitedOn() ?? Promise.reject(new Error("not yet"))));
  const taken = await paste(tokensPage, "xoxe.xoxp-new", "xoxe-new");
  const ended = await nextPage(new URL(taken.headers.get("location") as string, tokensPage).toString());
  expect(await ended.text()).toContain("Slack App Configuration tokens replaced: you can close this page.");
  await run;
  const state = JSON.parse(await readFile(join(stateRoot, "channels", "slack", "onboarding.json"), "utf8"));
  expect(state).toMatchObject({ appId: "A1", configToken: "xoxe.xoxp-new", configRefreshToken: "xoxe-new" });
});
