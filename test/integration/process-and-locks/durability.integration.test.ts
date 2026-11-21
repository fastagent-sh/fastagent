import { spawn } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it } from "vitest";
import { writeFileAtomic } from "../../../packages/fastagent/src/atomic-write.ts";
import { openLockedStorage } from "../../../packages/fastagent/src/harnesses/pi-durable/storage.ts";
import { withLockedFile } from "../../../packages/fastagent/src/locked-file.ts";

const roots: string[] = [];
const freshDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runNode(script: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, ...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("withLockedFile and writeFileAtomic: cross-process serialization and file safety", () => {
  it("serializes concurrent read-modify-write updates across processes without losing any increment", async () => {
    const dir = freshDir("fa-lock-");
    const target = join(dir, "count.json");
    writeFileSync(target, JSON.stringify({ count: 0 }));

    const moduleUrl = pathToFileURL(
      new URL("../../../packages/fastagent/src/locked-file.ts", import.meta.url).pathname,
    ).href;
    const worker = `
      import { withLockedFile } from ${JSON.stringify(moduleUrl)};
      const file = process.argv[1];
      for (let i = 0; i < 5; i++) {
        await withLockedFile(file, async (raw) => {
          const data = JSON.parse(raw ?? '{"count":0}');
          return { result: undefined, next: JSON.stringify({ count: data.count + 1 }) };
        });
      }
    `;
    const results = await Promise.all([
      runNode(worker, [target]),
      runNode(worker, [target]),
      runNode(worker, [target]),
    ]);
    for (const r of results) expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ count: 15 });
  });

  it("writes through a symlink to its target without replacing the link, and keeps 0600 over a stale temp", async () => {
    const dir = freshDir("fa-atomic-");
    const real = join(dir, "real-auth.json");
    const link = join(dir, "auth.json");
    writeFileSync(real, "{}");
    symlinkSync(real, link);

    // Pre-existing stale temp with loose permissions must still end up 0600 on the target.
    writeFileSync(`${real}.tmp`, "stale", { mode: 0o644 });
    chmodSync(`${real}.tmp`, 0o644);
    await withLockedFile(link, async () => ({ result: undefined, next: '{"ok":true}' }));

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toBe('{"ok":true}');
    expect(lstatSync(real).mode & 0o777).toBe(0o600);

    // A write failure leaves the existing file untouched.
    mkdirSync(`${real}.tmp`, { recursive: true });
    expect(() => writeFileAtomic(real, '{"corrupt":true}', 0o600)).toThrow(/EISDIR|illegal operation on a directory/);
    expect(readFileSync(real, "utf8")).toBe('{"ok":true}');
  });

  it("refuses to write if the caller's AbortSignal fires before commit", async () => {
    const dir = freshDir("fa-abort-");
    const target = join(dir, "state.json");
    writeFileSync(target, '{"v":1}');
    const controller = new AbortController();

    await expect(
      withLockedFile(
        target,
        async () => {
          controller.abort(new Error("caller timed out"));
          return { result: undefined, next: '{"v":2}' };
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("caller timed out");
    expect(readFileSync(target, "utf8")).toBe('{"v":1}');
  });
});

describe("openLockedStorage: exclusive SQLite locking across processes", () => {
  it("refuses a second process while held, then opens once released", async () => {
    const dir = freshDir("fa-sqlite-lock-");
    const db = join(dir, "agent.sqlite");
    const storageUrl = pathToFileURL(
      new URL("../../../packages/fastagent/src/harnesses/pi-durable/storage.ts", import.meta.url).pathname,
    ).href;

    const holder = await openLockedStorage(db, "dev", 0);
    try {
      const contender = await runNode(
        `
          import { openLockedStorage } from ${JSON.stringify(storageUrl)};
          try {
            await openLockedStorage(process.argv[1], "dev", 0);
            process.exit(0);
          } catch (error) {
            console.error(error.message);
            process.exit(2);
          }
        `,
        [db],
      );
      expect(contender.code).toBe(2);
      expect(contender.stderr).toContain("is held by another process: dev is running");
    } finally {
      await holder.close(BACKGROUND_CONTEXT);
    }

    const afterRelease = await openLockedStorage(db, "dev", 0);
    await afterRelease.close(BACKGROUND_CONTEXT);
  });
});

describe("@fastagent-sh/harness-dsh SIGKILL crash recovery on SQLite", () => {
  it("recovers an interrupted side-effecting tool without re-executing it and drains queued messages", async () => {
    const dir = freshDir("fa-dsh-sigkill-");
    const dbPath = join(dir, "dsh.sqlite");
    const effectFile = join(dir, "effect-count.txt");
    writeFileSync(effectFile, "0");

    const workerScript = `
      import { readFileSync, writeFileSync } from "node:fs";
      import {
        createFauxCore,
        createModels,
        createProvider,
        fauxAssistantMessage,
        fauxToolCall,
      } from "@earendil-works/pi-ai";
      import { openDshAgent, openSqliteDshStore } from "@fastagent-sh/harness-dsh";

      const [dbPath, effectPath, mode, existingSessionId, existingRunningId, existingQueued1Id, existingQueued2Id] =
        process.argv.slice(1);

      const core = createFauxCore({ provider: "crash", api: "crash" });
      const stream = (...args) => {
        const last = args[1].messages.at(-1);
        if (last?.role === "toolResult") {
          core.appendResponses([fauxAssistantMessage("answer: " + last.toolName)]);
        } else {
          const text = typeof last?.content === "string" ? last.content : "";
          if (text === "mark") {
            core.appendResponses([fauxAssistantMessage([fauxToolCall("mark", {})], { stopReason: "toolUse" })]);
          } else {
            core.appendResponses([fauxAssistantMessage("answer: " + text)]);
          }
        }
        return core.streamSimple(...args);
      };
      const models = createModels();
      models.setProvider(
        createProvider({
          id: "crash",
          auth: { apiKey: { name: "Crash", resolve: async () => ({ auth: {} }) } },
          models: core.models,
          api: { stream, streamSimple: stream },
        }),
      );

      let markEntered;
      const markStarted = new Promise((resolve) => {
        markEntered = resolve;
      });
      const markTool = {
        name: "mark",
        description: "Increments an on-disk counter and then blocks forever",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          const count = Number(readFileSync(effectPath, "utf8").trim()) + 1;
          writeFileSync(effectPath, String(count));
          markEntered();
          await new Promise(() => {});
          return { output: [{ type: "text", text: "unreachable" }] };
        },
      };

      const store = openSqliteDshStore(dbPath);
      const agent = await openDshAgent({
        name: "crash-test",
        workdir: process.cwd(),
        models,
        model: { provider: "crash", modelId: core.getModel().id },
        tools: [markTool],
        sandbox: "off",
        storage: store,
      });

      if (mode === "crash") {
        const session = await agent.sessions.create();
        const running = await agent.messages.send({ sessionId: session.id, content: "mark" });
        await markStarted;
        const q1 = await agent.messages.send({ sessionId: session.id, content: "after-1" });
        const q2 = await agent.messages.send({ sessionId: session.id, content: "after-2" });
        // Flush pending appends so SQLite has committed the open turn & queued messages before SIGKILL.
        await new Promise((resolve) => setTimeout(resolve, 60));
        // Keep the event loop alive so Process 1 stays running until the parent sends SIGKILL.
        setInterval(() => {}, 60_000);
        console.log(JSON.stringify({ sessionId: session.id, runningId: running.id, q1Id: q1.id, q2Id: q2.id }));
        await new Promise(() => {});
      } else {
        const r = await agent.messages.get({ sessionId: existingSessionId, messageId: existingRunningId }, { wait: 15 });
        const m1 = await agent.messages.get({ sessionId: existingSessionId, messageId: existingQueued1Id }, { wait: 15 });
        const m2 = await agent.messages.get({ sessionId: existingSessionId, messageId: existingQueued2Id }, { wait: 15 });
        console.log(JSON.stringify({ r, m1, m2 }));
        await agent.close();
        await store.close();
      }
    `;

    // Process 1: execute side-effecting tool, queue 2 messages, then SIGKILL!
    const crashChild = spawn(
      process.execPath,
      ["--conditions=@fastagent-sh/source", "--input-type=module", "-e", workerScript, dbPath, effectFile, "crash"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let crashStderr = "";
    crashChild.stderr.on("data", (chunk) => {
      crashStderr += chunk;
    });
    const ids = await new Promise<{ sessionId: string; runningId: string; q1Id: string; q2Id: string }>(
      (resolve, reject) => {
        let buf = "";
        crashChild.stdout.on("data", (chunk) => {
          buf += chunk;
          const nl = buf.indexOf("\n");
          if (nl !== -1) resolve(JSON.parse(buf.slice(0, nl)));
        });
        crashChild.on("exit", (code) => reject(new Error(`crash worker exited early (${code}): ${crashStderr}`)));
      },
    );

    expect(Number(readFileSync(effectFile, "utf8").trim())).toBe(1);
    // While Process 1 holds dsh.sqlite, a contending process opening with busyTimeoutMs: 0 must be refused.
    const contender = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(
        process.execPath,
        [
          "--conditions=@fastagent-sh/source",
          "--input-type=module",
          "-e",
          `import { openSqliteDshStore } from "@fastagent-sh/harness-dsh"; openSqliteDshStore(process.argv[1], { busyTimeoutMs: 0 });`,
          dbPath,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("close", (code) => resolve({ code, stderr }));
    });
    expect(contender.code).not.toBe(0);
    expect(contender.stderr).toContain("database is locked");
    expect(crashChild.exitCode).toBeNull();

    crashChild.kill("SIGKILL");
    const crashSignal = await new Promise<NodeJS.Signals | null>((resolve) =>
      crashChild.once("exit", (_code, signal) => resolve(signal)),
    );
    expect(crashSignal).toBe("SIGKILL");

    // Process 2: reopen the exact same SQLite file and verify recovery!
    const recoverResult = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(
        process.execPath,
        [
          "--conditions=@fastagent-sh/source",
          "--input-type=module",
          "-e",
          workerScript,
          dbPath,
          effectFile,
          "recover",
          ids.sessionId,
          ids.runningId,
          ids.q1Id,
          ids.q2Id,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });

    expect(recoverResult.code, recoverResult.stderr).toBe(0);
    const recovered = JSON.parse(recoverResult.stdout.trim()) as {
      r: { status: string; answer?: { text: string } };
      m1: { status: string; answer?: { text: string } };
      m2: { status: string; answer?: { text: string } };
    };
    expect(recovered.r).toMatchObject({ status: "completed", answer: { text: "answer: mark" } });
    expect(recovered.m1).toMatchObject({ status: "completed", answer: { text: "answer: after-1" } });
    expect(recovered.m2).toMatchObject({ status: "completed", answer: { text: "answer: after-2" } });
    // Interrupted side-effecting tool MUST NOT have re-executed after SIGKILL.
    expect(Number(readFileSync(effectFile, "utf8").trim())).toBe(1);
  });
});
