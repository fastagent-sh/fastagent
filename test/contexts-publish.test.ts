import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "../src/atomic-write.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { git, githubStandIn } from "./github-standin.ts";
import { resolveContent } from "../src/content/resolve.ts";

let failPublish = false;
let observe: (() => void) | undefined;
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      if (String(args[1]).includes("/.contexts/acme")) {
        observe?.();
        if (failPublish && String(args[1]).endsWith("/.fastagent-context.json")) {
          throw Object.assign(new Error("EIO: could not publish context"), { code: "EIO" });
        }
        fs.renameSync(...args);
        observe?.();
      } else {
        fs.renameSync(...args);
      }
    },
  };
});
const { fetchContexts, fetchedContexts } = await import("../src/contexts/fetch.ts");
const { copyRecord } = await import("../src/contexts/copy.ts");
const { loadContent, loadEnvironment } = await import("../src/content/file.ts");
let root = "";
afterEach(async () => {
  failPublish = false;
  observe = undefined;
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const github = githubStandIn();
  const repo = github.repo("acme/context");
  const first = repo.commit({ "context.json": '{ "description": "first" }' });
  root = await realpath(await mkdtemp(join(tmpdir(), "fa-ctx-publish-")));
  const agent = join(root, "agent");
  await mkdir(agent);
  await writeFile(join(agent, "context.json"), JSON.stringify({ contexts: { acme: { github: "acme/context" } } }));
  const contexts = [{ name: "acme", repo: "acme/context" }];
  await fetchContexts(agent, contexts, "fail");
  const second = repo.commit({ "context.json": '{ "description": "second" }' });
  return { agent, repo, contexts, first, second };
}

it("keeps the authoritative old snapshot when publishing its replacement fails and reports the failure", async () => {
  const { agent, contexts, first } = await fixture();
  failPublish = true;
  await expect(fetchContexts(agent, contexts, "fail")).rejects.toThrow("EIO: could not publish context");
  expect(fetchedContexts(agent, contexts)[0]).toMatchObject({ commit: first, description: "first" });
  expect(loadContent(agent).declared).toEqual([]);
});

it("a failed publication writes nothing else: this machine's bindings stay exactly as they were", async () => {
  const { agent, repo, contexts } = await fixture();
  const declaration = JSON.stringify({ content: { handbook: { github: "acme/handbook", readonly: true } } });
  const first = repo.commit({ "context.json": declaration });
  await fetchContexts(agent, contexts, "fail");
  const checkout = join(root, "handbook");
  await mkdir(checkout);
  git(checkout, "init", "-q");
  git(checkout, "remote", "add", "origin", "https://github.com/acme/handbook.git");
  const localPath = join(agent, "context.local.json");
  const local = JSON.stringify({ checkouts: { handbook: checkout } });
  await writeFile(localPath, local);
  repo.commit({ "context.json": JSON.stringify({ content: {} }) });
  failPublish = true;
  await expect(fetchContexts(agent, contexts, "fail")).rejects.toThrow("EIO: could not publish context");
  expect(fetchedContexts(agent, contexts)[0]?.commit).toBe(first);
  expect(await readFile(localPath, "utf8")).toBe(local);
  expect(resolveContent(agent, loadContent(agent))).toEqual([
    expect.objectContaining({ name: "handbook", location: checkout, readonly: true, clone: false }),
  ]);
});

it("two Node processes can read and publish complete snapshots concurrently", async () => {
  const { agent, contexts, first, second } = await fixture();
  const recordPath = join(agent, ".contexts", "acme", ".fastagent-context.json");
  const modulePath = fileURLToPath(new URL("../src/contexts/copy.ts", import.meta.url));
  const script = `
    import { copyRecord } from ${JSON.stringify(modulePath)};
    const context = ${JSON.stringify(contexts[0])};
    let failures = 0;
    process.send("ready");
    for (let i = 0; i < 50000; i++) {
      try {
        const {commit, declaration} = copyRecord(${JSON.stringify(agent)}, context);
        const description = JSON.parse(declaration).description;
        if (!(${JSON.stringify(first)} === commit && description === "first") &&
            !(${JSON.stringify(second)} === commit && description === "second")) failures++;
      } catch { failures++; }
    }
    console.log(JSON.stringify({ failures }));
    process.disconnect();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr!.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const result = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`reader exited ${code}: ${stderr}`))));
    child.on("message", () => {
      for (let i = 0; i < 1000; i++) {
        writeFileAtomic(
          recordPath,
          JSON.stringify({
            repo: "acme/context",
            commit: i % 2 ? first : second,
            declaration: JSON.stringify({ description: i % 2 ? "first" : "second" }),
          }),
        );
      }
    });
  });
  await result;
  expect(JSON.parse(stdout).failures).toBe(0);
});

it("every publication boundary exposes a complete old or new snapshot without moving the copy directory", async () => {
  const { agent, contexts, first, second } = await fixture();
  const seen: [string, string][] = [];
  observe = () => {
    const record = copyRecord(agent, contexts[0]!);
    seen.push([record.commit, JSON.parse(record.declaration).description]);
    expect(loadContent(agent).declared).toEqual([]);
    expect(loadEnvironment(agent)).toBeUndefined();
  };
  await fetchContexts(agent, contexts, "fail");
  expect(seen.length).toBeGreaterThan(0);
  for (const snapshot of seen)
    expect([
      [first, "first"],
      [second, "second"],
    ]).toContainEqual(snapshot);
  expect(seen.at(-1)).toEqual([second, "second"]);
});
