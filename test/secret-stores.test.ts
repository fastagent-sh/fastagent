import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileStore } from "../src/deploy/file-store.ts";
import { flyStore } from "../src/deploy/fly/store.ts";
import { railwayStore } from "../src/deploy/railway/store.ts";
import type { CliRunner } from "../src/deploy/runner.ts";

/** A fake host CLI: every call recorded, each answered by `script` (default: success, an empty JSON list for a `--json`). */
function fake(script: (args: string[]) => { code?: number; stdout?: string } = () => ({})) {
  const calls: { args: string[]; input?: string }[] = [];
  const run: CliRunner = async (args, opts) => {
    calls.push({ args, input: opts?.input });
    const answer = script(args);
    return { code: answer.code ?? 0, stdout: answer.stdout ?? (args.includes("--json") ? "[]" : "") };
  };
  return { run, calls, cmds: () => calls.map((call) => call.args.join(" ")) };
}

const quiet = () => {};

describe("flyStore", () => {
  it("lists names from `fly secrets list --json`, whichever way the field is spelled, and reads no value", async () => {
    const { run, cmds } = fake(() => ({
      stdout: JSON.stringify([{ Name: "A", Digest: "d1" }, { name: "B" }, { Digest: "no name" }]),
    }));
    expect([...(await flyStore(run, "bot", quiet, { stage: true }).names())]).toEqual(["A", "B"]);
    expect(cmds()).toEqual(["secrets list -a bot --json"]);
  });

  it("a failed or unreadable list is an error, not an empty store to fill", async () => {
    const failed = fake(() => ({ code: 1 }));
    await expect(flyStore(failed.run, "bot", quiet, { stage: true }).names()).rejects.toThrow("secrets list");
    const odd = fake(() => ({ stdout: "not json" }));
    await expect(flyStore(odd.run, "bot", quiet, { stage: true }).names()).rejects.toThrow("unreadable");
  });

  it("writes in one `fly secrets import` over stdin, staged for a deploy that follows and not otherwise", async () => {
    const staged = fake();
    await flyStore(staged.run, "bot", quiet, { stage: true }).write({ A: "a", B: "b" });
    expect(staged.cmds()).toEqual(["secrets import --stage -a bot"]);
    expect(staged.calls[0]?.input).toBe("A=a\nB=b\n");

    const live = fake();
    await flyStore(live.run, "bot", quiet, { stage: false }).write({ A: "a" });
    expect(live.cmds()).toEqual(["secrets import -a bot"]);
  });

  it("refuses a value with a line break, which would end its line early, and sends nothing", async () => {
    const { run, calls } = fake();
    await expect(flyStore(run, "bot", quiet, { stage: true }).write({ KEY: "a\nB=injected" })).rejects.toThrow(
      "KEY holds a line break",
    );
    expect(calls).toEqual([]);
  });

  it("a failed import is an error", async () => {
    const { run } = fake(() => ({ code: 1 }));
    await expect(flyStore(run, "bot", quiet, { stage: true }).write({ A: "a" })).rejects.toThrow("fly secrets import");
  });

  it("makes the app when it is not listed, and only then", async () => {
    const absent = fake();
    await flyStore(absent.run, "bot", quiet, { stage: true }).ensure();
    expect(absent.cmds()).toEqual(["apps list --json", "apps create bot"]);
    const present = fake((args) => (args[0] === "apps" ? { stdout: JSON.stringify([{ Name: "bot" }]) } : {}));
    await flyStore(present.run, "bot", quiet, { stage: true }).ensure();
    expect(present.cmds()).toEqual(["apps list --json"]);
  });
});

describe("railwayStore", () => {
  it("lists the keys of `railway variable list --json` and never repeats a value", async () => {
    const lines: string[] = [];
    const { run } = fake(() => ({ stdout: JSON.stringify({ A: "secret-a", RAILWAY_ENVIRONMENT: "production" }) }));
    const names = await railwayStore(run, "bot", (m) => lines.push(m)).names();
    expect([...names]).toEqual(["A", "RAILWAY_ENVIRONMENT"]);
    expect(lines.join("\n")).not.toContain("secret-a");
  });

  it("writes one variable per call over stdin, without redeploying on each, never in argv", async () => {
    const { run, calls } = fake();
    await railwayStore(run, "bot", quiet).write({ A: "value-a", B: "value-b" });
    expect(calls.map((call) => call.args.join(" "))).toEqual([
      "variables set A --stdin --skip-deploys --service bot",
      "variables set B --stdin --skip-deploys --service bot",
    ]);
    expect(calls.map((call) => call.input)).toEqual(["value-a", "value-b"]);
  });

  it("a variable that fails to set stops there, naming it", async () => {
    const { run, cmds } = fake((args) => (args.includes("B") ? { code: 1 } : {}));
    await expect(railwayStore(run, "bot", quiet).write({ A: "a", B: "b", C: "c" })).rejects.toThrow(
      "`railway variables set B` failed",
    );
    expect(cmds()).toHaveLength(2);
  });
});

describe("fileStore", () => {
  it("holds the names a value file gives a value, not the empty lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-file-store-"));
    const file = join(dir, "prod.env");
    await writeFile(file, "A=a\nB=\n# C=c\n");
    expect([...(await fileStore(dir, file).names())]).toEqual(["A"]);
  });

  it("writes into the file, replacing a name's old value in place and keeping the rest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-file-store-"));
    const file = join(dir, ".secrets", "production", ".env");
    const store = fileStore(dir, file);
    await store.write({ A: "one" });
    await store.write({ A: "two", B: "b" });
    const content = await readFile(file, "utf8");
    expect(content).toMatch(/^A=two$/m);
    expect(content).toMatch(/^B=b$/m);
    expect(content.match(/^A=/gm)).toHaveLength(1);
  });
});
