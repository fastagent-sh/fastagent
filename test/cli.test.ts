import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
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
  it("deploy (kit layout): the host's root .dockerignore is kept even under --force; kit artifacts written", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-deploy-kit-"));
    await writeFile(
      join(dir, "fastagent.config.mjs"),
      `export default { agentDir: "./agent", model: "openai-codex/gpt-5.5" };\n`,
    );
    await mkdir(join(dir, "agent"), { recursive: true });
    await writeFile(join(dir, "agent", "package.json"), `{"type":"module"}`);
    const hostIgnore = "# the HOST product's own rules\n.git\ndist\n";
    await writeFile(join(dir, ".dockerignore"), hostIgnore);

    const { code, stderr } = await run(["deploy", "fly", dir, "--force"]);
    expect(code).toBe(0);
    // The safety boundary docs/deploy.md promises: --force NEVER clobbers the host's file.
    expect(await readFile(join(dir, ".dockerignore"), "utf8")).toBe(hostIgnore);
    expect(stderr).toMatch(/kept \.dockerignore/);
    expect(stderr).toMatch(/excludes \.git/); // and the specific preflight warn fired (not force-gated)
    // Kit artifacts land namespaced.
    expect(await readFile(join(dir, "agent", "Dockerfile"), "utf8")).toMatch(/Repo-as-workspace/);
  });

  it("every deploy --run target keeps the experimental agentDir layout gated", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-deploy-kit-run-"));
    await writeFile(
      join(dir, "fastagent.config.mjs"),
      `export default { agentDir: "./agent", model: "openai/gpt-4o-mini" };\n`,
    );
    await mkdir(join(dir, "agent"), { recursive: true });
    for (const target of ["docker", "fly", "railway"]) {
      const result = await run(["deploy", target, dir, "--run"]);
      expect(result.code, target).toBe(1);
      expect(result.stderr, target).toMatch(/--run is not yet supported for the agentDir layout/);
      expect(result.stderr, target).not.toMatch(/not found|Docker daemon|login/);
    }
  });

  it("deploy docker generates app-only Compose and keeps user-owned Dockerfile/Compose on re-run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-deploy-docker-"));
    await writeFile(join(dir, "AGENTS.md"), "You are terse.\n");
    await writeFile(join(dir, "fastagent.config.mjs"), `export default { model: "openai/gpt-4o-mini" };\n`);

    const first = await run(["deploy", "docker", dir]);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("docker compose -f fastagent.compose.yml up -d --build");
    const generatedCompose = await readFile(join(dir, "fastagent.compose.yml"), "utf8");
    expect(generatedCompose).toContain('"127.0.0.1:8787:8787"');
    expect(generatedCompose).not.toContain("cloudflared");

    const customDockerfile = "FROM node:22-slim\nRUN echo custom\n";
    const customCompose = `${generatedCompose}\n# custom ingress belongs to me\n`;
    await writeFile(join(dir, "Dockerfile"), customDockerfile);
    await writeFile(join(dir, "fastagent.compose.yml"), customCompose);

    const second = await run(["deploy", "docker", dir]);
    expect(second.code).toBe(0);
    expect(second.stderr).toContain("kept Dockerfile");
    expect(second.stderr).toContain("kept fastagent.compose.yml");
    expect(await readFile(join(dir, "Dockerfile"), "utf8")).toBe(customDockerfile);
    expect(await readFile(join(dir, "fastagent.compose.yml"), "utf8")).toBe(customCompose);
  });

  it("deploy docker --tunnel keeps an existing app-only topology and prints an actionable runbook", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-deploy-kept-no-tunnel-"));
    await writeFile(join(dir, "fastagent.config.mjs"), `export default { model: "openai/gpt-4o-mini" };\n`);
    expect((await run(["deploy", "docker", dir])).code).toBe(0);
    const compose = await readFile(join(dir, "fastagent.compose.yml"), "utf8");

    const result = await run(["deploy", "docker", dir, "--tunnel"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/--tunnel.*kept fastagent\.compose\.yml.*no "tunnel" service/);
    expect(result.stderr).toMatch(/edit it, delete it and regenerate, or pass --force/);
    expect(result.stdout).not.toContain("logs -f tunnel");
    expect(result.stdout).toContain("docker compose -f fastagent.compose.yml up -d --build");
    expect(await readFile(join(dir, "fastagent.compose.yml"), "utf8")).toBe(compose);
  });

  it("deploy docker --tunnel shapes Compose but does not run Docker without --run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-deploy-tunnel-"));
    await writeFile(join(dir, "fastagent.config.mjs"), `export default { model: "openai/gpt-4o-mini" };\n`);
    const result = await run(["deploy", "docker", dir, "--tunnel"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Quick Tunnel");
    const compose = await readFile(join(dir, "fastagent.compose.yml"), "utf8");
    expect(compose).toContain("cloudflare/cloudflared:");
    expect(compose).toContain("http://agent:8787");
    expect(result.stderr).not.toMatch(/Docker CLI not found|Docker daemon/);

    // The file is now authoritative: a later plain generation/run must not treat omitted --tunnel as
    // "remove tunnel" (only --force resets generated topology).
    const second = await run(["deploy", "docker", dir]);
    expect(second.code).toBe(0);
    expect(second.stderr).not.toContain("fastagent.compose.yml — it no longer matches");
    expect(await readFile(join(dir, "fastagent.compose.yml"), "utf8")).toBe(compose);
  });

  it("deploy loads .env and installs its proxy before config-time network work", async () => {
    // Regression: the Node CLI used to load .env but omit installProxyFetch(), so post-deploy channel
    // calls bypassed HTTP(S)_PROXY. A config-time fetch gives the real CLI path an early network probe;
    // the reserved .invalid host can succeed only when the .env-only local proxy was installed first.
    const requests: string[] = [];
    const proxy = createServer((req, res) => {
      requests.push(req.url ?? "");
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("proxied");
    });
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = proxy.address();
      if (!address || typeof address === "string") throw new Error("proxy did not bind a TCP port");
      const proxyUrl = `http://127.0.0.1:${address.port}`;
      const dir = await mkdtemp(join(tmpdir(), "fa-deploy-proxy-"));
      await writeFile(join(dir, ".env"), `HTTP_PROXY=${proxyUrl}\nHTTPS_PROXY=${proxyUrl}\n`);
      await writeFile(join(dir, "AGENTS.md"), "You are terse.\n");
      await writeFile(
        join(dir, "fastagent.config.mjs"),
        `const response = await fetch("http://deploy-proxy.invalid/probe");\n` +
          `if (!response.ok) throw new Error("proxy probe failed");\n` +
          `export default { model: "openai-codex/gpt-5.5" };\n`,
      );
      const env = { ...process.env };
      for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]) {
        delete env[key]; // the proxy must come from the workspace .env, loaded inside runDeploy()
      }

      const { code, stderr } = await run(["deploy", "fly", dir], undefined, env);
      expect(code, stderr).toBe(0);
      expect(requests).toContain("http://deploy-proxy.invalid/probe");
    } finally {
      await new Promise<void>((resolve, reject) => proxy.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("--version / -v prints the version to stdout and exits 0 (no parse crash)", async () => {
    const v = await run(["--version"]);
    expect(v.code).toBe(0);
    expect(v.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect((await run(["-v"])).stdout.trim()).toBe(v.stdout.trim());
  });

  it("invoke without a message is a usage error on stderr, exits 2 (stdout clean)", async () => {
    const { code, stdout, stderr } = await run(["invoke"]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/missing required argument 'message'/);
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

  it("start fails when a declared channel cannot load instead of exposing the default /invoke route", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-cli-channel-fail-"));
    await mkdir(join(dir, "channels"), { recursive: true });
    await writeFile(join(dir, "fastagent.config.mjs"), `export default { model: "openai/gpt-5.5" };\n`);
    await writeFile(
      join(dir, "channels", "telegram.mjs"),
      `export default () => { throw new Error("TELEGRAM_SECRET_TOKEN required"); };\n`,
    );

    const { code, stderr } = await run(["start", dir, "--port", "0"]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/telegram\.mjs failed to load/);
    expect(stderr).toMatch(/channel setup is invalid \(1 load failure\(s\), 0 route collision\(s\)\)/);
    expect(stderr).toMatch(/\*\.disabled/);
    expect(stderr).not.toMatch(/routes:.*\/invoke/);
  });

  it("fire without a name is a usage error on stderr, exits 2 (stdout clean)", async () => {
    const { code, stdout, stderr } = await run(["fire"]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/missing required argument 'name'/);
    expect(stdout).toBe("");
  });

  it("fire on an unknown schedule name exits 1 and lists the available schedules", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-fire-"));
    await mkdir(join(dir, "schedules"), { recursive: true });
    await writeFile(join(dir, "AGENTS.md"), "You are terse.\n");
    const scheduleHref = new URL("../src/schedule/schedule.ts", import.meta.url).href;
    await writeFile(
      join(dir, "schedules", "daily.ts"),
      `import { defineSchedule } from ${JSON.stringify(scheduleHref)};\nexport default defineSchedule({ cron: "0 9 * * *", prompt: "digest" });\n`,
    );
    const env = { ...process.env };
    delete env.FASTAGENT_MODEL; // unknown-name exits before any model resolution
    const { code, stderr } = await run(["fire", "nope", dir], undefined, env);
    expect(code).toBe(1);
    expect(stderr).toMatch(/unknown schedule "nope"/);
    expect(stderr).toMatch(/available: daily/);
  });

  it("fire discovers schedules from agentDir (where the scheduler serves them), not the run root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-fire-kit-"));
    await writeFile(join(dir, "fastagent.config.mjs"), `export default { agentDir: "./agent" };\n`);
    await mkdir(join(dir, "agent", "schedules"), { recursive: true });
    const scheduleHref = new URL("../src/schedule/schedule.ts", import.meta.url).href;
    await writeFile(
      join(dir, "agent", "schedules", "daily.ts"),
      `import { defineSchedule } from ${JSON.stringify(scheduleHref)};\nexport default defineSchedule({ cron: "0 9 * * *", prompt: "digest" });\n`,
    );
    const env = { ...process.env };
    delete env.FASTAGENT_MODEL;
    const { code, stderr } = await run(["fire", "nope", dir], undefined, env);
    expect(code).toBe(1);
    expect(stderr).toMatch(/available: daily/); // found in agent/schedules — the same set dev/start serve
    expect(stderr).toMatch(/looked in agent\/schedules/); // a misplaced schedule reads as "wrong place", not "broken file"
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
    expect(info.context.length).toBeGreaterThan(0); // the AGENTS.md is loaded as ② project context
    expect(info.skills.map((s: { name: string }) => s.name)).toEqual(["greet"]); // the malformed skill is skipped
    expect(JSON.stringify(info.diagnostics)).toMatch(/description/); // info SURFACES the loader diagnostic to the user
    expect(info.channels).toEqual(["github"]);
    await expect(stat(join(dir, ".fastagent"))).rejects.toThrow(); // read-only: never creates sessions dir
  });

  it("info degrades when a tool can't load (missing dep) — reports it, still shows the surface, exits 0", async () => {
    // The scaffold ships tools/ that import @fastagent-sh/fastagent; before `npm install` the import fails.
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
    expect(info.context.length).toBeGreaterThan(0); // the rest of the surface still shows
    await expect(stat(join(dir, ".fastagent"))).rejects.toThrow(); // still read-only

    // text mode: the tools line degrades and the reason goes to stderr as a warning
    const text = await run(["info", dir], undefined, env);
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(/tools:\s+\(none\)/); // the broken tool was skipped, nothing else to show
    expect(text.stderr).toMatch(/broken\.ts/); // the reason is a warning on stderr
  });

  it("info loads schedules — a broken one is reported (exit 0), a good one carries its next instant", async () => {
    // Same G2 isolation as tools: a broken schedule file (bad cron) is skipped + reported at info time,
    // not first at `dev`; the good schedule still shows, with its next fire instant.
    const dir = await mkdtemp(join(tmpdir(), "fa-info-schedfail-"));
    await mkdir(join(dir, "schedules"), { recursive: true });
    await writeFile(join(dir, "AGENTS.md"), "You are terse.\n");
    await writeFile(
      join(dir, "schedules", "good.mjs"),
      'export default { cron: "0 9 * * *", tz: "UTC", prompt: "digest" };\n',
    );
    await writeFile(join(dir, "schedules", "bad.mjs"), 'export default { cron: "not a cron", prompt: "x" };\n');
    const env = { ...process.env };
    delete env.FASTAGENT_MODEL;

    const { code, stdout } = await run(["info", dir, "--json"], undefined, env);
    expect(code).toBe(0); // reported, not fatal
    const info = JSON.parse(stdout);
    expect(info.schedules).toHaveLength(1);
    expect(info.schedules[0]).toMatchObject({ name: "good", cron: "0 9 * * *" });
    expect(info.schedules[0].next).toMatch(/T09:00:00\.000Z$/); // loaded → the next instant is printable
    expect(JSON.stringify(info.scheduleFailures)).toMatch(/bad\.mjs/); // the broken one is surfaced per-file
    expect(info.selfSchedule).toBe(false); // no config → wake tool won't mount

    // text mode: next instant on the schedules line, the failure as a stderr warning
    const text = await run(["info", dir], undefined, env);
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(/schedules: good \(next .*T09:00:00\.000Z\)/);
    expect(text.stdout).toMatch(/selfSchedule: off/);
    expect(text.stderr).toMatch(/bad\.mjs/);
  });

  it("login self-ignores .fastagent on an adapted dir before it writes the credential file", async () => {
    // login is the command that CREATES the secret, so its self-ignore must fire independently of the
    // opener — and BEFORE the interactive gate below, so the .gitignore is written even though this
    // non-TTY spawn then fails fast. That .gitignore is the proof the leak guard ran. Adapted dir = no
    // root .gitignore (the feature's core use case).
    const cwd = await mkdtemp(join(tmpdir(), "fa-login-cli-"));
    const env = { ...process.env };
    delete env.FASTAGENT_AUTH_PATH; // ensure the in-tree default (not a dev's global override)
    const { code } = await run(["login", "no-such-provider"], cwd, env);
    expect(code).not.toBe(0);
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(join(cwd, ".fastagent", ".gitignore"), "utf8")).toBe("*\n");
  });

  it("login fails fast in a non-TTY (a pipe/CI) instead of hanging on the interactive menu", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "fa-login-tty-"));
    const { code, stderr } = await run(["login", "openai-codex"], cwd); // run() pipes stdio → not a TTY
    expect(code).toBe(1);
    expect(stderr).toMatch(/login is interactive.*run it in a terminal/);
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
