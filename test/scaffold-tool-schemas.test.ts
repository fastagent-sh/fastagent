import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The string formats OpenAI's strict tool schemas accept
 * (https://platform.openai.com/docs/guides/structured-outputs#supported-properties). Any other `format` fails the
 * whole request ("'uri' is not a valid format"), and pi-ai's strict check does not catch it for OpenAI, so a
 * scaffolded tool using one (`z.url()` emits `uri`) breaks every turn on that provider.
 */
const OPENAI_STRICT_FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "ipv4",
  "ipv6",
  "uuid",
]);

const SRC = new URL("../src/", import.meta.url).pathname;

/** Every code tool a scaffold writes into an agent: each channel bundle's companion tools (`scaffoldCompanionTools`). */
function scaffoldedTools(): string[] {
  const channels = join(SRC, "channels");
  return readdirSync(channels, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(channels, entry.name, "scaffold"))
    .filter((scaffold) => existsSync(scaffold))
    .flatMap((scaffold) =>
      readdirSync(scaffold)
        .filter((file) => file.endsWith(".ts") && !file.startsWith("channel."))
        .map((file) => join(scaffold, file)),
    );
}

function formats(schema: unknown): string[] {
  if (Array.isArray(schema)) return schema.flatMap(formats);
  if (typeof schema !== "object" || schema === null) return [];
  return Object.entries(schema).flatMap(([key, value]) =>
    key === "format" && typeof value === "string" ? [value] : formats(value),
  );
}

describe("scaffolded tools", () => {
  it("use no string format a provider's strict tool schema rejects", async () => {
    const files = scaffoldedTools();
    // The list is read from disk; pin that it found what it is about, so an emptied list cannot pass.
    expect(files.map((file) => file.split("/").at(-1)).sort()).toEqual([
      "feishu-send.ts",
      "feishu-threads.ts",
      "lark-send.ts",
      "lark-threads.ts",
      "slack-send.ts",
      "slack-threads.ts",
      "telegram-send.ts",
    ]);
    const offending: string[] = [];
    for (const file of files) {
      const tool = (await import(file)).default as { parameters: unknown };
      const rejected = formats(tool.parameters).filter((format) => !OPENAI_STRICT_FORMATS.has(format));
      if (rejected.length > 0) offending.push(`${file.slice(SRC.length)}: ${rejected.join(", ")}`);
    }
    expect(offending).toEqual([]);
  });
});
