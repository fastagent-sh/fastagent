import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { buildAgentSessionRuntime } from "../src/engines/pi/session-builder.ts";
import { log } from "../src/log.ts";

// `chat` must run the SAME agent dev/start serve, presented in pi's TUI — NOT pi's vanilla
// discovery. buildAgentSessionRuntime is split out precisely so that injection is inspectable without a
// TTY. In-memory sessions keep the test from writing to the machine's pi session store. A raw
// AgentTool via `config.tools` lets the custom-tool path be tested without installing the package.
/** A fresh AGENT dir (`<tmp>/fastagent/`). Passing it to the builder resolves to itself, with the
 *  temp dir as the workspace — the same placement `init` produces, entered from the inside. */
async function freshAgentDir(prefix: string, options: { persona?: boolean } = {}): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), prefix)), "fastagent");
  await mkdir(dir);
  if (options.persona !== false) await writeFile(join(dir, "persona.md"), "You are terse.\n");
  return dir;
}

describe("session builder: buildAgentSessionRuntime injects fastagent's assembled agent into pi's session", () => {
  it("binds the chat session manager to ordinary configured defineTool tools", async () => {
    const dir = await freshAgentDir("fa-chat-session-tool-");
    const observedKey = "__fastagent_chat_tool_session_test__";
    const piUrl = new URL("../src/pi.ts", import.meta.url).href;
    try {
      await writeFile(
        join(dir, "fastagent.config.mjs"),
        `import { defineTool, z } from ${JSON.stringify(piUrl)};
         export default {
           model: "openai-codex/gpt-5.5",
           tools: [defineTool({
             name: "inspect_session",
             description: "Inspect this session.",
             input: z.object({}),
             execute: async (_input, ctx) => {
               globalThis[${JSON.stringify(observedKey)}] = {
                 sessionId: ctx.sessionManager.getSessionId(),
                 header: await ctx.sessionManager.getHeader(),
                 branch: await ctx.sessionManager.getBranch(),
               };
               return "ok";
             },
           })],
         };\n`,
      );
      const rt = await buildAgentSessionRuntime(dir, {}, SessionManager.inMemory());
      try {
        rt.session.sessionManager.appendMessage({ role: "user", content: "history marker", timestamp: Date.now() });
        const tool = rt.session.agent.state.tools.find((candidate) => candidate.name === "inspect_session");
        expect(tool).toBeDefined();
        await tool!.execute("inspect-1", {});
        const observed = (globalThis as Record<string, unknown>)[observedKey] as {
          sessionId: string;
          header: { id: string; timestamp: string };
          branch: unknown[];
        };
        expect(observed.sessionId).toBe(rt.session.sessionId);
        expect(observed.header.id).toBe(rt.session.sessionId);
        expect(observed.header.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(JSON.stringify(observed.branch)).toContain("history marker");
      } finally {
        delete (globalThis as Record<string, unknown>)[observedKey];
        await rt.dispose();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("emulates deferral: deferred tools start inactive, search_tools mounts and activates via pi's session", async () => {
    const dir = await freshAgentDir("fa-chat-defer-");
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
      const rt = await buildAgentSessionRuntime(dir, {}, SessionManager.inMemory());
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
        // production guard is pi's batch serialization, triggered by the loader's executionMode — the
        // marker assertion IS the parallel protection (these two awaited calls are serial either way;
        // they pin the message/stamp behavior UNDER the serialization pi guarantees).
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

  it("leaves the baseline under codingTools false, with a capability-neutral default identity", async () => {
    const dir = await freshAgentDir("fa-chat-empty-", { persona: false });
    try {
      await writeFile(
        join(dir, "fastagent.config.mjs"),
        `export default { model: "openai-codex/gpt-5.5", codingTools: false };\n`,
      );
      const rt = await buildAgentSessionRuntime(dir, {}, SessionManager.inMemory());
      try {
        const state = rt.session.agent.state;
        // `false` removes what CHANGES things; reading and searching are how skills and attachments
        // work at all, so they stay.
        expect(state.tools.map((t) => t.name).sort()).toEqual(["find", "grep", "ls", "read"]);
        expect(state.systemPrompt).toContain("- read:");
        expect(state.systemPrompt).not.toContain("- bash:");
        expect(state.systemPrompt).toContain("You are an AI assistant operating inside pi, an agent harness.");
        expect(state.systemPrompt).not.toContain("You help users by reading files");
      } finally {
        await rt.dispose();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("honors codingTools false in chat's mounted surface and generated prompt — baseline aside", async () => {
    const dir = await freshAgentDir("fa-chat-no-coding-");
    try {
      await writeFile(
        join(dir, "fastagent.config.mjs"),
        `export default {
           model: "openai-codex/gpt-5.5",
           codingTools: false,
           tools: [{
             name: "lookup",
             description: "Look up a business record.",
             parameters: { type: "object", properties: {} },
             execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
           }],
         };\n`,
      );
      const rt = await buildAgentSessionRuntime(dir, {}, SessionManager.inMemory());
      try {
        const state = rt.session.agent.state;
        // The authored tool rides on top of the baseline; what `false` removed is the mutating half.
        expect(state.tools.map((t) => t.name)).toEqual(["read", "grep", "find", "ls", "lookup"]);
        expect(state.systemPrompt).toContain("- lookup: Look up a business record.");
        expect(state.systemPrompt).toContain("- read:");
        for (const name of ["bash", "edit", "write"]) {
          expect(state.systemPrompt).not.toContain(`- ${name}:`);
        }
      } finally {
        await rt.dispose();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("injects the definition's prompt + skills, the config model, custom tools, definition-only", async () => {
    const dir = await freshAgentDir("fa-chat-");
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
      const rt = await buildAgentSessionRuntime(dir, {}, SessionManager.inMemory());
      try {
        errorSpy.mockRestore();
        expect(warnings.some((line) => line.includes('skill "greet" collision'))).toBe(true);
        expect(warnings.some((line) => line.includes('tool "ping" (tools/ping) dropped'))).toBe(true);

        const st = rt.session.agent.state;
        // Default coding tools (rebuilt by pi from names) PLUS the config's custom tool, registered
        // through the session factory — definition-only, nothing machine-global leaked in.
        expect(st.tools.map((t) => t.name).sort()).toEqual([
          "bash",
          "edit",
          "find",
          "grep",
          "ls",
          "ping",
          "read",
          "write",
        ]);
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

  it("resolves the placement from the workspace: persona/tools from fastagent/, ② context from the workspace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-chat-nested-"));
    try {
      await writeFile(join(dir, "AGENTS.md"), "HOST_CTX_MARKER. Repo conventions.\n"); // ② at the workspace
      const root = join(dir, "fastagent");
      await mkdir(join(root, "tools"), { recursive: true });
      await writeFile(join(root, "fastagent.config.mjs"), `export default { model: "openai-codex/gpt-5.5" };\n`);
      await writeFile(join(root, "persona.md"), "You are PERSONA_MARKER bot.\n"); // ① in the workspace root
      await writeFile(
        join(root, "tools", "foo.mjs"),
        `export default { description: "d", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [], details: {} }) };`,
      );

      const rt = await buildAgentSessionRuntime(dir, {}, SessionManager.inMemory());
      try {
        const sp = rt.session.agent.state.systemPrompt ?? "";
        expect(sp).toContain("PERSONA_MARKER"); // ① persona from the workspace root
        expect(sp).toContain("HOST_CTX_MARKER"); // ② context walked from the workspace
        expect(rt.session.agent.state.tools.map((t) => t.name)).toContain("foo"); // tool from the workspace root
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
    const dir = await freshAgentDir("fa-chat-append-");
    const agentDir = await mkdtemp(join(tmpdir(), "fa-agentdir-"));
    const prev = process.env.PI_CODING_AGENT_DIR;
    try {
      await writeFile(join(dir, "AGENTS.md"), "# Agent\nDEFN_ONLY_MARKER.\n");
      await writeFile(join(dir, "fastagent.config.mjs"), `export default { model: "openai-codex/gpt-5.5" };\n`);
      await writeFile(join(agentDir, "APPEND_SYSTEM.md"), "GLOBAL_APPEND_LEAK_MARKER must not reach chat.\n");
      process.env.PI_CODING_AGENT_DIR = agentDir;

      const rt = await buildAgentSessionRuntime(dir, {}, SessionManager.inMemory());
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

  it("wires auth to the agent's credential file (not ~/.pi), touching no .gitignore", async () => {
    const dir = await freshAgentDir("fa-sb-auth-");
    try {
      await writeFile(join(dir, "fastagent.config.mjs"), `export default { model: "openai-codex/gpt-5.5" };\n`);
      // A credential in the PROJECT-level auth.json — the same file dev/start/login use.
      await mkdir(join(dir, ".secrets"), { recursive: true });
      await writeFile(
        join(dir, ".secrets", "auth.json"),
        `${JSON.stringify({ openai: { type: "api_key", key: "sk-test" } })}\n`,
      );

      const rt = await buildAgentSessionRuntime(dir, {}, SessionManager.inMemory());
      try {
        // The session's model hub reads the workspace store: the stored credential is visible.
        const creds = await rt.session.modelRuntime.listCredentials();
        expect(creds.some((c) => c.providerId === "openai" && c.type === "api_key")).toBe(true);
        // …and building a resident session writes nothing about git: the agent's .gitignore is the
        // author's file, scaffolded once by `init`.
        expect(existsSync(join(dir, ".secrets", ".gitignore"))).toBe(false);
      } finally {
        rt.session.dispose?.();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("honors config.thinkingLevel like serving does (fidelity)", async () => {
    const dir = await freshAgentDir("fa-sb-think-");
    try {
      await writeFile(
        join(dir, "fastagent.config.mjs"),
        `export default { model: "openai-codex/gpt-5.5", thinkingLevel: "high" };\n`,
      );
      const rt = await buildAgentSessionRuntime(dir, {}, SessionManager.inMemory());
      try {
        expect(rt.session.thinkingLevel).toBe("high");
      } finally {
        rt.session.dispose?.();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects cross-workspace session switches because chat env is workspace-scoped", async () => {
    const root = await mkdtemp(join(tmpdir(), "fa-chat-scope-"));
    const dir = join(root, "agent-a", "fastagent");
    const other = join(root, "agent-b", "fastagent");
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

      const rt = await buildAgentSessionRuntime(dir, {}, SessionManager.create(dir, sessionsDir));
      try {
        let invalidated = false;
        rt.setBeforeSessionInvalidate(() => {
          invalidated = true;
        });
        // A session that EXPLICITLY records another workspace is rejected before pi tears the live
        // session down — independent of process.cwd().
        await expect(rt.importFromJsonl(imported, other)).rejects.toThrow(/fastagent sessions are workspace-scoped/);
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
    const dir = join(root, "agent", "fastagent");
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
      const rt = await buildAgentSessionRuntime(dir, {}, SessionManager.create(dir, sessionsDir));
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

describe("session builder: the credential hint belongs to the runtime, not to each session", () => {
  it("warns once, not again on every newSession()", async () => {
    // Model resolution moved into createRuntime (extensions must load before a model they register
    // can resolve), which put this warning on a per-session path. Credentials do not change between
    // /new and /resume, so repeating it is nagging about a setting the user did not touch.
    const workspace = await mkdtemp(join(tmpdir(), "fa-hint-"));
    const dir = join(workspace, "fastagent");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "persona.md"), "You are terse.\n");
    await writeFile(join(dir, "fastagent.config.mjs"), 'export default { model: "openai-codex/gpt-5.5" };\n');
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const rt = await buildAgentSessionRuntime(dir, {}, SessionManager.inMemory());
    try {
      const hintsAfterBuild = warn.mock.calls
        .flat()
        .filter((c: unknown) => String(c).includes("no credentials for")).length;
      await rt.newSession();
      await rt.newSession();
      const hintsAfterReplacements = warn.mock.calls
        .flat()
        .filter((c: unknown) => String(c).includes("no credentials for")).length;
      expect(hintsAfterReplacements).toBe(hintsAfterBuild);
    } finally {
      warn.mockRestore();
      await rt.dispose?.();
    }
  });
});

describe("session builder: chat offers the model the same tool set serving does", () => {
  it("activates fastagent's tools without pi's extra ones", async () => {
    // Dropping the `tools` allowlist (it froze the set against extensions registering from a
    // handler) put this at risk: pi mounts read/bash/edit/write of ITS OWN and leaves them inactive,
    // so a version of this that stated the active set explicitly offered the model two of each.
    const dir = await mkdtemp(join(tmpdir(), "fa-active-"));
    await writeFile(join(dir, "persona.md"), "You are terse.\n");
    await writeFile(join(dir, "fastagent.config.mjs"), 'export default { model: "openai-codex/gpt-5.5" };\n');
    const rt = await buildAgentSessionRuntime(dir, {}, SessionManager.inMemory());
    try {
      const active = rt.session.getActiveToolNames().sort();
      expect(active).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
      // Exactly one copy of each: `noTools: "builtin"` keeps pi's own read/bash/edit/write out, and
      // fastagent mounts its own. Two under one name would be the model's problem to disambiguate.
      expect(rt.session.getAllTools().filter((tool) => tool.name === "bash")).toHaveLength(1);
    } finally {
      await rt.dispose?.();
    }
  });
});

describe("session builder: codingTools narrows chat exactly as it narrows serving", () => {
  it("mounts and activates only the configured coding tools", async () => {
    // Both assemblies take their tool list from resolveAgentAssembly, so a least-privilege posture
    // needs no per-assembly narrowing: what the definition disabled never reaches either list, and
    // pi's own copies stay out via `noTools: "builtin"`. Before the allowlist was dropped, chat
    // narrowed a second time by NAME — a second place for the two paths to disagree.
    const dir = await mkdtemp(join(tmpdir(), "fa-coding-narrow-"));
    await writeFile(join(dir, "persona.md"), "You are terse.\n");
    await writeFile(
      join(dir, "fastagent.config.mjs"),
      'export default { model: "openai-codex/gpt-5.5", codingTools: ["edit"] };\n',
    );
    const rt = await buildAgentSessionRuntime(dir, {}, SessionManager.inMemory());
    try {
      expect(rt.session.getActiveToolNames().sort()).toEqual(["edit", "find", "grep", "ls", "read"]);
      // A BOUNDARY, not a default: the disabled built-ins are refused at the registry, so nothing
      // that activates by name — a TUI command, the control plane, a deferred-tool loader — can put
      // one back. "Mounted but inactive" would be the whole distance between safe and not for a
      // public-facing agent running `codingTools: false`.
      const mounted = rt.session.getAllTools().map((tool) => tool.name);
      expect(mounted).not.toContain("bash");
      expect(mounted).not.toContain("write");
      rt.session.setActiveToolsByName(["read", "bash"]);
      expect(rt.session.getActiveToolNames()).not.toContain("bash"); // asking for it does not get it
    } finally {
      await rt.dispose?.();
    }
  });
});

describe("session builder: disabling a built-in frees its name for an authored tool", () => {
  it("mounts an authored `read` when codingTools is false", async () => {
    // The denylist that makes `codingTools` a boundary matches by NAME, so excluding a name the
    // author reused would delete THEIR tool instead of pi's — silently, and only for the four
    // built-in names. Docs promise the opposite: with the built-in off, the name is theirs.
    const dir = await mkdtemp(join(tmpdir(), "fa-authored-read-"));
    await writeFile(join(dir, "persona.md"), "You are terse.\n");
    await writeFile(
      join(dir, "fastagent.config.mjs"),
      'export default { model: "openai-codex/gpt-5.5", codingTools: false };\n',
    );
    await mkdir(join(dir, "tools"), { recursive: true });
    await writeFile(
      join(dir, "tools", "read.mjs"),
      `export default {
         description: "the author's own reader",
         parameters: { type: "object", properties: {} },
         execute: async () => ({ content: [{ type: "text", text: "mine" }], details: {} }),
       };\n`,
    );
    const rt = await buildAgentSessionRuntime(dir, {}, SessionManager.inMemory());
    try {
      expect(rt.session.getAllTools().map((t) => t.name)).toContain("read");
      expect(rt.session.getActiveToolNames()).toContain("read");
      // ...and the built-ins the author did NOT take are still refused.
      expect(rt.session.getAllTools().map((t) => t.name)).not.toContain("bash");
    } finally {
      await rt.dispose?.();
    }
  });
});
