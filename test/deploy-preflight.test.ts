import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflightDeploy } from "../src/deploy/preflight.ts";
import { createPiModels } from "../src/harnesses/models/environment.ts";
import type { AgentConfig as FastagentConfig } from "../src/harnesses/pi-durable/define.ts";
import { MISE_PACKAGE_NAMES } from "../src/environment/mise.ts";

/** An agent directory, as `init` produces one; `files` land in it. Named `agent`: a deployed agent's name is its
 *  directory's, and the temp prefix would not pass the release-name rule. */
async function agent(files: Record<string, string> = {}): Promise<string> {
  const host = await mkdtemp(join(tmpdir(), "fa-preflight-"));
  const dir = join(host, "agent");
  await mkdir(join(dir, ".secrets"), { recursive: true });
  await writeFile(join(dir, "SYSTEM.md"), "You are terse.\n");
  await writeFile(join(dir, "fastagent.config.ts"), "export default {};\n"); // THE marker
  // Real credential files: the leak gate only fires on paths that EXIST (nothing else can be baked).
  await writeFile(join(dir, ".secrets", "auth.json"), "{}\n");
  await writeFile(join(dir, ".secrets", ".env"), "K=v\n");
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true }); // a fixture may name a nested file (schedules/…)
    await writeFile(join(dir, name), content);
  }
  return dir;
}

const call = (target: string, config: FastagentConfig, over: Partial<Parameters<typeof preflightDeploy>[0]> = {}) =>
  preflightDeploy({
    agentDir: target,
    config,
    run: false,
    force: false,
    ...over,
  });

