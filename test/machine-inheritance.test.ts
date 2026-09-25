/**
 * An agent inherits the machine it runs on (src/engines/pi/machine.ts, docs/design/core.md §5).
 *
 * It already inherited the box — `bash` runs whatever is on the PATH — so its skills, prompt templates and pi's
 * engine settings are inherited the same way. Deploying ships the project scope; nothing here is compared against a
 * deployment.
 *
 * These tests stub HOME on purpose: `test/setup.ts` gives every file an EMPTY one, so anything here is the
 * machine's contribution and nothing else.
 */
import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { collect, createPiAgentFromDefinition } from "../src/index.ts";
import { piAgentSessionFactory } from "../src/engines/pi/agent-session-factory.ts";
import { agentCommands } from "../src/engines/pi/open.ts";
import { loadExtensionPaths } from "../src/engines/pi/definition.ts";
import { piInMemorySessionRecordStore } from "../src/engines/pi/session-store.ts";
import { log } from "../src/log.ts";
import { makeFaux, sentPrompt } from "./faux.ts";

afterEach(() => vi.unstubAllEnvs());

/** What a definition with no `extensions/` serves: nothing to load, so no model runtime is ever asked for. */
const noExtensions = {
  extensionPaths: [],
  modelRuntime: () => Promise.reject(new Error("no extensions, so no model runtime is needed")),
};

/** A machine with skills and prompt templates of its own, as pi keeps them. Returns pi's directory on it. */
async function machine(
  files: { skills?: Record<string, string>; prompts?: Record<string, string>; settings?: object } = {},
): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "fa-machine-"));
  const agent = join(home, ".pi", "agent");
  await mkdir(agent, { recursive: true });
  for (const [name, description] of Object.entries(files.skills ?? {})) {
    await skill(join(agent, "skills", name), name, description);
  }
  for (const [name, body] of Object.entries(files.prompts ?? {})) {
    await mkdir(join(agent, "prompts"), { recursive: true });
    await writeFile(join(agent, "prompts", `${name}.md`), body);
  }
  if (files.settings) await writeFile(join(agent, "settings.json"), JSON.stringify(files.settings));
  vi.stubEnv("HOME", home);
  return agent;
}

