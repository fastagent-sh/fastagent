import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentService } from "../src/service.ts";
import { createPiAgentFromDir } from "../src/engines/pi/open.ts";
import { mountAgentcoreService, deferAgentcoreService } from "../src/channels/agentcore-service.ts";
import { openPreparedStartService } from "../src/cli/commands/start.ts";
import { log } from "../src/log.ts";

async function agentDir(files: Record<string, string> = {}, config = `{ model: "openai-codex/gpt-5.5" }`) {
  const dir = await mkdtemp(join(tmpdir(), "fa-agentcore-"));
  await writeFile(join(dir, "fastagent.config.ts"), `export default ${config};\n`);
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
      await expect(openPreparedStartService(dir, { input: false })).rejects.toThrow(/failed to load/);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
    // The one test here that pays a full cold engine assembly: ~21s idle (measured), which the suite's
    // 30s ceiling never absorbed and 60s stopped absorbing too — a full `npm test` run puts a fork on
    // every core, and this stage is import-bound, so contention scales it by more than 3x. Raise the
    // budget rather than cap parallelism (vitest.config.ts states why). It still bounds a genuine hang:
    // the file's other ten tests answer in ~10ms or less, so only THIS one can spend it.
  }, 120_000);

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
      expect(service.channels).toEqual({ routes: [], longConnections: [] });
      await expect(service.ready).resolves.toBeUndefined();
    } finally {
      await service.close();
    }
  });

  it("does NOT serve /control/* here, whatever sessionControl says, and says so out loud", async () => {
    // The hole this closes: the forwarder relays an arbitrary `rawPath` as a webhook envelope AND
    // attaches the ingress secret itself, so an anonymous caller of the public Function URL arrives as
    // trusted ingress. A channel route survives that (it verifies the platform's signature inside);
    // `/control/*` does not, so mounting it here answered `GET /control/sessions` — and
    // `DELETE /control/sessions/{id}` — to anyone holding the URL.
    const dir = await agentDir(
      { "channels/hook.mjs": `export default () => ({ "POST /hook": () => new Response("channel") });` },
      `{ model: "openai-codex/gpt-5.5", sessionControl: true }`,
    );
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    process.env.FASTAGENT_INGRESS_SECRET = "s3cret";
    const service = await mountAgentcoreService(await open(dir));
    try {
      expect(service.controlPrefix).toBeUndefined();
      // …so the startup report has nothing of ours to warn about here either. The advice it would
      // otherwise print ("--bind 127.0.0.1", "firewall the port") names a port nobody dials on this
      // host: the real ingress is the forwarder's Function URL.
      expect(service.ours).not.toContain("POST /invoke");
      expect(warn.mock.calls.flat().join(" ")).toMatch(/sessionControl is ON but \/control\/\* is NOT served here/);

      /** What the forwarder sends for ANY public request to the Function URL. */
      const relay = (path: string, method = "GET") =>
        service.handler(
          new Request("http://h/invocations", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ kind: "webhook", auth: "s3cret", method, path }),
          }),
        );
      // The channel is reachable — that is what the relay is FOR.
      const hook = (await (await relay("/hook", "POST")).json()) as { status: number };
      expect(hook.status).toBe(200);
      // The control plane is not, at any path under the prefix.
      for (const path of ["/control/sessions", "/control/capabilities", "/control/sessions/s1"]) {
        const relayed = (await (await relay(path)).json()) as { status: number; bodyB64: string };
        expect({ path, status: relayed.status }).toEqual({ path, status: 404 });
      }
      // …and not on the outer surface either, which is what the Runtime itself dials.
      expect((await service.handler(new Request("http://h/control/sessions/s1"))).status).toBe(404);
    } finally {
      delete process.env.FASTAGENT_INGRESS_SECRET;
      warn.mockRestore();
      await service.close();
    }
  });

  it("without sessionControl there is no plane to reach", async () => {
    const service = await mountAgentcoreService(await open(await agentDir()));
    try {
      expect(service.controlPrefix).toBeUndefined();
      // …so the startup report has nothing of ours to warn about here either. The advice it would
      // otherwise print ("--bind 127.0.0.1", "firewall the port") names a port nobody dials on this
      // host: the real ingress is the forwarder's Function URL.
      expect(service.ours).not.toContain("POST /invoke");
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
