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

  it("writes each value with `fly secrets set NAME=-` over stdin, exactly as it is, staged for a deploy that follows", async () => {
    const staged = fake();
    await flyStore(staged.run, "bot", quiet, { stage: true }).write({ A: "a", B: "b" });
    expect(staged.cmds()).toEqual(["secrets set --stage -a bot A=-", "secrets set --stage -a bot B=-"]);
    expect(staged.calls.map((call) => call.input)).toEqual(["a", "b"]);
  });

  it("restarts a running app once: every value is staged but the last", async () => {
    const live = fake();
    await flyStore(live.run, "bot", quiet, { stage: false }).write({ A: "a", B: "b", C: "c" });
    expect(live.cmds()).toEqual([
      "secrets set --stage -a bot A=-",
      "secrets set --stage -a bot B=-",
      "secrets set -a bot C=-",
    ]);
  });

  it("keeps a value that `fly secrets import` would change: `#`, quotes, spaces, line breaks, `$`", async () => {
    // `import` cuts a value at `#`, strips matching quotes and leading spaces, and reads `"""` as multi-line:
    // measured on Fly, where the same value stored by `import` and by `NAME=-` has two digests.
    const { run, calls } = fake();
    const tricky = ["pa#ss", 'say "hi" # now', '"quoted"', "  padded", '"""x', "line one\nline two\n", "$HOME ${X}"];
    for (const value of tricky) await flyStore(run, "bot", quiet, { stage: true }).write({ KEY: value });
    expect(calls.map((call) => call.input)).toEqual(tricky);
    expect(calls.every((call) => call.args.includes("KEY=-") && !call.args.join(" ").includes("pa#ss"))).toBe(true);
  });

  it("refuses a value longer than flyctl reads from standard input, and sends nothing", async () => {
    const { run, calls } = fake();
    await expect(
      flyStore(run, "bot", quiet, { stage: true }).write({ BIG: "x".repeat(64 * 1024 + 1) }),
    ).rejects.toThrow("BIG is longer than the 65536 bytes");
    expect(calls).toEqual([]);
  });

  it("a failed set is an error naming it, and the values after it are not sent", async () => {
    const { run, cmds } = fake((args) => (args.includes("A=-") ? { code: 1 } : {}));
    await expect(flyStore(run, "bot", quiet, { stage: true }).write({ A: "a", B: "b" })).rejects.toThrow(
      "`fly secrets set A=-` failed",
    );
    expect(cmds()).toHaveLength(1);
  });

  it("says whether the app is listed, without making it", async () => {
    const absent = fake();
    expect(await flyStore(absent.run, "bot", quiet, { stage: true }).exists()).toBe(false);
    expect(absent.cmds()).toEqual(["apps list --json"]);
    const present = fake(() => ({ stdout: JSON.stringify([{ Name: "bot" }]) }));
    expect(await flyStore(present.run, "bot", quiet, { stage: true }).exists()).toBe(true);
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
    const names = await railwayStore(run, "bot", (m) => lines.push(m), { redeploy: false }).names();
    expect([...names]).toEqual(["A", "RAILWAY_ENVIRONMENT"]);
    expect(lines.join("\n")).not.toContain("secret-a");
  });

  it("writes one variable per call over stdin, never in argv, and none redeploys when a deploy follows", async () => {
    const { run, calls } = fake();
    await railwayStore(run, "bot", quiet, { redeploy: false }).write({ A: "value-a", B: "value-b" });
    expect(calls.map((call) => call.args.join(" "))).toEqual([
      "variables set A --stdin --skip-deploys --service bot",
      "variables set B --stdin --skip-deploys --service bot",
    ]);
    expect(calls.map((call) => call.input)).toEqual(["value-a", "value-b"]);
  });

  it("when nothing deploys after it, the last variable is the one that redeploys the service, once", async () => {
    const { run, cmds } = fake();
    await railwayStore(run, "bot", quiet, { redeploy: true }).write({ A: "a", B: "b", C: "c" });
    expect(cmds()).toEqual([
      "variables set A --stdin --skip-deploys --service bot",
      "variables set B --stdin --skip-deploys --service bot",
      "variables set C --stdin --service bot",
    ]);
  });

  it("an unreadable listing is an error that quotes none of the output, which holds every value (Node and Bun both quote the text)", async () => {
    const { run } = fake(() => ({ stdout: "hunter2-secret-value is not what railway prints" }));
    const failure = await railwayStore(run, "bot", quiet, { redeploy: false })
      .names()
      .then(
        () => undefined,
        (error: unknown) => error as Error,
      );
    expect(failure?.message).toContain("the output was not JSON");
    expect(failure?.message).not.toContain("hunter2");
  });

  it("uses the project named for the agent, and makes one (with its service) only when it is not linked", async () => {
    const service = (project: string) => ({
      name: project,
      environments: { edges: [{ node: { serviceInstances: { edges: [{ node: { serviceName: "bot" } }] } } }] },
    });
    const linked = fake((args) => (args[0] === "status" ? { stdout: JSON.stringify(service("bot")) } : {}));
    await railwayStore(linked.run, "bot", quiet, { redeploy: false }).ensure();
    expect(linked.cmds()).toEqual(["status --json"]);
    // Another project is refused even when it holds a service of this name: values are not written into it.
    const sameName = fake((args) => (args[0] === "status" ? { stdout: JSON.stringify(service("prod-app")) } : {}));
    await expect(railwayStore(sameName.run, "bot", quiet, { redeploy: false }).ensure()).rejects.toThrow("prod-app");
    expect(sameName.cmds()).toEqual(["status --json"]);
    // A project named for the agent that lacks the service gets it; an unrelated one is refused.
    const bare = fake((args) => (args[0] === "status" ? { stdout: JSON.stringify({ name: "bot" }) } : {}));
    await railwayStore(bare.run, "bot", quiet, { redeploy: false }).ensure();
    expect(bare.cmds()).toEqual(["status --json", "add --service bot --variables FASTAGENT_STATE_DIR=/data/.state"]);
    const unrelated = fake((args) => (args[0] === "status" ? { stdout: JSON.stringify({ name: "prod-app" }) } : {}));
    await expect(railwayStore(unrelated.run, "bot", quiet, { redeploy: false }).ensure()).rejects.toThrow("prod-app");
    expect(unrelated.cmds()).toEqual(["status --json"]);

    const unlinked = fake((args) => (args[0] === "status" ? { stdout: "" } : {}));
    await railwayStore(unlinked.run, "bot", quiet, { redeploy: false }).ensure();
    expect(unlinked.cmds()).toEqual([
      "status --json",
      "init --name bot",
      "add --service bot --variables FASTAGENT_STATE_DIR=/data/.state",
    ]);
  });

  it("exists when this directory is linked to the agent's project, and not otherwise; another project is refused", async () => {
    const linked = fake((args) => (args[0] === "status" ? { stdout: JSON.stringify({ name: "bot" }) } : {}));
    expect(await railwayStore(linked.run, "bot", quiet, { redeploy: false }).exists()).toBe(true);
    // Another project's variables are not read, whatever service it holds: the same refusal as `ensure`.
    const other = fake((args) =>
      args[0] === "status"
        ? {
            stdout: JSON.stringify({
              name: "prod-app",
              environments: { edges: [{ node: { serviceInstances: { edges: [{ node: { serviceName: "bot" } }] } } }] },
            }),
          }
        : {},
    );
    await expect(railwayStore(other.run, "bot", quiet, { redeploy: false }).exists()).rejects.toThrow("prod-app");
    expect(other.cmds()).toEqual(["status --json"]);
    const unlinked = fake((args) => (args[0] === "status" ? { stdout: "" } : {}));
    expect(await railwayStore(unlinked.run, "bot", quiet, { redeploy: false }).exists()).toBe(false);
    expect(unlinked.cmds()).toEqual(["status --json"]);
  });

  it("a variable that fails to set stops there, naming it", async () => {
    const { run, cmds } = fake((args) => (args.includes("B") ? { code: 1 } : {}));
    await expect(
      railwayStore(run, "bot", quiet, { redeploy: false }).write({ A: "a", B: "b", C: "c" }),
    ).rejects.toThrow("`railway variables set B` failed");
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
