import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/** Run the CLI to completion; capture stdout, stderr, exit code. */
function run(
  args: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { ...(cwd ? { cwd } : {}), env: env ?? process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("cli papercuts", () => {
  it("--version / -v prints the version to stdout and exits 0 (no parse crash)", async () => {
    const v = await run(["--version"]);
    expect(v.code).toBe(0);
    expect(v.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect((await run(["-v"])).stdout.trim()).toBe(v.stdout.trim());
  });

  it("invoke without a message prints usage to stderr and exits 2 (stdout clean)", async () => {
    const { code, stdout, stderr } = await run(["invoke"]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/usage: fastagent invoke/);
    expect(stdout).toBe("");
  });

  it("invoke surfaces a startup error to stderr, keeps stdout empty, exits non-zero", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "fa-cli-inv-"));
    const env = { ...process.env };
    delete env.FASTAGENT_MODEL; // no model source → assembly fails before any model call (no auth needed)
    const { code, stdout, stderr } = await run(["invoke", "hi", cwd], undefined, env);
    expect(code).toBe(1);
    expect(stderr).toMatch(/missing model/);
    expect(stdout).toBe(""); // a failure never pollutes stdout
  });

  it("info reports the assembled surface as JSON (incl. load diagnostics), read-only (no sessions dir)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-info-"));
    await mkdir(join(dir, "skills", "greet"), { recursive: true });
    await mkdir(join(dir, "skills", "bad"), { recursive: true });
    await mkdir(join(dir, "channels"), { recursive: true });
    await writeFile(join(dir, "AGENTS.md"), "You are terse.\n");
    await writeFile(
      join(dir, "skills", "greet", "SKILL.md"),
      "---\nname: greet\ndescription: Greet warmly.\n---\nHi.\n",
    );
    await writeFile(join(dir, "skills", "bad", "SKILL.md"), "---\nname: bad\n---\nno description.\n"); // malformed
    await writeFile(
      join(dir, "channels", "github.ts"),
      'export default () => ({ "POST /x": () => new Response("ok") });\n',
    );
    const env = { ...process.env };
    delete env.FASTAGENT_MODEL;
    const { code, stdout } = await run(["info", dir, "--json"], undefined, env);
    expect(code).toBe(0); // an unset model is reported, not fatal
    const info = JSON.parse(stdout);
    expect(info.model).toBeNull();
    expect(info.instructions).toBe(true);
    expect(info.skills.map((s: { name: string }) => s.name)).toEqual(["greet"]); // the malformed skill is skipped
    expect(JSON.stringify(info.diagnostics)).toMatch(/description/); // info SURFACES the loader diagnostic to the user
    expect(info.channels).toEqual(["github"]);
    await expect(stat(join(dir, ".fastagent"))).rejects.toThrow(); // read-only: never creates sessions dir
  });

  it("login self-ignores .fastagent on an adapted dir before it writes the credential file", async () => {
    // login is the command that CREATES the secret, so its self-ignore must fire independently of the
    // opener. A bogus provider fails the auth flow AFTER the self-ignore, so the .gitignore is the
    // proof the leak guard ran. Adapted dir = no root .gitignore (the feature's core use case).
    const cwd = await mkdtemp(join(tmpdir(), "fa-login-cli-"));
    const env = { ...process.env };
    delete env.FASTAGENT_AUTH_PATH; // ensure the in-tree default (not a dev's global override)
    const { code } = await run(["login", "no-such-provider"], cwd, env);
    expect(code).not.toBe(0); // unknown provider fails the flow
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(join(cwd, ".fastagent", ".gitignore"), "utf8")).toBe("*\n");
  });

  it("login from $HOME does NOT self-ignore the HOME-global ~/.fastagent (a dotfiles repo may track it)", async () => {
    // self-ignore protects agent PROJECT trees, not the user's home. Run from $HOME (cwd == home) so
    // the credential default IS the global file; the bogus provider fails after the self-ignore
    // decision, so an absent .gitignore proves the global dir was left alone.
    // NOT realpath'd on purpose: macOS hands the child a /var→/private/var symlinked $HOME, so this
    // also exercises that the home check canonicalizes (a raw string compare would leak a .gitignore here).
    const home = await mkdtemp(join(tmpdir(), "fa-home-"));
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    delete env.FASTAGENT_AUTH_PATH;
    const { code } = await run(["login", "no-such-provider"], home, env);
    expect(code).not.toBe(0);
    await expect(stat(join(home, ".fastagent", ".gitignore"))).rejects.toThrow(); // home left untouched
  });

  it("login reads .env from the current directory (a FASTAGENT_AUTH_PATH set there takes effect)", async () => {
    // Regression: login used to load .env from ./<provider> (the positional is the provider, not a dir).
    // Put FASTAGENT_AUTH_PATH in cwd/.env pointing OUTSIDE the tree — if .env is honored, auth resolves
    // there and the in-tree .fastagent is never self-ignored; if the bug returns (.env ignored), auth
    // falls back to the in-tree default and .fastagent/.gitignore appears. So its ABSENCE is the proof.
    const cwd = await mkdtemp(join(tmpdir(), "fa-login-env-"));
    const external = join(await mkdtemp(join(tmpdir(), "fa-ext-")), "auth.json");
    await writeFile(join(cwd, ".env"), `FASTAGENT_AUTH_PATH=${external}\n`);
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.FASTAGENT_AUTH_PATH; // must come only from .env
    const { code } = await run(["login", "no-such-provider"], cwd, env);
    expect(code).not.toBe(0);
    await expect(stat(join(cwd, ".fastagent", ".gitignore"))).rejects.toThrow(); // external path won → no in-tree self-ignore
  });

  it("invoke points an upgraded user at their global credential when the project file is empty", async () => {
    // The breaking change's safety net: project auth defaults empty, but a pre-upgrade global login
    // still has the credential — the startup report must say so (set FASTAGENT_AUTH_PATH) instead of a
    // bare turn failure. HOME override makes GLOBAL_AUTH_PATH resolve into the temp home.
    const home = await mkdtemp(join(tmpdir(), "fa-home-"));
    await mkdir(join(home, ".fastagent"), { recursive: true });
    await writeFile(
      join(home, ".fastagent", "auth.json"),
      JSON.stringify({ anthropic: { type: "api_key", key: "sk-test" } }),
    );
    const proj = await mkdtemp(join(tmpdir(), "fa-proj-"));
    await writeFile(join(proj, "fastagent.config.mjs"), `export default { model: "anthropic/claude-sonnet-4-5" };`);
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    delete env.ANTHROPIC_API_KEY; // else the project probe finds env creds and the hint never fires
    delete env.FASTAGENT_AUTH_PATH;
    delete env.FASTAGENT_MODEL;
    const { stderr } = await run(["invoke", "hi", proj], undefined, env);
    expect(stderr).toMatch(/global .*has them/i); // the migration hint fired
    expect(stderr).toMatch(/FASTAGENT_AUTH_PATH=/); // with the actionable env-var fix
  });
});
