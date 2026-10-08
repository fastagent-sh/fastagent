import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../src/open-url.ts", () => ({ openExternalUrl: () => {} }));
const { onboardFeishuCloudApp } = await import("../src/cli/add-feishu.ts");

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("a webhook preparation the app-config scope blocks names the command that started it", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "fa-feishu-rerun-")), "fastagent");
  await mkdir(join(dir, ".secrets"), { recursive: true });
  await writeFile(join(dir, ".secrets", ".env"), "FEISHU_APP_ID=cli_1\nFEISHU_APP_SECRET=s\n");
  vi.stubEnv("FASTAGENT_SECRETS_DIR", "");
  // The app holds every agent scope but not application:application:patch, and its config read is refused.
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = String(input);
    if (url.includes("tenant_access_token")) return Response.json({ code: 0, tenant_access_token: "T", expire: 7200 });
    if (url.includes("/application/v6/scopes")) {
      const names = ["im:message.group_msg", "im:message:readonly", "im:chat.members:read"];
      return Response.json({ code: 0, data: { scopes: names.map((scope_name) => ({ scope_name, grant_status: 1 })) } });
    }
    return Response.json({ code: 99991672, msg: "permission denied" });
  });
  const printed: string[] = [];
  vi.spyOn(console, "error").mockImplementation((line) => void printed.push(String(line)));
  await onboardFeishuCloudApp(dir, "feishu", "webhook", "fastagent deploy fly --run");
  expect(printed.join("\n")).toContain("have the permission approved and re-run `fastagent deploy fly --run`");
  await rm(dir, { recursive: true, force: true });
});
