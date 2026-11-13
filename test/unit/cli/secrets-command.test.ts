import { writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deploymentName } from "../../../src/deploy/deployment-name.ts";
import { toFlyAppName } from "../../../src/deploy/fly/plan.ts";
import { besideAgent, runInProcess } from "../../doubles/cli-run.ts";
import { resetHostClis } from "../../doubles/host-cli-double.ts";
import { agent, fakeFly, realStdin } from "./secrets-command-fixtures.ts";

vi.mock("../../../src/deploy/runner.ts", () => import("../../doubles/host-cli-double.ts"));

afterEach(() => {
  if (realStdin) Object.defineProperty(process, "stdin", realStdin);
  resetHostClis();
});

describe("secrets list", () => {
  it("prints every declared name with whether the target holds it, the model's key included, and no value", async () => {
    // The project's own files hold values too: a deployment reads none of them, and no value is ever printed.
    const dir = await agent({
      ".secrets/production/.env": "GH_TOKEN=ghp_secret\n",
      ".secrets/.env": "SENTRY_DSN=dsn_secret\n",
    });
    fakeFly(["GH_TOKEN"], { app: toFlyAppName(await deploymentName(dir)) });
    const result = await runInProcess(["secrets", "list", "fly", dir, "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      host: "Fly",
      exists: true,
      secrets: [
        // The model's key is known, and optional: OpenAI has a login to run on the box instead.
        { name: "OPENAI_API_KEY", set: false, required: false, hint: "your model provider key, or a login on the box" },
        { name: "GH_TOKEN", set: true, required: true, hint: expect.stringContaining("required by") },
        { name: "SENTRY_DSN", set: false, required: false },
      ],
    });
    expect(result.stdout).not.toContain("ghp_secret");
    expect(result.stdout).not.toContain("dsn_secret");
    const text = await runInProcess(["secrets", "list", "fly", dir]);
    expect(text.stdout).toMatch(
      /^missing {2}OPENAI_API_KEY {2}\(optional: your model provider key, or a login on the box\)$/m,
    );
    expect(text.stdout).toMatch(/^set {6}GH_TOKEN/m);
  });
});

describe("secrets push", () => {
  it("sets the declared names a file holds, and says which it did not push because nothing declares them", async () => {
    const fly = fakeFly([]);
    const dir = await agent();
    const other = besideAgent(dir, "other.env");
    await writeFile(other, "GH_TOKEN=ghp_x\nSENTRY_DSN=https://dsn\nUNDECLARED=nope\nEMPTY=\n");
    const result = await runInProcess(["secrets", "push", "fly", dir, "--env-file", other]);
    expect(result.code, result.stderr).toBe(0);
    const staged = await fly.stdin();
    expect(staged).toContain("ghp_x");
    expect(staged).toContain("https://dsn");
    expect(staged).not.toContain("nope");
    expect(result.stderr).toContain("not pushed, since the definition does not declare them: UNDECLARED, EMPTY");
    expect(result.stderr).not.toContain("ghp_x"); // names are said, values are not
  });

  it("on Fly: each declared name goes in with `NAME=-` over stdin, creating the app first, exactly as the file holds it, restarting once", async () => {
    const fly = fakeFly([]);
    const dir = await agent();
    const values = besideAgent(dir, "fly.env");
    await writeFile(values, "GH_TOKEN=ghp_x\nSENTRY_DSN=https://dsn.example/a#b\nUNDECLARED=nope\n");
    const result = await runInProcess(["secrets", "push", "fly", dir, "--env-file", values]);
    expect(result.code, result.stderr).toBe(0);
    const calls = await fly.calls();
    expect(calls.some((c) => c.startsWith("apps create "))).toBe(true);
    const sets = calls.filter((c) => c.startsWith("secrets set"));
    // Every value but the last is staged, so a running app restarts once.
    expect(sets).toEqual([
      expect.stringMatching(/^secrets set --stage -a \S+ GH_TOKEN=-$/),
      expect.stringMatching(/^secrets set -a \S+ SENTRY_DSN=-$/),
    ]);
    expect(await fly.stdin()).toBe("ghp_x\nhttps://dsn.example/a#b\n");
    expect(calls.join("\n")).not.toContain("ghp_x"); // never argv
  });
});

describe("secrets set", () => {
  it("without a terminal reads the value from standard input, never the command line", async () => {
    const fly = fakeFly(["GH_TOKEN"]);
    const dir = await agent();
    Object.defineProperty(process, "stdin", { value: Readable.from(["ghp_from_stdin\n"]), configurable: true });
    const result = await runInProcess(["secrets", "set", "fly", "GH_TOKEN", dir]);
    expect(result.code, result.stderr).toBe(0);
    expect(await fly.stdin()).toBe("ghp_from_stdin\n");
    expect((await fly.calls()).join("\n")).not.toContain("ghp_from_stdin");
    expect(result.stdout).toBe("");
  });
});
