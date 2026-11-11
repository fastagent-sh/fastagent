import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { containerArtifacts, GENERATED_DOCKERFILE_MARKER } from "../src/deploy/container.ts";
import { agentcoreTemplateFile } from "../src/deploy/agentcore/plan.ts";
import { deploymentName } from "../src/deploy/deployment-name.ts";
import { dockerComposeFile } from "../src/deploy/docker/plan.ts";
import { flyTomlFile } from "../src/deploy/fly/plan.ts";
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

/** The variables a generated `fly.<name>.toml` sets on the box, as the box reads them. */
async function flyVariables(dir: string, name: string): Promise<Record<string, string>> {
  const toml = await readFile(join(dir, flyTomlFile(name)), "utf8");
  const found = [...toml.matchAll(/^ {2}(FASTAGENT_(?:NAME|RELEASE_ID|CONFIG_JSON)) = (".*")$/gm)];
  return Object.fromEntries(found.map((m) => [m[1] as string, JSON.parse(m[2] as string) as string]));
}

/** The configuration a deploy of `dir` to Fly delivers, parsed. */
async function flyConfig(dir: string, name: string): Promise<unknown> {
  return JSON.parse((await flyVariables(dir, name)).FASTAGENT_CONFIG_JSON as string);
}

describe("cli: deploy and the variables that set the configuration", () => {
  it("does not read them: a deployment's configuration is the program's defaults and what --config delivers", async () => {
    const dir = await agentWorkspace("fa-deploy-vars-", {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
      ".secrets/production/.env": "FASTAGENT_HTTP_API=false\nFASTAGENT_THINKING_LEVEL=low\n",
    });
    const result = await runInProcess(["deploy", "fly", dir], undefined, {
      ...process.env,
      FASTAGENT_HTTP_API: "false",
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).not.toMatch(/Agent API: not served/);
    const delivered = await flyConfig(dir, await deploymentName(dir));
    expect(delivered).not.toHaveProperty("http.api");
    expect(delivered).not.toHaveProperty("thinkingLevel");
  });
});

describe("cli: deploy, an instance of its own", () => {
  const instances = async () => {
    const dir = await agentWorkspace("fa-deploy-instances-", {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
    });
    const configs = await mkdtemp(join(tmpdir(), "fa-deploy-instances-config-"));
    for (const name of ["acme", "globex"]) await writeFile(join(configs, `${name}.json`), JSON.stringify({ name }));
    return { dir, config: (name: string) => join(configs, `${name}.json`) };
  };

  it("two instances of one directory are two deployments: each its own name, its own manifest, neither touching the other", async () => {
    const { dir, config } = await instances();
    for (const name of ["acme", "globex"]) {
      const result = await runInProcess(["deploy", "fly", dir, "--config", config(name)]);
      expect(result.code, result.stderr).toBe(0);
      expect(await readFile(join(dir, `fly.${name}.toml`), "utf8")).toContain(`app = "${name}"`);
    }
    // The first deploy's file is still its own after the second ran: nothing was shared or overwritten.
    expect(await readFile(join(dir, "fly.acme.toml"), "utf8")).toContain('app = "acme"');
    await expect(stat(join(dir, "fly.toml"))).rejects.toThrow();
    const docker = await runInProcess(["deploy", "docker", dir, "--config", config("acme")]);
    expect(docker.code, docker.stderr).toBe(0);
    expect(await readFile(join(dir, "fastagent.acme.compose.yml"), "utf8")).toMatch(/^name: .*acme/m);
  });

  it("an instance's name and configuration are in its own manifest, and every instance builds the same image", async () => {
    const { dir, config } = await instances();
    const dockerfiles: string[] = [];
    for (const name of ["acme", "globex"]) {
      const result = await runInProcess(["deploy", "fly", dir, "--config", config(name)]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).not.toContain("LAST");
      const variables = await flyVariables(dir, name);
      expect(variables.FASTAGENT_NAME).toBe(name);
      expect(JSON.parse(variables.FASTAGENT_CONFIG_JSON as string)).toMatchObject({ name });
      dockerfiles.push(await readFile(join(dir, "Dockerfile"), "utf8"));
    }
    // What each wrote is still there after the other: the manifests differ, the image does not.
    expect((await flyVariables(dir, "acme")).FASTAGENT_NAME).toBe("acme");
    expect((await flyVariables(dir, "acme")).FASTAGENT_RELEASE_ID).not.toBe(
      (await flyVariables(dir, "globex")).FASTAGENT_RELEASE_ID,
    );
    expect(dockerfiles[0]).toBe(dockerfiles[1]);
    // The build directory holds the program's package list and nothing of an instance.
    expect(await readdir(join(dir, ".fastagent/deploy"))).toEqual(["fastagent.packages"]);
  });

  it("refuses a configuration a host's variable cannot hold: Railway's 32768 characters, AgentCore's 4096 bytes in all", async () => {
    const { dir } = await instances();
    const big = (size: number) => {
      const file = join(dirname(dir), `big-${size}.json`);
      return writeFile(file, JSON.stringify({ description: "x".repeat(size) })).then(() => file);
    };
    const railway = await runInProcess(["deploy", "railway", dir, "--config", await big(33000), "--run"]);
    expect([railway.code, railway.stderr]).toEqual([
      1,
      expect.stringContaining("a Railway variable holds at most 32768: FASTAGENT_CONFIG_JSON carries it whole"),
    ]);
    const agentcore = await runInProcess(["deploy", "agentcore", dir, "--config", await big(4000), "--run"]);
    expect([agentcore.code, agentcore.stderr]).toEqual([
      1,
      expect.stringMatching(/deploy stopped: the runtime's environment variables add up to \d+ bytes .* over the 4096/),
    ]);
    // Generate-only says it and goes on: nothing is deployed, and the manifest shows what would not fit.
    const planned = await runInProcess(["deploy", "agentcore", dir, "--config", await big(4000)]);
    expect(planned.code, planned.stderr).toBe(0);
    expect(planned.stderr).toMatch(/warn: the runtime's environment variables add up to/);
    // What fits goes through the same check unremarked.
    const fits = await runInProcess(["deploy", "agentcore", dir, "--config", await big(100)]);
    expect(fits.stderr).not.toMatch(/environment variables add up to/);
  });

  it("warns once of a manifest an earlier version wrote, which is no longer read, and names the file that replaces it", async () => {
    const { dir, config } = await instances();
    await writeFile(join(dir, "fly.toml"), '# Generated by `fastagent deploy fly`\napp = "mine"\n');
    await writeFile(join(dir, "fastagent.compose.yml"), "# my own compose, no marker\n");
    const fly = await runInProcess(["deploy", "fly", dir, "--config", config("acme")]);
    expect(fly.code, fly.stderr).toBe(0);
    expect(fly.stderr).toContain("fly.toml was generated by an earlier version and is no longer read");
    expect(fly.stderr).toContain("this instance's manifest is fly.acme.toml");
    // The author's own file, with no marker, is not ours to remark on.
    const docker = await runInProcess(["deploy", "docker", dir, "--config", config("acme")]);
    expect(docker.stderr).not.toContain("earlier version");
  });

  it("the commands that address a deployment take the instance from --config: a configuration they cannot read stops them", async () => {
    const { dir } = await instances();
    const missing = join(dir, "absent.json");
    for (const argv of [
      ["destroy", "agentcore", dir, "--config", missing],
      ["logs", "agentcore", dir, "--config", missing],
      ["secrets", "list", "fly", dir, "--config", missing],
    ]) {
      const result = await runInProcess(argv);
      expect([argv[0], result.code, result.stderr]).toEqual([
        argv[0],
        1,
        expect.stringContaining("cannot read the instance configuration"),
      ]);
    }
  });
});

describe("cli: deploy --idle-timeout", () => {
  const agent = () =>
    agentWorkspace("fa-deploy-idle-", {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini", deploy: { agentcore: { idleTimeoutSeconds: 600 } } } };\n`,
    });
  const template = async (dir: string) => readFile(join(dir, agentcoreTemplateFile(await deploymentName(dir))), "utf8");

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
      await expect(stat(join(dir, agentcoreTemplateFile(await deploymentName(dir))))).rejects.toThrow();
    }
    const fly = await runInProcess(["deploy", "fly", dir, "--idle-timeout", "900"]);
    expect(fly.stderr).toContain("--idle-timeout: agentcore-only");
  });
});

