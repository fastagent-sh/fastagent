import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { containerArtifacts, GENERATED_DOCKERFILE_MARKER } from "../src/deploy/container.ts";
import { agentWorkspace, run, runInProcess } from "./cli-run.ts";
import { CODEX_MODEL } from "./codex-model.ts";

/** Whether `pid` runs: signal 0 only asks. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("cli: deploy and the variables that set the configuration", () => {
  const agent = () =>
    agentWorkspace("fa-deploy-vars-", {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
      ".secrets/production/.env": "FASTAGENT_HTTP_API=false\nFASTAGENT_THINKING_LEVEL=low\n",
    });
  const delivered = async (dir: string) =>
    JSON.parse(await readFile(join(dir, ".fastagent/deploy", "fastagent.json"), "utf8"));

  it("decides with what the production value file says and delivers it, so the box runs what the deploy planned", async () => {
    const dir = await agent();
    const result = await runInProcess(["deploy", "fly", dir]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/Agent API: not served/);
    // Fly adds the URL it mints beside them.
    expect(await delivered(dir)).toMatchObject({ http: { api: false }, thinkingLevel: "low" });
  });

  it("reads the value file only: this shell's variable is not a source, as for the model", async () => {
    const dir = await agentWorkspace("fa-deploy-vars-shell-", {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
    });
    const result = await runInProcess(["deploy", "fly", dir], undefined, {
      ...process.env,
      FASTAGENT_HTTP_API: "false",
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).not.toMatch(/Agent API: not served/);
    expect(await delivered(dir)).not.toHaveProperty("http.api");
    expect(await delivered(dir)).not.toHaveProperty("thinkingLevel");
  });

  it("refuses a value the configuration would refuse, naming the variable and the file", async () => {
    const dir = await agentWorkspace("fa-deploy-vars-bad-", {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
      ".secrets/production/.env": "FASTAGENT_THINKING_LEVEL=loud\n",
    });
    const result = await runInProcess(["deploy", "fly", dir]);
    expect([result.code, result.stderr]).toEqual([
      1,
      expect.stringContaining("FASTAGENT_THINKING_LEVEL in .secrets/production/.env: /thinkingLevel"),
    ]);
  });
});

describe("cli: deploy --idle-timeout", () => {
  const agent = () =>
    agentWorkspace("fa-deploy-idle-", {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini", deploy: { agentcore: { idleTimeoutSeconds: 600 } } } };\n`,
    });
  const template = async (dir: string) => readFile(join(dir, "agentcore.template.yaml"), "utf8");

  it("sets AgentCore's idle timeout over the program's default, which is what an unflagged deploy uses", async () => {
    const dir = await agent();
    expect((await runInProcess(["deploy", "agentcore", dir])).code).toBe(0);
    expect(await template(dir)).toContain("IdleRuntimeSessionTimeout: 600");
    const flagged = await runInProcess(["deploy", "agentcore", dir, "--idle-timeout", "900", "--force"]);
    expect(flagged.code, flagged.stderr).toBe(0);
    expect(await template(dir)).toContain("IdleRuntimeSessionTimeout: 900");
  });

  it("refuses a value AWS would refuse, writing no artifact, and is reported by the hosts that have no idle timeout", async () => {
    const dir = await agent();
    for (const value of ["30", "1209601", "abc", "90.5"]) {
      const result = await runInProcess(["deploy", "agentcore", dir, "--idle-timeout", value]);
      expect([result.code, result.stderr]).toEqual([
        2,
        expect.stringContaining("--idle-timeout must be a whole number of seconds from 60 to 1209600"),
      ]);
      await expect(stat(join(dir, "agentcore.template.yaml"))).rejects.toThrow();
    }
    const fly = await runInProcess(["deploy", "fly", dir, "--idle-timeout", "900"]);
    expect(fly.stderr).toContain("--idle-timeout: agentcore-only");
  });
});

describe("cli: deploy", () => {
  it("selects the production value file and Docker env_file without reading dev values", async () => {
    const dir = await agentWorkspace("fa-deploy-env-", {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
      ".secrets/.env": "FASTAGENT_MODEL=not-a-model\nDEV_ONLY=secret\n",
      ".secrets/production/.env": "FASTAGENT_MODEL=openai/gpt-4o-mini\nPRODUCTION_ONLY=value\n",
    });
    const result = await runInProcess(["deploy", "docker", dir]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("source: .secrets/production/.env");
    // `deploy` builds first, generate-only included: the image's `start` opens dist/.
    expect(await stat(join(dir, "dist", "index.js"))).toBeDefined();
    expect(result.stdout).not.toContain("DEV_ONLY");
    expect(await readFile(join(dir, "fastagent.compose.yml"), "utf8")).toContain(".secrets/production/.env");
  });

  it("an unattended first deploy requires production app values rather than reusing the dev app", async () => {
    const dir = await agentWorkspace("fa-deploy-new-app-", {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
      ".secrets/.env": "FEISHU_APP_ID=cli_dev\nFEISHU_APP_SECRET=dev_secret\nFEISHU_VERIFICATION_TOKEN=dev_token\n",
      // As \`needs\` returns it, so the fixture needs no package of its own.
      "src/channels/feishu.mjs": `export default {
  kind: "fastagent.needs",
  secrets: ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_VERIFICATION_TOKEN"].map((name) => ({ name, optional: false })),
  build: () => () => ({ "POST /feishu": () => new Response("ok") }),
};\n`,
    });
    const result = await runInProcess(["deploy", "fly", dir, "--run", "--no-input"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      ".secrets/production/.env has no FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_VERIFICATION_TOKEN",
    );
    // Named so it runs from where this deploy ran: the agent is not the current directory here.
    expect(result.stderr).toContain(`\`fastagent deploy fly ${dir} --run --json\`, which hands their part to its user`);
    expect(await readFile(join(dir, ".secrets", ".env"), "utf8")).toContain("FEISHU_APP_ID=cli_dev");
    await expect(stat(join(dir, "Dockerfile"))).rejects.toThrow();
  });

  it("deploy WIRES the ownership rule — the real command keeps a file it did not generate", async () => {
    // The rule itself (exists x ours x force) is a state machine, tested at its own level in
    // test/deploy-artifacts.test.ts; eight spawns proving it here made this the slowest and only flaky
    // test in the suite. What a subprocess is for is the WIRING: that the command actually consults it.
    const dir = await agentWorkspace("fa-deploy-ignore-", {
      "fastagent.config.ts": `export default { defaults: { model: "${CODEX_MODEL}" } };\n`,
      "package.json": `{"type":"module"}`,
    });
    expect((await runInProcess(["deploy", "fly", dir])).code).toBe(0);
    expect(await readFile(join(dir, ".dockerignore"), "utf8")).toMatch(/^# Generated by/);
    // Artifacts land in the agent directory.
    expect(await readFile(join(dir, "Dockerfile"), "utf8")).toMatch(/agent directory is baked at \/app$/m);
    expect(await readFile(join(dir, "fly.toml"), "utf8")).toMatch(/FASTAGENT_SECRETS_DIR/);

    const hostIgnore = "# the author's own rules\n.git\ndist\n"; // no marker → the author's
    await writeFile(join(dir, ".dockerignore"), hostIgnore);
    const forced = await runInProcess(["deploy", "fly", dir, "--force"]);
    expect(forced.code).toBe(0);
    // The safety boundary docs/deploy.md promises: --force NEVER clobbers the author's file.
    expect(await readFile(join(dir, ".dockerignore"), "utf8")).toBe(hostIgnore);
    expect(forced.stderr).toMatch(/kept \.dockerignore — not generated by fastagent/);
    expect(forced.stderr).toMatch(/BAKE SECRETS INTO THE IMAGE/); // the critical kept-file warn fired (not force-gated)
    expect(forced.stderr).toMatch(/excludes \.git/); // …and the history note
  });

  /** An `aws` and a `docker` on PATH that answer the reads before the build; `held` is what the secret holds. */
  async function fakeAwsAndDocker(held: string) {
    const bin = await mkdtemp(join(tmpdir(), "fa-aws-"));
    const called = join(bin, "called");
    await writeFile(
      join(bin, "aws"),
      `#!/bin/sh
echo "$@" >> ${called}
case "$1 $2" in
  "sts get-caller-identity") echo '{"Account":"123456789012"}';;
  "configure get") echo us-west-2;;
  "cloudformation describe-stacks") echo "Stack with id x does not exist" >&2; exit 254;;
  "secretsmanager describe-secret") echo '{"Name":"x"}';;
  "secretsmanager get-secret-value") echo '${held}';;
  "bedrock-agentcore-control list-agent-runtimes") echo '{}';;
  *) exit 1;;
esac
`,
      { mode: 0o755 },
    );
    await writeFile(
      join(bin, "docker"),
      `#!/bin/sh\necho "docker $@" >> ${called}\ncase "$1" in version|buildx) exit 0;; esac\nexit 1\n`,
      { mode: 0o755 },
    );
    return { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, calls: () => readFile(called, "utf8") };
  }

  it("deploy agentcore --run with a login to redo and no terminal stops before the build and the stack", async () => {
    // Every AgentCore deploy wipes the runtime's login; with nobody to redo it, the deploy would replace a serving
    // runtime with one that cannot answer. Decided once the target's values are known, and before anything is built.
    const dir = await agentWorkspace("fa-deploy-ac-login-", {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
    });
    const aws = await fakeAwsAndDocker("{}");
    const result = await runInProcess(["deploy", "agentcore", dir, "--run"], undefined, aws.env);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/wipes the runtime's openai login.*run this deploy in a terminal/);
    // The coding agent's way names this agent, run from wherever this deploy was; the key's variable is named.
    expect(result.stderr).toContain(
      `\`fastagent deploy agentcore ${dir} --run --json\`, which hands the login to its user`,
    );
    expect(result.stderr).toContain("fastagent secrets set agentcore OPENAI_API_KEY");
    const calls = await aws.calls();
    expect(calls).not.toMatch(/cloudformation deploy|ecr |s3 |s3api |docker buildx build|docker login/);
  });

  it("deploy agentcore --run goes on when the target already holds the model's key: there is no login to redo", async () => {
    const dir = await agentWorkspace("fa-deploy-ac-key-", {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
    });
    const aws = await fakeAwsAndDocker('{"OPENAI_API_KEY":"sk"}');
    const result = await runInProcess(["deploy", "agentcore", dir, "--run"], undefined, aws.env);
    expect(result.stderr).not.toContain("wipes the runtime");
    // Past the stop: the docker CLI of the fake refuses, which is the next thing the deploy needs.
    expect(await aws.calls()).toContain("ecr describe-repositories");
  });

  it("deploy agentcore --run --json goes on past that stop: its ticket has someone to redo the login", async () => {
    const dir = await agentWorkspace("fa-deploy-ac-ticket-", {
      "fastagent.config.ts": `export default { defaults: { model: "${CODEX_MODEL}" } };\n`,
    });
    const bin = await mkdtemp(join(tmpdir(), "fa-aws-"));
    const called = join(bin, "called");
    await writeFile(join(bin, "aws"), `#!/bin/sh\necho "$@" >> ${called}\nexit 1\n`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    const started = await run(["deploy", "agentcore", dir, "--run", "--json"], undefined, env);
    let report = JSON.parse(started.stdout);
    for (let tries = 0; report.status === "working" && tries < 40; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      report = JSON.parse((await run(["deploy", "agentcore", "--check", report.ticket], undefined, env)).stdout);
    }
    // Past the stop: the AWS CLI was asked, and what it answered is the ticket's reason.
    expect(report).toMatchObject({ status: "failed", deployment: "agentcore", message: expect.stringMatching(/AWS/) });
    expect(await readFile(called, "utf8")).toContain("sts get-caller-identity");
  });

  it.each([
    [
      "fly",
      'case "$1 $2" in "auth whoami") exit 1;; "auth login") echo "Open https://fly.io/app/auth/cli/abc123"; sleep 30;; esac',
      // A code the approval page shows comes back through --check --code.
      { url: "https://fly.io/app/auth/cli/abc123", resume_command: expect.stringMatching(/--check \w+ --code/) },
    ],
    [
      "railway",
      'case "$1" in whoami) exit 1;; login) echo "https://railway.com/activate?user_code=AB-12" >&2; sleep 30;; esac',
      { url: "https://railway.com/activate?user_code=AB-12", code: "AB-12" },
    ],
  ])("deploy %s --run --json hands a signed-out host CLI's sign-in to the person", async (host, body, expected) => {
    const dir = await agentWorkspace(`fa-deploy-${host}-login-`, {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
      ".secrets/production/.env": "OPENAI_API_KEY=sk\n",
    });
    const bin = await mkdtemp(join(tmpdir(), "fa-host-cli-"));
    await writeFile(join(bin, host), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    let report = JSON.parse((await run(["deploy", host, dir, "--run", "--json"], undefined, env)).stdout);
    try {
      for (let tries = 0; report.status === "working" && tries < 40; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        report = JSON.parse((await run(["deploy", host, "--check", report.ticket], undefined, env)).stdout);
      }
      expect(report).toMatchObject({
        status: "need_user_action",
        deployment: host,
        ...expected,
        stop_command: `fastagent deploy ${host} --check ${report.ticket} --stop --json`,
      });
      // The way out of a deploy no deadline cuts: stopped where it is, with what it started.
      const stopped = await run(["deploy", host, "--check", report.ticket, "--stop", "--json"], undefined, env);
      expect(JSON.parse(stopped.stdout)).toMatchObject({
        status: "failed",
        message: expect.stringMatching(/^stopped on request/),
      });
    } finally {
      const ticket = JSON.parse(
        await readFile(
          join(process.env.HOME as string, ".fastagent", ".state", "tickets", `${report.ticket}.json`),
          "utf8",
        ),
      );
      expect(ticket.pid === undefined || !isRunning(ticket.pid)).toBe(true);
      if (ticket.pid && isRunning(ticket.pid)) process.kill(ticket.pid);
    }
  });

  it("deploy: generate mode succeeds with the WYSIWYG note; the agentDir config key is retired", async () => {
    const dir = await agentWorkspace("fa-deploy-gen-", {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
    });
    const result = await runInProcess(["deploy", "fly", dir]);
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/baked as the definition/); // the WYSIWYG bake note is stated
    // Where the Agent API is reached, as Fly names the app, and how its key comes about: a generate-only deploy has
    // set nothing.
    expect(result.stderr).toMatch(
      /Agent API: https:\/\/[\w-]+\.fly\.dev\/v1, behind FASTAGENT_API_KEY, which --run makes and sets on the target/,
    );
    // With a key in the production value file, run from elsewhere the check names the agent: that is where
    // `invoke --url` finds the key.
    await mkdir(join(dir, ".secrets", "production"), { recursive: true });
    await writeFile(join(dir, ".secrets", "production", ".env"), "FASTAGENT_API_KEY=k\n");
    const keyed = await runInProcess(["deploy", "fly", dir]);
    expect(keyed.code, keyed.stderr).toBe(0);
    expect(/check it: .* "hello" (\S+)\n/.exec(keyed.stderr)?.[1]).toBe(dir);
    expect(result.stderr).not.toMatch(/not yet supported/); // no placement gate anywhere

    // The retired config key fails visibly — placement is structural now, never configured.
    const legacy = await agentWorkspace("fa-deploy-legacy-", {
      "fastagent.config.ts": `export default { agentDir: "./agent" };\n`,
    });
    const rejected = await runInProcess(["deploy", "fly", legacy]);
    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toMatch(/unknown key "agentDir"/);
  });

  it("plans a channel the way the configuration it delivers chooses, webhook without one", async () => {
    const dir = await agentWorkspace("fa-deploy-ingress-", {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
      // byIngress as it returns, so the fixture needs no package of its own.
      "src/channels/hook.ts":
        'export default { kind: "fastagent.by-ingress", webhook: () => ({ "POST /hook": () => new Response("ok") }), ' +
        'connection: { name: "hook", connect: () => ({ ready: Promise.resolve(), closed: new Promise(() => {}) }) } };\n',
      ".secrets/production/.env": "OPENAI_API_KEY=sk\n",
    });
    const plain = await runInProcess(["deploy", "docker", dir]);
    expect(plain.code, plain.stderr).toBe(0);
    expect(plain.stderr).toContain('route channel "hook" is custom');
    const config = join(dirname(dir), "websocket.json");
    await writeFile(config, JSON.stringify({ channels: { hook: { ingress: "connection" } } }));
    const chosen = await runInProcess(["deploy", "docker", dir, "--config", config, "--force"]);
    expect(chosen.code, chosen.stderr).toBe(0);
    expect(chosen.stderr).toContain('long-connection channel "hook" is custom');
  });

  it("deploy --config delivers the instance configuration into the image's /etc/fastagent/, and decides with it", async () => {
    const dir = await agentWorkspace("fa-deploy-config-", {
      "fastagent.config.ts": `import { obj, str } from "@earendil-works/pi-schema";
export default { settings: obj({ repo: str() }), defaults: { model: "openai/gpt-4o-mini" } };\n`,
    });
    await mkdir(join(dir, "node_modules", "@earendil-works"), { recursive: true });
    const { symlink } = await import("node:fs/promises");
    await symlink(
      new URL("../node_modules/@earendil-works/pi-schema", import.meta.url).pathname,
      join(dir, "node_modules", "@earendil-works", "pi-schema"),
      "dir",
    );
    // A required setting no default gives: the program alone does not deploy, as the box would not start.
    const bare = await runInProcess(["deploy", "fly", dir]);
    expect([bare.code, bare.stderr]).toEqual([1, expect.stringContaining("/repo missing")]);

    const config = join(await mkdtemp(join(tmpdir(), "fa-deploy-config-file-")), "production.json");
    await writeFile(config, JSON.stringify({ settings: { repo: "acme/api" }, http: { api: false } }));
    const delivered = await runInProcess(["deploy", "fly", dir, "--config", config]);
    expect(delivered.code, delivered.stderr).toBe(0);
    // The configuration decides the deployment's own choices: here, no Agent API key.
    expect(delivered.stderr).toMatch(/Agent API: not served/);
    const manifest = JSON.parse(await readFile(join(dir, ".fastagent/deploy", "fastagent.release.json"), "utf8"));
    // In a directory of its own, apart from the program's, which the image copies to /etc/fastagent/ and names.
    expect(manifest.config).toBeUndefined();
    const dockerfile = await readFile(join(dir, "Dockerfile"), "utf8");
    expect(dockerfile).toContain(
      "COPY .fastagent/deploy/ /etc/fastagent/\nENV FASTAGENT_CONFIG=/etc/fastagent/fastagent.json",
    );
    // With the app's URL as its http.publicUrl, which Fly's is known before the build: the box points its channels
    // there.
    const flyUrl = expect.stringMatching(/^https:\/\/fa-deploy-config-[a-z0-9-]+\.fly\.dev$/);
    expect(JSON.parse(await readFile(join(dir, ".fastagent/deploy", "fastagent.json"), "utf8"))).toEqual({
      settings: { repo: "acme/api" },
      http: { api: false, publicUrl: flyUrl },
    });
    // The project's own development configuration stays out of the image.
    const ignore = await readFile(join(dir, ".dockerignore"), "utf8");
    expect(ignore).toMatch(/^\/fastagent\.json$/m);
    // Docker lets a negation re-include inside an excluded directory, which BuildKit and the classic builder both
    // answer for `/.fastagent` followed by `!/.fastagent/deploy` (verified); the order is the whole rule.
    expect(ignore.indexOf("!/.fastagent/deploy")).toBeGreaterThan(ignore.indexOf("\n/.fastagent\n"));

    // Every deploy writes it again, whoever wrote it before: a build output, never a file kept as the author's.
    await writeFile(config, JSON.stringify({ settings: { repo: "acme/web" } }));
    const again = await runInProcess(["deploy", "fly", dir, "--config", config]);
    expect(again.code, again.stderr).toBe(0);
    expect(JSON.parse(await readFile(join(dir, ".fastagent/deploy", "fastagent.json"), "utf8"))).toEqual({
      settings: { repo: "acme/web" },
      http: { publicUrl: flyUrl },
    });
    // An operator's own URL (a custom domain) is theirs to name, and kept.
    await writeFile(
      config,
      JSON.stringify({ settings: { repo: "acme/web" }, http: { publicUrl: "https://agent.acme.com" } }),
    );
    const own = await runInProcess(["deploy", "fly", dir, "--config", config]);
    expect(own.code, own.stderr).toBe(0);
    expect(JSON.parse(await readFile(join(dir, ".fastagent/deploy", "fastagent.json"), "utf8"))).toEqual({
      settings: { repo: "acme/web" },
      http: { publicUrl: "https://agent.acme.com" },
    });
    // Without --config, only the host's URL: the program's defaults, never what an earlier deploy delivered.
    const other = await agentWorkspace("fa-deploy-config-none-", {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
    });
    await writeFile(config, JSON.stringify({ thinkingLevel: "high" }));
    expect((await runInProcess(["deploy", "fly", other, "--config", config])).code).toBe(0);
    const plain = await runInProcess(["deploy", "fly", other]);
    expect(plain.code, plain.stderr).toBe(0);
    expect(JSON.parse(await readFile(join(other, ".fastagent/deploy", "fastagent.json"), "utf8"))).toEqual({
      http: { publicUrl: expect.stringMatching(/\.fly\.dev$/) },
    });

    const missing = await runInProcess(["deploy", "fly", dir, "--config", join(dirname(config), "absent.json")]);
    expect([missing.code, missing.stderr]).toEqual([1, expect.stringContaining("absent.json")]);
  });

  it("never clobbers an existing Dockerfile: flags a stale generated one, warns on a hand-written one (G6)", async () => {
    // deploy KEEPS any existing Dockerfile without --force (no silent data loss). A generated one (marker)
    // that drifted from current config is flagged stale; a hand-written one is kept (preflight warns when the
    // environment then won't reach the image). An up-to-date generated one is kept quietly. Marker/predicate come
    // from container.ts (single source).
    const setup = async (dockerfileContent: string) => {
      const dir = await agentWorkspace("fa-kept-", {
        "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
        Dockerfile: dockerfileContent,
      });
      await writeFile(join(dir, "AGENTS.md"), "You are terse.\n");
      const res = await runInProcess(["deploy", "railway", dir]);
      // Railway mints the domain later, so the report says where the API goes on it.
      expect(res.stderr).toContain("Agent API: <the deployment's URL>/v1");
      return { res, dockerfile: await readFile(join(dir, "Dockerfile"), "utf8") };
    };

    // A generated-but-edited Dockerfile (marker kept, a hand-added line) → flagged stale, NEVER overwritten.
    const edited = `${GENERATED_DOCKERFILE_MARKER}. was generated\nFROM node:22-slim\nRUN echo my-own-edit\n`;
    const gen = await setup(edited);
    expect(gen.res.stderr).toMatch(/no longer matches what deploy would generate/); // stale flagged
    expect(gen.res.stderr).toMatch(/--force to regenerate/);
    expect(gen.dockerfile).toBe(edited); // preserved — the user's edit survives (no data loss)

    // An up-to-date generated Dockerfile (built with the SAME inputs deploy uses) → kept quietly, no stale flag.
    const current = containerArtifacts({
      releaseId: "release-one",
      agent: "any",
      runtime: "node",
      hasLockfile: false,
      apt: [],
    }).find((a) => a.path === "Dockerfile")!.content;
    const fresh = await setup(current);
    expect(fresh.res.stderr).not.toMatch(/no longer matches/); // identical → nothing to flag

    // A HAND-WRITTEN Dockerfile (no marker) → kept verbatim.
    const hw = await setup("FROM python:3.12\n");
    expect(hw.dockerfile).toBe("FROM python:3.12\n"); // preserved, never clobbered
  });
});
