import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServedAgent } from "../src/service.ts";
import { openServing } from "../src/harnesses/pi-durable/serve.ts";
import { loadSourceDefinition } from "../src/harnesses/pi-durable/open.ts";
import { mountAgentcoreService, deferAgentcoreService } from "../src/channels/agentcore-service.ts";
import { openPreparedStartService } from "../src/cli/commands/start.ts";
import { buildProject } from "../src/harnesses/pi-durable/build.ts";
import { buildable } from "./cli-run.ts";
import { CODEX_MODEL } from "./codex-model.ts";

async function agentDir(files: Record<string, string> = {}, config = `{ defaults: { model: "${CODEX_MODEL}" } }`) {
  const dir = await mkdtemp(join(tmpdir(), "fa-agentcore-"));
  await writeFile(join(dir, "fastagent.config.ts"), `export default ${config};\n`);
  await writeFile(join(dir, "SYSTEM.md"), "You are a test agent.\n");
  await buildable(dir);
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), body);
  }
  return dir;
}

/** The directory opened as a serve opens it, with no storage of its own, as the mount takes it. */
const open = async (dir: string) =>
  openServing(await loadSourceDefinition(dir), { secrets: {}, env: {}, ownEnv: process.env, storage: "memory" });

const DIGEST = `import { defineSchedule } from "@fastagent-sh/fastagent";
export default defineSchedule({ cron: "0 9 * * *", prompt: "hi" });\n`;

/** A deferred service whose stages are scripted: `prepare` takes the workspace, `assemble` runs in it. */
const deferred = (assemble: () => Promise<ServedAgent>, prepare: () => Promise<void> = async () => {}) =>
  deferAgentcoreService({ prepare, assemble: () => assemble() });
const invocation = () => new Request("http://h/invocations", { method: "POST", body: "{}" });

