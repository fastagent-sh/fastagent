import * as EffectSchema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { defineTool } from "@fastagent-sh/fastagent";
import {
  MemoryDshEventStore,
  buildDshSandboxPolicy,
  openDshAgent,
  toDshToolDefinition,
} from "@fastagent-sh/harness-dsh";

describe("@fastagent-sh/harness-dsh skeleton contracts", () => {
  it("MemoryDshEventStore enforces single-writer fencing, contiguous seqs, concurrent readers, and reopen", async () => {
    const store = new MemoryDshEventStore();
    const header = { version: 4, id: "s-1", createdAt: 1_700_000_000_000, isSeeded: false };
    const writer = await store.create(header);

    // Concurrent write open is refused; concurrent read open succeeds.
    await expect(store.open("s-1", "write")).rejects.toThrow(/already owned by another writer/);
    const reader = await store.open("s-1", "read");
    await expect(reader.append([{ seq: 0, type: "turn/start" }])).rejects.toThrow(/read-only/);

    // Non-contiguous seq is refused without partial mutation.
    await expect(writer.append([{ seq: 1, type: "turn/start" }])).rejects.toThrow(/expected contiguous seq 0/);
    await writer.append([
      { seq: 0, type: "turn/start", data: { turn: 1 } },
      { seq: 1, type: "turn/end", data: { turn: 1 } },
    ]);
    expect((await reader.read(0)).events.map((e) => e.type)).toEqual(["turn/start", "turn/end"]);
    expect(await store.stat("s-1")).toMatchObject({ eventCount: 2, revision: "2" });

    // Closing the writer releases ownership so a new writer can reopen.
    await writer.close();
    await expect(writer.read(0)).rejects.toThrow(/is closed/);
    const reopened = await store.open("s-1", "write");
    await reopened.append([{ seq: 2, type: "turn/start", data: { turn: 2 } }]);
    expect((await store.list())[0]?.eventCount).toBe(3);
    await reopened.close();
    await reader.close();
  });

  it("toDshToolDefinition bridges FastAgent defineTool (Standard JSON Schema v1) into DSH tool contract", async () => {
    const struct = EffectSchema.Struct({
      name: EffectSchema.String,
    });
    const schema = {
      ...EffectSchema.toStandardJSONSchemaV1(struct),
      "~standard": {
        ...EffectSchema.toStandardJSONSchemaV1(struct)["~standard"],
        ...EffectSchema.toStandardSchemaV1(struct)["~standard"],
      },
    };
    const fastAgentTool = defineTool({
      name: "greet",
      description: "Greet a person",
      parameters: schema,
      execute: async ({ name }) => `Hello, ${name}!`,
    });

    const bridged = toDshToolDefinition(fastAgentTool);
    expect(bridged.name).toBe("greet");
    expect(bridged.parameters).toMatchObject({ type: "object", required: ["name"] });

    const out = await bridged.execute({ name: "Ada" }, { signal: new AbortController().signal });
    expect(out).toEqual({ text: "Hello, Ada!" });
    expect(bridged.output.render(out)).toEqual([{ type: "text", text: "Hello, Ada!" }]);

    const bad = await bridged.execute({ name: 123 }, { signal: new AbortController().signal });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("Invalid arguments");
  });

  it("buildDshSandboxPolicy produces fail-closed policies for workspace, read-only, and off modes", () => {
    expect(buildDshSandboxPolicy({ workdir: "/srv/agent", mode: "off" })).toBeUndefined();
    expect(buildDshSandboxPolicy({ workdir: "/srv/agent" })).toEqual({
      workspace: "/srv/agent",
      writablePaths: ["/srv/agent"],
      readablePaths: ["/srv/agent"],
      network: "none",
    });
    expect(buildDshSandboxPolicy({ workdir: "/srv/agent", mode: "read-only", network: true })).toEqual({
      workspace: "/srv/agent",
      writablePaths: [],
      readablePaths: ["/srv/agent"],
      network: "allow",
    });
    expect(() => buildDshSandboxPolicy({ workdir: "relative/dir" })).toThrow(/must be an absolute path/);
  });

  it("openDshAgent validates options up front and reports unavailable until Phase 1 runtime wiring", async () => {
    await expect(openDshAgent({ name: "", workdir: "/srv/agent" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(openDshAgent({ name: "demo", workdir: "relative" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(openDshAgent({ name: "demo", workdir: "/srv/agent" })).rejects.toMatchObject({
      code: "unavailable",
      retryable: false,
    });
  });
});
