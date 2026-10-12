/**
 * Contexts (src/contexts/): what an agent's context.json lists, what a context's own context.json may hold, how the
 * agent's declarations and its contexts' join, how a context is fetched into .contexts/, and who fetches. GitHub is a
 * local stand-in (github-standin.ts). Each rule is tested once, here, where it lives; callers test their wiring.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { declareContent } from "../src/content/declare.ts";
import { resolveContent, staleCheckouts } from "../src/content/resolve.ts";
import { fastagentPromptSections } from "../src/harnesses/pi/create.ts";
import { loadContent, loadEnvironment, loadEnvironmentParts, parseContextCopy } from "../src/content/file.ts";
import { declareContexts } from "../src/contexts/declare.ts";
import { copyRecord } from "../src/contexts/copy.ts";
import { fetchContexts, fetchedContexts } from "../src/contexts/fetch.ts";
import { remoteCommit } from "../src/content/git.ts";
import { joinContent, joinEnvironment } from "../src/contexts/join.ts";
import { declareEnvironment, declaredVariables } from "../src/environment/declare.ts";
import {
  ContextNameError,
  addContent,
  addContext,
  removeContent,
  removeContext,
} from "../src/harnesses/pi/authoring.ts";
import { createPiAgentFromDir } from "../src/harnesses/pi/open.ts";
import { log } from "../src/log.ts";
import { git, githubStandIn } from "./github-standin.ts";
import type { LockOptions } from "proper-lockfile";

/**
 * `proper-lockfile` as it behaves when a lock is lost: an `onCompromised` callback, or — with none, its own default —
 * an exception thrown from a timer, which is an uncaught exception that takes the process down.
 */
let compromiseNext = false;
vi.mock("proper-lockfile", async (original) => {
  const real = await original<typeof import("proper-lockfile")>();
  // The runtime module is CommonJS: `import lockfile from "proper-lockfile"` sees it as the default export, while its
  // types declare the named ones.
  const { lock } = (real as unknown as { default: { lock: typeof real.lock } }).default;
  return {
    default: {
      ...real,
      lock: async (path: string, options: LockOptions = {}) => {
        const release = await lock(path, options);
        if (compromiseNext && path.endsWith("/.contexts/acme")) {
          compromiseNext = false;
          const lost = new Error("the lock file's mtime could not be updated");
          // With no handler, `proper-lockfile` throws this from a timer: an uncaught exception, not a report.
          if (options.onCompromised === undefined)
            setTimeout(() => {
              throw lost;
            }, 0);
          else options.onCompromised(lost);
        }
        return release;
      },
    },
  };
});

