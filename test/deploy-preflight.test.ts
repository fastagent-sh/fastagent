import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { preflightDeploy } from "../src/deploy/preflight.ts";
import { type AnyModel, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { modelsOver } from "../src/harnesses/models/models.ts";
import { resolveStateRoot } from "../src/paths.ts";
import { useValueFile } from "../src/value-file.ts";
import { keepCatalog } from "./kept-catalog.ts";
import { readInstanceConfigFile } from "../src/harnesses/pi-durable/config.ts";
import { MISE_PACKAGE_NAMES } from "../src/environment/mise.ts";
import { CODEX_MODEL } from "./codex-model.ts";
import { agent, empty, call } from "./deploy-preflight-fixtures.ts";

vi.mock("../src/git.ts", () => import("./git-double.ts"));

describe("deploy/preflight: the host-neutral pre-flight", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("gates an agent with no package.json, which cannot be built, before it writes or builds anything", async () => {
    const dir = await agent();
    await rm(join(dir, "package.json"));
    const pre = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(pre.ok).toBe(false);
    if (!pre.ok) expect(pre.gate).toMatch(/no package\.json, and a deployed agent is built/);
    expect(existsSync(join(dir, "dist"))).toBe(false);
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

  it("takes the model from the configuration alone: a FASTAGENT_MODEL in the environment or a file is the machine's", async () => {
    // The shell and a file name what runs on the machine they are on, and a deployment's model is what its
    // configuration says: delivered whole at every deploy, so nothing stale outlives a change on a host.
    const dir = await agent();
    vi.stubEnv("FASTAGENT_MODEL", "openai/gpt-4o-mini");
    await writeFile(join(dir, ".secrets", ".env"), "FASTAGENT_MODEL=anthropic/other\n");
    const pre = await call(dir, { model: "openai/gpt-4.1" }, { run: true });
    if (!pre.ok) throw new Error(pre.gate);
    expect(pre.messages).toContainEqual({ level: "note", text: "model openai/gpt-4.1 (source: fastagent.config)" });
    expect(JSON.parse(pre.container.config)).toEqual({});
    expect(pre.declaredSecrets.map((s) => s.name)).not.toContain("FASTAGENT_MODEL");
  });

  it("a model only a fetched list has passes, warning that a box with no list kept must fetch it to start", async () => {
    const dir = await agent();
    const builtIn = modelsOver(new InMemoryCredentialStore()).getModels("openai")[0] as AnyModel;
    keepCatalog(join(resolveStateRoot(dir), "models"), [{ ...builtIn, id: "gpt-released" }]);
    const released = await call(dir, { model: "openai/gpt-released" });
    if (!released.ok) throw new Error(`preflight gated: ${released.gate}`);
    expect(released.messages).toContainEqual({
      level: "warn",
      text: expect.stringMatching(/^"openai\/gpt-released" is in pi's published catalog, not in the pi-ai/),
    });
    const carried = await call(dir, { model: `openai/${builtIn.id}` });
    if (!carried.ok) throw new Error(`preflight gated: ${carried.gate}`);
    expect(carried.messages.filter(({ text }) => /is in pi's published catalog/.test(text))).toEqual([]);
  });

  it("a config model adds nothing to the delivered configuration — the program's defaults are in the image", async () => {
    const pre = await call(await agent(), { model: "openai/gpt-4o-mini" }, { run: true });
    expect(pre.ok).toBe(true);
    if (!pre.ok) return;
    expect(pre.messages).toContainEqual({ level: "note", text: "model openai/gpt-4o-mini (source: fastagent.config)" });
    expect(JSON.parse(pre.container.config)).toEqual({});
  });

  it("gates a model that is not a spec, but accepts a multi-segment modelId", async () => {
    // A provider-less spec resolves to nothing on the box, so letting it past this point ships the crash-loop the
    // gate exists to stop. A `/` inside the modelId is not a typo: 795 of pi's 1354 built-in specs look like
    // `baseten/zai-org/GLM-5.3`, and resolution splits on the first slash. Gated with or without `--run`: a spec the
    // box cannot resolve is a crash loop no artifact can say otherwise.
    const dir = await agent();
    for (const bad of ["openai/gpt-4o mini", "gpt-4o"]) {
      const pre = await call(dir, { model: bad });
      expect(pre.ok).toBe(false);
      if (!pre.ok) expect(pre.gate).toMatch(/model in fastagent\.config is not a "provider\/modelId"/);
    }
    const pre = await call(dir, { model: "baseten/zai-org/GLM-5.3" }, { run: true });
    expect(pre.ok).toBe(true);
  });

  it("asks a kept Dockerfile for the deployed mark, and nothing about the instance: its configuration and name are variables on the host", async () => {
    // Without the mark `start` takes no storage: a box that lost it runs as a local instance on a disk that is gone at
    // the next restart. The INSTRUCTION is the question, not who wrote the file, and `--force` does not rescue it.
    const unmarked = await agent({ Dockerfile: "FROM node:22-slim\n" });
    const config = { model: "openai/gpt-4o-mini" };
    const delivered = { source: { values: { thinkingLevel: "high" }, label: "/elsewhere/fastagent.json" } };
    const gated = await call(unmarked, config, { run: true, delivered });
    expect(gated).toMatchObject({ ok: false, gate: expect.stringMatching(/does not set FASTAGENT_DEPLOYED/) });
    expect((await call(unmarked, config, { run: true, force: true })).ok).toBe(false);
    const planned = await call(unmarked, config);
    expect(planned.ok && planned.messages.some((m) => /does not set FASTAGENT_DEPLOYED/.test(m.text))).toBe(true);
    // The ordinary multi-variable spelling is fine: reading only the first name after `ENV` would false-gate it.
    for (const env of ["ENV FASTAGENT_DEPLOYED=1", "ENV FASTAGENT_ROOT=/data FASTAGENT_DEPLOYED=1"]) {
      const own = await agent({ Dockerfile: `FROM node:22-slim\n${env}\n` });
      const pre = await call(own, config, { run: true, delivered });
      expect(pre.ok).toBe(true);
      if (pre.ok) expect(JSON.stringify(pre.messages)).not.toMatch(/FASTAGENT_CONFIG|FASTAGENT_RELEASE/);
    }
  });

  it("container facts come from the AGENT DIR; git auto-baked when it ships .git", async () => {
    const agentDir = await agent({
      "fastagent.config.ts": `export default { defaults: { model: "openai/gpt-4o-mini" } };\n`,
      "package.json": `{"type":"module","dependencies":{"@fastagent-sh/fastagent":"^1"}}`,
    });
    await mkdir(join(agentDir, ".git")); // the agent is a git repo — the image gets the git binary

    const ok = await call(agentDir, { model: "openai/gpt-4o-mini" }, { run: true });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
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
    const instance = join(agentDir, ".fastagent", "dev");
    await mkdir(join(instance, ".state"), { recursive: true }); // …as does machine state: only what is THERE gets warned about
    await mkdir(join(agentDir, "content")); // …and clones in the root, which a host refuses
    await writeFile(join(agentDir, ".dockerignore"), ".git\n"); // the author's own — kept, not ours

    const pre = await call(agentDir, { model: "openai/gpt-4o-mini" });
    expect(pre.ok).toBe(true);
    if (pre.ok) {
      const text = JSON.stringify(pre.messages);
      expect(text).toMatch(/BAKE SECRETS INTO THE IMAGE/); // missing .secrets/.env excludes — the critical one
      expect(text).toMatch(/does not exclude .{0,12}\.fastagent.{0,12} — the build machine's sessions/); // state and clones would ship
      expect(text).toMatch(/does not exclude .{0,12}content.{0,12} — this machine's clones/); // an issue: --run gates on it
      expect(text).toMatch(/does not exclude .{0,30}node_modules/); // the native-binary clobber hazard — named
      expect(text).toMatch(/excludes \.git/); // pull\/push loop dead — named as a note
    }
    // Shipped content/ is refused, not only warned about: the host links its own there, and a release holding one
    // does not start.
    await writeFile(join(agentDir, ".dockerignore"), "**/.secrets\n**/.env\n");
    const gated = await call(agentDir, { model: "openai/gpt-4o-mini" }, { run: true });
    expect(gated).toMatchObject({ ok: false, gate: expect.stringMatching(/does not exclude .content/) });
  });

  it("a kept .dockerignore that excludes only the state by name still warns that the instance's clones would ship", async () => {
    const agentDir = await agent({ "package.json": `{"type":"module"}` });
    await mkdir(join(agentDir, ".fastagent", "dev", "content", "app"), { recursive: true });
    await mkdir(join(agentDir, ".fastagent", "dev", ".state"), { recursive: true });
    const ignore = join(agentDir, ".dockerignore");
    // What an earlier generated file, and many written by hand, hold: the name-based rules, which cover .state alone.
    await writeFile(ignore, "**/node_modules\n**/.secrets/**\n**/.state\n**/.env\n/content\n");
    const warned = async () => {
      const pre = await call(agentDir, { model: "openai/gpt-4o-mini" });
      if (!pre.ok) throw new Error(pre.gate);
      return JSON.stringify(pre.messages);
    };
    expect(await warned()).toMatch(/does not exclude .{0,12}\.fastagent.{0,12} — the build machine's sessions/);
    await writeFile(ignore, "**/node_modules\n**/.secrets/**\n**/.state\n**/.env\n/content\n/.fastagent\n");
    expect(await warned()).not.toMatch(/does not exclude .{0,12}\.fastagent/);
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

  it("lists the secrets the MCP servers of the program and of the delivered configuration reference", async () => {
    const dir = await agent({
      "context.json": JSON.stringify({
        mcpServers: { test: { command: "node", env: { TOKEN: "$" + "{MCP_TOKEN}" } } },
      }),
    });
    const config = join(dir, "..", `delivered-${basename(dir)}.json`);
    await writeFile(
      config,
      JSON.stringify({
        mcpServers: {
          notes: {
            type: "http",
            url: "https://notes.example.com/mcp",
            headers: { Authorization: "Bearer $" + "{NOTES_KEY}" },
          },
        },
      }),
    );
    const delivered = await readInstanceConfigFile(config);
    const pre = await call(dir, { model: "openai/gpt-4o-mini" }, { delivered: { source: delivered } });
    expect(pre.ok).toBe(true);
    if (!pre.ok) return;
    expect(pre.declaredSecrets).toContainEqual(
      expect.objectContaining({ name: "MCP_TOKEN", declaredIn: "context.json mcpServers.test" }),
    );
    expect(pre.declaredSecrets).toContainEqual(
      expect.objectContaining({ name: "NOTES_KEY", declaredIn: `${config} mcpServers.notes` }),
    );
  });

  describe("the MCP servers the box will open", () => {
    const delivering = async (dir: string, mcpServers: unknown) => {
      const config = join(dir, "..", `mcp-${basename(dir)}.json`);
      await writeFile(config, JSON.stringify({ mcpServers }));
      return { source: await readInstanceConfigFile(config), config };
    };
    const said = (pre: Awaited<ReturnType<typeof call>>) => (pre.ok ? pre.messages : []);

    it("warns of a literal credential in the program's servers, and refuses one in the delivered configuration's", async () => {
      const dir = await agent({
        "context.json": JSON.stringify({
          mcpServers: {
            docs: { type: "http", url: "https://docs.example.com/mcp", headers: { Authorization: "Bearer abc" } },
          },
        }),
      });
      const delivered = await delivering(dir, {
        notes: { command: "node", env: { NOTES_TOKEN: "ghp_x", OK: "$" + "{OK_VALUE}" } },
      });
      // Generate-only says both, as warnings.
      const planned = await call(dir, { model: "openai/gpt-4o-mini" }, { delivered });
      expect(planned.ok).toBe(true);
      const literals = said(planned).filter((m) => m.text.includes("is a literal value"));
      expect(literals.map((m) => m.level)).toEqual(["warn", "warn"]);
      expect(literals[0]?.text).toMatch(
        /^context\.json mcpServers\.docs\.headers\.Authorization is a literal value, and this deploy puts it in the image: replace the secret in it with \$\{AUTHORIZATION\} \(a scheme stays: `Bearer \$\{AUTHORIZATION\}`\)/,
      );
      expect(literals[1]?.text).toContain(`${delivered.config} mcpServers.notes.env.NOTES_TOKEN is a literal value`);
      expect(literals[1]?.text).toContain("manifest meant to be committed");
      expect(literals[1]?.text).toContain("write ${NOTES_TOKEN}");
      expect(literals[1]?.text).toContain("fastagent secrets set <host> <NAME>");

      // A deploy that runs stops at the delivered one only: the program's is in the image, as its code is, while this
      // one is written into a manifest meant to be committed and shown on the platform.
      const gated = await call(dir, { model: "openai/gpt-4o-mini" }, { delivered, run: true });
      expect(gated.ok).toBe(false);
      if (!gated.ok) expect(gated.gate).toContain("mcpServers.notes.env.NOTES_TOKEN is a literal value");
      const programOnly = await call(dir, { model: "openai/gpt-4o-mini" }, { run: true });
      expect(programOnly.ok).toBe(true);
    });

    it("refuses a relative stdio command in the delivered configuration, which nothing delivers, and allows the others", async () => {
      const dir = await agent({
        "context.json": JSON.stringify({ mcpServers: { packaged: { command: "./assets/server" } } }),
      });
      const relative = await delivering(dir, { scripted: { command: "./notes-server" } });
      const gated = await call(dir, { model: "openai/gpt-4o-mini" }, { delivered: relative, run: true });
      expect(gated.ok).toBe(false);
      if (!gated.ok)
        expect(gated.gate).toMatch(/mcpServers\.scripted: the command "\.\/notes-server" is a relative path/);
      const warned = await call(dir, { model: "openai/gpt-4o-mini" }, { delivered: relative });
      expect(said(warned).some((m) => m.level === "warn" && m.text.includes("is a relative path"))).toBe(true);
      // The program's own relative command is the package's (what `build` copies, `assets/` among it); a bare or absolute command, or a
      // variable that supplies the directory, is the box's to find.
      const fine = await delivering(dir, {
        bare: { command: "npx" },
        absolute: { command: "/opt/mcp/server" },
        variable: { command: "$" + "{MCP_HOME}/server" },
      });
      const ok = await call(dir, { model: "openai/gpt-4o-mini" }, { delivered: fine, run: true });
      expect(ok.ok).toBe(true);
    });

    it("reports a name both declare as an issue, instead of failing when the box opens", async () => {
      const dir = await agent({ "context.json": JSON.stringify({ mcpServers: { docs: { command: "node" } } }) });
      const delivered = await delivering(dir, { docs: { command: "npx" } });
      const gated = await call(dir, { model: "openai/gpt-4o-mini" }, { delivered, run: true });
      expect(gated.ok).toBe(false);
      if (!gated.ok) expect(gated.gate).toMatch(/MCP server "docs" is declared by the program/);
      const warned = await call(dir, { model: "openai/gpt-4o-mini" }, { delivered });
      expect(warned.ok).toBe(true);
      expect(said(warned).some((m) => m.text.includes('MCP server "docs" is declared by the program'))).toBe(true);
    });
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
        name: "agent",
        config: { ...empty, model: "openai/gpt-4o-mini" },
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
        expect(clean.container.machineryPaths).toEqual([".secrets", "creds"]);

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

  it("tells a kept .dockerignore that excludes nothing of .fastagent to exclude it AND let the deploy's directory through", async () => {
    // Following the first half alone drops `.fastagent/deploy/`, which the image is built from.
    const agentDir = await agent();
    await mkdir(join(agentDir, ".fastagent"), { recursive: true });
    await writeFile(join(agentDir, ".dockerignore"), "**/node_modules\n**/.secrets/**\n**/.state\n**/.env\n");
    const planned = await call(agentDir, { model: "openai/gpt-4o-mini" });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const said = planned.messages.map((m) => m.text).find((text) => text.includes("does not exclude `.fastagent`"));
    expect(said).toContain("`/.fastagent` and `!/.fastagent/deploy`");
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

  it("carries only the configuration --config delivers: its repositories are cloned, a directory is an issue", async () => {
    const dir = await agent({
      "context.json": JSON.stringify({ content: { handbook: { github: "acme/handbook" } } }),
      // The development instance's, which a deploy does not carry.
      "fastagent.json": JSON.stringify({ content: { app: { path: "/code/app" } } }),
    });
    const configDir = await mkdtemp(join(tmpdir(), "fa-preflight-config-"));
    const deliver = (values: object): NonNullable<Parameters<typeof preflightDeploy>[0]["delivered"]> => ({
      source: { values, label: join(configDir, "fastagent.json"), directory: configDir },
    });

    const plain = await call(dir, { model: "openai/gpt-4o-mini" }, { run: true });
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    expect(plain.messages.map((m) => m.text)).toContain(
      "fastagent.json is the development instance's configuration and a deploy does not carry it: pass --config " +
        "<file> to deliver one",
    );
    expect(JSON.stringify(plain.messages)).not.toMatch(/works on app/);
    expect(plain.container.config).toBe("{}");

    const repository = deliver({ settings: {}, content: { extra: { github: "acme/extra" } } });
    const delivered = await call(dir, { model: "openai/gpt-4o-mini" }, { run: true, delivered: repository });
    expect(delivered.ok).toBe(true);
    if (!delivered.ok) return;
    expect(delivered.messages.map((m) => m.text)).toEqual(
      expect.arrayContaining([
        "works on handbook: github acme/handbook, cloned on the host, and brought up to date in place at each start",
        "works on extra: github acme/extra, cloned on the host, and brought up to date in place at each start",
      ]),
    );
    expect(delivered.container.config).toBe(JSON.stringify(repository.source.values));
    expect(delivered.messages.map((m) => m.text)).toContain(
      `fastagent.json is the development instance's configuration and a deploy does not carry it; it carries ${join(configDir, "fastagent.json")}`,
    );
    // The installs of its git follow the content it delivers too.
    expect(delivered.container.apt).toContain("git");

    const local = deliver({ content: { data: { path: "/srv/data" } } });
    const gated = await call(dir, { model: "openai/gpt-4o-mini" }, { run: true, delivered: local });
    expect(gated).toMatchObject({
      ok: false,
      gate: expect.stringMatching(
        new RegExp(
          `^works on data: a directory of this machine \\(/srv/data\\), in ${join(configDir, "fastagent.json")}, which the host does not have`,
        ),
      ),
    });
  });

  it("declares no GITHUB_TOKEN where no repository is cloned: the name is the host's clone's, not every agent's", async () => {
    const dir = await agent({});
    const pre = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(pre.ok).toBe(true);
    if (!pre.ok) return;
    expect(pre.declaredSecrets.map((secret) => secret.name)).not.toContain("GITHUB_TOKEN");
    expect(pre.messages.some((m) => m.text.includes("GITHUB_TOKEN"))).toBe(false);
  });

  it("says what each repository context becomes on the host, bakes git, and names the token it clones with", async () => {
    const dir = await agent({
      "context.json": JSON.stringify({
        content: { app: { github: "acme/app" }, handbook: { github: "acme/handbook", ref: "main" } },
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
      "works on handbook: github acme/handbook@main, cloned on the host, and brought up to date in place at each start",
    );
    expect(notes).toContainEqual(
      expect.stringMatching(
        /^no GITHUB_TOKEN in the values given to this deploy \(--env-file or --from-env\): unless the target holds one, the host clones without/,
      ),
    );
    expect(notes.join("\n")).toContain("`fastagent secrets set <host> GITHUB_TOKEN`");
    // The name is declared (optional) so `secrets list|push|set` and `deploy` know it, only where a github entry is.
    expect(pre.declaredSecrets).toContainEqual(
      expect.objectContaining({ name: "GITHUB_TOKEN", optional: true, declaredIn: expect.stringContaining("github") }),
    );
    expect(pre.container.apt).toEqual(["git"]);

    // Where a deployment starts the storage over, a clone does not outlive a release, and that is said.
    vi.stubEnv("GITHUB_TOKEN", "ghp_x");
    const reset = await call(dir, config, { storageResets: true, fromEnv: true });
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
    const config = { model: CODEX_MODEL };
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

  it("computes container facts and no model WARNING when the model is in config ", async () => {
    const dir = await agent();
    const pre = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(pre.ok).toBe(true);
    if (!pre.ok) return;
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

  it("notes a custom channel (its webhook is the author's to wire; its variables are the target's to hold like every other)", async () => {
    const dir = await agent({ "src/channels/discord.ts": "export default () => ({});\n" });
    const pre = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(pre.ok).toBe(true);
    if (pre.ok) {
      expect(pre.channels).toEqual([{ name: "discord", ingress: "webhook" }]);
      expect(pre.messages).toContainEqual({
        level: "note",
        text: expect.stringContaining(
          'route channel "discord" is custom — the variables it declares are the target\'s to hold (`fastagent secrets`)',
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
      declaredIn: "src/channels/discord.ts",
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
    vi.stubEnv("GH_HOST", "github.example.com");
    const variablesOnly = await call(dir, { model: "openai/gpt-4o-mini" }, { fromEnv: true });
    expect(variablesOnly.ok && variablesOnly.messages.map((m) => m.text).join("\n")).not.toMatch(
      /kept your hand-written/,
    );
  });

  it("warns a kept hand-written Dockerfile that never runs `fastagent build`, which Railway's upload needs", async () => {
    const warned = (pre: Awaited<ReturnType<typeof call>>) =>
      pre.ok && pre.messages.some((m) => m.level === "warn" && /does not run `fastagent build`/.test(m.text));
    const without = await agent({ Dockerfile: "FROM node:24\nCOPY . .\n" });
    expect(warned(await call(without, { model: "openai/gpt-4o-mini" }))).toBe(true);
    for (const step of [
      "RUN ./node_modules/.bin/fastagent build",
      "RUN npx fastagent build",
      "RUN bun run fastagent build",
    ]) {
      const withStep = await agent({ Dockerfile: `FROM node:24\nCOPY . .\n${step}\n` });
      expect(warned(await call(withStep, { model: "openai/gpt-4o-mini" }))).toBe(false);
    }
    // A generated Dockerfile has the step itself, so there is nothing to say of it.
    expect(warned(await call(await agent(), { model: "openai/gpt-4o-mini" }))).toBe(false);
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
    await writeFile(join(ownImage, "Dockerfile"), "FROM oven/bun:1.4\nENV FASTAGENT_DEPLOYED=1\n");
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
      await writeFile(join(dir, "package.json"), '{"type":"module"}');
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
      if (!unknown.ok) {
        expect(unknown.gate).toMatch(/no provider of the deployed agent offers "gw\/nope"/);
        // What it could have been, and the command that lists the rest.
        expect(unknown.gate).toContain("gw's models include gw/m1 (`fastagent models gw` lists all 1)");
      }
    } finally {
      await rm(host, { recursive: true, force: true });
    }
  });

  it("a provider's own list is fetched as the box starts: a credential only a login on the box brings is warned of", async () => {
    // Under test/fixtures, so the configuration's import of pi-ai resolves this repository's.
    const host = join(import.meta.dirname, "fixtures", `.tmp-preflight-own-${process.pid}`);
    const dir = join(host, "agent");
    await mkdir(join(dir, ".secrets"), { recursive: true });
    try {
      await writeFile(join(dir, "package.json"), '{"type":"module"}');
      await writeFile(
        join(dir, "fastagent.config.ts"),
        `import { createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
const never = () => { throw new Error("no message is sent"); };
export default { providers: [createProvider({ id: "gw", auth: { apiKey: envApiKeyAuth("Gw", ["GW_KEY"]) }, models: [],
  fetchModels: async () => [], api: { stream: never, streamSimple: never } })] };\n`,
      );
      const builtIn = modelsOver(new InMemoryCredentialStore()).getModels("openai")[0] as AnyModel;
      const list = { models: [{ ...builtIn, id: "fetched-1", provider: "gw" }], checkedAt: Date.now() };
      await mkdir(join(resolveStateRoot(dir), "models", "providers"), { recursive: true });
      await writeFile(join(resolveStateRoot(dir), "models", "providers", "gw.json"), JSON.stringify(list));

      const fetchedFirst = /provider "gw" fetches its own model list/;
      const loginOnly = await call(dir, { model: "gw/fetched-1" }, { run: true });
      if (!loginOnly.ok) throw new Error(`preflight gated: ${loginOnly.gate}`);
      expect(loginOnly.messages).toContainEqual({
        level: "warn",
        text: expect.stringMatching(
          /^provider "gw" fetches its own model list, .* if "gw\/fetched-1" is only in that list, the box refuses to start on it until gw's API key is in the values given to this deploy \(--env-file or --from-env\)$/,
        ),
      });

      vi.stubEnv("GW_KEY", "k");
      const carried = await call(dir, { model: "gw/fetched-1" }, { run: true, fromEnv: true });
      if (!carried.ok) throw new Error(`preflight gated: ${carried.gate}`);
      expect(carried.messages.filter(({ text }) => fetchedFirst.test(text))).toEqual([]);
    } finally {
      await rm(host, { recursive: true, force: true });
    }
  });

  it("with nothing stored here either: the box still logs in, since this machine's login was never the source", async () => {
    noAnthropicEnv();
    const pre = await call(await agent(), { model: "anthropic/claude-sonnet-4-5" }, { run: true });
    expect(pre.ok && pre.boxLogin).toBe("anthropic");
  });

  it("a key in the environment travels only with --from-env: without it the shell's key is not a value the deploy was given", async () => {
    // The shell of whoever runs `deploy` holds what that person uses for other tools, and a provider key there must not
    // turn a subscription deploy into a key deploy. A CI job or `op run` says `--from-env`, as for `secrets push`.
    noAnthropicEnv();
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-from-the-shell");
    const without = await call(await agent(), { model: "anthropic/claude-sonnet-4-5" }, { run: true });
    if (!without.ok) throw new Error(without.gate);
    expect(without.boxLogin).toBe("anthropic");
    expect(without.modelAuth).toBeUndefined();
    expect(without.secrets.map((s) => s.name)).not.toContain("ANTHROPIC_API_KEY");

    const given = await call(await agent(), { model: "anthropic/claude-sonnet-4-5" }, { run: true, fromEnv: true });
    expect(given.ok && given.boxLogin).toBeUndefined();
    expect(given.ok && given.modelAuth).toBe("ANTHROPIC_API_KEY");
  });

  it("a key in the file --env-file names travels without --from-env, whatever the shell holds", async () => {
    noAnthropicEnv();
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-from-the-shell");
    const dir = await agent();
    const file = join(dir, "given.env");
    await writeFile(file, "OPENAI_API_KEY=sk-from-the-file\n");
    useValueFile(file);
    try {
      const pre = await call(dir, { model: "openai/gpt-4o-mini" }, { run: true });
      if (!pre.ok) throw new Error(pre.gate);
      expect(pre.modelAuth).toBe("OPENAI_API_KEY");
      expect(pre.valuesFrom).toBe("given.env");
      // Not the shell's: the file is read as data, and the environment is not asked.
      expect(pre.values.has("ANTHROPIC_API_KEY")).toBe(false);
    } finally {
      useValueFile(undefined);
    }
  });

  it("a key only in a project file does not travel: neither the development file nor the one `start` reads is a source", async () => {
    // What a person keeps for `dev` and for `start` is that machine's. The box logs in, and nothing asks for the key.
    noAnthropicEnv();
    const dir = await agent({
      ".secrets/.env": "ANTHROPIC_API_KEY=sk-dev\n",
      ".secrets/production/.env": "ANTHROPIC_API_KEY=sk-start\n",
    });
    const pre = await call(dir, { model: "anthropic/claude-sonnet-4-5" }, { run: true });
    if (!pre.ok) throw new Error(pre.gate);
    expect(pre.boxLogin).toBe("anthropic");
    expect(pre.secrets.map((s) => s.name)).not.toContain("ANTHROPIC_API_KEY");
  });

  it("a credential that points at a FILE on this machine does not travel: the box is asked", async () => {
    // The value file names a path; the file exists here and nowhere else. pi finds it and reports ADC, which read
    // with this machine's file system would ship a deploy with no credential and no login.
    const adc = join(await mkdtemp(join(tmpdir(), "fa-adc-")), "adc.json");
    await writeFile(adc, "{}");
    const vertex = modelsOver(new InMemoryCredentialStore()).getProvider("google-vertex")?.getModels()[0]?.id as string;
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "p");
    vi.stubEnv("GOOGLE_CLOUD_LOCATION", "us-central1");
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", adc);
    const pre = await call(await agent(), { model: `google-vertex/${vertex}` }, { run: true, fromEnv: true });
    expect(pre.ok && pre.boxLogin).toBe("google-vertex");
  });

  it("a keyless credential in the environment travels; none in it leaves it to the box", async () => {
    // AWS keys are what pi reads for amazon-bedrock, with no single key variable to require. Given to the deploy they
    // reach the box; absent, whether the box has a role is the box's answer.
    const bedrock = modelsOver(new InMemoryCredentialStore()).getProvider("amazon-bedrock")?.getModels()[0]
      ?.id as string;
    for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "AWS_PROFILE"]) {
      vi.stubEnv(name, "");
    }
    const absent = await call(await agent(), { model: `amazon-bedrock/${bedrock}` }, { run: true, fromEnv: true });
    expect(absent.ok && absent.boxLogin).toBe("amazon-bedrock");

    vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIAEXAMPLE");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "secret");
    vi.stubEnv("AWS_REGION", "us-east-1");
    const carried = await call(await agent(), { model: `amazon-bedrock/${bedrock}` }, { run: true, fromEnv: true });
    if (!carried.ok) throw new Error(carried.gate);
    expect(carried.boxLogin).toBeUndefined();
    expect(carried.modelAuth).toBeUndefined(); // nothing more for the values gate to ask
  });

  it("a key given to the deploy wins over this machine's own login: that login stays here, the key is what travels", async () => {
    // pi ranks a stored credential above the environment, which answers "what authenticates HERE". The deploy asks
    // what reaches the box, and a key given to the deployment is exactly that.
    noAnthropicEnv();
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant");
    const oauth = { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 };
    const dir = await agent({ ".secrets/auth.json": JSON.stringify({ anthropic: oauth }) });
    const pre = await call(dir, { model: "anthropic/claude-sonnet-4-5" }, { run: true, fromEnv: true });
    if (!pre.ok) throw new Error(pre.gate);
    expect(pre.boxLogin).toBeUndefined();
    expect(pre.modelAuth).toBe("ANTHROPIC_API_KEY");
    expect(pre.messages.some((m) => /login --deployment/.test(m.text))).toBe(false);
  });
});

describe("preflight: what the definition declares", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("requires what tools DECLARED, and lists nothing else", async () => {
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
    vi.stubEnv("GH_TOKEN", "ghp");
    vi.stubEnv("X_API_KEY", "x");
    const pre = await call(dir, { model: "openai/gpt-4o-mini" });
    expect(pre.ok).toBe(true);
    if (!pre.ok) return;
    expect(pre.declaredSecrets).toEqual([
      { name: "X_API_KEY", declaredIn: "src/tools/x-post.ts", optional: false },
      { name: "X_API_SECRET", declaredIn: "src/tools/x-post.ts", optional: false },
      { name: "GH_HOST", declaredIn: "context.json", description: "the GitHub host gh talks to", optional: false },
    ]);
    // The runbook names the file to open for each declared name, and no variable a file merely holds (GH_TOKEN).
    expect(pre.secrets).toEqual([
      { name: "X_API_KEY", hint: "required by src/tools/x-post.ts" },
      { name: "X_API_SECRET", hint: "required by src/tools/x-post.ts" },
      { name: "GH_HOST", hint: "required by context.json: the GitHub host gh talks to" },
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
