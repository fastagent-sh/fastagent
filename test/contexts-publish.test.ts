import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { githubStandIn } from "./github-standin.ts";

let failPublish = false;
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      if (failPublish && String(args[0]).includes(".acme.next-") && !String(args[0]).endsWith(".old")) {
        throw Object.assign(new Error("EIO: could not publish context"), { code: "EIO" });
      }
      return fs.renameSync(...args);
    },
  };
});
const { fetchContexts, fetchedContexts } = await import("../src/contexts/fetch.ts");
let root = "";
afterEach(async () => {
  failPublish = false;
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

it("restores the usable copy when publishing its replacement fails, and reports the failure", async () => {
  const github = githubStandIn();
  const repo = github.repo("acme/context");
  const first = repo.commit({ "context.json": '{ "description": "first" }' });
  root = await mkdtemp(join(tmpdir(), "fa-ctx-publish-"));
  const agent = join(root, "agent");
  await mkdir(agent);
  const contexts = [{ name: "acme", repo: "acme/context" }];
  await fetchContexts(agent, contexts, "fail");
  repo.commit({ "context.json": '{ "description": "second" }' });
  failPublish = true;
  await expect(fetchContexts(agent, contexts, "fail")).rejects.toThrow("EIO: could not publish context");
  expect(await readFile(join(agent, ".contexts", "acme", "context.json"), "utf8")).toContain("first");
  expect(fetchedContexts(agent, contexts)[0]?.commit).toBe(first);
});