afterEach(() => {
  compromiseNext = false;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** An agent directory whose context.json is `context`. */
async function agent(context: unknown): Promise<string> {
  const dir = join(await realpath(await mkdtemp(join(tmpdir(), "fa-ctx-"))), "agent");
  await mkdir(dir);
  await writeFile(join(dir, "fastagent.config.ts"), "export default {};\n");
  await writeFile(join(dir, "context.json"), JSON.stringify(context));
  return dir;
}

async function boundContext() {
  const github = githubStandIn();
  const repo = github.repo("acme/github-context");
  repo.commit({
    "context.json": JSON.stringify({ content: { handbook: { github: "acme/handbook", readonly: true } } }),
  });
  github.repo("acme/handbook").commit({ "README.md": "keep this checkout\n" });
  const dir = await agent({ contexts: { acme: { github: "acme/github-context" } } });
  await fetchContexts(dir, acme(), "fail");
  const checkout = join(dir, "..", "handbook");
  git(dir, "clone", "-q", "https://github.com/acme/handbook.git", checkout);
  const notes = join(dir, "..", "notes");
  await mkdir(notes);
  await writeFile(
    join(dir, "context.local.json"),
    JSON.stringify({
      checkouts: { handbook: checkout },
      content: { notes: { path: notes, readonly: true } },
    }),
  );
  return { dir, checkout, notes, repo };
}

const acme = (ref?: string) => declareContexts({ acme: { github: "acme/github-context", ...(ref ? { ref } : {}) } });

describe("contexts: what an agent lists", () => {
  it("reads each context by name, with its repository and ref", () => {
    expect(declareContexts({ acme: { github: "acme/x" }, billing: { github: "acme/billing", ref: "v2" } })).toEqual([
      { name: "acme", repo: "acme/x" },
      { name: "billing", repo: "acme/billing", ref: "v2" },
    ]);
    expect(declareContexts(undefined)).toEqual([]);
  });

  it.each([
    ["not a map", ["acme/x"], /"contexts" must be an object of contexts by name/],
    ["a string where the entry goes", { acme: "acme/x" }, /context "acme" must be \{ "github": "owner\/repo" \}/],
    ["an unknown key", { acme: { github: "acme/x", path: "/x" } }, /context "acme": unknown key "path"/],
    ["a repository not owner/repo", { acme: { github: "acme" } }, /"github" must be "owner\/repo"/],
    ["a ref git would read as an option", { acme: { github: "a/b", ref: "--upload-pack=x" } }, /"ref" must name/],
    ["a name that is not one path segment", { "a b": { github: "a/b" } }, /context "a b": a name is one path/],
    ["two names equal ignoring case", { A: { github: "a/b" }, a: { github: "a/c" } }, /two contexts are named/],
  ])("refuses %s, naming it", (_what, raw, message) => {
    expect(() => declareContexts(raw)).toThrow(message);
  });
});

describe("contexts: a context's own context.json", () => {
  it("holds content, an environment and a one-line description, and no contexts", () => {
    const path = ".contexts/acme/context.json";
    expect(
      parseContextCopy(
        JSON.stringify({
          description: "The team's GitHub.",
          content: { handbook: { github: "acme/handbook", readonly: true } },
          environment: { packages: { gh: "2" } },
        }),
        path,
      ),
    ).toEqual({
      description: "The team's GitHub.",
      content: [{ name: "handbook", repo: "acme/handbook", readonly: true }],
      environment: { packages: { gh: "2" }, aptPackages: [], variables: {} },
    });
    expect(() => parseContextCopy(`{ "contexts": {} }`, path)).toThrow(
      `${path}: a context uses no contexts: only an agent lists them`,
    );
    expect(() => parseContextCopy(`{ "description": "two\\nlines" }`, path)).toThrow(
      `${path}: "description" must be one line of text`,
    );
    // Nothing else a repository may hold is read: a context declares what an agent works with, never how it works.
    expect(() => parseContextCopy(`{ "skills": [] }`, path)).toThrow(`${path}: unknown key "skills"`);
  });
});

describe("contexts: joined with the agent's own declarations", () => {
  const own = <T>(declared: T) => ({ source: "context.json", declared });
  const theirs = <T>(declared: T) => ({ context: "acme", source: ".contexts/acme/context.json", declared });

  it("joins content, each entry marked with its context; a name declared twice refuses, naming both", () => {
    const mine = declareContent({ app: { github: "acme/app" } });
    const handbook = declareContent({ handbook: { github: "acme/handbook" } });
    expect(joinContent([own(mine), theirs(handbook)])).toEqual([
      { name: "app", repo: "acme/app", readonly: false },
      { name: "handbook", repo: "acme/handbook", readonly: false, context: "acme" },
    ]);
    expect(() => joinContent([own(mine), theirs(declareContent({ App: { github: "acme/other" } }))])).toThrow(
      `content "App" is declared by context.json and by .contexts/acme/context.json — rename or remove one of them`,
    );
  });

  it("joins environments: one package at two versions refuses, naming both; variables are attributed to each", () => {
    const mine = declareEnvironment({ packages: { gh: "2" }, variables: { GITHUB_TOKEN: { description: "mine" } } });
    const same = declareEnvironment({
      packages: { gh: "2", jq: "1" },
      aptPackages: ["chromium"],
      variables: { GITHUB_TOKEN: { description: "the context's" } },
    });
    expect(joinEnvironment([own(mine), theirs(same)])).toEqual({
      packages: { gh: "2", jq: "1" },
      aptPackages: ["chromium"],
      variables: { GITHUB_TOKEN: { description: "mine" } },
    });
    // A name two declare is one value, required by each.
    expect(declaredVariables([own(mine), theirs(same)]).map(({ name, source }) => [name, source])).toEqual([
      ["GITHUB_TOKEN", "context.json"],
      ["GITHUB_TOKEN", ".contexts/acme/context.json"],
    ]);
    expect(() => joinEnvironment([own(mine), theirs(declareEnvironment({ packages: { gh: "latest" } }))])).toThrow(
      `package "gh" is declared at "2" by context.json and at "latest" by .contexts/acme/context.json — declare one ` +
        `version`,
    );
    expect(joinEnvironment([own(undefined), theirs(undefined)])).toBeUndefined();
  });
});

describe("contexts: fetched into .contexts/<name>", () => {
  it("refuses a .contexts link that would fetch outside the agent directory", async () => {
    const dir = await agent({});
    const outside = await mkdtemp(join(tmpdir(), "fa-ctx-outside-"));
    await symlink(outside, join(dir, ".contexts"));
    await expect(fetchContexts(dir, acme(), "fail")).rejects.toThrow(/is a link: contexts must be fetched inside/);
    expect(existsSync(join(outside, "acme"))).toBe(false);
  });

  it("asks the remote what a ref names, without fetching, and reads a tag as the commit it points at", async () => {
    const github = githubStandIn();
    const repo = github.repo("acme/github-context");
    const first = repo.commit({ "context.json": `{ "description": "one" }` });
    const dir = await agent({});
    // No ref: the default branch, as a fetch of HEAD would resolve it (context add does not fetch).
    expect(await remoteCommit("acme/github-context", undefined, dir)).toBe(first);
    expect(await remoteCommit("acme/github-context", "main", dir)).toBe(first);
    // A ref the remote does not have, and one no ref of the remote answers with.
    expect(await remoteCommit("acme/github-context", "nope", dir)).toBeUndefined();
    expect(await remoteCommit("acme/github-context", first, dir)).toBeUndefined();
    const second = repo.commit({ "context.json": `{ "description": "two" }` });
    expect(await remoteCommit("acme/github-context", "main", dir)).toBe(second);
    repo.tag("light", "");
    // An annotated tag is two objects: the commit a context would be fetched to is the one it points at.
    repo.tag("annotated", "v1");
    expect(await remoteCommit("acme/github-context", "light", dir)).toBe(second);
    expect(await remoteCommit("acme/github-context", "annotated", dir)).toBe(second);
  });

  it("a copy already at the commit its ref names is not fetched: no temporary clone is made for it", async () => {
    const github = githubStandIn();
    const repo = github.repo("acme/github-context");
    const first = repo.commit({ "context.json": `{ "description": "one" }` });
    const dir = await agent({});
    expect(await fetchContexts(dir, acme(), "fail")).toEqual([{ name: "acme", commit: first, outcome: "fetched" }]);
    // A fetch clones into a temporary directory; there is none to make one in, so one would fail loudly here.
    vi.stubEnv("TMPDIR", join(dir, "no-such-directory"));
    expect(await fetchContexts(dir, acme(), "fail")).toEqual([{ name: "acme", commit: first, outcome: "current" }]);
    expect(await fetchContexts(dir, acme(), "keep")).toEqual([{ name: "acme", commit: first, outcome: "current" }]);
    // And that the same setup does fail once the ref really names another commit: the check above is not vacuous.
    repo.commit({ "context.json": `{ "description": "two" }` });
    await expect(fetchContexts(dir, acme(), "fail")).rejects.toThrow(/no such file or directory/);
  });

  it("reports a lock lost mid-fetch instead of throwing from a timer, publishing nothing", async () => {
    const github = githubStandIn();
    const repo = github.repo("acme/github-context");
    const first = repo.commit({ "context.json": `{ "description": "one" }` });
    const dir = await agent({});
    await fetchContexts(dir, acme(), "fail");
    const before = await readFile(join(dir, ".contexts", "acme", ".fastagent-context.json"), "utf8");
    repo.commit({ "context.json": `{ "description": "two" }` });
    compromiseNext = true;
    await expect(fetchContexts(dir, acme(), "fail")).rejects.toThrow(
      /the lock for .* was lost while it was held .*: retry the fetch/,
    );
    expect(await readFile(join(dir, ".contexts", "acme", ".fastagent-context.json"), "utf8")).toBe(before);
    expect(fetchedContexts(dir, acme())[0]).toMatchObject({ commit: first, description: "one" });
  });

  it("at its ref, and again only when the ref names another commit", async () => {
    const github = githubStandIn();
    const repo = github.repo("acme/github-context");
    const first = repo.commit({ "context.json": `{ "description": "one" }`, "secret.txt": "do not bake" });
    const dir = await agent({});
    expect(await fetchContexts(dir, acme(), "fail")).toEqual([{ name: "acme", commit: first, outcome: "fetched" }]);
    expect(await fetchContexts(dir, acme(), "fail")).toEqual([{ name: "acme", commit: first, outcome: "current" }]);
    await writeFile(join(dir, ".contexts", "acme", "context.json"), `{ "description": "changed here" }`);
    expect(await fetchContexts(dir, acme(), "fail")).toEqual([{ name: "acme", commit: first, outcome: "fetched" }]);
    expect(fetchedContexts(dir, acme())[0]?.description).toBe("one");
    const second = repo.commit({ "context.json": `{ "description": "two" }` });
    expect(await fetchContexts(dir, acme(), "fail")).toEqual([{ name: "acme", commit: second, outcome: "fetched" }]);
    expect(fetchedContexts(dir, acme())).toEqual([
      expect.objectContaining({ name: "acme", commit: second, description: "two" }),
    ]);
    // A tag follows the context; a full commit pins it.
    repo.tag("v1");
    repo.commit({ "context.json": `{ "description": "three" }` });
    await fetchContexts(dir, acme("v1"), "fail");
    expect(fetchedContexts(dir, acme("v1"))[0]?.description).toBe("two");
    await fetchContexts(dir, acme(first), "fail");
    expect(fetchedContexts(dir, acme(first))[0]).toMatchObject({ commit: first, description: "one" });
    // The copy's source/ref is checked on a host even when Railway strips .git.
    expect(() => copyRecord(dir, acme("main")[0]!)).toThrow(/was fetched from another repository or ref/);
    // Nothing is left beside the copy.
    expect(existsSync(join(dir, ".contexts"))).toBe(true);
    expect(readFileSync(join(dir, ".contexts", "acme", "context.json"), "utf8")).toBe(`{ "description": "one" }`);
    expect(existsSync(join(dir, ".contexts", "acme", "secret.txt"))).toBe(false);
    expect(existsSync(join(dir, ".contexts", "acme", ".git"))).toBe(false);
    // A fetch started from an earlier declaration cannot recreate a copy after a remove or ref change.
    await expect(fetchContexts(dir, acme(), "fail", true)).rejects.toThrow(
      `context "acme" is no longer declared at that repository and ref`,
    );
  });

  it("refuses what is not a context; keep goes on with the copy here, fail and a first fetch throw", async () => {
    const github = githubStandIn();
    const repo = github.repo("acme/github-context");
    repo.commit({ "README.md": "not a context\n" });
    const dir = await agent({});
    await expect(fetchContexts(dir, acme(), "keep")).rejects.toThrow(
      `context "acme": github acme/github-context has no context.json at its root: it is not a context`,
    );
    const good = repo.commit({ "context.json": `{ "description": "good" }` });
    await fetchContexts(dir, acme(), "fail");
    repo.commit({ "context.json": `{ "skills": [] }` });
    await expect(fetchContexts(dir, acme(), "keep")).rejects.toThrow(/unknown key "skills"/);
    await expect(fetchContexts(dir, acme(), "fail")).rejects.toThrow(/unknown key "skills"/);
    github.offline();
    expect(await fetchContexts(dir, acme(), "keep")).toEqual([
      { name: "acme", commit: good, outcome: "kept", reason: expect.stringMatching(/could not list github/) },
    ]);
    await expect(fetchContexts(dir, acme(), "fail")).rejects.toThrow(/context "acme": could not list github/);
    expect(fetchedContexts(dir, acme())[0]).toMatchObject({ commit: good, description: "good" });
  });
});

describe("contexts: every reader reads the agent joined with its contexts", () => {
  it("as fetched here; a context not fetched stops the reader, naming context fetch", async () => {
    const github = githubStandIn();
    github.repo("acme/github-context").commit({
      "context.json": JSON.stringify({
        description: "The team's GitHub context.",
        content: { handbook: { github: "acme/handbook", readonly: true, description: "Consult this handbook." } },
        environment: { packages: { gh: "2" }, variables: { GITHUB_TOKEN: { description: "gh's token" } } },
      }),
    });
    const dir = await agent({
      contexts: { acme: { github: "acme/github-context" } },
      content: { app: { github: "acme/app" } },
      environment: { packages: { jq: "1" } },
    });
    for (const read of [loadContent, loadEnvironment]) {
      expect(() => read(dir)).toThrow(
        `context "acme" (github acme/github-context) is not fetched here: run \`fastagent context fetch\` in ${dir}`,
      );
    }
    await fetchContexts(dir, acme(), "fail");
    expect(loadContent(dir).declared.map((entry) => [entry.name, entry.context])).toEqual([
      ["app", undefined],
      ["handbook", "acme"],
    ]);
    const content = resolveContent(dir, loadContent(dir));
    const prompt = fastagentPromptSections({
      tools: [],
      builtinExtensions: [],
      workingSet: { agentDir: dir, content },
    }).content;
    expect(prompt).toContain("Consult this handbook.");
    expect(prompt).not.toContain("The team's GitHub context.");
    expect(loadEnvironment(dir)?.packages).toEqual({ jq: "1", gh: "2" });
    expect(loadEnvironmentParts(dir).map((part) => part.source)).toEqual([
      "context.json",
      ".contexts/acme/context.json",
    ]);
  });

  it("a command that develops the agent fetches its contexts; production runs on the copies and refuses without", async () => {
    const github = githubStandIn();
    github.repo("acme/github-context").commit({
      "context.json": JSON.stringify({
        content: { handbook: { github: "acme/handbook", readonly: true } },
        environment: { variables: { FA_CTX_TOKEN: { description: "the handbook's token" } } },
      }),
    });
    github.repo("acme/handbook").commit({ "README.md": "rules\n" });
    const dir = await agent({ contexts: { acme: { github: "acme/github-context" } } });
    vi.spyOn(log, "info").mockImplementation(() => {});
    await expect(createPiAgentFromDir(dir)).rejects.toThrow(/context "acme" .* is not fetched here/);
    expect(existsSync(join(dir, ".contexts"))).toBe(false);
    // A context's variable is required like the agent's own, attributed to the context's file.
    await expect(createPiAgentFromDir(dir, { fetchContexts: true })).rejects.toThrow(
      /missing required secrets: FA_CTX_TOKEN \(\.contexts\/acme\/context\.json\)/,
    );
    vi.stubEnv("FA_CTX_TOKEN", "x");
    const opened = await createPiAgentFromDir(dir);
    // Its content is the agent's to work with like its own, cloned at content/<name>.
    expect(opened.content).toEqual([
      expect.objectContaining({ name: "handbook", context: "acme", location: join(dir, "content", "handbook") }),
    ]);
  });
});

describe("contexts: added and removed", () => {
  it("adds a context once it is fetched, joins and installs; a refusal leaves no copy and no declaration", async () => {
    const github = githubStandIn();
    github.repo("acme/github-context").commit({
      "context.json": JSON.stringify({ description: "GitHub", environment: { packages: { gh: "2" } } }),
    });
    github.repo("acme/clash").commit({
      "context.json": JSON.stringify({ content: { app: { github: "acme/other" } } }),
    });
    const dir = await agent({ content: { app: { github: "acme/app" } }, environment: { packages: { jq: "1" } } });
    const installed: unknown[] = [];
    const added = await addContext(
      dir,
      { name: "acme", entry: { github: "acme/github-context" } },
      { install: async (environment, packages) => void installed.push([environment.packages, packages]) },
    );
    expect(installed).toEqual([[{ jq: "1", gh: "2" }, ["gh"]]]);
    expect(added.contexts).toEqual([expect.objectContaining({ name: "acme", description: "GitHub" })]);
    expect(JSON.parse(await readFile(join(dir, "context.json"), "utf8")).contexts).toEqual({
      acme: { github: "acme/github-context" },
    });
    await expect(addContext(dir, { name: "ACME", entry: { github: "acme/github-context" } })).rejects.toBeInstanceOf(
      ContextNameError,
    );
    await expect(addContext(dir, { name: "clash", entry: { github: "acme/clash" } })).rejects.toThrow(
      `content "app" is declared by context.json and by .contexts/clash/context.json`,
    );
    expect(existsSync(join(dir, ".contexts", "clash"))).toBe(false);
    expect(Object.keys(JSON.parse(await readFile(join(dir, "context.json"), "utf8")).contexts)).toEqual(["acme"]);

    const removed = await removeContext(dir, "Acme");
    expect([removed.name, removed.contexts]).toEqual(["acme", []]);
    expect(existsSync(join(dir, ".contexts", "acme"))).toBe(false);
    expect(JSON.parse(await readFile(join(dir, "context.json"), "utf8")).contexts).toBeUndefined();
    await expect(removeContext(dir, "acme")).rejects.toThrow('no context named "acme" (this agent uses: none)');
  });

  it("removing a context leaves this machine's checkout binding of it, and reports it as one nothing declares", async () => {
    const { dir, checkout } = await boundContext();
    const local = await readFile(join(dir, "context.local.json"), "utf8");
    expect(resolveContent(dir, loadContent(dir)).map((entry) => [entry.name, entry.kind])).toEqual([
      ["handbook", "github"],
      ["notes", "local"],
    ]);
    const removed = await removeContext(dir, "acme");
    expect(JSON.parse(local).checkouts.handbook).toBe(checkout);
    // Nothing writes this machine's file: the binding is left where it is, and said to be one nothing declares.
    expect(await readFile(join(dir, "context.local.json"), "utf8")).toBe(local);
    expect(resolveContent(dir, loadContent(dir)).map((entry) => entry.name)).toEqual(["notes"]);
    expect(staleCheckouts(loadContent(dir)).map((entry) => entry.name)).toEqual(["handbook"]);
    expect(removed.notes.join(" ")).toMatch(/checkout bindings in context\.local\.json are left as they are/);
    expect(await readFile(join(checkout, "README.md"), "utf8")).toBe("keep this checkout\n");
  });

  it("a refresh that withdraws content leaves the checkout binding, outside the agent, and never local content", async () => {
    const { dir, checkout, repo } = await boundContext();
    repo.commit({ "context.json": JSON.stringify({ content: {} }) });
    await fetchContexts(dir, acme(), "fail", true);
    // The directory is still there and still bound: what changed is that no entry declares it any more, and the one
    // thing that must not happen is it becoming writable content the agent works on.
    expect(resolveContent(dir, loadContent(dir)).map((entry) => [entry.name, entry.kind])).toEqual([
      ["notes", "local"],
    ]);
    expect(staleCheckouts(loadContent(dir))).toEqual([
      expect.objectContaining({ name: "handbook", path: checkout, kind: "checkout" }),
    ]);
    expect(JSON.parse(await readFile(join(dir, "context.local.json"), "utf8")).checkouts).toEqual({
      handbook: checkout,
    });
    expect(await readFile(join(checkout, "README.md"), "utf8")).toBe("keep this checkout\n");
  });

  it("fetches a declared context into an agent whose machine already binds other content, with no copy yet", async () => {
    // A colleague's clone: .contexts/ is git-ignored, so this is the state of every machine that pulls the agent.
    const github = githubStandIn();
    github.repo("acme/github-context").commit({ "context.json": JSON.stringify({ content: {} }) });
    const dir = await agent({ contexts: { acme: { github: "acme/github-context" } } });
    const notes = join(dir, "..", "notes");
    await mkdir(notes);
    await writeFile(join(dir, "context.local.json"), JSON.stringify({ content: { notes: { path: notes } } }));
    expect(await fetchContexts(dir, acme(), "fail", true)).toEqual([
      expect.objectContaining({ name: "acme", outcome: "fetched" }),
    ]);
    expect(resolveContent(dir, loadContent(dir)).map((entry) => entry.name)).toEqual(["notes"]);
    // And with one of its own checkouts bound as well: nothing here is attributed to the context being fetched.
    await writeFile(
      join(dir, "context.local.json"),
      JSON.stringify({ checkouts: { other: join(dir, "..", "other") }, content: { notes: { path: notes } } }),
    );
    expect(await fetchContexts(dir, acme(), "fail", true)).toEqual([
      expect.objectContaining({ name: "acme", outcome: "current" }),
    ]);
    expect(staleCheckouts(loadContent(dir)).map((entry) => entry.name)).toEqual(["other"]);
  });

  it("removes and recovers a context whose copy is gone: nothing has to be attributed to do either", async () => {
    const { dir, repo } = await boundContext();
    await rm(join(dir, ".contexts"), { recursive: true });
    const local = await readFile(join(dir, "context.local.json"), "utf8");
    repo.commit({ "context.json": JSON.stringify({ content: {} }) });
    expect(await fetchContexts(dir, acme(), "fail", true)).toEqual([
      expect.objectContaining({ name: "acme", outcome: "fetched", commit: expect.any(String) }),
    ]);
    expect(await readFile(join(dir, "context.local.json"), "utf8")).toBe(local);
    await rm(join(dir, ".contexts"), { recursive: true });
    await removeContext(dir, "acme");
    expect(JSON.parse(await readFile(join(dir, "context.json"), "utf8")).contexts).toBeUndefined();
    expect(await readFile(join(dir, "context.local.json"), "utf8")).toBe(local);
  });

  it("removal without a snapshot still works when there are no local bindings to attribute", async () => {
    const dir = await agent({ contexts: { acme: { github: "acme/github-context" } } });
    await removeContext(dir, "acme");
    expect(JSON.parse(await readFile(join(dir, "context.json"), "utf8")).contexts).toBeUndefined();
  });

  it("removes a context whose requested ref was edited to one that was never fetched", async () => {
    const { dir, checkout } = await boundContext();
    const file = JSON.parse(await readFile(join(dir, "context.json"), "utf8"));
    file.contexts.acme.ref = "does-not-exist";
    await writeFile(join(dir, "context.json"), JSON.stringify(file));
    expect(() => loadContent(dir)).toThrow(/was fetched from another repository or ref/);
    await removeContext(dir, "acme");
    expect(resolveContent(dir, loadContent(dir)).map((entry) => entry.name)).toEqual(["notes"]);
    expect(staleCheckouts(loadContent(dir)).map((entry) => entry.name)).toEqual(["handbook"]);
    expect(await readFile(join(checkout, "README.md"), "utf8")).toBe("keep this checkout\n");
  });

  it("serializes context additions and removes a context even when its declarations conflict", async () => {
    const github = githubStandIn();
    for (const repo of ["acme/one", "acme/two"]) {
      github.repo(repo).commit({ "context.json": JSON.stringify({ content: { app: { github: "acme/app" } } }) });
    }
    const dir = await agent({});
    const outcomes = await Promise.allSettled([
      addContext(dir, { name: "one", entry: { github: "acme/one" } }),
      addContext(dir, { name: "two", entry: { github: "acme/two" } }),
    ]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
    const file = JSON.parse(await readFile(join(dir, "context.json"), "utf8"));
    const [name] = Object.keys(file.contexts);
    await writeFile(
      join(dir, "context.json"),
      JSON.stringify({
        ...file,
        content: { app: { github: "acme/another" } },
      }),
    );
    expect(() => loadContent(dir)).toThrow(/declared by context.json and by/);
    await removeContext(dir, name!);
    expect(loadContent(dir).declared.map((content) => content.repo)).toEqual(["acme/another"]);
  });

  it("content and env edit the agent's own declarations, and name the context for what is its", async () => {
    const github = githubStandIn();
    github.repo("acme/github-context").commit({
      "context.json": JSON.stringify({
        content: { handbook: { github: "acme/handbook" } },
        environment: { packages: { gh: "2" } },
      }),
    });
    const dir = await agent({ contexts: { acme: { github: "acme/github-context" } } });
    await fetchContexts(dir, acme(), "fail");
    await expect(addContent(dir, { name: "handbook", entry: { github: "acme/x" } })).rejects.toThrow(
      `the context "acme" declares content named "handbook" (.contexts/acme/context.json)`,
    );
    await expect(removeContent(dir, "handbook")).rejects.toThrow(
      `content "handbook" is declared by .contexts/acme/context.json, the context "acme" — it goes with the context`,
    );
    const remove = await cli(["env", "remove", "gh"], dir);
    expect([remove.code, remove.stderr]).toEqual([
      1,
      expect.stringContaining(`the package "gh" is declared by .contexts/acme/context.json, the context "acme"`),
    ]);
    await writeFile(join(dir, "package.json"), `{"dependencies":{"@fastagent-sh/fastagent":"^0"}}`);
    const add = await cli(["env", "add", "gh@3"], dir);
    expect([add.code, add.stderr]).toEqual([
      1,
      expect.stringContaining(`package "gh" is declared at "3" by context.json and at "2" by .contexts/acme`),
    ]);
  });

  it("the commands, through the CLI", async () => {
    const github = githubStandIn();
    const commit = github.repo("acme/github-context").commit({
      "context.json": JSON.stringify({ description: "GitHub", content: { handbook: { github: "acme/handbook" } } }),
    });
    const dir = await agent({});
    const add = await cli(["context", "add", "github:acme/github-context", "--name", "acme"], dir);
    expect(add.code, add.stderr).toBe(0);
    expect(add.stderr).toContain(`acme  github acme/github-context, fetched at ${commit.slice(0, 7)}`);
    const list = await cli(["context", "list", "--json"], dir);
    expect(JSON.parse(list.stdout)).toEqual([
      expect.objectContaining({ name: "acme", commit, brings: { content: ["handbook"], packages: [], variables: [] } }),
    ]);
    const fetch = await cli(["context", "fetch"], dir);
    expect([fetch.code, fetch.stderr]).toEqual([0, expect.stringContaining("context acme: already up to date")]);
    const remove = await cli(["context", "remove", "acme"], dir);
    expect(remove.code, remove.stderr).toBe(0);
    const unknown = await cli(["context", "add", "acme/x"], dir);
    expect([unknown.code, unknown.stderr]).toEqual([2, expect.stringContaining("written github:owner/repo")]);
  });
});

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function cli(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