async function skill(dir: string, name: string, description: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nBody of ${name}.\n`);
}

/** An agent directory with its own skills. */
async function definition(skills: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fa-def-"));
  await writeFile(join(dir, "persona.md"), "You are terse.\n");
  for (const [name, description] of Object.entries(skills)) await skill(join(dir, "skills", name), name, description);
  return dir;
}

/** Run one turn and return the system prompt the model was sent. */
async function promptSentBy(dir: string): Promise<string> {
  const { faux } = makeFaux();
  let sent = "";
  faux.setResponses([
    (context) => {
      sent = sentPrompt(context);
      return fauxAssistantMessage("ok");
    },
  ]);
  const { agent } = await createPiAgentFromDefinition(dir, { model: "faux/faux-1", providers: [faux.provider] });
  await collect(agent.invoke({ session: "s" }, { text: "hi" }));
  return sent;
}

/** Collect `log.warn` while `fn` runs. Read before restoring: `mockRestore()` clears `mock.calls` with it. */
async function warnings(fn: () => Promise<unknown>): Promise<string> {
  const warned: string[] = [];
  const warn = vi.spyOn(log, "warn").mockImplementation((message) => void warned.push(message));
  try {
    await fn();
  } finally {
    warn.mockRestore();
  }
  return warned.join("\n");
}

it("a skill installed on the machine reaches the model", async () => {
  await machine({ skills: { metar: "Read aviation weather." } });
  expect(await promptSentBy(await definition())).toContain("Read aviation weather.");
});

it("the DEFINITION wins a name collision — vendoring one in is how an author overrides the machine", async () => {
  await machine({ skills: { metar: "The MACHINE version." } });
  const prompt = await promptSentBy(await definition({ metar: "The DEFINITION version." }));

  expect(prompt).toContain("The DEFINITION version.");
  expect(prompt).not.toContain("The MACHINE version.");
});

it("`commands()` lists every skill the agent has and the machine's prompts, by how each is invoked", async () => {
  // `source` is the spelling: a `skill` is sent as `/skill:<name>`, a `prompt` as `/<name>`. Where a name came
  // from is not something a client needs to act on.
  await machine({ skills: { metar: "Machine skill." }, prompts: { review: "Review this: " } });
  const dir = await definition({ digest: "Definition skill." });

  expect(await agentCommands(dir, dir, noExtensions)).toEqual([
    { name: "digest", description: "Definition skill.", source: "skill" },
    { name: "metar", description: "Machine skill.", source: "skill" },
    expect.objectContaining({ name: "review", source: "prompt" }),
  ]);
});

it("`commands()` lists extension commands as pi dispatches them, and drops a template one shadows", async () => {
  await machine({ prompts: { tag: "A template the command shadows.", review: "Review this: " } });
  const dir = await definition();
  await mkdir(join(dir, "extensions"), { recursive: true });
  await writeFile(
    join(dir, "extensions", "a.ts"),
    `export default function (pi) {
  pi.registerCommand("go", { description: "d-go", handler: async () => {} });
  pi.registerCommand("tag", { description: "d-tag", handler: async () => {} });
  pi.on("session_start", () => { globalThis.__fa_cmd_list_started__ = true; });
}`,
  );
  await writeFile(
    join(dir, "extensions", "b.ts"),
    `export default function (pi) { pi.registerCommand("go", { description: "d-go", handler: async () => {} }); }`,
  );
  const modelRuntime = () => ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });

  const extensionPaths = await loadExtensionPaths(dir);
  expect(await agentCommands(dir, dir, { extensionPaths, modelRuntime })).toEqual([
    { name: "go:1", description: "d-go", source: "extension" },
    { name: "tag", description: "d-tag", source: "extension" },
    { name: "go:2", description: "d-go", source: "extension" },
    expect.objectContaining({ name: "review", source: "prompt" }),
  ]);
  // Listing loads the extensions; it opens no session.
  expect((globalThis as Record<string, unknown>).__fa_cmd_list_started__).toBeUndefined();
});

it("an empty machine contributes nothing — the definition is the whole answer", async () => {
  // `test/setup.ts`'s empty HOME is this case, and it is the one a fresh container is in.
  const dir = await definition({ digest: "Definition skill." });
  expect(await agentCommands(dir, dir, noExtensions)).toEqual([
    { name: "digest", description: "Definition skill.", source: "skill" },
  ]);
});

it("a machine prompt template whose frontmatter does not parse is said, not silently absent", async () => {
  await machine({
    prompts: {
      review: "---\ndescription: Review the diff.\n---\nReview it.\n",
      broken: "---\ndescription: [unclosed\n---\nNever listed.\n",
    },
  });
  const dir = await definition();

  let names: string[] = [];
  const warned = await warnings(async () => {
    names = (await agentCommands(dir, dir, noExtensions)).map((command) => command.name);
  });

  expect(names).toContain("review");
  expect(names).not.toContain("broken");
  expect(warned).toMatch(/prompt template warning: [\s\S]*broken\.md/);
});

it("an INSTALLED pi package's skills are inherited like any other", async () => {
  // A package lives where pi's package manager put it (`~/.pi/agent/git/…`), not under `~/.pi/agent/skills`, so
  // only resolving `packages` finds it — the only thing fastagent never does is install one.
  const agent = await machine({ settings: { packages: ["git:github.com/acme/tools"] } });
  await skill(join(agent, "git", "github.com", "acme", "tools", "skills", "lint"), "lint", "Lint from a package.");

  let prompt = "";
  const warned = await warnings(async () => {
    prompt = await promptSentBy(await definition());
  });

  expect(prompt).toContain("Lint from a package.");
  expect(warned).not.toMatch(/is not installed/); // present, so not reported as missing
});

it("a pi package that is NOT installed is skipped and said — never installed", async () => {
  // pi's own loader would `npm install` it, and throw out of `reload()` when that failed (measured): one offline
  // laptop or registry 404 took boot and every turn down. The npm here only records what it is asked to do.
  const log = join(await mkdtemp(join(tmpdir(), "fa-npm-")), "calls.log");
  const npm = join(tmpdir(), `fa-npm-${process.pid}-${Date.now()}.sh`);
  await writeFile(npm, `#!/bin/sh\necho "$@" >> ${log}\nexit 1\n`, { mode: 0o755 });
  await writeFile(log, "");
  await machine({
    skills: { metar: "Read aviation weather." },
    settings: { npmCommand: [npm], packages: ["npm:not-installed-anywhere"] },
  });

  let prompt = "";
  const warned = await warnings(async () => {
    prompt = await promptSentBy(await definition());
  });

  expect(prompt).toContain("Read aviation weather."); // the machine's local skills still load
  expect(warned).toMatch(/pi package npm:not-installed-anywhere is not installed/);
  const asked = (await readFile(log, "utf8")).split("\n").filter(Boolean);
  expect(
    asked.filter((line) => line.startsWith("install")),
    asked.join("\n"),
  ).toEqual([]);
});