describe("deploy/preflight: the host-neutral pre-flight", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("gates a placement the release manifest could not carry, naming the directory", async () => {
    // `init --agent-dir` accepts any single path segment; the manifest joins this name onto the
    // storage root inside the container and accepts fewer. Without this gate the refusal surfaced
    // from artifact generation as "invalid deployment release manifest" — a file nobody wrote.
    const host = await mkdtemp(join(tmpdir(), "fa-preflight-"));
    const dir = join(host, "my.agent");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "fastagent.config.ts"), "export default {};\n");
    const pre = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(pre.ok).toBe(false);
    if (!pre.ok) expect(pre.gate).toContain('"my.agent"');
    await rm(host, { recursive: true, force: true });
  });

  it("gates --run when NO source resolves a model (would ship a crash-loop)", async () => {
    const dir = await agent(); // .secrets/.env holds no FASTAGENT_MODEL, config holds no model
    vi.stubEnv("FASTAGENT_MODEL", undefined);
    const pre = await call(dir, {}, { run: true });
    expect(pre.ok).toBe(false);
    if (!pre.ok) expect(pre.gate).toMatch(/no model resolves/);
  });

  it("names WHICH environment was read in that gate, without attributing the variable", async () => {
    // The chain is the usual one; it is evaluated in the environment being deployed. Someone with
    // FASTAGENT_MODEL set here sees `fastagent info` report a model, so the gate has to say which environment it
    // looked in rather than just "no model resolves". It must NOT call the value the operator's, though: the
    // first-run picker sets the same variable a second earlier when it cannot write the choice back to a config.
    const dir = await agent();
    vi.stubEnv("FASTAGENT_MODEL", "openai/gpt-4o-mini");
    const pre = await call(dir, {}, { run: true });
    expect(pre.ok).toBe(false);
    if (!pre.ok) {
      expect(pre.gate).toMatch(/belongs to this machine, not to the deployment/);
      expect(pre.gate).not.toMatch(/your shell|you exported/i);
    }
  });

  it("reads the model from the value file, reports the source, and hands back the value to carry", async () => {
    // The value file is how a deployment picks a model without editing the committed default; the operator's
    // shell is deliberately not a source, so this cannot be satisfied by exporting FASTAGENT_MODEL.
    const dir = await agent();
    await writeFile(join(dir, ".secrets", ".env"), "FASTAGENT_MODEL=openai/gpt-4o-mini\n");
    const pre = await call(dir, { model: "openai/other" }, { run: true });
    expect(pre.ok).toBe(true);
    if (!pre.ok) return;
    const source = ".secrets/.env"; // as READ, relative to the agent directory
    expect(pre.messages).toContainEqual({ level: "note", text: `model openai/gpt-4o-mini (source: ${source})` });
    // It travels BAKED into the image, not as a host variable: an image cannot interpolate the operator's shell,
    // and it is not a credential, so it stays out of the secret channel and every runbook's required list.
    expect(pre.container.modelSpec).toBe("openai/gpt-4o-mini");
    expect(pre.declaredSecrets.map((s) => s.name)).not.toContain("FASTAGENT_MODEL");
  });

  it("a config model bakes nothing extra — the config is already in the image", async () => {
    const pre = await call(await agent(), { model: "openai/gpt-4o-mini" }, { run: true });
    expect(pre.ok).toBe(true);
    if (!pre.ok) return;
    expect(pre.messages).toContainEqual({ level: "note", text: "model openai/gpt-4o-mini (source: fastagent.config)" });
    expect(pre.container.modelSpec).toBeUndefined();
  });

  it("gates a model that is not a spec — in EITHER source — but accepts a multi-segment modelId", async () => {
    // A provider-less spec resolves to nothing on the box, so letting it past this point ships the crash-loop the
    // gate exists to stop. `config.model` was the half that used to go unchecked. A `/` inside the modelId is not a
    // typo: 795 of pi's 1354 built-in specs look like `baseten/zai-org/GLM-5.3`, and resolution splits on the first
    // slash. Gated with or without `--run` — the manifest validates the spec on the way out, so there is no artifact
    // to produce either.
    const dir = await agent();
    for (const bad of ["openai/gpt-4o mini", "gpt-4o"]) {
      await writeFile(join(dir, ".secrets", ".env"), `FASTAGENT_MODEL=${bad}\n`);
      const pre = await call(dir, {});
      expect(pre.ok).toBe(false);
      if (!pre.ok) expect(pre.gate).toMatch(/is not a "provider\/modelId" spec/);
    }
    await writeFile(join(dir, ".secrets", ".env"), "");
    const fromConfig = await call(dir, { model: "gpt-4o" });
    expect(fromConfig.ok).toBe(false);
    if (!fromConfig.ok) expect(fromConfig.gate).toMatch(/model in fastagent\.config is not a "provider\/modelId"/);

    await writeFile(join(dir, ".secrets", ".env"), "FASTAGENT_MODEL=baseten/zai-org/GLM-5.3\n");
    const pre = await call(dir, {}, { run: true });
    expect(pre.ok && pre.container.modelSpec).toBe("baseten/zai-org/GLM-5.3");
  });

  it("gates a Dockerfile that cannot read the manifest — by the INSTRUCTION, not by who wrote the file", async () => {
    // `prepareStartWorkspace` returns early without FASTAGENT_RELEASE_FILE, so a model living only in the value
    // file would be reported here and missing on the box. The question is whether that ENV is set, not whether we
    // generated the file: a hand-written Dockerfile that sets it works, and must not be refused.
    const dir = await agent({ Dockerfile: "FROM node:22-slim\n" });
    await writeFile(join(dir, ".secrets", ".env"), "FASTAGENT_MODEL=openai/gpt-4o-mini\n");
    const gated = await call(dir, {}, { run: true });
    expect(gated.ok).toBe(false);
    if (!gated.ok) expect(gated.gate).toMatch(/does not set FASTAGENT_RELEASE_FILE/);

    // `--force` does not rescue it: writeArtifacts keeps a file it did not generate whatever the flag says.
    expect((await call(dir, {}, { run: true, force: true })).ok).toBe(false);

    // Generate-only warns instead of refusing.
    const planned = await call(dir, {});
    expect(planned.ok && planned.messages.some((m) => /FASTAGENT_RELEASE_FILE/.test(m.text))).toBe(true);

    // A hand-written Dockerfile that DOES set it is fine — the manifest is read whoever wrote the file. Including
    // the ordinary multi-variable spelling: reading only the first name after `ENV` false-gates a working file.
    for (const env of [
      "ENV FASTAGENT_RELEASE_FILE=/app/fastagent/fastagent.release.json",
      "ENV FASTAGENT_STORAGE_DIR=/data FASTAGENT_RELEASE_FILE=/app/fastagent/fastagent.release.json",
    ]) {
      const own = await agent({ Dockerfile: `FROM node:22-slim\n${env}\n` });
      await writeFile(join(own, ".secrets", ".env"), "FASTAGENT_MODEL=openai/gpt-4o-mini\n");
      expect((await call(own, {}, { run: true })).ok).toBe(true);
    }

    // And a config model needs no manifest at all.
    const fromConfig = await agent({ Dockerfile: "FROM node:22-slim\n" });
    expect((await call(fromConfig, { model: "openai/gpt-4o-mini" }, { run: true })).ok).toBe(true);
  });

  it("container facts come from the AGENT DIR; git auto-baked when it ships .git", async () => {
    const agentDir = await agent({
      "fastagent.config.ts": `export default { model: "openai/gpt-4o-mini" };\n`,
      "package.json": `{"type":"module","dependencies":{"@fastagent-sh/fastagent":"^1"}}`,
    });
    await mkdir(join(agentDir, ".git")); // the agent is a git repo — the image gets the git binary

    const ok = await call(agentDir, { model: "openai/gpt-4o-mini" }, { run: true });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.container.hasPackageJson).toBe(true);
      expect(ok.container.apt).toEqual(["git"]); // git baked: it ships .git
      expect(JSON.stringify(ok.messages)).toMatch(/baked as the definition/); // the WYSIWYG note is stated
    }
  });

  it("git is baked iff the agent directory ships a .git — a non-git dir gets no silent git layer", async () => {
    // No .git: no git layer (history without a binary is a dead loop; a binary without history is dead weight —
    // an apt package in context.json is the explicit way in).
    const noGit = await agent();
    const pre = await call(noGit, { model: "openai/gpt-4o-mini" });
    expect(pre.ok).toBe(true);
    if (pre.ok) {
      expect(pre.container.shipsGit).toBe(false);
      expect(pre.container.apt).toEqual([]);
    }

    // .git present: git rides in.
    const gitDir = await agent();
    await mkdir(join(gitDir, ".git"));
    const pre2 = await call(gitDir, { model: "openai/gpt-4o-mini" });
    expect(pre2.ok).toBe(true);
    if (pre2.ok) {
      expect(pre2.container.shipsGit).toBe(true);
      expect(pre2.container.apt).toEqual(["git"]);
    }
  });

  it("a kept .dockerignore: warns for missing secret/machinery/node_modules excludes; notes a .git exclude", async () => {
    const agentDir = await agent({ "package.json": `{"type":"module"}` });
    await mkdir(join(agentDir, "node_modules")); // installed deps exist → they could actually be uploaded
    await mkdir(join(agentDir, ".state")); // …as does machine state: only what is THERE gets warned about
    await mkdir(join(agentDir, "content")); // …and this machine's clones of the agent's content
    await writeFile(join(agentDir, "context.local.json"), `{ "content": {} }`); // …and its bindings
    await writeFile(join(agentDir, ".dockerignore"), ".git\n"); // the author's own — kept, not ours

    const pre = await call(agentDir, { model: "openai/gpt-4o-mini" });
    expect(pre.ok).toBe(true);
    if (pre.ok) {
      const text = JSON.stringify(pre.messages);
      expect(text).toMatch(/BAKE SECRETS INTO THE IMAGE/); // missing .secrets/.env excludes — the critical one
      expect(text).toMatch(/does not exclude .{0,12}\.state/); // machine state would ship
      expect(text).toMatch(/does not exclude .{0,12}content.{0,12} — this machine's clones/); // an issue: --run gates on it
      expect(pre.messages).toContainEqual({
        level: "warn",
        text: expect.stringMatching(
          /does not exclude `context\.local\.json` — the directories of this machine the agent is bound to would ship/,
        ),
      });
      expect(text).toMatch(/does not exclude .{0,30}node_modules/); // the native-binary clobber hazard — named
      expect(text).toMatch(/excludes \.git/); // pull\/push loop dead — named as a note
    }
    // Shipped content/ is refused, not only warned about: the host links its own there, and a release holding one
    // does not start.
    await writeFile(join(agentDir, ".dockerignore"), "**/.secrets\n**/.env\n");
    const gated = await call(agentDir, { model: "openai/gpt-4o-mini" }, { run: true });
    expect(gated).toMatchObject({ ok: false, gate: expect.stringMatching(/does not exclude .content/) });
  });

  it("the GENERATED dockerignore passes its own leak gate — contents-only .secrets excludes are not a leak", async () => {
    // The regression this pins: the leak check used to ask about the secrets DIRECTORY, which the
    // generated `**/.secrets/**` (contents-only, so the tracked scaffolds can be re-included) answers
    // "not excluded" — fastagent's own default output gated fastagent's own deploy on every fresh
    // agent without --force. auth.json and .secrets/.env ARE excluded; nothing leaks.
    const agentDir = await agent();
    await writeFile(
      join(agentDir, ".dockerignore"),
      "# Generated by `fastagent deploy`. Delete this line to take ownership (deploy then keeps your file).\n" +
        "**/node_modules\n**/.secrets/**\n**/.state\n**/.cache\n**/.env\n**/.env.*\n!**/.env.example\n" +
        "!**/.secrets/.gitignore\n**/*.log\n",
    );
    // No --force: the kept-but-ours branch is exactly the one that used to gate.
    const pre = await call(agentDir, { model: "openai/gpt-4o-mini" }, { run: true });
    expect(pre.ok).toBe(true);
  });

  it("a kept ignore that misses the secrets gates NAMING the leaking FILE, not the directory", async () => {
    const agentDir = await agent();
    await writeFile(join(agentDir, ".dockerignore"), "**/node_modules\n");
    const gated = await call(agentDir, { model: "openai/gpt-4o-mini" }, { run: true });
    expect(gated.ok).toBe(false);
    if (!gated.ok) {
      expect(gated.gate).toMatch(/BAKE SECRETS INTO THE IMAGE/);
      expect(gated.gate).toMatch(/`\.secrets\/auth\.json`/); // the FILE — actionable, not a directory
      expect(gated.gate).toMatch(/`\.secrets\/\.env`/);
    }
  });

  it("a secrets dir holding only the tracked scaffolds is not a leak — they travel on purpose", async () => {
    const agentDir = await agent();
    await rm(join(agentDir, ".secrets", "auth.json"));
    await rm(join(agentDir, ".secrets", ".env"));
    await writeFile(join(agentDir, ".secrets", ".gitignore"), "*\n");
    await writeFile(join(agentDir, ".secrets", ".env.example"), "TOKEN=\n");
    // An ignore with NO secrets rule at all: with nothing bakeable inside, there is nothing to gate —
    // the existence rule ("a file that is not there cannot be baked") applied per file.
    await writeFile(join(agentDir, ".dockerignore"), "**/node_modules\n");
    const pre = await call(agentDir, { model: "openai/gpt-4o-mini" }, { run: true });
    expect(pre.ok).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)(
    "a directory under the secrets dir it cannot read stops the pre-flight instead of reading as empty",
    async () => {
      const agentDir = await agent({ ".secrets/gcp/key.json": "{}\n" });
      const nested = join(agentDir, ".secrets", "gcp");
      await chmod(nested, 0o000);
      try {
        await expect(call(agentDir, { model: "openai/gpt-4o-mini" })).rejects.toThrow(/cannot read .*gcp/);
      } finally {
        await chmod(nested, 0o755);
      }
    },
  );

  it("the .env family at the agent's root is interrogated, like the generated rules", async () => {
    // The generated file excludes `**/.env` + `**/.env.*` (minus .env.example). A kept file must be asked about the
    // same set, or the likeliest credential files ship: a root `.env` (the file habit puts there — env.ts warns
    // about it by name) and a `.env.local`.
    const agentDir = await agent();
    await writeFile(join(agentDir, ".env"), "TELEGRAM_BOT_TOKEN=real\n");
    await writeFile(join(agentDir, ".env.local"), "DATABASE_URL=real\n");
    await writeFile(join(agentDir, ".secrets", ".env.example"), "TOKEN=\n"); // committable by design
    await writeFile(join(agentDir, ".dockerignore"), "**/.secrets\n**/.state\nnode_modules\n");

    const gated = await call(agentDir, { model: "openai/gpt-4o-mini" }, { run: true });
    expect(gated.ok).toBe(false);
    if (!gated.ok) {
      expect(gated.gate).toMatch(/BAKE SECRETS INTO THE IMAGE/);
      expect(gated.gate).toMatch(/`\.env`/);
      expect(gated.gate).toMatch(/`\.env\.local`/);
      expect(gated.gate).not.toMatch(/\.env\.example/); // never gated — the template travels on purpose
    }
  });

  it("a kept ignore that drops the agent's config gates; an allowlist that keeps it does not", async () => {
    // Without `fastagent.config.ts` the box has no agent to open. An allowlist that re-includes it must still not
    // gate a deployment that is actually correct.
    const dropped = await agent();
    await writeFile(join(dropped, ".dockerignore"), "*.ts\n");
    const gated = await call(dropped, { model: "openai/gpt-4o-mini" }, { run: true });
    expect(gated.ok).toBe(false);
    if (!gated.ok) expect(gated.gate).toMatch(/would ship WITHOUT the agent's config/);

    const allowed = await agent();
    await writeFile(join(allowed, ".dockerignore"), "*\n!fastagent.config.ts\n!skills/**\n");
    // warn posture, so the OTHER checks report instead of gating — leaving exactly the config branch under test.
    const pre = await call(allowed, { model: "openai/gpt-4o-mini" });
    expect(pre.ok).toBe(true);
    if (pre.ok) expect(JSON.stringify(pre.messages)).not.toMatch(/ship WITHOUT the/);
  });

  it("the secret checks follow FASTAGENT_SECRETS_DIR — a custom in-tree dir is gated AND excluded", async () => {
    // The name-based `**/.secrets` excludes reach a directory called `.secrets`; an override pointing
    // somewhere else in the baked tree is invisible to them, and `COPY . .` would ship the credential.
    const agentDir = await agent();
    const creds = join(agentDir, "creds");
    await mkdir(creds);
    await writeFile(join(creds, "auth.json"), "{}\n"); // exists → the gate has something to protect
    const env = { ...process.env, FASTAGENT_SECRETS_DIR: creds };
    const call2 = (over: Partial<Parameters<typeof preflightDeploy>[0]> = {}) =>
      preflightDeploy({
        agentDir,
        config: { model: "openai/gpt-4o-mini" },
        run: false,
        force: false,
        ...over,
      });
    const saved = process.env.FASTAGENT_SECRETS_DIR;
    process.env.FASTAGENT_SECRETS_DIR = env.FASTAGENT_SECRETS_DIR;
    try {
      // Generated ignore: the resolved dir is excluded by PATH, not by its (non-matching) name.
      const clean = await call2();
      expect(clean.ok).toBe(true);
      if (clean.ok)
        // The DIR, not the two filenames we happen to know — an atomic-write temp or a second key file
        // beside auth.json must not ship either.
        expect(clean.container.machineryPaths).toEqual([".secrets", "creds", ".state"]);

      // A kept .dockerignore carrying only the default name-based excludes misses it → gate.
      await writeFile(join(agentDir, ".dockerignore"), "**/node_modules\n**/.secrets\n**/.state\n**/.env\n");
      const gated = await call2({ run: true });
      expect(gated.ok).toBe(false);
      // The gate names the leaking FILE inside the relocated dir (the leak question is per file;
      // the dir stays the unit only for machineryPaths above).
      if (!gated.ok) expect(gated.gate).toMatch(/does not exclude `creds\/auth\.json`/);
    } finally {
      if (saved === undefined) delete process.env.FASTAGENT_SECRETS_DIR;
      else process.env.FASTAGENT_SECRETS_DIR = saved;
    }
  });

  it("the per-Dockerfile ignore is interrogated too — it is what BuildKit prefers", async () => {
    // BuildKit prefers the ignore file BESIDE the Dockerfile over the context root's, so checking only one left the
    // credential gate not covering the file that actually decides that build.
    const agentDir = await agent();
    await writeFile(join(agentDir, ".dockerignore"), "**/node_modules\n**/.secrets\n**/.state\n**/.env\n");
    await writeFile(join(agentDir, "Dockerfile.dockerignore"), "node_modules\n"); // theirs, and it leaks
    const gated = await call(agentDir, { model: "openai/gpt-4o-mini" }, { run: true });
    expect(gated.ok).toBe(false);
    if (!gated.ok) expect(gated.gate).toMatch(/your Dockerfile\.dockerignore \(kept\) does not exclude/);
  });

  it("--run gates on a kept .dockerignore that would bake secrets or drop the agent", async () => {
    // Missing **/.secrets and **/.env excludes: warn generate-only (asserted above), GATE under --run —
    // a full deploy must not push a secret-laden image (same discipline as the model-travel gate).
    const agentDir = await agent();
    await writeFile(join(agentDir, ".dockerignore"), "node_modules\n");
    const gated = await call(agentDir, { model: "openai/gpt-4o-mini" }, { run: true });
    expect(gated.ok).toBe(false);
    if (!gated.ok) expect(gated.gate).toMatch(/BAKE SECRETS/);

    // A rule matching the config: the image ships WITHOUT the agent — the whole deploy is meaningless
    // (crash-loop with no agent to open), so gate regardless of where the rule came from.
    await writeFile(join(agentDir, ".dockerignore"), "fastagent.config.ts\n**/.secrets\n**/.env\n");
    const noAgent = await call(agentDir, { model: "openai/gpt-4o-mini" }, { run: true });
    expect(noAgent.ok).toBe(false);
    if (!noAgent.ok) expect(noAgent.gate).toMatch(/WITHOUT the agent/);

    // Negation is the ignore matcher's job, with git's last-match-wins: a later `!` re-includes the
    // path, so the secrets are back in the context → still gates.
    await writeFile(join(agentDir, ".dockerignore"), "**/.secrets\n!**/.secrets\n**/.env\n");
    const negated = await call(agentDir, { model: "openai/gpt-4o-mini" }, { run: true });
    expect(negated.ok).toBe(false);
    if (!negated.ok) expect(negated.gate).toMatch(/\.secrets/);

    // The generated excludes satisfy every check — no gate, no secret/state/node_modules warning.
    await writeFile(join(agentDir, ".dockerignore"), "**/node_modules\n**/.secrets\n**/.state\n**/.env\n");
    const clean = await call(agentDir, { model: "openai/gpt-4o-mini" }, { run: true });
    expect(clean.ok).toBe(true);
    if (clean.ok) expect(JSON.stringify(clean.messages)).not.toMatch(/BAKE SECRETS|node_modules|\.state/);
  });

  it("deploys without a directory bound only here, saying so: a warning for one it works on, a note for one it knows", async () => {
    const dir = await agent({
      "context.json": JSON.stringify({ content: { handbook: { github: "acme/handbook" } } }),
      // A checkout of a declared repository is this machine's way to it; the host clones that one.
      "context.local.json": JSON.stringify({
        content: {
          handbook: { path: "/code/handbook" },
          app: { path: "/code/app" },
          docs: { path: "/docs", readonly: true },
        },
      }),
    });
    const pre = await call(dir, { model: "openai/gpt-4o-mini" }, { run: true });
    expect(pre.ok).toBe(true);
    if (!pre.ok) return;
    expect(pre.messages).toContainEqual({
      level: "warn",
      text:
        "works on app: a directory of this machine (/code/app, bound in context.local.json), stays here, and the " +
        "deployed agent works without it; to work on it from a host, move it to a GitHub repository and add it as " +
        "github:owner/repo",
    });
    expect(pre.messages).toContainEqual({
      level: "note",
      text:
        "knows docs: a directory of this machine (/docs, bound in context.local.json), stays here, and the deployed " +
        "agent works without it; to ship what the agent reads there, copy it into the agent directory, which every " +
        "release carries",
    });
    expect(pre.messages.filter((m) => m.text.includes("handbook")).map((m) => m.text)).toEqual([
      "works on handbook: github acme/handbook, cloned on the host, and brought up to date in place at each start",
    ]);
  });

  it("says what each repository context becomes on the host, bakes git, and names the token it clones with", async () => {
    const dir = await agent({
      "context.json": JSON.stringify({
        content: { app: { github: "acme/app" }, handbook: { github: "acme/handbook", ref: "main", readonly: true } },
      }),
    });
    const config = { model: "openai/gpt-4o-mini" };
    const pre = await call(dir, config);
    expect(pre.ok).toBe(true);
    if (!pre.ok) return;
    const notes = pre.messages.filter((m) => m.level === "note").map((m) => m.text);
    expect(notes).toContain(
      "works on app: github acme/app, cloned on the host, and brought up to date in place at each start",
    );
    expect(notes).toContain(
      "knows handbook: github acme/handbook@main, cloned on the host, and brought up to date in place at each start",
    );
    expect(notes).toContainEqual(
      expect.stringMatching(/^no GITHUB_TOKEN in \.secrets\/\.env: the host clones without a credential/),
    );
    expect(pre.container.apt).toEqual(["git"]);

    // Where a deployment starts the storage over, a clone does not outlive a release, and that is said.
    await writeFile(join(dir, ".secrets", ".env"), "K=v\nGITHUB_TOKEN=ghp_x\n");
    const reset = await call(dir, config, { storageResets: true });
    expect(reset.ok).toBe(true);
    if (!reset.ok) return;
    const said = reset.messages.map((m) => m.text);
    expect(said).toContain(
      "works on app: github acme/app, cloned afresh on every deployment, since the host's storage starts over; what the agent did not push is lost",
    );
    expect(said.some((text) => text.startsWith("no GITHUB_TOKEN"))).toBe(false);
  });

  it("loads the definition the box will load: a refusal in it gates --run instead of shipping a crash-loop", async () => {
    const dir = await agent({ "src/tools/x.ts": "export default { name: 'x' };\n" });
    const config = { model: "openai-codex/gpt-5.5" };
    const gated = await call(dir, config, { run: true });
    expect(gated.ok).toBe(false);
    if (!gated.ok)
      expect(gated.gate).toMatch(/definition does not build.*src\/tools\/x\.ts: must default-export a tool/);
    const warned = await call(dir, config, { run: false });
    expect(warned.ok).toBe(true);
    if (warned.ok)
      expect(warned.messages).toContainEqual({
        level: "warn",
        text: expect.stringMatching(/definition does not build/),
      });
  });

  it("warns (not gates) about the same model issue without --run", async () => {
    const pre = await call(await agent(), {}, { run: false });
    expect(pre.ok).toBe(true);
    if (pre.ok)
      expect(pre.messages).toContainEqual({ level: "warn", text: expect.stringMatching(/no model resolves/) });
  });

  it("computes container facts and no model WARNING when the model is in config (markdown agent)", async () => {
    const dir = await agent();
    const pre = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(pre.ok).toBe(true);
    if (!pre.ok) return;
    expect(pre.container.hasPackageJson).toBe(false); // markdown/skills agent → global-install path
    expect(pre.container.runtime).toBe("node");
    expect(pre.port).toBe(8787);
    expect(pre.messages.some((m) => m.level === "warn" && /model/.test(m.text))).toBe(false);
  });

  it("recognizes Slack as a first-party route channel for secrets/deploy guidance", async () => {
    const dir = await agent({
      "src/channels/slack.ts": "export default () => ({ '/slack': () => new Response() });\n",
    });
    const pre = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(pre.ok).toBe(true);
    if (pre.ok) {
      expect(pre.channels).toEqual([{ name: "slack", ingress: "webhook" }]);
      expect(pre.messages.some((message) => message.text.includes('channel "slack" is custom'))).toBe(false);
    }
  });

  it("notes a custom channel (its webhook is the author's to wire; its variables travel like every other)", async () => {
    const dir = await agent({ "src/channels/discord.ts": "export default () => ({});\n" });
    const pre = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(pre.ok).toBe(true);
    if (pre.ok) {
      expect(pre.channels).toEqual([{ name: "discord", ingress: "webhook" }]);
      expect(pre.messages).toContainEqual({
        level: "note",
        text: expect.stringContaining(
          'route channel "discord" is custom — its variables travel from .secrets/.env like every other',
        ),
      });
    }
  });

  it("a custom channel's declared secrets join the required list, and its shape is read without their values", async () => {
    const dir = await agent({
      "src/channels/discord.ts": `import { needs } from "@fastagent-sh/fastagent";
export default needs(["DISCORD_TOKEN"], ({ DISCORD_TOKEN }) => {
  if (DISCORD_TOKEN === "") throw new Error("no token");
  return { name: "discord gateway", connect() {} };
});\n`,
    });
    const pre = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(pre.ok).toBe(true);
    if (!pre.ok) return;
    expect(pre.declaredSecrets).toContainEqual({
      name: "DISCORD_TOKEN",
      source: "src/channels/discord.ts",
      optional: false,
    });
    // The value file holds no DISCORD_TOKEN, and its ingress is still known.
    expect(pre.channels).toEqual([{ name: "discord", ingress: "long-connection" }]);
  });

  it("recognizes a long-connection module structurally and reports its always-on requirement", async () => {
    const dir = await agent({
      "src/channels/feishu.ts": `export default { name: "feishu websocket", connect() {} };\n`,
    });
    const pre = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(pre.ok).toBe(true);
    if (pre.ok) {
      expect(pre.channels).toEqual([{ name: "feishu", ingress: "long-connection" }]);
      expect(pre.messages).toContainEqual({
        level: "note",
        text: expect.stringMatching(/long-connection channel.*keeps one machine running/),
      });
    }
  });

  it("keeps a custom long-connection channel always-on without pretending it has a webhook", async () => {
    const dir = await agent({ "src/channels/socket.ts": `export default { name: "custom socket", connect() {} };\n` });
    const pre = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(pre.ok).toBe(true);
    if (pre.ok) {
      expect(pre.channels).toEqual([{ name: "socket", ingress: "long-connection" }]);
      expect(pre.messages).toContainEqual({
        level: "note",
        text: expect.stringMatching(/long-connection channel "socket".*keep the process running.*skip webhook/),
      });
    }
  });

  it("warns a KEPT hand-written Dockerfile that the environment won't reach, --force included", async () => {
    // `--force` does not rescue it: writeArtifacts refuses a file it did not generate whatever the flag says, so the
    // environment is dropped either way. Suppressing the warning under `--force` only hid that.
    const dir = await agent({
      Dockerfile: "FROM python:3.12\n",
      "context.json": JSON.stringify({ environment: { aptPackages: ["chromium"] } }),
    });
    for (const force of [false, true]) {
      const pre = await call(dir, { model: "openai/gpt-4o-mini" }, { force });
      expect(pre.ok).toBe(true);
      if (pre.ok) {
        expect(pre.messages).toContainEqual({
          level: "warn",
          text: expect.stringMatching(/kept your hand-written Dockerfile — it installs the environment context\.json/),
        });
      }
    }
    // Variables travel with the value file, whatever the image does: no environment for the Dockerfile to install.
    await writeFile(
      join(dir, "context.json"),
      JSON.stringify({ environment: { variables: { GH_HOST: { description: "the GitHub host" } } } }),
    );
    await mkdir(join(dir, ".secrets"), { recursive: true });
    await writeFile(join(dir, ".secrets", ".env"), "GH_HOST=github.example.com\n");
    const variablesOnly = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(variablesOnly.ok && variablesOnly.messages.map((m) => m.text).join("\n")).not.toMatch(
      /kept your hand-written/,
    );
  });

  /** The agent's mise, faked where its platform package puts it: it resolves every name to aqua and logs each lock. */
  async function installMise(dir: string): Promise<() => Promise<string>> {
    const pkg = join(dir, "node_modules", "@jdxcode", `mise-${process.platform}-${process.arch}`);
    await mkdir(join(pkg, "bin"), { recursive: true });
    await writeFile(join(pkg, "package.json"), "{}\n");
    const runs = join(dir, "..", "mise-runs.log");
    await writeFile(
      join(pkg, "bin", "mise"),
      `#!/bin/sh\necho "$*" >> "${runs}"\ncase "$1" in\n  tool) printf '{"backend":"aqua:o/%s"}' "$2" ;;\nesac\n`,
    );
    await chmod(join(pkg, "bin", "mise"), 0o755);
    return () => readFile(runs, "utf8").catch(() => "");
  }

  const withMise = JSON.stringify({
    type: "module",
    dependencies: { "@fastagent-sh/fastagent": "^1" },
    optionalDependencies: Object.fromEntries(MISE_PACKAGE_NAMES.map((name) => [name, "2026.10.7"])),
  });

  it("packages need the linux mise in package.json, and mise here to check them; deploy installs nothing here", async () => {
    const dir = await agent({
      "package.json": `{"type":"module","dependencies":{"@fastagent-sh/fastagent":"^1"}}`,
      "context.json": JSON.stringify({ environment: { packages: { jq: "1.8.1" }, aptPackages: ["chromium", "git"] } }),
    });
    const gated = await call(dir, { model: "openai/gpt-4o-mini" }, { run: true });
    expect(gated).toMatchObject({
      ok: false,
      gate: expect.stringMatching(
        /does not list @jdxcode\/mise-linux-arm64, @jdxcode\/mise-linux-x64\. Run `fastagent env install`/,
      ),
    });
    await writeFile(join(dir, "package.json"), withMise);
    // Listed but not installed on this machine (it never installed the agent's dependencies): nothing can be checked,
    // which stops --run and only warns a deploy that writes the artifacts.
    const notHere =
      `the agent's mise is not installed here, so the packages context.json declares cannot be checked. Run ` +
      `\`fastagent env install\` in ${dir}, then deploy again.`;
    expect(await call(dir, { model: "openai/gpt-4o-mini" }, { run: true })).toMatchObject({ ok: false, gate: notHere });
    const artifactsOnly = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(artifactsOnly.ok && artifactsOnly.messages).toContainEqual({ level: "warn", text: notHere });
    const runs = await installMise(dir);
    const checked = await call(dir, { model: "openai/gpt-4o-mini" }, { run: true });
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(checked.container.packages).toEqual(["jq@1.8.1"]);
      // mise downloads over TLS (the slim image has no CAs); the agent's own apt packages join the one layer.
      expect(checked.container.apt).toEqual(["ca-certificates", "chromium", "git"]);
    }
    // Checked here; the image installs them.
    expect(await runs()).toBe("tool jq --json\n");
    await writeFile(join(dir, "context.json"), JSON.stringify({ environment: { aptPackages: ["chromium"] } }));
    const none = await call(dir, { model: "openai/gpt-4o-mini" }, { run: true });
    expect(none.ok && none.container.packages).toBeUndefined();
  });

  it("an image that installs rust has curl: rustup, which mise installs it with, downloads with it", async () => {
    const dir = await agent({ "context.json": JSON.stringify({ environment: { packages: { rust: "1" } } }) });
    const pre = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(pre.ok && pre.container.apt).toEqual(["ca-certificates", "curl"]);
  });

  it("a PyPI package without its runtime stops --run, before the build it would fail", async () => {
    const dir = await agent({
      "package.json": withMise,
      "context.json": JSON.stringify({ environment: { packages: { "pypi:markitdown": "0.1" } } }),
    });
    const runs = await installMise(dir);
    const advice = /^pypi:markitdown installs with python and uv, .* `fastagent env add python uv`$/;
    expect(await call(dir, { model: "openai/gpt-4o-mini" }, { run: true })).toMatchObject({
      ok: false,
      gate: expect.stringMatching(advice),
    });
    // Writing only the artifacts, it warns: the image's install, without uv, would fail the build and say less.
    const artifactsOnly = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(artifactsOnly.ok && artifactsOnly.messages).toContainEqual({
      level: "warn",
      text: expect.stringMatching(advice),
    });
    expect(await runs()).toBe("");
  });

  it("a declared schedule keeps a machine up; the agent's own wake-ups do not", async () => {
    // Nothing → false, no note. Every serve mounts `wake`, so a wake-up is NOT a reason to stay up: a box that slept
    // fires what is due when a request next wakes it.
    const none = await call(await agent(), { model: "openai/gpt-4o-mini" });
    expect(none.ok && !none.hasCron).toBe(true);
    if (none.ok) expect(none.messages.find((m) => /keeps one machine running/.test(m.text))).toBeUndefined();

    // A schedule → hasCron: the schedule is the agent's own clock, so nothing wakes a sleeping box for it.
    const schedule = (cron: string) =>
      `import { defineSchedule } from "@fastagent-sh/fastagent";\nexport default defineSchedule({ cron: "${cron}", prompt: "go" });\n`;
    const withCron = await call(await agent({ "src/schedules/daily.ts": schedule("0 9 * * *") }), {
      model: "openai/gpt-4o-mini",
    });
    expect(withCron.ok && withCron.hasCron).toBe(true);
    if (withCron.ok) {
      const note = withCron.messages.find((m) => /keeps one machine running/.test(m.text));
      expect(note?.level).toBe("note");
    }
    // One that does not build still counts, conservatively: it may well be a schedule tomorrow, and scaling to zero
    // because it did not build would hide that behind silence.
    const broken = await call(await agent({ "src/schedules/broken.ts": schedule("not a cron") }), {
      model: "openai/gpt-4o-mini",
    });
    expect(broken.ok && broken.hasCron).toBe(true);
    if (broken.ok) {
      expect(broken.messages.map((m) => m.text).join("\n")).toMatch(/does not build.*src\/schedules\/broken\.ts/);
    }
  });

  it("warns that a deployment with no channel and no schedule is reached by nothing but its health check", async () => {
    const reachedBy = /nothing reaches it but its health check/;
    const none = await call(await agent(), { model: "openai/gpt-4o-mini" });
    expect(none.ok && none.messages.find((m) => reachedBy.test(m.text))?.level).toBe("warn");
    const schedule = `export default { kind: "fastagent.schedule", cron: "0 9 * * *", prompt: "go" };\n`;
    const scheduled = await call(await agent({ "src/schedules/daily.ts": schedule }), { model: "openai/gpt-4o-mini" });
    expect(scheduled.ok && scheduled.messages.some((m) => reachedBy.test(m.text))).toBe(false);
    const channel = `export default () => ({ "POST /hook": () => new Response("ok") });\n`;
    const served = await call(await agent({ "src/channels/hook.ts": channel }), { model: "openai/gpt-4o-mini" });
    expect(served.ok && served.messages.some((m) => reachedBy.test(m.text))).toBe(false);
    // A deployment that serves the Agent API is reached by whoever holds its key.
    const api = await call(await agent(), { model: "openai/gpt-4o-mini" }, { servesApi: true });
    expect(api.ok && api.messages.some((m) => reachedBy.test(m.text))).toBe(false);
  });

  it("a Bun pinned below the floor stops --run: the image would run a Bun without node:sqlite", async () => {
    const pinned = (version: string) =>
      agent({
        "package.json": JSON.stringify({
          packageManager: `bun@${version}`,
          dependencies: { "@fastagent-sh/fastagent": "*" },
        }),
      });
    const old = await call(await pinned("1.3.13+sha256.deadbeef"), { model: "openai/gpt-4o-mini" }, { run: true });
    expect(old.ok).toBe(false);
    if (!old.ok) expect(old.gate).toMatch(/pins bun@1\.3\.13.*Bun ships from 1\.4\.0.*fail at start/);
    const current = await call(await pinned("1.4.0"), { model: "openai/gpt-4o-mini" });
    expect(current.ok && current.messages.some((m) => /node:sqlite/.test(m.text))).toBe(false);
    // A hand-written Dockerfile names its own base, so the pin says nothing about the image.
    const ownImage = await pinned("1.3.13");
    await writeFile(join(ownImage, "Dockerfile"), "FROM oven/bun:1.4\nENV FASTAGENT_RELEASE_FILE=/app/x\n");
    const kept = await call(ownImage, { model: "openai/gpt-4o-mini" }, { run: true });
    expect(kept.ok ? kept.messages.filter((m) => /node:sqlite/.test(m.text)) : kept.gate).toEqual([]);
  });

  it("warns a code agent with no lockfile and no @fastagent-sh/fastagent dep", async () => {
    const dir = await agent({ "package.json": JSON.stringify({ name: "a", type: "module" }) });
    const pre = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(pre.ok).toBe(true);
    if (!pre.ok) return;
    expect(pre.messages.some((m) => /no package-lock\.json/.test(m.text) || /not reproducible/.test(m.text))).toBe(
      true,
    );
    expect(pre.messages.some((m) => /does not list @fastagent-sh\/fastagent/.test(m.text))).toBe(true);
  });

  it("names a package.json it cannot parse instead of reporting it as missing a dependency", async () => {
    const dir = await agent({ "package.json": "{ not json" });
    await expect(call(dir, { model: "openai/gpt-4o-mini" })).rejects.toThrow(/package\.json.*not valid JSON/);
  });
});

