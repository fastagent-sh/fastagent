import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { buildChatRuntime } from "../src/engines/pi/chat.ts";

// `chat` must run the SAME agent dev/start serve, presented in pi's TUI — NOT pi's vanilla
// discovery. buildChatRuntime is split out precisely so that injection is inspectable without a
// TTY. In-memory sessions keep the test from writing to the machine's pi session store. A raw
// AgentTool via `config.tools` lets the custom-tool path be tested without installing the package.
describe("chat: buildChatRuntime injects fastagent's assembled agent into pi's session", () => {
  it("emulates deferral: deferred tools start inactive, search_tools mounts and activates via pi's session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-chat-defer-"));
    try {
      await writeFile(
        join(dir, "fastagent.config.mjs"),
        `export default {
           model: "openai-codex/gpt-5.5",
           tools: [{
             name: "lookup_weather",
             description: "Look up the weather forecast for a city.",
             parameters: { type: "object", properties: {} },
             deferred: true,
             execute: async () => ({ content: [{ type: "text", text: "sunny" }], details: {} }),
           }],
         };\n`,
      );
      const rt = await buildChatRuntime(dir, {}, SessionManager.inMemory());
      try {
        const session = rt.session;
        // Initial active set mirrors serving: deferred tool registered but NOT active; loader active.
        expect(session.getAllTools().map((t) => t.name)).toContain("lookup_weather");
        const active = session.getActiveToolNames();
        expect(active).toContain("search_tools");
        expect(active).not.toContain("lookup_weather");

        // Drive the SAME builtin loader through pi's tool surface: it must activate via the session.
        const loader = session.getAllTools().find((t) => t.name === "search_tools");
        expect(loader).toBeDefined();
        const custom = rt.session.agent.state.tools.find((t) => t.name === "search_tools") as unknown as {
          execute: (
            id: string,
            params: unknown,
            signal?: AbortSignal,
          ) => Promise<{ content: Array<{ text?: string }> }>;
        };
        const result = await custom.execute("c1", { query: "weather forecast" });
        expect(result.content[0]?.text).toMatch(/Activated: lookup_weather/);
        expect(session.getActiveToolNames()).toContain("lookup_weather");

        // Attribution regression (review): pi wraps SDK customTools in its own before/after active-set
        // diff, so two PARALLEL loader calls would both get stamped with the same activation. The
        // production guard is pi's batch serialization, triggered by the loader's executionMode —
        // assert the contract (marker present on the REGISTERED tool) and the serial behavior (second
        // call reports already-active, exactly one stamp).
        await rt.newSession();
        const reSession = rt.session;
        const loader2 = rt.session.agent.state.tools.find((t) => t.name === "search_tools") as unknown as {
          executionMode?: string;
          execute: (id: string, params: unknown) => Promise<{ addedToolNames?: string[] }>;
        };
        expect(loader2.executionMode).toBe("sequential"); // what makes pi serialize the batch
        const r1 = await loader2.execute("p1", { query: "weather" });
        const r2 = await loader2.execute("p2", { query: "forecast" });
        const stamped = [r1, r2].filter((r) => (r.addedToolNames ?? []).length > 0);
        expect(stamped).toHaveLength(1);
        expect(stamped[0]?.addedToolNames).toEqual(["lookup_weather"]);
        expect(reSession.getActiveToolNames()).toContain("lookup_weather");

        // The documented divergence, as a spec: chat activations do not survive /new — pi's chat
        // session records no activations, so every rebuild re-narrows and discovery starts over.
        await rt.newSession();
        const rebuilt = rt.session;
        expect(rebuilt.getActiveToolNames()).not.toContain("lookup_weather");
        expect(rebuilt.getActiveToolNames()).toContain("search_tools");
      } finally {
        await rt.dispose();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("injects the definition's prompt + skills, the config model, custom tools, definition-only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-chat-"));
    try {
      await writeFile(join(dir, "AGENTS.md"), "# Test Agent\nMAGIC_CHAT_MARKER_91. Be terse.\n");
      await writeFile(
        join(dir, "fastagent.config.mjs"),
        `export default {
           model: "openai-codex/gpt-5.5",
           tools: [{
             name: "ping",
             description: "Reply pong.",
             parameters: { type: "object", properties: {} },
             execute: async () => ({ content: [{ type: "text", text: "pong" }], details: {} }),
           }],
         };\n`,
      );
      await mkdir(join(dir, "skills", "greet"), { recursive: true });
      await writeFile(
        join(dir, "skills", "greet", "SKILL.md"),
        "---\nname: greet\ndescription: How to greet a user.\n---\nSay hi warmly.\n",
      );
      await mkdir(join(dir, "skills", "greet-copy"), { recursive: true });
      await writeFile(
        join(dir, "skills", "greet-copy", "SKILL.md"),
        "---\nname: greet\ndescription: Duplicate greet.\n---\nDuplicate.\n",
      );
      await mkdir(join(dir, "tools"), { recursive: true });
      await writeFile(
        join(dir, "tools", "ping.mjs"),
        `export default {
           description: "Discovered ping should be dropped because config.tools wins.",
           parameters: { type: "object", properties: {} },
           execute: async () => ({ content: [{ type: "text", text: "stale" }], details: {} }),
         };\n`,
      );

      const warnings: string[] = [];
      const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      });
      const rt = await buildChatRuntime(dir, {}, SessionManager.inMemory());
      try {
        errorSpy.mockRestore();
        expect(warnings.some((line) => line.includes('skill "greet" collision'))).toBe(true);
        expect(warnings.some((line) => line.includes('tool "ping" (tools/ping) dropped'))).toBe(true);

        const st = rt.session.agent.state;
        // Default coding tools (rebuilt by pi from names) PLUS the config's custom tool, registered
        // through the session factory — definition-only, nothing machine-global leaked in.
        expect(st.tools.map((t) => t.name).sort()).toEqual(["bash", "edit", "ping", "read", "write"]);
        // The injected system prompt is fastagent's: the definition's AGENTS.md and skill are in it.
        const sp = st.systemPrompt ?? "";
        expect(sp).toContain("MAGIC_CHAT_MARKER_91");
        expect(sp).toMatch(/greet/);
        expect(st.model).toBeDefined(); // the config model resolved (fastagent's, not pi's default)
        // Duplication guard: pi appends the skill section + env (cwd; pi ≥0.80.7 dropped the date from
        // its default prompt for cache stability); the override must carry only base+instructions, or
        // chat drifts from served and wastes context.
        expect((sp.match(/Current date/g) ?? []).length).toBe(0);
        expect((sp.match(/Current working directory/g) ?? []).length).toBe(1);
        expect((sp.match(/<available_skills>/g) ?? []).length).toBe(1);

        // Chat is a coherent startup snapshot per cwd: same-cwd rebuilds (/new, fork) must not
        // half-refresh only the fs-read pieces while config/tools stay stale in Node's import cache.
        await writeFile(join(dir, "AGENTS.md"), "# Changed Agent\nSHOULD_NOT_HOT_RELOAD_IN_CHAT.\n");

        // P1 regression guard: the TUI rebuilds the session on /new (and /resume, fork) via the same
        // factory. The custom tool must come back — registering through customTools (not patching
        // state afterward) is what makes that hold.
        await rt.newSession();
        expect(rt.session.agent.state.tools.map((t) => t.name)).toContain("ping");
        const rebuiltPrompt = rt.session.agent.state.systemPrompt ?? "";
        expect(rebuiltPrompt).toContain("MAGIC_CHAT_MARKER_91");
        expect(rebuiltPrompt).not.toContain("SHOULD_NOT_HOT_RELOAD_IN_CHAT");
      } finally {
        errorSpy.mockRestore();
        rt.session.dispose?.();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves config.agentDir: persona/tools from agentDir, ② context walked from cwd", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-chat-agentdir-"));
    try {
      await writeFile(join(dir, "AGENTS.md"), "HOST_CTX_MARKER. Repo conventions.\n"); // ② at cwd
      await writeFile(
        join(dir, "fastagent.config.mjs"),
        `export default { agentDir: "./agent", model: "openai-codex/gpt-5.5" };\n`,
      );
      const agentDir = join(dir, "agent");
      await mkdir(join(agentDir, "tools"), { recursive: true });
      await writeFile(join(agentDir, "persona.md"), "You are PERSONA_MARKER bot.\n"); // ① in agentDir
      await writeFile(
        join(agentDir, "tools", "foo.mjs"),
        `export default { description: "d", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [], details: {} }) };`,
      );

      const rt = await buildChatRuntime(dir, {}, SessionManager.inMemory());
      try {
        const sp = rt.session.agent.state.systemPrompt ?? "";
        expect(sp).toContain("PERSONA_MARKER"); // ① persona from agentDir
        expect(sp).toContain("HOST_CTX_MARKER"); // ② context walked from cwd (run root)
        expect(rt.session.agent.state.tools.map((t) => t.name)).toContain("foo"); // tool from agentDir
      } finally {
        rt.session.dispose?.();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("suppresses pi's machine-global APPEND_SYSTEM.md so chat matches what dev/start serve", async () => {
    // getAgentDir() honors PI_CODING_AGENT_DIR; point it at a temp agent dir holding an append
    // prompt. dev/start never read that file, so chat must not either, or fidelity breaks.
    const dir = await mkdtemp(join(tmpdir(), "fa-chat-append-"));
    const agentDir = await mkdtemp(join(tmpdir(), "fa-agentdir-"));
    const prev = process.env.PI_CODING_AGENT_DIR;
    try {
      await writeFile(join(dir, "AGENTS.md"), "# Agent\nDEFN_ONLY_MARKER.\n");
      await writeFile(join(dir, "fastagent.config.mjs"), `export default { model: "openai-codex/gpt-5.5" };\n`);
      await writeFile(join(agentDir, "APPEND_SYSTEM.md"), "GLOBAL_APPEND_LEAK_MARKER must not reach chat.\n");
      process.env.PI_CODING_AGENT_DIR = agentDir;

      const rt = await buildChatRuntime(dir, {}, SessionManager.inMemory());
      try {
        const sp = rt.session.agent.state.systemPrompt ?? "";
        expect(sp).toContain("DEFN_ONLY_MARKER"); // fastagent's prompt is there
        expect(sp).not.toContain("GLOBAL_APPEND_LEAK_MARKER"); // pi's append prompt is suppressed
      } finally {
        rt.session.dispose?.();
      }
    } finally {
      if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prev;
      await rm(dir, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("rejects cross-workspace session switches because chat env is workspace-scoped", async () => {
    const root = await mkdtemp(join(tmpdir(), "fa-chat-scope-"));
    const dir = join(root, "agent-a");
    const other = join(root, "agent-b");
    const sessionsDir = join(root, "sessions");
    try {
      await mkdir(dir, { recursive: true });
      await mkdir(other, { recursive: true });
      await writeFile(join(dir, "AGENTS.md"), "# Agent A\n");
      await writeFile(join(dir, "fastagent.config.mjs"), `export default { model: "openai-codex/gpt-5.5" };\n`);
      await writeFile(join(other, "AGENTS.md"), "# Agent B\n");
      await writeFile(join(other, "fastagent.config.mjs"), `export default { model: "openai-codex/gpt-5.5" };\n`);
      const imported = join(root, "other-session.jsonl");
      await writeFile(
        imported,
        `${JSON.stringify({ type: "session", version: 3, id: "other", timestamp: new Date().toISOString(), cwd: other })}\n`,
      );

      const rt = await buildChatRuntime(dir, {}, SessionManager.create(dir, sessionsDir));
      try {
        let invalidated = false;
        rt.setBeforeSessionInvalidate(() => {
          invalidated = true;
        });
        // A session that EXPLICITLY records another workspace is rejected before pi tears the live
        // session down — independent of process.cwd().
        await expect(rt.importFromJsonl(imported, other)).rejects.toThrow(/fastagent chat is workspace-scoped/);
        expect(invalidated).toBe(false);
        expect(rt.cwd).toBe(realpathSync(dir)); // runtime cwd is canonical (symlink-free)
      } finally {
        rt.session.dispose?.();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps cwd-less legacy sessions in the chat workspace across import and fork", async () => {
    // The chat process runs chdir'd into the workspace (runChat); these cases depend on that
    // invariant, so emulate it here. Without it, a cwd-less session would fall back to pi's
    // process.cwd() and trip the cross-workspace teardown path on import AND on /fork.
    const root = await mkdtemp(join(tmpdir(), "fa-chat-legacy-"));
    const dir = join(root, "agent");
    const sessionsDir = join(root, "sessions");
    const originalCwd = process.cwd();
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "AGENTS.md"), "# Agent\n");
      await writeFile(join(dir, "fastagent.config.mjs"), `export default { model: "openai-codex/gpt-5.5" };\n`);
      // A legacy session: a header with NO cwd, plus one user message entry to fork at.
      const legacy = join(root, "legacy-session.jsonl");
      await writeFile(
        legacy,
        `${JSON.stringify({ type: "session", version: 3, id: "legacy", timestamp: new Date().toISOString() })}\n` +
          `${JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "hi" } })}\n`,
      );

      process.chdir(dir);
      const realDir = realpathSync(dir); // pi binds the realpath via process.cwd()
      const rt = await buildChatRuntime(dir, {}, SessionManager.create(dir, sessionsDir));
      try {
        // Import the cwd-less session: no foreign cwd, so it runs in the chat workspace.
        await expect(rt.importFromJsonl(legacy)).resolves.toMatchObject({ cancelled: false });
        expect(rt.cwd).toBe(realDir);
        // Fork at an entry: pi reopens the current (cwd-less) session file without a cwd override.
        // The chdir invariant keeps that resolving to the chat workspace instead of process.cwd().
        await expect(rt.fork("m1", { position: "at" })).resolves.toMatchObject({ cancelled: false });
        expect(rt.cwd).toBe(realDir);
      } finally {
        rt.session.dispose?.();
      }
    } finally {
      process.chdir(originalCwd);
      await rm(root, { recursive: true, force: true });
    }
  });
});