describe("cli: deploy", () => {
  it("a token held only in the project's own files is not a value the deploy was given", async () => {
    const dir = await agentWorkspace("fa-deploy-held-", {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
      "context.json": JSON.stringify({ content: { app: { github: "acme/app" } } }),
      ".secrets/.env": "GITHUB_TOKEN=held-by-dev\n",
      ".secrets/production/.env": "GITHUB_TOKEN=held-by-start\n",
    });
    const clean = { ...process.env };
    delete clean.GITHUB_TOKEN;
    const none = await runInProcess(["deploy", "docker", dir], undefined, clean);
    expect(none.code, none.stderr).toBe(0);
    expect(none.stderr).toContain("no GITHUB_TOKEN in the values given to this deploy");
    // The environment is a source when asked, and the file named is one always; the shell alone is not.
    const shell = { ...clean, GITHUB_TOKEN: "ghp" };
    const unasked = await runInProcess(["deploy", "docker", dir, "--force"], undefined, shell);
    expect(unasked.stderr).toContain("no GITHUB_TOKEN in the values given to this deploy");
    const given = await runInProcess(["deploy", "docker", dir, "--force", "--from-env"], undefined, shell);
    expect(given.stderr).not.toContain("no GITHUB_TOKEN");
    const file = join(dir, "given.env");
    await writeFile(file, "GITHUB_TOKEN=ghp\n");
    const named = await runInProcess(["deploy", "docker", dir, "--force", "--env-file", file], undefined, clean);
    expect(named.stderr).not.toContain("no GITHUB_TOKEN");
    expect(named.stderr).not.toContain("held-by");
  });

  it("reads no default value file: the model is the configuration's, and no file of the project reaches the manifest", async () => {
    const dir = await agentWorkspace("fa-deploy-env-", {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
      // The development file and the one `start` reads: a deployment reads neither, and neither's model is the box's.
      ".secrets/.env": "FASTAGENT_MODEL=not-a-model\nDEV_ONLY=dev-held-9f3\n",
      ".secrets/production/.env": "FASTAGENT_MODEL=anthropic/other\nPRODUCTION_ONLY=start-held-7c1\n",
    });
    const clean = { ...process.env };
    delete clean.FASTAGENT_MODEL;
    const result = await runInProcess(["deploy", "docker", dir], undefined, clean);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain("model openai/gpt-4o-mini (source: fastagent.config)");
    // `deploy` builds first, generate-only included: the image's `start` opens dist/.
    expect(await stat(join(dir, "dist", "index.js"))).toBeDefined();
    expect(result.stdout).not.toContain("DEV_ONLY");
    const compose = await readFile(join(dir, dockerComposeFile(await deploymentName(dir))), "utf8");
    expect(compose).not.toContain("env_file");
    for (const leaked of [
      "DEV_ONLY",
      "PRODUCTION_ONLY",
      "not-a-model",
      "anthropic/other",
      "dev-held-9f3",
      "start-held-7c1",
    ]) {
      expect(compose, leaked).not.toContain(leaked);
    }
    expect(JSON.parse(/FASTAGENT_CONFIG_JSON: (".*")$/m.exec(compose)?.[1] as string)).not.toContain("anthropic");

    // A FASTAGENT_MODEL in the shell or in a file names the machine it is on: the deployment's is its configuration.
    const shell = await runInProcess(["deploy", "docker", dir, "--force"], undefined, {
      ...process.env,
      FASTAGENT_MODEL: "anthropic/shell-model",
    });
    expect(shell.stderr).toContain("model openai/gpt-4o-mini (source: fastagent.config)");
    expect(await readFile(join(dir, dockerComposeFile(await deploymentName(dir))), "utf8")).not.toContain(
      "shell-model",
    );
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
    // The dev app's values are not the deployment's: nothing in the environment, and no file to make one into.
    expect(result.stderr).toContain(
      "FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_VERIFICATION_TOKEN are not in the values given to this deploy (--env-file or --from-env), so a production feishu app has to be made",
    );
    expect(result.stderr).toContain("`fastagent channels setup feishu --env-file <file>`");
    // With a file to keep it in, the next refusal is the one for nobody to ask; it names the deploy that runs from where
    // this one ran, with the file.
    const file = join(dir, "prod.env");
    await writeFile(file, "");
    const named = await runInProcess(["deploy", "fly", dir, "--run", "--no-input", "--env-file", file]);
    expect(named.code).toBe(2);
    expect(named.stderr).toContain(
      `\`fastagent deploy fly ${dir} --env-file ${file} --run --json\`, which hands their part to its user`,
    );
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
    expect(await readFile(join(dir, flyTomlFile(await deploymentName(dir))), "utf8")).toMatch(/FASTAGENT_SECRETS_DIR/);

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
      /Agent API: https:\/\/[\w-]+\.fly\.dev\/v1, behind FASTAGENT_API_KEY, which --run sets on the target from the values given to this deploy \(--env-file or --from-env\), or makes at a terminal/,
    );
    // With a key in this command's environment, run from elsewhere the check names the agent: `invoke --url` is run
    // from there with the same key.
    const shell = { ...process.env, FASTAGENT_API_KEY: "k" };
    // The shell is not a source unless asked: a key exported there is not one the deploy was given.
    const unasked = await runInProcess(["deploy", "fly", dir, "--force"], undefined, shell);
    expect(unasked.stderr).not.toMatch(/check it: /);
    const keyed = await runInProcess(["deploy", "fly", dir, "--from-env", "--force"], undefined, shell);
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

  it("deploy --config delivers the instance configuration as a variable of the host, and decides with it", async () => {
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
    // The image holds the program and nothing of the instance: no copy of the configuration, no variable naming one.
    const dockerfile = await readFile(join(dir, "Dockerfile"), "utf8");
    expect(dockerfile).not.toMatch(/FASTAGENT_CONFIG|\/etc\/fastagent|FASTAGENT_RELEASE/);
    // With the app's URL as its http.publicUrl, which Fly's is known before the build: the box points its channels
    // there.
    const name = await deploymentName(dir, config);
    const flyUrl = expect.stringMatching(/^https:\/\/fa-deploy-config-[a-z0-9-]+\.fly\.dev$/);
    expect(await flyConfig(dir, name)).toEqual({
      settings: { repo: "acme/api" },
      http: { api: false, publicUrl: flyUrl },
    });
    // The project's own development configuration stays out of the image.
    const ignore = await readFile(join(dir, ".dockerignore"), "utf8");
    expect(ignore).toMatch(/^\/fastagent\.json$/m);
    // Docker lets a negation re-include inside an excluded directory, which BuildKit and the classic builder both
    // answer for `/.fastagent` followed by `!/.fastagent/deploy` (verified); the order is the whole rule.
    expect(ignore.indexOf("!/.fastagent/deploy")).toBeGreaterThan(ignore.indexOf("\n/.fastagent\n"));

    // The manifest is the author's once written, so a changed configuration is kept out of it until `--force`: a
    // `--run` stops there, naming what drifted.
    await writeFile(config, JSON.stringify({ settings: { repo: "acme/web" } }));
    const kept = await runInProcess(["deploy", "fly", dir, "--config", config]);
    expect(kept.code, kept.stderr).toBe(0);
    expect(kept.stderr).toMatch(new RegExp(`kept ${flyTomlFile(name)} — it no longer matches`));
    expect(await flyConfig(dir, name)).toMatchObject({ settings: { repo: "acme/api" } });
    const again = await runInProcess(["deploy", "fly", dir, "--config", config, "--force"]);
    expect(again.code, again.stderr).toBe(0);
    expect(await flyConfig(dir, name)).toEqual({
      settings: { repo: "acme/web" },
      http: { publicUrl: flyUrl },
    });
    // An operator's own URL (a custom domain) is theirs to name, and kept.
    await writeFile(
      config,
      JSON.stringify({ settings: { repo: "acme/web" }, http: { publicUrl: "https://agent.acme.com" } }),
    );
    const own = await runInProcess(["deploy", "fly", dir, "--config", config, "--force"]);
    expect(own.code, own.stderr).toBe(0);
    expect(await flyConfig(dir, name)).toEqual({
      settings: { repo: "acme/web" },
      http: { publicUrl: "https://agent.acme.com" },
    });
    // Without --config, only the host's URL: the program's defaults, never what an earlier deploy delivered.
    const other = await agentWorkspace("fa-deploy-config-none-", {
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
    });
    await writeFile(config, JSON.stringify({ thinkingLevel: "high" }));
    expect((await runInProcess(["deploy", "fly", other, "--config", config])).code).toBe(0);
    const plain = await runInProcess(["deploy", "fly", other, "--force"]);
    expect(plain.code, plain.stderr).toBe(0);
    expect(await flyConfig(other, await deploymentName(other))).toEqual({
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
      config: "{}",
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
