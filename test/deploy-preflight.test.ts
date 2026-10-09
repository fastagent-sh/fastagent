import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { preflightDeploy } from "../src/deploy/preflight.ts";
import type { FastagentConfig } from "../src/harnesses/pi/config.ts";
import { globalCatalogPath } from "../src/harnesses/pi/models.ts";
import { createPiModels } from "../src/harnesses/pi/agent-models.ts";

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

    const ok = await call(agentDir, { model: "openai/gpt-4o-mini", deploy: { apt: ["ripgrep"] } }, { run: true });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.container.hasPackageJson).toBe(true);
      expect(ok.container.apt).toEqual(["git", "ripgrep"]); // git baked (it ships .git), deploy.apt kept, deduped
      expect(JSON.stringify(ok.messages)).toMatch(/baked as the definition/); // the WYSIWYG note is stated
    }
  });

  it("git is baked iff the agent directory ships a .git — a non-git dir gets no silent git layer", async () => {
    // No .git: only the author's declared packages reach the image (history without a binary is a
    // dead loop; a binary without history is dead weight — deploy.apt is the explicit escape hatch).
    const noGit = await agent();
    const pre = await call(noGit, { model: "openai/gpt-4o-mini", deploy: { apt: ["ripgrep"] } });
    expect(pre.ok).toBe(true);
    if (pre.ok) {
      expect(pre.container.shipsGit).toBe(false);
      expect(pre.container.apt).toEqual(["ripgrep"]);
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
    await mkdir(join(agentDir, ".contexts")); // …and the clones of the agent's github contexts
    await writeFile(join(agentDir, ".dockerignore"), ".git\n"); // the author's own — kept, not ours

    const pre = await call(agentDir, { model: "openai/gpt-4o-mini" });
    expect(pre.ok).toBe(true);
    if (pre.ok) {
      const text = JSON.stringify(pre.messages);
      expect(text).toMatch(/BAKE SECRETS INTO THE IMAGE/); // missing .secrets/.env excludes — the critical one
      expect(text).toMatch(/does not exclude .{0,12}\.state/); // machine state would ship
      expect(text).toMatch(/does not exclude .{0,12}\.contexts/); // so would the clones
      expect(text).toMatch(/does not exclude .{0,30}node_modules/); // the native-binary clobber hazard — named
      expect(text).toMatch(/excludes \.git/); // pull\/push loop dead — named as a note
    }
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
        expect(clean.container.machineryPaths).toEqual([".secrets", "creds", ".state", ".contexts"]);

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

  it("deploys without a directory context, saying so: a warning for one it works on, a note for one it knows", async () => {
    const dir = await agent();
    const pre = await call(
      dir,
      {
        model: "openai/gpt-4o-mini",
        contexts: [{ local: "/srv/app" }, { local: "/srv/docs", readonly: true }, { github: "acme/handbook" }],
      },
      { run: true },
    );
    expect(pre.ok).toBe(true);
    if (!pre.ok) return;
    expect(pre.messages).toContainEqual({
      level: "warn",
      text:
        "works on app: local /srv/app, stays on this machine, and the deployed agent works without it; to work on " +
        "it from a host, move it to a GitHub repository and declare it as github",
    });
    expect(pre.messages).toContainEqual({
      level: "note",
      text:
        "knows docs: local /srv/docs, stays on this machine, and the deployed agent works without it; to ship what " +
        "the agent reads there, copy it into the agent directory, which every release carries",
    });
  });

  it("says what each repository context becomes on the host, bakes git, and names the token it clones with", async () => {
    const dir = await agent();
    const config = {
      model: "openai/gpt-4o-mini",
      contexts: [{ github: "acme/app" }, { github: "acme/handbook", ref: "main", readonly: true }],
    };
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
    const dir = await agent({ "persona.md": "You are terse.\n" });
    const config = { model: "openai-codex/gpt-5.5" };
    const gated = await call(dir, config, { run: true });
    expect(gated.ok).toBe(false);
    if (!gated.ok) expect(gated.gate).toMatch(/definition does not load.*persona\.md is no longer read/);
    const warned = await call(dir, config, { run: false });
    expect(warned.ok).toBe(true);
    if (warned.ok)
      expect(warned.messages).toContainEqual({
        level: "warn",
        text: expect.stringMatching(/definition does not load/),
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
    const dir = await agent();
    await mkdir(join(dir, "channels"), { recursive: true });
    await writeFile(join(dir, "channels", "slack.mjs"), "export default () => ({ '/slack': () => new Response() });\n");
    const pre = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(pre.ok).toBe(true);
    if (pre.ok) {
      expect(pre.channels).toEqual([{ name: "slack", ingress: "webhook" }]);
      expect(pre.messages.some((message) => message.text.includes('channel "slack" is custom'))).toBe(false);
    }
  });

  it("notes a custom channel (its webhook is the author's to wire; its variables travel like every other)", async () => {
    const dir = await agent();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "channels"), { recursive: true });
    await writeFile(join(dir, "channels", "discord.ts"), "export default () => ({});\n");
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

  it("a custom channel's declared secrets join the required list", async () => {
    const dir = await agent();
    await mkdir(join(dir, "channels"), { recursive: true });
    await writeFile(
      join(dir, "channels", "discord.mjs"),
      `export default Object.assign(() => ({}), { secrets: ["DISCORD_TOKEN"] });\n`,
    );
    const pre = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(pre.ok).toBe(true);
    if (!pre.ok) return;
    expect(pre.declaredSecrets).toContainEqual({ name: "DISCORD_TOKEN", source: "channels/discord.mjs" });
  });

  it("recognizes a long-connection module structurally and reports its always-on requirement", async () => {
    const dir = await agent();
    await mkdir(join(dir, "channels"), { recursive: true });
    await writeFile(
      join(dir, "channels", "feishu.mjs"),
      `export default { name: "feishu websocket", connect() {} };\n`,
    );
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
    const dir = await agent();
    await mkdir(join(dir, "channels"), { recursive: true });
    await writeFile(join(dir, "channels", "socket.mjs"), `export default { name: "custom socket", connect() {} };\n`);
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

  it("fails visibly when an enabled channel throws during deployment inspection", async () => {
    const dir = await agent();
    await mkdir(join(dir, "channels"), { recursive: true });
    await writeFile(join(dir, "channels", "broken.mjs"), `throw new Error("import exploded");\n`);
    await expect(call(dir, { model: "openai/gpt-4o-mini" })).rejects.toThrow(/cannot inspect.*import exploded/);
  });

  it("warns a KEPT hand-written Dockerfile that deploy.apt won't reach, --force included", async () => {
    // `--force` does not rescue it: writeArtifacts refuses a file it did not generate whatever the flag says, so the
    // packages are dropped either way. Suppressing the warning under `--force` only hid that.
    const dir = await agent({ Dockerfile: "FROM python:3.12\n" }); // no generated marker → hand-written
    const config: FastagentConfig = { model: "openai/gpt-4o-mini", deploy: { apt: ["git"] } };

    for (const force of [false, true]) {
      const pre = await call(dir, config, { force });
      expect(pre.ok).toBe(true);
      if (pre.ok) {
        expect(pre.messages).toContainEqual({ level: "warn", text: expect.stringMatching(/deploy\.apt.*NOT applied/) });
      }
    }
  });

  it("a declared schedule keeps a machine up; the agent's own wake-ups do not", async () => {
    // Nothing → false, no note. Every serve mounts `wake`, so a wake-up is NOT a reason to stay up: a box that slept
    // fires what is due when a request next wakes it.
    const none = await call(await agent(), { model: "openai/gpt-4o-mini" });
    expect(none.ok && !none.hasCron).toBe(true);
    if (none.ok) expect(none.messages.find((m) => /keeps one machine running/.test(m.text))).toBeUndefined();

    // A schedules/ file → hasCron: the schedule is the agent's own clock, so nothing wakes a sleeping box for it.
    const { mkdir, writeFile: wf } = await import("node:fs/promises");
    const dir = await agent();
    await mkdir(join(dir, "schedules"), { recursive: true });
    // A file that fails to LOAD still counts, conservatively: it may well be a schedule tomorrow, and scaling to
    // zero because it did not parse would hide that behind silence.
    await wf(join(dir, "schedules", "broken.md"), "no frontmatter\n");
    const broken = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(broken.ok && broken.hasCron).toBe(true);
    if (broken.ok) {
      expect(broken.messages.map((m) => m.text).join("\n")).toMatch(/schedules\/broken\.md is not a valid schedule/);
    }
    await wf(join(dir, "schedules", "broken.md"), `---\ncron: "0 9 * * *"\n---\ngo\n`);
    const withCron = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(withCron.ok && withCron.hasCron).toBe(true);
    if (withCron.ok) {
      const note = withCron.messages.find((m) => /keeps one machine running/.test(m.text));
      expect(note?.level).toBe("note");
    }
    // Past the cap, a valid file would never fire on the box: refused here like a broken one.
    for (let i = 0; i < 20; i++)
      await wf(join(dir, "schedules", `s${String(i).padStart(2, "0")}.md`), `---\ncron: "0 9 * * *"\n---\ngo\n`);
    const over = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(over.ok).toBe(true);
    if (over.ok) {
      const issues = over.messages.filter((m) => /past the first 20 schedules/.test(m.text)).map((m) => m.text);
      expect(issues).toEqual([expect.stringMatching(/^schedules\/s19\.md is past the first 20/)]);
    }
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

  it("a model only the definition's extensions declare is not gated: its credentials are that code's, on the box", async () => {
    const dir = await agent({
      "extensions/router.ts": `export default (pi) => pi.registerVirtualModel({
  provider: "router", id: "auto", name: "Automatic",
  route: (_request, ctx) => ({ model: ctx.modelRegistry.find("anthropic", "claude-sonnet-4-5"), thinkingLevel: "off" }),
});\n`,
    });
    const pre = await call(dir, { model: "router/auto" }, { run: true });
    if (!pre.ok) throw new Error(`preflight gated: ${pre.gate}`);
    expect(pre.boxLogin).toBeUndefined();
    expect(pre.messages).toContainEqual({
      level: "note",
      text: expect.stringMatching(/router\/auto is declared by the definition's extensions/),
    });
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

  it('a built-in provider the definition keys by its own "$NAME" carries that variable, even over a local login', async () => {
    // environmentAuthSource knows only the built-in variable (ANTHROPIC_API_KEY); the deployed registry reads the
    // definition's reference instead, so that is what the value file must hold and what travels.
    noAnthropicEnv();
    const oauth = { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 };
    const keyedBy = (env: string) =>
      agent({
        "models.json": JSON.stringify({ providers: { anthropic: { apiKey: "$MY_ANT_KEY" } } }),
        ".secrets/auth.json": JSON.stringify({ anthropic: oauth }),
        ".secrets/.env": env,
      });
    const held = await call(
      await keyedBy("MY_ANT_KEY=sk-ant\n"),
      { model: "anthropic/claude-sonnet-4-5" },
      { run: true },
    );
    if (!held.ok) throw new Error(held.gate);
    expect(held.boxLogin).toBeUndefined();
    expect(held.modelAuth).toBe("MY_ANT_KEY");

    // Declared but not set yet: still that variable, which the values gate then asks for by name.
    const unset = await call(await keyedBy(""), { model: "anthropic/claude-sonnet-4-5" }, { run: true });
    if (!unset.ok) throw new Error(unset.gate);
    expect(unset.boxLogin).toBeUndefined();
    expect(unset.secrets.map((s) => s.name)).toContain("MY_ANT_KEY");
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

describe("preflight: how a models.json endpoint's credential reaches the host", () => {
  afterEach(() => vi.unstubAllEnvs());
  const GATEWAY = (apiKey: string, baseUrl = "https://gw.example.com/v1") =>
    JSON.stringify({
      providers: { mygw: { baseUrl, api: "openai-completions", apiKey, models: [{ id: "m1" }] } },
    });

  it("an env-keyed endpoint reports the VARIABLE NAME, so the value carries like any provider key", async () => {
    // What made this wrong: probeAuthSource answers "is it authenticated here" ("configured API key"),
    // not "how does the credential reach the host". Reporting the display label left `--run` seeing no
    // credential at all, and it stopped a correctly configured agent with two impossible remedies.
    const dir = await agent({ "models.json": GATEWAY("$FA_PREFLIGHT_GW_KEY") });
    process.env.FA_PREFLIGHT_GW_KEY = "sk-x";
    try {
      const pre = await call(dir, { model: "mygw/m1" });
      expect(pre.ok).toBe(true);
      if (pre.ok) {
        expect(pre.modelAuth).toBe("FA_PREFLIGHT_GW_KEY"); // the name, not "configured API key"
        expect(pre.boxLogin).toBeUndefined();
      }
    } finally {
      delete process.env.FA_PREFLIGHT_GW_KEY;
    }
  });

  it("a literal key WARNS, whatever it points at — the framework does not decide what is a credential", () => {
    // FastAgent gates what IT causes (a packing rule that would put `.secrets/auth.json` in the image); this is the
    // author's own committed file, and no static rule separates a leaked key from the placeholder pi's docs
    // prescribe for a keyless local server (`"apiKey": "ollama"`). So: report, never refuse.
    return (async () => {
      for (const baseUrl of ["https://gw.example.com/v1", "http://localhost:11434/v1"]) {
        const dir = await agent({ "models.json": GATEWAY("sk-literal-in-file", baseUrl) });
        const pre = await call(dir, { model: "mygw/m1" }, { run: true });
        expect(pre.ok).toBe(true);
        if (pre.ok) {
          expect(pre.boxLogin).toBeUndefined(); // the definition carries it: nothing to carry, nothing to log in
          expect(pre.messages).toContainEqual({ level: "warn", text: expect.stringMatching(/literal apiKey/) });
        }
      }
    })();
  });

  it("every provider is reported, not just the selected model's — the file ships whole", async () => {
    const dir = await agent({
      "models.json": JSON.stringify({
        providers: {
          mygw: {
            baseUrl: "https://a.example.com/v1",
            api: "openai-completions",
            apiKey: "$K",
            models: [{ id: "m1" }],
          },
          unused: {
            baseUrl: "https://b.example.com/v1",
            api: "openai-completions",
            apiKey: "sk-u",
            models: [{ id: "m2" }],
          },
        },
      }),
    });
    vi.stubEnv("K", "sk-k"); // the selected model resolves its key, so the run is not refused for that
    const pre = await call(dir, { model: "mygw/m1" }, { run: true });
    expect(pre.ok).toBe(true);
    if (pre.ok) expect(pre.messages).toContainEqual({ level: "warn", text: expect.stringMatching(/"unused"/) });
  });

  it("a !command key is not reported — it runs on the box and the credential never travels", async () => {
    const dir = await agent({ "models.json": GATEWAY("!printf sk-from-a-command") });
    const pre = await call(dir, { model: "mygw/m1" }, { run: true });
    expect(pre.ok).toBe(true);
    if (pre.ok) {
      expect(pre.boxLogin).toBeUndefined();
      expect(pre.messages.some((m) => /literal apiKey/.test(m.text))).toBe(false);
    }
  });

  it("a model whose endpoint comes only from the machine's models.json is warned about: that file does not ship", async () => {
    const machine = join(await mkdtemp(join(tmpdir(), "fa-machine-models-")), "models.json");
    await writeFile(
      machine,
      JSON.stringify({
        providers: {
          localgw: {
            baseUrl: "http://127.0.0.1:8000/v1",
            api: "openai-completions",
            apiKey: "x",
            models: [{ id: "m" }],
          },
        },
      }),
    );
    vi.stubEnv("FASTAGENT_MODELS_PATH", machine);
    const pre = await call(await agent(), { model: "localgw/m" });
    expect(pre.ok).toBe(true);
    if (pre.ok) {
      expect(pre.messages).toContainEqual({ level: "warn", text: expect.stringMatching(/localgw.*does not ship/) });
    }
    // No built-in "localgw" to fall back on, so running the deployment is refused, not warned about.
    const running = await call(await agent(), { model: "localgw/m" }, { run: true });
    expect(running).toMatchObject({ ok: false, gate: expect.stringMatching(/unknown model/) });

    // The agent's own entry for the provider is what ships, so nothing is said.
    const own = await agent({
      "models.json": JSON.stringify({
        providers: {
          localgw: {
            baseUrl: "https://gw.example.com/v1",
            api: "openai-completions",
            apiKey: "$K",
            models: [{ id: "m" }],
          },
        },
      }),
    });
    const shipped = await call(own, { model: "localgw/m" });
    expect(shipped.ok).toBe(true);
    if (shipped.ok) expect(shipped.messages.some((m) => /does not ship/.test(m.text))).toBe(false);
  });

  it("a model known only from the machine's model catalog is refused under --run; the agent's own catalog ships", async () => {
    // As `fastagent models --refresh` leaves it: one anthropic model newer than the bundled catalog.
    const [bundled] = createPiModels().getProvider("anthropic")?.getModels() ?? [];
    const entry = { models: [{ ...bundled, id: "claude-newer" }], lastModified: Date.now() + 86_400_000 };
    await mkdir(dirname(globalCatalogPath()), { recursive: true });
    await writeFile(globalCatalogPath(), JSON.stringify({ anthropic: entry }));
    try {
      const running = await call(await agent(), { model: "anthropic/claude-newer" }, { run: true });
      expect(running).toMatchObject({ ok: false, gate: expect.stringMatching(/does not ship.*models --refresh/) });

      // An entry pi ignores (dated no later than its bundled catalog, as pi writes a 404) supplies nothing here either,
      // so it is no reason to send anyone to refresh the agent.
      await writeFile(globalCatalogPath(), JSON.stringify({ anthropic: { ...entry, lastModified: 0 } }));
      const ignored = await call(await agent(), { model: "anthropic/claude-newer" });
      expect(ignored.ok && ignored.messages.some((m) => /machine's model catalog/.test(m.text))).toBe(false);
      await writeFile(globalCatalogPath(), JSON.stringify({ anthropic: entry }));

      // The same entry in the agent's own models-store.json travels with the definition: nothing to say.
      const own = await agent({ "models-store.json": JSON.stringify({ anthropic: entry }) });
      const shipped = await call(own, { model: "anthropic/claude-newer" }, { run: true });
      if (!shipped.ok) throw new Error(shipped.gate);
      expect(shipped.messages.some((m) => /does not ship/.test(m.text))).toBe(false);
    } finally {
      await rm(globalCatalogPath(), { force: true });
    }
  });

  it("a machine entry that only overrides a built-in provider is warned about, and its key does not count", async () => {
    const anthropic = createPiModels().getProvider("anthropic")?.getModels()[0]?.id as string;
    const machine = join(await mkdtemp(join(tmpdir(), "fa-machine-models-")), "models.json");
    // The company-gateway shape: the machine routes built-in anthropic through a proxy with its own key.
    await writeFile(
      machine,
      JSON.stringify({
        providers: { anthropic: { baseUrl: "https://llm-proxy.internal/v1", apiKey: "$CORP_PROXY_KEY" } },
      }),
    );
    vi.stubEnv("FASTAGENT_MODELS_PATH", machine);
    vi.stubEnv("CORP_PROXY_KEY", "proxy");

    // The deployment's key, where a deployment's key lives: the value file.
    const pre = await call(
      await agent({ ".secrets/.env": "ANTHROPIC_API_KEY=sk-ant\n" }),
      { model: `anthropic/${anthropic}` },
      { run: true },
    );

    expect(pre.ok).toBe(true); // the deployed agent still resolves pi's built-in anthropic
    if (pre.ok) {
      expect(pre.messages).toContainEqual({
        level: "warn",
        text: expect.stringMatching(/built-in "anthropic" without it/),
      });
      // Judged on the deployed registry: the host needs ANTHROPIC_API_KEY, not the machine's proxy key.
      expect(pre.modelAuth).toBe("ANTHROPIC_API_KEY");
      expect(pre.boxLogin).toBeUndefined();
      expect(pre.secrets.map((secret) => secret.name)).toContain("ANTHROPIC_API_KEY");
    }
  });

  it("requires what tools DECLARED, and lists the rest of the value file after them", async () => {
    const dir = await agent();
    await mkdir(join(dir, "tools"), { recursive: true });
    await writeFile(
      join(dir, "tools", "x-post.mjs"),
      `export default { name: "x-post", description: "post", parameters: {},
         secrets: ["X_API_KEY", "X_API_SECRET"], execute: async () => ({ content: [] }) };\n`,
    );
    await mkdir(join(dir, ".secrets"), { recursive: true });
    await writeFile(join(dir, ".secrets", ".env"), "GH_TOKEN=ghp\nX_API_KEY=x\n");
    const pre = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(pre.ok).toBe(true);
    if (!pre.ok) return;
    expect(pre.declaredSecrets).toEqual([
      { name: "X_API_KEY", source: "tools/x-post.mjs" },
      { name: "X_API_SECRET", source: "tools/x-post.mjs" },
    ]);
    // The runbook names the file to open for a required one, and the value file for the rest.
    expect(pre.secrets).toEqual([
      { name: "X_API_KEY", hint: "required by tools/x-post.mjs" },
      { name: "X_API_SECRET", hint: "required by tools/x-post.mjs" },
      { name: "GH_TOKEN", hint: "from .secrets/.env" },
    ]);
  });

  it("warns when a code input cannot be loaded, and GATES --run on it", async () => {
    // Generate-only warns: the operator may be producing artifacts on a machine that never installed
    // the agent's deps. `--run` gates, because the BOX will load that file successfully and refuse to
    // start on a declaration this deploy could not read — a crash loop after a "successful" deploy.
    const dir = await agent();
    await mkdir(join(dir, "tools"), { recursive: true });
    await writeFile(join(dir, "tools", "broken.mjs"), `throw new Error("boom");\n`);
    const pre = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(pre.ok).toBe(true);
    if (pre.ok) {
      expect(pre.messages.some((m) => m.level === "warn" && /tools\/broken\.mjs failed to load/.test(m.text))).toBe(
        true,
      );
    }
    const run = await call(dir, { model: "openai/gpt-4o-mini" }, { run: true });
    expect(run.ok).toBe(false);
    if (!run.ok) expect(run.gate).toMatch(/tools\/broken\.mjs failed to load.*would refuse to start/);
  });

  it("sessionControl needs no secret of ours — it warns that the deployed plane is unauthenticated", async () => {
    const dir = await agent();
    const off = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(off.ok && off.declaredSecrets).toEqual([]);
    // WITHOUT the control plane the warning still fires, naming `POST /invoke`: it is on every
    // deployment whatever channels are declared, and conditioning this on `sessionControl` left a
    // telegram-only agent publishing "run a turn with my tools" on a public URL in silence.
    const unauthenticated = (pre: Awaited<ReturnType<typeof call>>) =>
      pre.ok ? pre.messages.filter((m) => m.level === "warn" && /UNAUTHENTICATED/.test(m.text)) : [];
    const anonymous = unauthenticated(off);
    expect(anonymous).toHaveLength(1);
    expect(anonymous[0]?.text).toContain("POST /invoke");
    expect(anonymous[0]?.text).not.toContain("/control/*");
    // …and NOT on a host that publishes no URL at all: the AgentCore container is reachable only
    // through the Runtime's IAM and the forwarder's shared secret. A warning about a public endpoint
    // that does not exist is how an operator learns to skim past every deploy warning.
    expect(unauthenticated(await call(dir, { model: "openai/gpt-4o-mini" }, { publicUrl: false }))).toEqual([]);

    // The same rule applied to the definition, not just the host: `http.invoke: false` withholds the
    // one endpoint this warning would otherwise name, so with no control plane either there is
    // nothing left to warn about.
    const withheld = await call(dir, { model: "openai/gpt-4o-mini", http: { invoke: false } });
    expect(unauthenticated(withheld)).toEqual([]);
    // With the control plane on, the warning stands — naming only what is actually served.
    const controlOnly = unauthenticated(
      await call(dir, { model: "openai/gpt-4o-mini", http: { invoke: false }, sessionControl: true }),
    );
    expect(controlOnly).toHaveLength(1);
    expect(controlOnly[0]?.text).toContain("/control/*");
    expect(controlOnly[0]?.text).not.toContain("POST /invoke");

    const on = await call(dir, { model: "openai/gpt-4o-mini", sessionControl: true });
    expect(on.ok).toBe(true);
    if (on.ok) {
      // Only what the DEFINITION declared: fastagent mints no credential of its own any more.
      expect(on.declaredSecrets).toEqual([]);
      // The operator still has to hear it, because the plane rides the PUBLIC host URL.
      expect(on.messages.some((m) => m.level === "warn" && /UNAUTHENTICATED/.test(m.text))).toBe(true);
    }
  });
});