describe("preflight: a model credential that does not travel", () => {
  afterEach(() => vi.unstubAllEnvs());
  const noAnthropicEnv = () => {
    for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"]) vi.stubEnv(name, "");
  };

  it("a stored login, OAuth or key, is never carried: the deployment logs in to that provider itself", async () => {
    noAnthropicEnv();
    const oauth = { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 };
    for (const stored of [oauth, { type: "api_key", key: "k" }]) {
      const dir = await agent({ ".secrets/auth.json": JSON.stringify({ anthropic: stored }) });
      const pre = await call(dir, { model: "anthropic/claude-sonnet-4-5" }, { run: true });
      if (!pre.ok) throw new Error(`preflight gated: ${pre.gate}`);
      expect(pre.boxLogin).toBe("anthropic");
      expect(pre.secrets.map((s) => s.name)).not.toContain("ANTHROPIC_API_KEY");
      expect(pre.messages).toContainEqual({
        level: "note",
        text: expect.stringMatching(/login anthropic --deployment/),
      });
    }
  });

  it("a model a provider of the definition offers is checked against it, and authenticated by that code", async () => {
    // Under test/fixtures, so the configuration's import of pi-ai resolves this repository's.
    const host = join(import.meta.dirname, "fixtures", `.tmp-preflight-${process.pid}`);
    const dir = join(host, "agent");
    await mkdir(dir, { recursive: true });
    try {
      await writeFile(
        join(dir, "fastagent.config.ts"),
        `import { fauxProvider } from "@earendil-works/pi-ai";
export default { providers: [fauxProvider({ provider: "gw", models: [{ id: "m1" }] }).provider] };\n`,
      );
      const pre = await call(dir, { model: "gw/m1" }, { run: true });
      if (!pre.ok) throw new Error(`preflight gated: ${pre.gate}`);
      expect(pre.boxLogin).toBeUndefined();
      const unknown = await call(dir, { model: "gw/nope" }, { run: true });
      expect(unknown.ok).toBe(false);
      if (!unknown.ok) expect(unknown.gate).toMatch(/no provider of the deployed agent offers "gw\/nope"/);
    } finally {
      await rm(host, { recursive: true, force: true });
    }
  });

  it("with nothing stored here either: the box still logs in, since this machine's login was never the source", async () => {
    noAnthropicEnv();
    const pre = await call(await agent(), { model: "anthropic/claude-sonnet-4-5" }, { run: true });
    expect(pre.ok && pre.boxLogin).toBe("anthropic");
  });

  it("a key in the value file travels, and nothing logs in", async () => {
    noAnthropicEnv(); // the value file alone decides (§9), not the shell running deploy
    const dir = await agent({ ".secrets/.env": "ANTHROPIC_API_KEY=sk-ant\n" });
    const pre = await call(dir, { model: "anthropic/claude-sonnet-4-5" }, { run: true });
    expect(pre.ok && pre.boxLogin).toBeUndefined();
    expect(pre.ok && pre.modelAuth).toBe("ANTHROPIC_API_KEY");
  });

  it("a key exported in the shell running deploy does not travel: the box logs in, and nothing asks for that key", async () => {
    // §9: the shell is not a source. A developer's ANTHROPIC_API_KEY for local tools must not turn a subscription
    // deploy into a "no value for ANTHROPIC_API_KEY" refusal, nor decide which path the deploy takes at all.
    noAnthropicEnv();
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-from-the-shell");
    const pre = await call(await agent(), { model: "anthropic/claude-sonnet-4-5" }, { run: true });
    if (!pre.ok) throw new Error(pre.gate);
    expect(pre.boxLogin).toBe("anthropic");
    expect(pre.secrets.map((s) => s.name)).not.toContain("ANTHROPIC_API_KEY");
  });

  it("a credential that points at a FILE on this machine does not travel: the box is asked", async () => {
    // The value file names a path; the file exists here and nowhere else. pi finds it and reports ADC, which read
    // with this machine's file system would ship a deploy with no credential and no login.
    const adc = join(await mkdtemp(join(tmpdir(), "fa-adc-")), "adc.json");
    await writeFile(adc, "{}");
    const vertex = createPiModels().getProvider("google-vertex")?.getModels()[0]?.id as string;
    const env = `GOOGLE_CLOUD_PROJECT=p\nGOOGLE_CLOUD_LOCATION=us-central1\nGOOGLE_APPLICATION_CREDENTIALS=${adc}\n`;
    const pre = await call(await agent({ ".secrets/.env": env }), { model: `google-vertex/${vertex}` }, { run: true });
    expect(pre.ok && pre.boxLogin).toBe("google-vertex");
  });

  it("a keyless credential in the value file travels; the same credential only in this shell leaves it to the box", async () => {
    // AWS keys are what pi reads for amazon-bedrock, with no single key variable to require. From the value file they
    // reach the box; from the shell they are this machine's, and whether the box has a role is the box's answer.
    const bedrock = createPiModels().getProvider("amazon-bedrock")?.getModels()[0]?.id as string;
    const aws = "AWS_ACCESS_KEY_ID=AKIAEXAMPLE\nAWS_SECRET_ACCESS_KEY=secret\nAWS_REGION=us-east-1\n";
    const carried = await call(
      await agent({ ".secrets/.env": aws }),
      { model: `amazon-bedrock/${bedrock}` },
      { run: true },
    );
    if (!carried.ok) throw new Error(carried.gate);
    expect(carried.boxLogin).toBeUndefined();
    expect(carried.modelAuth).toBeUndefined(); // nothing more for the values gate to ask

    vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIAEXAMPLE");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "secret");
    vi.stubEnv("AWS_REGION", "us-east-1");
    const shellOnly = await call(await agent(), { model: `amazon-bedrock/${bedrock}` }, { run: true });
    expect(shellOnly.ok && shellOnly.boxLogin).toBe("amazon-bedrock");
  });

  it("the value file's key wins over this machine's own login: that login stays here, the key is what travels", async () => {
    // pi ranks a stored credential above the environment, which answers "what authenticates HERE". The deploy asks
    // what reaches the box, and a key the author put in the value file for the deployment is exactly that.
    noAnthropicEnv();
    const oauth = { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 };
    const dir = await agent({
      ".secrets/auth.json": JSON.stringify({ anthropic: oauth }),
      ".secrets/.env": "ANTHROPIC_API_KEY=sk-ant\n",
    });
    const pre = await call(dir, { model: "anthropic/claude-sonnet-4-5" }, { run: true });
    if (!pre.ok) throw new Error(pre.gate);
    expect(pre.boxLogin).toBeUndefined();
    expect(pre.modelAuth).toBe("ANTHROPIC_API_KEY");
    expect(pre.messages.some((m) => /login --deployment/.test(m.text))).toBe(false);
  });
});

