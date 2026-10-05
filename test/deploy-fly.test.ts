import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFlyAppName, parseFlyMinMachines, planFlyDeploy, toFlyAppName } from "../src/deploy/fly/plan.ts";
import { declaredChannels } from "../src/channels/discover.ts";

const flyToml = (p: ReturnType<typeof planFlyDeploy>) => p.artifacts.find((a) => a.path === "fly.toml")!.content;
const dockerfile = (p: ReturnType<typeof planFlyDeploy>) => p.artifacts.find((a) => a.path === "Dockerfile")!.content;
const runbook = (p: ReturnType<typeof planFlyDeploy>) => p.runbook.join("\n");

/** Defaults for the fields a test doesn't care about (a code agent with a lockfile). */
const base = {
  releaseId: "release-one",
  agent: "reviewer",
  appName: "bot",
  port: 8787,
  hasPackageJson: true,
  runtime: "node",
  hasLockfile: true,
  version: "9.9.9",
  hasCron: false,
} as const;

describe("deploy/fly: planFlyDeploy", () => {
  it("wires the state root to the volume and tunes autostop to suspend", () => {
    const toml = flyToml(planFlyDeploy({ ...base, channels: [] }));
    expect(toml).toContain('FASTAGENT_STATE_DIR = "/data/.state"');
    expect(toml).toContain('FASTAGENT_SECRETS_DIR = "/data/.secrets"');
    expect(toml).toContain('destination = "/data"');
    expect(toml).toContain('auto_stop_machines = "suspend"');
    expect(toml).toContain("min_machines_running = 0");
    expect(toml).toContain("internal_port = 8787");
  });

  it("keeps one machine running for a cron, scales to zero otherwise (definition-aware)", () => {
    expect(flyToml(planFlyDeploy({ ...base, channels: [], hasCron: true }))).toContain(
      "min_machines_running = 1", // routines/wake need a running machine — no external wake-up for a cron instant
    );
    expect(flyToml(planFlyDeploy({ ...base, channels: declaredChannels(["telegram"]) }))).toContain(
      "min_machines_running = 0",
    );
  });

  it("keeps one machine running and drops webhook URLs for long-connection Feishu", () => {
    const plan = planFlyDeploy({
      ...base,
      channels: [...declaredChannels(["feishu"], "long-connection")],
    });
    const toml = flyToml(plan);
    const out = runbook(plan);
    expect(toml).toContain("min_machines_running = 1");
    expect(toml).toContain("long-connection channel must stay connected"); // residency.ts words it once
    expect(out).not.toContain("https://bot.fly.dev/feishu");
  });

  it("keeps one machine running for a custom long-connection channel", () => {
    const plan = planFlyDeploy({
      ...base,
      channels: declaredChannels(["socket"], "long-connection"),
    });
    expect(flyToml(plan)).toContain("min_machines_running = 1");
  });

  it("suspends on idle and scales to zero when nothing in the definition needs a machine up", () => {
    // The two lines an operator edits when they want otherwise: the artifact IS the knob.
    const def = flyToml(planFlyDeploy({ ...base, channels: [] }));
    expect(def).toContain('auto_stop_machines = "suspend"');
    expect(def).toContain("min_machines_running = 0");
  });

  it("gives the runbook an address to be reached on, both families", () => {
    // The runbook is the DEFAULT path (`--run` is opt-in), so #425 reaches an operator through it
    // first. `[http_service]` declares a service without allocating an address, and both commands
    // are needed: an AAAA-only app is unreachable to IPv4-only webhook senders.
    const out = runbook(planFlyDeploy({ ...base, channels: [] }));
    expect(out).toContain("fly ips allocate-v4 --shared --app bot");
    expect(out).toContain("fly ips allocate-v6 --app bot");
  });

  it("sets every variable the pre-flight listed, each with where its value comes from", () => {
    const out = runbook(
      planFlyDeploy({
        ...base,
        channels: declaredChannels(["telegram"]),
        secrets: [
          { name: "OPENAI_API_KEY", hint: "your model provider key" },
          { name: "GH_TOKEN", hint: "required by tools/gh.ts" },
        ],
      }),
    );
    expect(out).toContain("#   GH_TOKEN: required by tools/gh.ts");
    expect(out).toContain("fly secrets set --app bot OPENAI_API_KEY=<value> GH_TOKEN=<value>");
    // the fastagent-only post step: point the webhook at the live URL
    expect(out).toContain("https://bot.fly.dev/telegram");
  });

  // WHICH webhook steps a runbook carries is webhookRunbook's — deploy-channel-ingress owns that. What
  // is fly's is the base URL those steps are spelled with.
  it("spells every webhook step at the fly URL", () => {
    const out = runbook(planFlyDeploy({ ...base, channels: declaredChannels(["slack", "feishu"]) }));
    expect(out).toContain("https://bot.fly.dev/slack");
    expect(out).toContain("https://bot.fly.dev/feishu");
    expect(out).not.toContain("https://bot.fly.dev/lark"); // only what is mounted
  });

  it("bakes config deploy.apt into the generated Dockerfile (G6 — system tools the agent's tools need)", () => {
    const docker = dockerfile(planFlyDeploy({ ...base, channels: [], apt: ["git", "ripgrep"] }));
    expect(docker).toMatch(/apt-get install -y --no-install-recommends git ripgrep/);
    // omitted when no apt declared: no apt layer at all
    expect(dockerfile(planFlyDeploy({ ...base, channels: [] }))).not.toContain("apt-get");
  });

  it("a credential that does not travel is a login on the box, after the deploy", () => {
    const out = runbook(planFlyDeploy({ ...base, boxLogin: "openai-codex", channels: [] }));
    expect(out.indexOf("fastagent login openai-codex --deployment fly")).toBeGreaterThan(out.indexOf("fly deploy"));
    expect(runbook(planFlyDeploy({ ...base, channels: [] }))).not.toContain("login --deployment");
  });

  it("leaves the volume to `fly deploy`: fly.toml sizes it, the runbook never pre-creates it", () => {
    // A pre-created volume is pinned to a host chosen WITHOUT the machine's guest/image, which is how a deploy
    // ends at "insufficient resources to create new machine with existing volume".
    const p = planFlyDeploy({ ...base, channels: [] });
    expect(flyToml(p)).toContain("primary_region");
    expect(flyToml(p)).toContain("initial_size");
    expect(runbook(p)).not.toContain("fly volumes create");
  });

  it("the markdown path pins the global install and ALWAYS uses node:22-slim, whatever the runtime says", () => {
    const md = { ...base, channels: [], hasPackageJson: false } as const;
    const docker = dockerfile(planFlyDeploy(md));
    expect(docker).toContain("npm i -g @fastagent-sh/fastagent@9.9.9"); // pinned to the current version
    expect(docker).not.toContain("npm ci");
    // Even a bun agent: oven/bun has no npm, so the global install needs the node base.
    const asBun = dockerfile(planFlyDeploy({ ...md, runtime: "bun", bunVersion: "1.3.13" }));
    expect(asBun).toContain("FROM node:22-slim");
    expect(asBun).not.toContain("oven/bun");
    expect(asBun).toContain("npm i -g @fastagent-sh/fastagent");
  });

  it("artifacts at the agent's root, its deps installed, .git shipped, explicit deploy flags", () => {
    const p = planFlyDeploy({ ...base, channels: [] });
    expect(p.artifacts.map((a) => a.path).sort()).toEqual([
      ".dockerignore",
      "Dockerfile",
      "Dockerfile.dockerignore",
      "fastagent.release.json",
      "fly.toml",
    ]);
    // Both ignore forms carry the same content (recursive patterns, .git not excluded).
    const rootIgnore = p.artifacts.find((a) => a.path === ".dockerignore")?.content ?? "";
    expect(rootIgnore).toMatch(/^\*\*\/node_modules$/m);
    expect(rootIgnore).not.toMatch(/^\.git$/m);
    const df = dockerfile(p);
    expect(df).toContain("WORKDIR /app/definition");
    expect(df).toContain("COPY package.json package-lock.json* *.tgz ./");
    // `*.tgz` rides with the manifest because the install layer runs BEFORE `COPY . .`, and a
    // `"dep": "file:./x.tgz"` resolves against the directory being installed in. Without it the build
    // fails on a dependency the author can see sitting right there in the agent directory.
    expect(df).toContain("RUN npm ci");
    expect(df).toContain("COPY . ."); // …then the whole agent directory
    // The npm entrypoint needs NO shell: assert the property (the binary path resolves from the image's
    // WORKDIR) rather than transcribing the line.
    const cmdBin = /CMD \["(\.\/[^"]+)", "start", "\/app\/definition"\]/.exec(df)?.[1];
    expect(cmdBin).toBeDefined();
    expect(posix.normalize(posix.join("/app/definition", cmdBin as string))).toBe(
      "/app/definition/node_modules/.bin/fastagent",
    );
    expect(df).not.toContain("sh"); // exec form: PID 1 is the agent, so SIGTERM reaches it
    const ignore = p.artifacts.find((a) => a.path === "Dockerfile.dockerignore")?.content ?? "";
    expect(ignore).not.toMatch(/^\.git$/m); // the definition's .git ships — NOT excluded
    // Recursive on purpose: dockerignore is root-anchored, and a bare `node_modules` would let the build
    // machine's deps (macOS binaries) clobber the image's freshly-installed linux deps.
    expect(ignore).toMatch(/^\*\*\/node_modules$/m);
    expect(ignore).toMatch(/^\*\*\/\.env$/m);
    expect(ignore).toMatch(/^\*\*\/\.secrets\/\*\*$/m); // credentials stay out; tracked scaffolds travel
    expect(ignore).toMatch(/^\*\*\/\.state$/m);
    // The runbook deploys from the agent directory with explicit, version-proof flags.
    expect(runbook(p)).toContain("fly deploy . --config fly.toml --dockerfile Dockerfile --app bot");
    expect(runbook(p)).toContain("each release replaces /data/definition");
  });

  it("a bun agent uses the bun base + bun install + bun run; markdown-only uses the pinned global CLI", () => {
    const bunDf = dockerfile(planFlyDeploy({ ...base, runtime: "bun", bunVersion: "1.3.13", channels: [] }));
    expect(bunDf).toContain("FROM oven/bun:1.3.13");
    expect(bunDf).toContain("COPY package.json bun.lock* *.tgz ./");
    expect(bunDf).toContain("RUN bun install --frozen-lockfile");
    // Bun resolves the script from the package.json in its cwd, which WORKDIR already is: exec form, no shell.
    expect(bunDf).toContain(`CMD ["bun", "run", "fastagent", "start", "/app/definition"]`);
    // The image opens the definition by path: nothing selects an agent by name.
    expect(bunDf).not.toContain("FASTAGENT_AGENT");

    const mdDf = dockerfile(planFlyDeploy({ ...base, hasPackageJson: false, channels: [] }));
    expect(mdDf).toContain("FROM node:22-slim");
    expect(mdDf).not.toContain("FASTAGENT_AGENT");
    expect(mdDf).toContain("npm i -g @fastagent-sh/fastagent@9.9.9"); // pinned global — no deps to install
    expect(mdDf).not.toContain("npm ci");
    expect(mdDf).toContain(`["fastagent", "start", "/app/definition"]`);
  });

  it("falls back to npm install when a code agent has no lockfile (npm ci would hard-fail)", () => {
    expect(dockerfile(planFlyDeploy({ ...base, channels: [], hasLockfile: false }))).toMatch(
      /RUN npm install\n/, // no lockfile → npm install; all deps (no --omit=dev — the agent needs its toolchain)
    );
    expect(dockerfile(planFlyDeploy({ ...base, channels: [] }))).toMatch(/RUN npm ci\n/);
  });

  it("a code agent's CMD runs the LOCAL bin, never npx/bunx (bare `fastagent` on npm is a third party)", () => {
    const npm = dockerfile(planFlyDeploy({ ...base, channels: [] }));
    expect(npm).toContain(`CMD ["./node_modules/.bin/fastagent", "start", "/app/definition"]`);
    expect(npm).not.toContain("npx");
  });

  it("generates a Bun Dockerfile for a bun agent (oven/bun base, bun install, bun run)", () => {
    const bun = dockerfile(planFlyDeploy({ ...base, channels: [], runtime: "bun", bunVersion: "1.3.13" }));
    expect(bun).toContain("FROM oven/bun:1.3.13");
    expect(bun).toContain("bun install --frozen-lockfile"); // base.hasLockfile: true → frozen
    expect(bun).not.toContain("node:22-slim");
    // Unpinned bun (a bun lockfile but no packageManager version) → oven/bun:1; no lockfile → plain install.
    const unpinned = dockerfile(planFlyDeploy({ ...base, channels: [], runtime: "bun", hasLockfile: false }));
    expect(unpinned).toContain("FROM oven/bun:1\n");
    expect(unpinned).toMatch(/RUN bun install\n/); // no --frozen-lockfile without a lockfile
  });

  it("the fly.toml marker is what makes --force mean 'reset' (and a hand-written one exempt)", async () => {
    // The ownership predicate is load-bearing twice over: writeArtifacts uses it to decide what --force
    // may replace, and deploy.ts uses it to decide whether to round-trip `app =` and run the
    // scale-to-zero gate. Before it existed, `fly.toml` read as the author's forever.
    const { isGeneratedFlyToml } = await import("../src/deploy/fly/plan.ts");
    const generated = flyToml(planFlyDeploy({ ...base, channels: [] }));
    expect(isGeneratedFlyToml(generated)).toBe(true);
    expect(isGeneratedFlyToml('app = "mine"\n')).toBe(false);
    expect(isGeneratedFlyToml(`# my own header\n${generated}`)).toBe(false); // marker must open the file
  });

  it("sanitizes a dir basename into a valid Fly app name", () => {
    expect(toFlyAppName("My Agent")).toBe("my-agent");
    expect(toFlyAppName("123bot")).toBe("app-123bot"); // must start with a letter
    expect(toFlyAppName("weird_@_name")).toBe("weird-name");
  });

  it("parses the app name from a kept fly.toml (double OR single quotes; else undefined)", () => {
    expect(parseFlyAppName('app = "renamed-bot"\nprimary_region = "iad"')).toBe("renamed-bot");
    expect(parseFlyAppName("app = 'single-quoted'")).toBe("single-quoted"); // TOML allows single quotes
    expect(parseFlyAppName('primary_region = "iad"')).toBeUndefined(); // no app line → caller uses basename
  });

  it("parses min_machines_running from a kept fly.toml (the KEEP-mode time-trigger check)", () => {
    expect(parseFlyMinMachines("  min_machines_running = 0         # scale to zero")).toBe(0); // explicit 0 → warn/gate
    expect(parseFlyMinMachines("  min_machines_running = 1         # kept running")).toBe(1); // ≥ 1 → fine
    // Absent line → undefined; the CALLER treats it as 0 (Fly's platform default) — a hand-written
    // fly.toml without the line scales to zero exactly like an explicit 0.
    expect(parseFlyMinMachines('app = "bot"\nprimary_region = "iad"')).toBeUndefined();
  });
});
