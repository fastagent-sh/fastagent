import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentService } from "../src/service.ts";
import { createPiAgentFromDir } from "../src/engines/pi/open.ts";
import { mountAgentcoreService, deferAgentcoreService } from "../src/channels/agentcore-service.ts";
import { openPreparedStartService } from "../src/cli/commands/start.ts";

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

/** A deferred service whose stages are scripted: `prepare` takes the workspace, `assemble` runs in it. */
const deferred = (assemble: () => Promise<AgentService>, prepare: () => Promise<void> = async () => {}) =>
  deferAgentcoreService({ prepare, assemble: () => assemble() });
const invocation = () => new Request("http://h/invocations", { method: "POST", body: "{}" });

describe("deferred AgentCore initialization", () => {
  it("the assemble stage REJECTS instead of exiting — every 503/probe verdict above depends on it", async () => {
    // On this host `openPreparedStartService` runs inside an envelope, so a `failStartup` there would
    // kill the container mid-request and the deploy driver would gate on a generic timeout instead of
    // the runtime's own error text.
    const dir = await agentDir({ "channels/bad.mjs": "throw new Error('broken channel');\n" });
    const exit = vi.spyOn(process, "exit").mockImplementation(((): never => {
      throw new Error("process.exit called");
    }) as never);
    try {
      await expect(openPreparedStartService(dir, { input: false })).rejects.toThrow(/channel setup is invalid/);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });

  it("returns authenticated probe failures as structured transport-200 diagnostics", async () => {
    vi.stubEnv("FASTAGENT_INGRESS_SECRET", "trusted-probe");
    try {
      const deferred = deferAgentcoreService({
        prepare: async () => {
          throw new Error("EFS mount unavailable");
        },
        assemble: async () => {
          throw new Error("must not assemble");
        },
      });
      for (const auth of ["trusted-probe", "wrong"]) {
        const r = await deferred.handler(
          new Request("http://h/invocations", {
            method: "POST",
            body: JSON.stringify({ kind: "probe", auth }),
          }),
        );
        expect(r.status).toBe(auth === "trusted-probe" ? 200 : 503);
        if (r.status === 200)
          expect(await r.json()).toEqual({ ok: false, error: "initialization failed: Error: EFS mount unavailable" });
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("opens only on invocation and shares one initialization across concurrent requests", async () => {
    const close = vi.fn(async () => {});
    const open = vi.fn(async () => ({ handler: () => new Response("ready"), close }) as unknown as AgentService);
    const service = deferred(open);
    expect((await service.handler(new Request("http://h/ping"))).status).toBe(200);
    expect(open).not.toHaveBeenCalled();
    const responses = await Promise.all([service.handler(invocation()), service.handler(invocation())]);
    expect(await Promise.all(responses.map((r) => r.text()))).toEqual(["ready", "ready"]);
    expect(open).toHaveBeenCalledOnce();
    await service.close();
    await service.close();
    expect(close).toHaveBeenCalledOnce();
  });
  it("caches an assembly failure rather than reading an empty workspace or starting a second scheduler", async () => {
    const open = vi.fn(async (): Promise<AgentService> => {
      throw new Error("channels/lark.ts is broken");
    });
    const service = deferred(open);
    for (let i = 0; i < 2; i++) {
      const r = await service.handler(invocation());
      expect(r.status).toBe(503);
      expect(await r.text()).toContain("channels/lark.ts is broken");
    }
    expect(open).toHaveBeenCalledOnce();
  });
  it("does not assemble a service after close() — nothing would ever stop its scheduler", async () => {
    // Shutdown can land while the workspace is still being taken (a first boot copies it onto the
    // volume). close() has already run by the time prepare settles, so assembling here would start
    // channels and a scheduler with no one left to close them.
    const open = vi.fn(
      async () => ({ handler: () => new Response("ready"), close: async () => {} }) as unknown as AgentService,
    );
    let release = (): void => {};
    const service = deferred(open, () => new Promise<void>((r) => (release = r)));
    const pending = service.handler(invocation());
    await service.close();
    release();
    expect((await pending).status).toBe(503);
    expect(open).not.toHaveBeenCalled();
  });

  it("retries a failed prepare on the next envelope — it took no lease and started no timers", async () => {
    const close = vi.fn(async () => {});
    const open = vi.fn(async () => ({ handler: () => new Response("ready"), close }) as unknown as AgentService);
    let attempts = 0;
    const service = deferred(open, async () => {
      if (++attempts < 3) throw new Error("could not acquire workspace lease at /mnt/data/.deployment");
    });
    for (let i = 0; i < 2; i++) {
      const r = await service.handler(invocation());
      expect(r.status).toBe(503);
      expect(await r.text()).toContain("could not acquire workspace lease");
    }
    expect(open).not.toHaveBeenCalled(); // nothing assembles over a workspace this process never took
    expect(await (await service.handler(invocation())).text()).toBe("ready");
    // Concurrent envelopes share one attempt, and a taken workspace is never taken twice.
    await Promise.all([service.handler(invocation()), service.handler(invocation())]);
    expect(attempts).toBe(3);
    expect(open).toHaveBeenCalledOnce();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

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

  it("reports only the adapter's boot surface", async () => {
    const dir = await agentDir({
      "channels/hook.mjs": `export default () => ({ "POST /hook": () => new Response("x") });`,
    });
    const service = await mountAgentcoreService(await open(dir));
    try {
      // Channels are constructed only after trusted ingress arrives.
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

  it("reports loaded schedules, and close() is safe to call twice", async () => {
    const dir = await agentDir(
      { "schedules/digest.ts": `export default { cron: "0 9 * * *", prompt: "hi" };` },
      `{ model: "openai-codex/gpt-5.5" }`,
    );
    const service = await mountAgentcoreService(await open(dir));
    expect(service.schedules.map((s) => s.name)).toEqual(["digest"]);

    await service.close();
    // Both the shutdown hook and an explicit close can run.
    await expect(service.close()).resolves.toBeUndefined();
  });
});