it("a broken SKILL.md on the machine says so, once — not once per `GET /control/commands`", async () => {
  // Absent from the prompt and the list either way; the warning is the only thing that says why. The whole line
  // is asserted because the name is in the path regardless of what the message renders.
  const agent = await machine();
  await mkdir(join(agent, "skills", "broken"), { recursive: true });
  await writeFile(join(agent, "skills", "broken", "SKILL.md"), "---\nname: broken\n---\nno description\n");
  const dir = await definition();

  let names: string[] = [];
  const warned = await warnings(async () => {
    for (let i = 0; i < 3; i++) names = (await agentCommands(dir, dir, noExtensions)).map((c) => c.name);
  });

  expect(names).not.toContain("broken");
  expect(warned).toMatch(/^\[fastagent\] skill warning: .*description.*SKILL\.md\)$/m);
  expect(warned.split("\n").filter((line) => line.includes("description"))).toHaveLength(1);
});

it("the machine is read ONCE, and the listing and a turn read the same one", async () => {
  // Like a `PATH` entry added after a process started, a skill installed after boot arrives on the next start —
  // in the menu AND the turn, so `/` cannot offer a name the prompt would not expand. The definition, by contrast,
  // is live: that is what `dev` is built on.
  const agent = await machine({ skills: { early: "Present at boot." } });
  const dir = await definition();
  expect((await agentCommands(dir, dir, noExtensions)).map((c) => c.name)).toEqual(["early"]);

  await skill(join(agent, "skills", "late"), "late", "Installed after boot.");

  expect(
    (await agentCommands(dir, dir, noExtensions)).map((c) => c.name),
    "offered a name no turn would expand",
  ).toEqual(["early"]);
  expect(await promptSentBy(dir)).not.toContain("Installed after boot.");
});

it("a definition that did not change does not reload the loader per turn", async () => {
  // The loader's skill list is the MERGE (definition + machine); comparing the definition's half against it made
  // every turn look like a definition change — a full `reload()` on a loader concurrent turns share. The tell is
  // that the machine's half turns live, which it must not.
  const agent = await machine({ skills: { drift: "First description." } });
  const dir = await definition();
  const { faux } = makeFaux();
  const sent: string[] = [];
  faux.setResponses(
    Array.from({ length: 2 }, () => (context: Parameters<typeof sentPrompt>[0]) => {
      sent.push(sentPrompt(context));
      return fauxAssistantMessage("ok");
    }),
  );
  const { agent: served } = await createPiAgentFromDefinition(dir, {
    model: "faux/faux-1",
    providers: [faux.provider],
  });
  await collect(served.invoke({ session: "s" }, { text: "one" }));

  await skill(join(agent, "skills", "drift"), "drift", "Second description.");
  await collect(served.invoke({ session: "s" }, { text: "two" }));

  expect(sent[1]).toContain("First description.");
  expect(sent[1]).not.toContain("Second description.");
});

it("pi's engine settings are inherited, the project file deep-merged over the machine's, as pi does", async () => {
  // Two scopes, which is why the served settings are not `SettingsManager.inMemory` (one scope): flattening them
  // first would let a project `retry.enabled` wipe the machine's `retry.maxRetries`.
  await machine({ settings: { retry: { maxRetries: 7 } } });
  const dir = await definition();
  await mkdir(join(dir, ".pi"), { recursive: true });
  await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify({ retry: { enabled: false } }));
  const { faux } = makeFaux();
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);

  const session = await piAgentSessionFactory({
    sessions: piInMemorySessionRecordStore({ cwd: dir }),
    engine: async () => ({ modelRuntime, model: faux.getModel() }),
    readDefinition: () => ({ systemPrompt: "test", skills: [] }),
    cwd: dir,
  })("s");

  expect(session.settingsManager.getRetryEnabled()).toBe(false); // the project file
  expect(session.settingsManager.getRetrySettings().maxRetries).toBe(7); // the machine's, kept by the merge
});

it("a package missing under `PI_OFFLINE` is still said — pi skips it without asking there", async () => {
  // pi's offline mode returns before calling `onMissing`, so a warning hung on that callback vanished exactly when
  // the machine is offline. The configured list is asked instead.
  vi.stubEnv("PI_OFFLINE", "1");
  await machine({ settings: { packages: ["npm:not-installed-anywhere"] } });

  const warned = await warnings(async () => promptSentBy(await definition()));

  expect(warned).toMatch(/pi package npm:not-installed-anywhere is not installed/);
});

it("an unreadable pi settings file is said, not silently replaced by pi's defaults", async () => {
  // pi reads a file it cannot parse (or cannot lock, while its own TUI writes it) as `{}` and keeps the error for
  // whoever asks. The machine is read once, so unasked, the whole process ran on defaults with nothing said.
  const agent = await machine();
  await writeFile(join(agent, "settings.json"), '{ "retry": { "maxRetries": 7 }, }');

  const warned = await warnings(async () => promptSentBy(await definition()));

  expect(warned).toMatch(/pi global settings \(.*settings\.json\) could not be read, so pi's defaults apply/);
});
