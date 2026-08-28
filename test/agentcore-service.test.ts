/**
 * The AgentCore assembly as a SERVICE — the properties `start` used to get from six inline branches.
 *
 * The point of the extraction is that `start` no longer knows any of this. These tests hold the
 * assembly to what those branches did: the adapter is the surface, the control plane is mounted over
 * it, channels are NOT discovered at boot (the state mount is pre-restore), and one `close()` stops
 * everything the branches wired to separate signal handlers.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPiAgentFromDir } from "../src/engines/pi/open.ts";
import { mountAgentcoreService } from "../src/channels/agentcore-service.ts";

async function agentDir(files: Record<string, string> = {}, config = `{ model: "openai-codex/gpt-5.5" }`) {
  const dir = await mkdtemp(join(tmpdir(), "fa-agentcore-"));
  await writeFile(join(dir, "fastagent.config.mjs"), `export default ${config};\n`);
  await writeFile(join(dir, "persona.md"), "You are a test agent.\n");
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), body);
  }
  return dir;
}

const open = async (dir: string) => createPiAgentFromDir(dir, { serving: true });

describe("mountAgentcoreService", () => {
  it("serves the adapter surface, not the channel routes", async () => {
    // The channel exists, but on this host it is reachable only THROUGH an envelope — the platform
    // invokes POST /invocations and nothing else.
    const dir = await agentDir({
      "channels/hook.mjs": `export default () => ({ "POST /hook": () => new Response("direct") });`,
    });
    const service = await mountAgentcoreService(await open(dir));
    try {
      expect((await service.handler(new Request("http://h/ping"))).status).toBe(200);
      expect((await service.handler(new Request("http://h/hook", { method: "POST" }))).status).toBe(404);
      // What the startup line reports must be what is served — the adapter paths, not nothing.
      expect(Object.keys(service.routes).sort()).toEqual(["GET /ping", "POST /invocations"]);
    } finally {
      await service.close();
    }
  });

  it("reports no channels at boot — a list here would be the pre-restore emptiness", async () => {
    const dir = await agentDir({
      "channels/hook.mjs": `export default () => ({ "POST /hook": () => new Response("x") });`,
    });
    const service = await mountAgentcoreService(await open(dir));
    try {
      // Discovery is deferred to the first envelope, AFTER the state snapshot is restored. Reporting
      // the channel here would mean it had been constructed against an empty state mount.
      expect(service.channels).toEqual({ routes: [], longConnections: [], builtinInvoke: false });
      expect(service.ready).resolves.toBeUndefined();
    } finally {
      await service.close();
    }
  });

  it("mounts the control plane so a forwarder-relayed /control/* dispatches", async () => {
    const dir = await agentDir({}, `{ model: "openai-codex/gpt-5.5", sessionControl: true }`);
    const service = await mountAgentcoreService(await open(dir));
    try {
      expect(service.control?.token).toBeTruthy();
      // Unauthenticated is 401, not 404: the plane owns the prefix and answers for it.
      expect((await service.handler(new Request("http://h/control/sessions/s1"))).status).toBe(401);
      const ok = await service.handler(
        new Request("http://h/control/sessions/s1", {
          headers: { authorization: `Bearer ${service.control!.token}` },
        }),
      );
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ status: "idle" });
    } finally {
      await service.close();
    }
  });

  it("without sessionControl there is no plane to reach", async () => {
    const service = await mountAgentcoreService(await open(await agentDir()));
    try {
      expect(service.control).toBeUndefined();
      expect((await service.handler(new Request("http://h/control/sessions/s1"))).status).toBe(404);
    } finally {
      await service.close();
    }
  });

  it("owns the schedules, and close() is safe to call twice", async () => {
    const dir = await agentDir(
      { "schedules/digest.ts": `export default { cron: "0 9 * * *", prompt: "hi" };` },
      `{ model: "openai-codex/gpt-5.5" }`,
    );
    const service = await mountAgentcoreService(await open(dir));
    expect(service.schedules.map((s) => s.name)).toEqual(["digest"]);

    await service.close();
    // Both the shutdown hook and an explicit close can run.
    await expect(service.close()).resolves.toBeUndefined();
    // NOT asserted: that the scheduler's timers are gone. Fake timers would have to be installed
    // before the assembly, which deadlocks its filesystem IO, so the stop is unobservable from here
    // — see the note on close() in agentcore-service.ts.
  });
});
