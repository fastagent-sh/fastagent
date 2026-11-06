import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { agentWorkspace, runInProcess } from "./cli-run.ts";

/** A channel that declares what a deployment needs: GH_TOKEN required, SENTRY_DSN optional. */
const HOOK = `export default {
  kind: "fastagent.needs",
  secrets: [{ name: "GH_TOKEN", optional: false }, { name: "SENTRY_DSN", optional: true }],
  build: () => () => ({ "POST /hook": () => new Response("ok") }),
};\n`;

async function agent(files: Record<string, string> = {}) {
  return agentWorkspace("fa-secrets-", {
    "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
    "src/channels/hook.mjs": HOOK,
    ...files,
  });
}

const production = (dir: string) => join(dir, ".secrets", "production", ".env");
const read = (file: string) => readFile(file, "utf8");

/** A `fly` on PATH that answers what the store asks of it and keeps what it was given. */
async function fakeFly(listed: string[] = ["GH_TOKEN"]) {
  const bin = await mkdtemp(join(tmpdir(), "fa-fake-fly-"));
  const log = join(bin, "log");
  await writeFile(
    join(bin, "fly"),
    `#!/bin/sh
echo "$@" >> "${log}"
case "$1" in
  version) echo "fly v0";;
  apps) if [ "$2" = "list" ]; then echo '[]'; fi;;
  secrets)
    if [ "$2" = "list" ]; then echo '[${listed.map((name) => `{"Name":"${name}"}`).join(",")}]'; fi
    if [ "$2" = "import" ]; then cat > "${log}.stdin"; fi;;
esac
`,
  );
  await chmod(join(bin, "fly"), 0o755);
  return {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    calls: async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n"),
    stdin: async () => readFile(`${log}.stdin`, "utf8").catch(() => undefined),
  };
}

const realStdin = Object.getOwnPropertyDescriptor(process, "stdin");
afterEach(() => {
  if (realStdin) Object.defineProperty(process, "stdin", realStdin);
});

describe("secrets list", () => {
  it("prints every declared name with whether the target holds it, the model's key included, and no value", async () => {
    const dir = await agent({ ".secrets/production/.env": "GH_TOKEN=ghp_secret\n" });
    const result = await runInProcess(["secrets", "list", "docker", dir, "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      host: "Docker",
      secrets: [
        // The model's key is known, and optional: OpenAI has a login to run on the box instead.
        { name: "OPENAI_API_KEY", set: false, required: false },
        { name: "GH_TOKEN", set: true, required: true, hint: expect.stringContaining("required by") },
        { name: "SENTRY_DSN", set: false, required: false },
      ],
    });
    expect(result.stdout).not.toContain("ghp_secret");
    const text = await runInProcess(["secrets", "list", "docker", dir]);
    expect(text.stdout).toMatch(/^missing {2}OPENAI_API_KEY {2}\(optional\)$/m);
    expect(text.stdout).toMatch(/^set {6}GH_TOKEN/m);
  });
});

describe("secrets push", () => {
  it("sets the declared names a value file holds, and says which it did not push because nothing declares them", async () => {
    const dir = await agent();
    const other = join(dir, "..", "other.env");
    await writeFile(other, "GH_TOKEN=ghp_x\nSENTRY_DSN=https://dsn\nUNDECLARED=nope\nEMPTY=\n");
    const result = await runInProcess(["secrets", "push", "docker", dir, "--env-file", other]);
    expect(result.code, result.stderr).toBe(0);
    const written = await read(production(dir));
    expect(written).toContain("GH_TOKEN=ghp_x");
    expect(written).toContain("SENTRY_DSN=https://dsn");
    expect(written).not.toContain("UNDECLARED");
    expect(result.stderr).toContain("not pushed, since the definition does not declare them: UNDECLARED, EMPTY");
    expect(result.stderr).not.toContain("ghp_x"); // names are said, values are not
  });

  it("--from-env takes only declared names from the environment of the command that injected them", async () => {
    const dir = await agent();
    const env = { ...process.env, GH_TOKEN: "ghp_env", HOME_SECRET: "not declared" };
    const result = await runInProcess(["secrets", "push", "docker", dir, "--from-env"], undefined, env);
    expect(result.code, result.stderr).toBe(0);
    const written = await read(production(dir));
    expect(written).toContain("GH_TOKEN=ghp_env");
    expect(written).not.toContain("HOME_SECRET");
    // The environment is a source only when asked for: without the flag it is not read.
    const dir2 = await agent();
    const none = await runInProcess(["secrets", "push", "docker", dir2], undefined, env);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("holds no values: pass --env-file <file>, or --from-env");
  });

  it("two sources are a usage error", async () => {
    const dir = await agent();
    const result = await runInProcess(["secrets", "push", "docker", dir, "--from-env", "--env-file", join(dir, "x")]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("two sources");
  });

  it("on Fly: the production file's declared names go in one import over stdin, creating the app first, live and not staged", async () => {
    const fly = await fakeFly([]);
    const dir = await agent({ ".secrets/production/.env": "GH_TOKEN=ghp_x\nUNDECLARED=nope\n" });
    const result = await runInProcess(["secrets", "push", "fly", dir], undefined, fly.env);
    expect(result.code, result.stderr).toBe(0);
    const calls = await fly.calls();
    expect(calls.some((c) => c.startsWith("apps create "))).toBe(true);
    expect(calls.filter((c) => c.startsWith("secrets import"))).toHaveLength(1);
    expect(calls.find((c) => c.startsWith("secrets import"))).not.toContain("--stage");
    expect(await fly.stdin()).toBe("GH_TOKEN=ghp_x\n");
    expect(calls.join("\n")).not.toContain("ghp_x"); // never argv
  });
});

describe("secrets set", () => {
  it("--generate sets a random value and prints it once, on stdout, for what FastAgent makes itself", async () => {
    const dir = await agent();
    const result = await runInProcess(["secrets", "set", "docker", "FASTAGENT_API_KEY", dir, "--generate"]);
    expect(result.code, result.stderr).toBe(0);
    const printed = result.stdout.trim();
    expect(printed).toMatch(/^[\w-]{43}$/);
    expect(await read(production(dir))).toContain(`FASTAGENT_API_KEY=${printed}`);
    expect(result.stderr).not.toContain(printed);
  });

  it("without a terminal reads the value from standard input, never the command line", async () => {
    const fly = await fakeFly(["GH_TOKEN"]);
    const dir = await agent();
    Object.defineProperty(process, "stdin", { value: Readable.from(["ghp_from_stdin\n"]), configurable: true });
    const result = await runInProcess(["secrets", "set", "fly", "GH_TOKEN", dir], undefined, fly.env);
    expect(result.code, result.stderr).toBe(0);
    expect(await fly.stdin()).toBe("GH_TOKEN=ghp_from_stdin\n");
    expect((await fly.calls()).join("\n")).not.toContain("ghp_from_stdin");
    expect(result.stdout).toBe("");
  });

  it("warns that a name no declaration reads reaches nothing, and refuses what is not a variable name", async () => {
    const dir = await agent();
    Object.defineProperty(process, "stdin", { value: Readable.from(["v\n"]), configurable: true });
    const stray = await runInProcess(["secrets", "set", "docker", "STRAY", dir]);
    expect(stray.code, stray.stderr).toBe(0);
    expect(stray.stderr).toContain("warn: STRAY is not declared by the definition, so nothing reads it on Docker");
    const bad = await runInProcess(["secrets", "set", "docker", "not a name", dir]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("is not an environment variable name");
  });
});
