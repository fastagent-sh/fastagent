import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { prepareChannelApps, unpreparedChannelApps } from "../src/cli/commands/deploy/channel-apps.ts";
import { setUpChannel } from "../src/cli/channel-setup.ts";

vi.mock("../src/cli/channel-setup.ts", async (original) => ({
  ...(await original<typeof import("../src/cli/channel-setup.ts")>()),
  setUpChannel: vi.fn(async () => ({ written: [], kept: [], after: [] })),
}));

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(setUpChannel).mockClear();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

it("creates missing apps for either way and prepares an existing webhook app without its token", () => {
  const channels = [
    { name: "feishu", ingress: "webhook" },
    { name: "lark", ingress: "long-connection" },
    { name: "telegram", ingress: "webhook" },
  ] as const;
  expect(unpreparedChannelApps(channels, new Map())).toEqual([
    { kind: "feishu", way: "webhook" },
    { kind: "lark", way: "connection" },
  ]);
  const values = new Map([
    ["FEISHU_APP_ID", "f"],
    ["FEISHU_APP_SECRET", "fs"],
    ["LARK_APP_ID", "l"],
    ["LARK_APP_SECRET", "ls"],
  ]);
  expect(unpreparedChannelApps(channels, values)).toEqual([{ kind: "feishu", way: "webhook" }]);
  values.set("FEISHU_VERIFICATION_TOKEN", "t");
  expect(unpreparedChannelApps(channels, values)).toEqual([]);
  values.set("FEISHU_VERIFICATION_TOKEN", " ");
  expect(unpreparedChannelApps(channels, values)).toEqual([{ kind: "feishu", way: "webhook" }]);
});

it("sets each app up as production, in the file it was given, for the person it was given", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fa-prepare-"));
  dirs.push(dir);
  await mkdir(join(dir, ".secrets"), { recursive: true });
  const dev = "FEISHU_APP_ID=cli_dev\nFEISHU_APP_SECRET=dev_secret\n";
  await writeFile(join(dir, ".secrets", ".env"), dev);
  vi.stubEnv("FASTAGENT_SECRETS_DIR", "");
  vi.stubEnv("FASTAGENT_ENVIRONMENT", "production");
  const printed = vi.spyOn(console, "error").mockImplementation(() => {});
  const person = { waitsOn: () => {}, carriesOn: () => {}, afterwards: () => {} };
  const file = join(dir, "prod.env");
  await prepareChannelApps(
    dir,
    file,
    [
      { kind: "feishu", way: "webhook" },
      { kind: "lark", way: "connection" },
    ],
    "fastagent deploy fly --run",
    person,
  );
  expect(vi.mocked(setUpChannel).mock.calls.map(([input]) => input)).toEqual([
    { kind: "feishu", agentDir: dir, file, way: "webhook", dev: false, rerun: "fastagent deploy fly --run", person },
    { kind: "lark", agentDir: dir, file, way: "connection", dev: false, rerun: "fastagent deploy fly --run", person },
  ]);
  expect(printed.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
    "preparing the production app for webhook",
  );
  expect(await readFile(join(dir, ".secrets", ".env"), "utf8")).toBe(dev);
});
