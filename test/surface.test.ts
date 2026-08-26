/**
 * The product's assembly, end to end: a directory becomes a mounted handler.
 *
 * These are the properties an embedder gets for free by calling one function instead of composing
 * the parts. Each was, at some point, composed wrong — inside this repo's own CLI.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openAgentSurface } from "../src/surface.ts";

async function agentDir(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fa-surface-"));
  await writeFile(join(dir, "fastagent.config.mjs"), `export default { model: "openai-codex/gpt-5.5" };\n`);
  await writeFile(join(dir, "persona.md"), "You are a test agent.\n");
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), body);
  }
  return dir;
}

describe("openAgentSurface", () => {
  it("mounts channel routes on a handler, with health beside them", async () => {
    const dir = await agentDir({
      "channels/hook.mjs": `export default () => ({ "POST /hook": () => new Response("from-channel") });`,
    });
    const surface = await openAgentSurface(dir);
    try {
      expect(await (await surface.handler(new Request("http://h/hook", { method: "POST" }))).text()).toBe(
        "from-channel",
      );
      expect((await surface.handler(new Request("http://h/health"))).status).toBe(200);
      expect(surface.channels.routes).toEqual(["hook"]);
      // A declared channel replaces the built-in /invoke — the fallback exists only when there is none.
      expect((await surface.handler(new Request("http://h/invoke", { method: "POST" }))).status).toBe(404);
    } finally {
      await surface.close();
    }
  });

  it("falls back to POST /invoke when the directory declares no channel", async () => {
    const dir = await agentDir();
    const surface = await openAgentSurface(dir);
    try {
      // 400 rather than 404: the route is mounted and rejecting an empty body.
      expect((await surface.handler(new Request("http://h/invoke", { method: "POST" }))).status).toBe(400);
    } finally {
      await surface.close();
    }
  });

  it("mounts the control plane when the config asks for it, reachable on the same handler", async () => {
    // THE property composing by hand gets wrong: routes and mounts must both reach the router. This
    // repo shipped a version where they did not — /control/* 404'd while control.json advertised it.
    const dir = await mkdtemp(join(tmpdir(), "fa-surface-ctl-"));
    await writeFile(
      join(dir, "fastagent.config.mjs"),
      `export default { model: "openai-codex/gpt-5.5", sessionControl: true };\n`,
    );
    await writeFile(join(dir, "persona.md"), "You are a test agent.\n");
    const surface = await openAgentSurface(dir);
    try {
      // 401, not 404: the plane is mounted and asking for the token it minted.
      expect((await surface.handler(new Request("http://h/control/capabilities"))).status).toBe(401);
      expect(surface.mounts.map((m) => m.prefix)).toEqual(["/control"]);
    } finally {
      await surface.close();
    }
  });

  it("does not mount a control plane the config did not ask for", async () => {
    const surface = await openAgentSurface(await agentDir());
    try {
      expect(surface.mounts).toEqual([]);
      expect((await surface.handler(new Request("http://h/control/capabilities"))).status).toBe(404);
    } finally {
      await surface.close();
    }
  });

  it("closes on its own signal, and close() is idempotent", async () => {
    const controller = new AbortController();
    const surface = await openAgentSurface(await agentDir(), { signal: controller.signal });
    controller.abort();
    await expect(surface.close()).resolves.toBeUndefined();
    await expect(surface.close()).resolves.toBeUndefined();
  });

  it("surfaces a broken channel at open, rather than serving without it", async () => {
    const dir = await agentDir({ "channels/bad.mjs": `throw new Error("boom at import");` });
    await expect(openAgentSurface(dir)).rejects.toThrow(/channel setup is invalid|boom at import/);
  });
});