describe("deferred AgentCore initialization", () => {
  it("the assemble stage REJECTS instead of exiting — every 503/probe verdict above depends on it", async () => {
    // On this host `openPreparedStartService` runs inside an envelope, so a `failStartup` there would
    // kill the container mid-request and the deploy driver would gate on a generic timeout instead of
    // the runtime's own error text.
    const dir = await agentDir({
      "src/channels/bad.mjs": "export default () => { throw new Error('broken channel'); };\n",
    });
    await buildProject(dir);
    const exit = vi.spyOn(process, "exit").mockImplementation(((): never => {
      throw new Error("process.exit called");
    }) as never);
    try {
      await expect(openPreparedStartService(dir, { input: false })).rejects.toThrow(/broken channel/);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
    // The one test here that pays a full cold harness assembly: ~21s idle (measured), which the suite's
    // 30s ceiling never absorbed and 60s stopped absorbing too — a full `npm test` run puts a fork on
    // every core, and this stage is import-bound, so contention scales it by more than 3x. Raise the
    // budget rather than cap parallelism (vitest.config.ts states why). It still bounds a genuine hang:
    // every test here but this one and the IAM-door one below answers in ~10ms or less, so only those
    // two can spend it — they are the two that mount a service for real.
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
        const r = await deferred.fetch(
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
    const open = vi.fn(async () => ({ fetch: async () => new Response("ready"), close }) as unknown as ServedAgent);
    const service = deferred(open);
    expect((await service.fetch(new Request("http://h/ping"))).status).toBe(200);
    expect(open).not.toHaveBeenCalled();
    const responses = await Promise.all([service.fetch(invocation()), service.fetch(invocation())]);
    expect(await Promise.all(responses.map((r) => r.text()))).toEqual(["ready", "ready"]);
    expect(open).toHaveBeenCalledOnce();
    await service.close();
    await service.close();
    expect(close).toHaveBeenCalledOnce();
  });
  it("caches an assembly failure rather than reading an empty workspace or starting a second scheduler", async () => {
    const open = vi.fn(async (): Promise<ServedAgent> => {
      throw new Error("channels/lark.ts is broken");
    });
    const service = deferred(open);
    for (let i = 0; i < 2; i++) {
      const r = await service.fetch(invocation());
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
      async () => ({ fetch: async () => new Response("ready"), close: async () => {} }) as unknown as ServedAgent,
    );
    let release = (): void => {};
    const service = deferred(open, () => new Promise<void>((r) => (release = r)));
    const pending = service.fetch(invocation());
    await service.close();
    release();
    expect((await pending).status).toBe(503);
    expect(open).not.toHaveBeenCalled();
  });

  it("retries a failed prepare on the next envelope — it took no lease and started no timers", async () => {
    const close = vi.fn(async () => {});
    const open = vi.fn(async () => ({ fetch: async () => new Response("ready"), close }) as unknown as ServedAgent);
    let attempts = 0;
    const service = deferred(open, async () => {
      if (++attempts < 3) throw new Error("could not acquire workspace lease at /mnt/data/.deployment");
    });
    for (let i = 0; i < 2; i++) {
      const r = await service.fetch(invocation());
      expect(r.status).toBe(503);
      expect(await r.text()).toContain("could not acquire workspace lease");
    }
    expect(open).not.toHaveBeenCalled(); // nothing assembles over a workspace this process never took
    expect(await (await service.fetch(invocation())).text()).toBe("ready");
    // Concurrent envelopes share one attempt, and a taken workspace is never taken twice.
    await Promise.all([service.fetch(invocation()), service.fetch(invocation())]);
    expect(attempts).toBe(3);
    expect(open).toHaveBeenCalledOnce();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("mountAgentcoreService: the container points its own webhook channels", () => {
  const FORWARDER = "https://fwd.lambda-url.us-west-2.on.aws";
  /** A `telegram` route channel and the secrets that point it, on an instance with `config`. */
  async function telegramMount(config: Record<string, unknown> = {}) {
    const dir = await agentDir({
      "src/channels/telegram.mjs": `export default () => ({ "POST /telegram": () => new Response("ok") });`,
    });
    return mountAgentcoreService(
      await openServing(await loadSourceDefinition(dir), {
        secrets: { TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_SECRET_TOKEN: "s3cret" },
        env: {},
        ownEnv: process.env,
        storage: "memory",
        config: { values: config, label: "test" },
      }),
    );
  }
  const probe = (service: ServedAgent) =>
    service
      .fetch(
        new Request("http://h/invocations", {
          method: "POST",
          body: JSON.stringify({ kind: "probe", auth: "s3cret", wake: { url: FORWARDER } }),
        }),
      )
      .then((r) => r.json());
  const stubTelegram = () => {
    const calls: string[] = [];
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith("https://api.telegram.org/")) return real(input, init);
      calls.push(String(init?.body));
      return Response.json({ ok: true, result: true });
    });
    return calls;
  };

  it("registers at the forwarder URL the envelope names, once, and the probe reports the outcome", async () => {
    process.env.FASTAGENT_INGRESS_SECRET = "s3cret";
    const calls = stubTelegram();
    const service = await telegramMount();
    try {
      expect(await probe(service)).toEqual({ ok: true, webhooks: [{ channel: "telegram", outcome: "pending" }] });
      await vi.waitFor(async () =>
        expect(await probe(service)).toEqual({ ok: true, webhooks: [{ channel: "telegram", outcome: "registered" }] }),
      );
      // The /health the forwarder relays tells the same story as the probe.
      const relayed = await service.fetch(
        new Request("http://h/invocations", {
          method: "POST",
          body: JSON.stringify({ kind: "webhook", auth: "s3cret", method: "GET", path: "/health" }),
        }),
      );
      const reply = (await relayed.json()) as { bodyB64: string };
      expect(JSON.parse(Buffer.from(reply.bodyB64, "base64").toString())).toEqual({
        status: "ok",
        webhooks: [{ channel: "telegram", outcome: "registered" }],
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain(`${FORWARDER}/telegram`);
      expect(calls[0]).toContain("s3cret");
    } finally {
      await service.close();
      vi.unstubAllGlobals();
    }
  });

  it("registers at the configuration's own http.publicUrl when it names one", async () => {
    process.env.FASTAGENT_INGRESS_SECRET = "s3cret";
    const calls = stubTelegram();
    const service = await telegramMount({ http: { publicUrl: "https://agent.acme.com" } });
    try {
      await probe(service);
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]).toContain("https://agent.acme.com/telegram");
      expect(calls[0]).not.toContain(FORWARDER);
    } finally {
      await service.close();
      vi.unstubAllGlobals();
    }
  });
});

describe("mountAgentcoreService", () => {
  it("serves the adapter surface, not the channel routes", async () => {
    // The channel exists, but on this host it is reachable only THROUGH an envelope — the platform
    // invokes POST /invocations and nothing else.
    const dir = await agentDir({
      "src/channels/hook.mjs": `export default () => ({ "POST /hook": () => new Response("direct") });`,
    });
    const service = await mountAgentcoreService(await open(dir));
    try {
      expect((await service.fetch(new Request("http://h/ping"))).status).toBe(200);
      expect((await service.fetch(new Request("http://h/hook", { method: "POST" }))).status).toBe(404);
      // What the startup line reports must be what is served — the adapter paths, not nothing.
      expect(Object.keys(service.routes).sort()).toEqual(["GET /ping", "POST /invocations"]);
    } finally {
      await service.close();
    }
  });

  it("reports only the adapter's boot surface", async () => {
    const dir = await agentDir({
      "src/channels/hook.mjs": `export default () => ({ "POST /hook": () => new Response("x") });`,
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

  it("relays a webhook envelope to the channel routes, and to nothing else", async () => {
    // The forwarder relays an arbitrary `rawPath` as a webhook envelope AND attaches the ingress secret itself, so an
    // anonymous caller of the public Function URL arrives as trusted ingress: what answers there must verify its own
    // caller, which a channel route does (its platform's signature) and nothing else is mounted to.
    const dir = await agentDir({
      "src/channels/hook.mjs": `export default () => ({ "POST /hook": () => new Response("channel") });`,
    });
    process.env.FASTAGENT_INGRESS_SECRET = "s3cret";
    const service = await mountAgentcoreService(await open(dir));
    try {
      /** What the forwarder sends for ANY public request to the Function URL. */
      const relay = (path: string, method = "GET") =>
        service.fetch(
          new Request("http://h/invocations", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ kind: "webhook", auth: "s3cret", method, path }),
          }),
        );
      // The channel is reachable — that is what the relay is FOR.
      const hook = (await (await relay("/hook", "POST")).json()) as { status: number };
      expect(hook.status).toBe(200);
      // Nothing else is, at any path.
      for (const path of ["/invoke", "/control/sessions", "/sessions/s1"]) {
        const relayed = (await (await relay(path)).json()) as { status: number; bodyB64: string };
        expect({ path, status: relayed.status }).toEqual({ path, status: 404 });
      }
      // …and not on the outer surface either, which is what the Runtime itself dials.
      expect((await service.fetch(new Request("http://h/control/sessions/s1"))).status).toBe(404);
    } finally {
      delete process.env.FASTAGENT_INGRESS_SECRET;
      await service.close();
    }
  });

  it("OCCURRENCE SEMANTICS live here, on the authenticated envelope — a redelivery claims nothing twice", async () => {
    // A slot, a claim, a fire history and the overlap policy live here: the container set the alarm for this instant
    // and the forwarder relays it behind the ingress secret, so the claim means something.
    const dir = await agentDir({ "src/schedules/digest.ts": DIGEST });
    process.env.FASTAGENT_INGRESS_SECRET = "ingress-s3cret";
    const service = await mountAgentcoreService(await open(dir));
    const occurrence = "2026-07-07T09:00:00.000Z";
    const fire = () =>
      service.fetch(
        new Request("http://h/invocations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ auth: "ingress-s3cret", kind: "schedule-fire", name: "digest", occurrence }),
        }),
      );
    try {
      const first = (await (await fire()).json()) as { slot: string; fired: boolean };
      expect(first).toMatchObject({ slot: occurrence, fired: true });
      // EventBridge redelivers a fire it could not deliver, byte-identical (measured). The CLAIM is
      // what makes that one fire rather than two.
      const retry = (await (await fire()).json()) as { fired: boolean; skippedReason?: string };
      expect(retry.fired).toBe(false);
      expect(retry.skippedReason).toContain("already claimed");
      // …and the fire is on the record, which is what `fastagent schedules list` reads.
      const { readFires } = await import("../src/schedule/state.ts");
      const { resolveStateRoot } = await import("../src/paths.ts");
      expect(readFires(resolveStateRoot(dir), "digest").map((f) => f.slot)).toEqual([occurrence]);

      // An alarm for a schedule since removed: answered as skipped, never as an error EventBridge would retry.
      const unknown = await service.fetch(
        new Request("http://h/invocations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ auth: "ingress-s3cret", kind: "schedule-fire", name: "gone", occurrence }),
        }),
      );
      expect(unknown.status).toBe(200);
      expect(await unknown.json()).toMatchObject({ fired: false, skippedReason: "no such schedule any more" });
    } finally {
      process.env.FASTAGENT_INGRESS_SECRET = undefined;
      await service.close();
    }
  });

  it("reports loaded schedules, and close() is safe to call twice", async () => {
    const dir = await agentDir({ "src/schedules/digest.ts": DIGEST }, `{ defaults: { model: "${CODEX_MODEL}" } }`);
    const service = await mountAgentcoreService(await open(dir));
    expect(service.schedules.map((s) => s.name)).toEqual(["digest"]);

    await service.close();
    // Both the shutdown hook and an explicit close can run.
    await expect(service.close()).resolves.toBeUndefined();
  });
});

describe("a deployed box's build", () => {
  it("opens although the agent edited the project's copy, which only a local start refuses", async () => {
    const dir = await agentDir();
    await buildProject(dir);
    await writeFile(join(dir, "SYSTEM.md"), "The agent rewrote its own prompt.\n");
    await expect(openPreparedStartService(dir, { input: false })).rejects.toThrow(/built from other sources/);
    vi.stubEnv("FASTAGENT_RELEASE_FILE", join(dir, "release.json"));
    vi.stubEnv("FASTAGENT_STATE_DIR", join(dir, ".state"));
    const service = await openPreparedStartService(dir, { input: false });
    await service.close();
  }, 120_000);
});

describe("AgentCore assembly of a project nobody built", () => {
  it("rejects naming `fastagent build` instead of exiting the container", async () => {
    const dir = await agentDir();
    const exit = vi.spyOn(process, "exit").mockImplementation(((): never => {
      throw new Error("process.exit called");
    }) as never);
    try {
      await expect(openPreparedStartService(dir, { input: false })).rejects.toThrow(
        /holds no build: run `fastagent build`/,
      );
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });
});
