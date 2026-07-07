import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { containerArtifacts, GENERATED_DOCKERFILE_MARKER } from "../src/deploy/container.ts";
import { fastagentVersion } from "../src/version.ts";

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

  it("never clobbers an existing Dockerfile: flags a stale generated one, warns on a hand-written one (G6)", async () => {
    // deploy KEEPS any existing Dockerfile without --force (no silent data loss). A generated one (marker)
    // that drifted from current config is flagged stale; a hand-written one is kept + warned (its apt won't
    // apply). An up-to-date generated one is kept quietly. Marker/predicate come from container.ts (single source).
    const setup = async (dockerfileContent: string) => {
      const dir = await mkdtemp(join(tmpdir(), "fa-apt-"));
      await writeFile(join(dir, "AGENTS.md"), "You are terse.\n");
      await writeFile(
        join(dir, "fastagent.config.mjs"),
        `export default { model: "openai/gpt-4o-mini", deploy: { apt: ["git"] } };\n`,
      );
      await writeFile(join(dir, "Dockerfile"), dockerfileContent);
      const res = await run(["deploy", "railway", dir]);
      return { res, dockerfile: await readFile(join(dir, "Dockerfile"), "utf8") };
    };

    // A generated-but-edited Dockerfile (marker kept, a hand-added line) → flagged stale, NEVER overwritten.
    const edited = `${GENERATED_DOCKERFILE_MARKER}. was generated\nFROM node:22-slim\nRUN echo my-own-edit\n`;
    const gen = await setup(edited);
    expect(gen.res.stderr).toMatch(/no longer matches what deploy would generate/); // stale flagged
    expect(gen.res.stderr).toMatch(/--force to regenerate/);
    expect(gen.dockerfile).toBe(edited); // preserved — the user's edit survives (no data loss)
    expect(gen.res.stderr).not.toMatch(/deploy\.apt.*NOT applied/); // generated → not the hand-written warn

    // An up-to-date generated Dockerfile (built with the SAME inputs deploy uses) → kept quietly, no stale flag.
    const current = containerArtifacts({
      hasPackageJson: false,
      runtime: "node",
      hasLockfile: false,
      version: await fastagentVersion(),
      apt: ["git"],
    }).find((a) => a.path === "Dockerfile")!.content;
    const fresh = await setup(current);
    expect(fresh.res.stderr).not.toMatch(/no longer matches/); // identical → nothing to flag

    // A HAND-WRITTEN Dockerfile (no marker) → kept verbatim + warned (its apt won't include the packages).
    const hw = await setup("FROM python:3.12\n");
    expect(hw.dockerfile).toBe("FROM python:3.12\n"); // preserved, never clobbered
    expect(hw.res.stderr).toMatch(/deploy\.apt.*NOT applied/); // warn: install those packages yourself
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

  it("info degrades when a tool can't load (missing dep) — reports it, still shows the surface, exits 0", async () => {
    // The scaffold ships tools/ that import @kid7st/fastagent; before `npm install` the import fails.
    // A broken tool file is ISOLATED (skipped + reported, not thrown) so it can't crash the load — info
    // reports it, and dev/start degrade the SAME way (G2): the agent keeps serving without that one tool.
    const dir = await mkdtemp(join(tmpdir(), "fa-info-toolfail-"));
    await mkdir(join(dir, "tools"), { recursive: true });
    await writeFile(join(dir, "AGENTS.md"), "You are terse.\n");
    await writeFile(join(dir, "tools", "broken.ts"), 'import "totally-not-a-real-package-xyz";\nexport default {};\n');
    const env = { ...process.env };
    delete env.FASTAGENT_MODEL;

    const { code, stdout } = await run(["info", dir, "--json"], undefined, env);
    expect(code).toBe(0); // reported, not fatal
    const info = JSON.parse(stdout);
    expect(info.tools).toEqual([]); // the broken tool isn't loaded…
    expect(JSON.stringify(info.toolFailures)).toMatch(/broken\.ts/); // …it's surfaced as a per-file load failure
    expect(info.toolError).toBeNull(); // isolated, so NOT a whole-load abort
    expect(info.instructions).toBe(true); // the rest of the surface still shows
    await expect(stat(join(dir, ".fastagent"))).rejects.toThrow(); // still read-only

    // text mode: the tools line degrades and the reason goes to stderr as a warning
    const text = await run(["info", dir], undefined, env);
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(/tools:\s+\(none\)/); // the broken tool was skipped, nothing else to show
    expect(text.stderr).toMatch(/broken\.ts/); // the reason is a warning on stderr
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
});