describe("preflight: what the definition declares", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("requires what tools DECLARED, and lists the rest of the value file after them", async () => {
    const dir = await agent({
      "src/tools/x-post.ts": `import { needs } from "@fastagent-sh/fastagent";
export default needs(["X_API_KEY", "X_API_SECRET"], () => ({
  name: "x-post", description: "post", parameters: {}, execute: async () => ({}),
}));\n`,
    });
    // The variables context.json declares for the agent's commands are required the same way, with what they are for.
    await writeFile(
      join(dir, "context.json"),
      JSON.stringify({ environment: { variables: { GH_HOST: { description: "the GitHub host gh talks to" } } } }),
    );
    await mkdir(join(dir, ".secrets"), { recursive: true });
    await writeFile(join(dir, ".secrets", ".env"), "GH_TOKEN=ghp\nX_API_KEY=x\n");
    const pre = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(pre.ok).toBe(true);
    if (!pre.ok) return;
    expect(pre.declaredSecrets).toEqual([
      { name: "X_API_KEY", source: "src/tools/x-post.ts", optional: false },
      { name: "X_API_SECRET", source: "src/tools/x-post.ts", optional: false },
      { name: "GH_HOST", source: "context.json", description: "the GitHub host gh talks to" },
    ]);
    // The runbook names the file to open for a required one, and the value file for the rest.
    expect(pre.secrets).toEqual([
      { name: "X_API_KEY", hint: "required by src/tools/x-post.ts" },
      { name: "X_API_SECRET", hint: "required by src/tools/x-post.ts" },
      { name: "GH_HOST", hint: "required by context.json: the GitHub host gh talks to" },
      { name: "GH_TOKEN", hint: "from .secrets/.env" },
    ]);
  });

  it("warns when the definition does not load, and GATES --run on it", async () => {
    // Generate-only warns: the operator may be producing artifacts on a machine that never installed
    // the agent's deps. `--run` gates, because the box would refuse to start on it: a crash loop after a
    // "successful" deploy.
    const dir = await agent({ "src/tools/broken.ts": `throw new Error("boom");\n` });
    const pre = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(pre.ok).toBe(true);
    if (pre.ok) {
      expect(pre.messages.some((m) => m.level === "warn" && /does not load.*boom/.test(m.text))).toBe(true);
    }
    const run = await call(dir, { model: "openai/gpt-4o-mini" }, { run: true });
    expect(run.ok).toBe(false);
    if (!run.ok)
      expect(run.gate).toMatch(/the definition does not load, so the deployed agent would not start: .*boom/);
  });
});
