import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chunkSlackMarkdown, chunkSlackText, createSlackApi } from "../src/channels/slack/slack-api.ts";

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Slack Web API transport", () => {
  it("gates success on ok:true and names the Slack method/error details", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({
        ok: false,
        error: "invalid_arguments",
        needed: "files:read",
        response_metadata: { messages: ["[ERROR] missing required field: file"] },
      }),
    );
    const api = createSlackApi({ botToken: "x", baseUrl: "https://slack.test/api" });
    await expect(api.fileInfo("F1")).rejects.toThrow(
      /files\.info.*invalid_arguments.*files:read.*missing required field: file/,
    );
  });

  it("calls files.info with its required GET query argument and bearer token", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ ok: true, file: { id: "F 1/+", mimetype: "image/png" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = createSlackApi({ botToken: "xoxb-secret", baseUrl: "https://slack.test/api" });

    await expect(api.fileInfo("F 1/+")).resolves.toMatchObject({ id: "F 1/+" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [input, init] = fetchMock.mock.calls[0] ?? [];
    const url = new URL(String(input));
    expect(url.pathname).toBe("/api/files.info");
    expect(url.searchParams.get("file")).toBe("F 1/+");
    expect(init).toMatchObject({ method: "GET" });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer xoxb-secret");
    expect(init?.body).toBeUndefined();
  });

  it("uses standard Markdown and Slack's native Agent stream protocol", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const method = String(input).split("/").pop();
      return Response.json({
        ok: true,
        ...(method === "chat.startStream" || method === "chat.postMessage" ? { ts: "1.0" } : {}),
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = createSlackApi({ botToken: "x", baseUrl: "https://slack.test/api" });
    const target = {
      channelId: "C1",
      threadTs: "9.0",
      recipientUserId: "U1",
      recipientTeamId: "T1",
    };

    await expect(api.postMarkdown(target, "**bold**")).resolves.toBe("1.0");
    const streamTs = await api.startStream(target, { markdownText: "# Answer" });
    await api.appendStream("C1", streamTs, {
      chunks: [{ type: "task_update", id: "tool-1", title: "search", status: "in_progress" }],
    });
    await api.stopStream("C1", streamTs);
    await api.setThreadStatus(target, "is working…");
    await api.setThreadTitle(target, "A useful title");

    const calls = fetchMock.mock.calls.map(([input, init]) => ({
      method: String(input).split("/").pop(),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    }));
    expect(calls[0]).toMatchObject({
      method: "chat.postMessage",
      body: { markdown_text: "**bold**", thread_ts: "9.0" },
    });
    expect(calls[1]).toMatchObject({
      method: "chat.startStream",
      body: {
        chunks: [{ type: "markdown_text", text: "# Answer" }],
        thread_ts: "9.0",
        recipient_user_id: "U1",
        recipient_team_id: "T1",
        task_display_mode: "plan",
      },
    });
    expect(calls[2]?.body).toMatchObject({
      chunks: [{ type: "task_update", id: "tool-1", title: "search", status: "in_progress" }],
    });
    expect(calls.map((call) => call.method)).toEqual([
      "chat.postMessage",
      "chat.startStream",
      "chat.appendStream",
      "chat.stopStream",
      "assistant.threads.setStatus",
      "assistant.threads.setTitle",
    ]);
  });

  it("honours Retry-After for 429 and then succeeds", async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return calls === 1
        ? Response.json({ ok: false, error: "ratelimited" }, { status: 429, headers: { "retry-after": "1" } })
        : Response.json({ ok: true, ts: "2.0" });
    });
    const api = createSlackApi({ botToken: "x", baseUrl: "https://slack.test/api" });
    const pending = api.postMessage({ channelId: "C1" }, "hi");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toBe("2.0");
    expect(calls).toBe(2);
  });

  it("downloads authenticated Slack-hosted bytes, creates vision refs, and writes ordinary files", async () => {
    const calls: { url: string; authorization?: string }[] = [];
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") ?? undefined });
      if (String(input).includes("image")) {
        return new Response(Buffer.from("png"), { headers: { "content-type": "image/png", "content-length": "3" } });
      }
      return new Response(Buffer.from("report"), { headers: { "content-type": "text/plain" } });
    });
    const api = createSlackApi({ botToken: "xoxb-secret" });
    const image = await api.fetchImage({
      id: "F1",
      mimetype: "image/png",
      url_private: "https://files.slack.com/image",
    });
    expect(image).toEqual({ mimeType: "image/png", data: Buffer.from("png").toString("base64") });

    const root = mkdtempSync(join(tmpdir(), "fa-slack-files-"));
    roots.push(root);
    mkdirSync(root, { recursive: true });
    const file = await api.fetchFile(
      { id: "F2", name: "../report.txt", mimetype: "text/plain", url_private_download: "https://files.slack.com/file" },
      "C1",
      root,
    );
    expect(file.path).toBe(join(root, "C1", "F2-__report.txt"));
    expect(readFileSync(file.path, "utf8")).toBe("report");
    expect(calls.every((call) => call.authorization === "Bearer xoxb-secret")).toBe(true);
  });

  it("refuses external/non-Slack download hosts and metadata above the 20 MB cap", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const api = createSlackApi({ botToken: "x" });
    await expect(
      api.fetchFile({ id: "F1", name: "x", url_private: "https://evil.example/file" }, "C1", "/tmp"),
    ).rejects.toThrow(/non-Slack file URL/);
    await expect(
      api.fetchFile(
        { id: "F2", name: "x", size: 21 * 1024 * 1024, url_private: "https://files.slack.com/x" },
        "C1",
        "/tmp",
      ),
    ).rejects.toThrow(/too large/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Slack text splitting", () => {
  it("preserves Unicode code points and prefers newline boundaries", () => {
    expect(chunkSlackText("😀😀😀", 2)).toEqual(["😀😀", "😀"]);
    expect(chunkSlackText("abc\ndef", 5)).toEqual(["abc\n", "def"]);
    expect(chunkSlackText("abc\ndef", 5).join("")).toBe("abc\ndef");
  });

  it("balances fenced code blocks when standard Markdown continues in another message", () => {
    const markdown = `Before\n\n\`\`\`ts\n${"const value = 1;\n".repeat(40)}\`\`\`\n\nAfter`;
    const chunks = chunkSlackMarkdown(markdown, 300);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => Array.from(chunk).length <= 300)).toBe(true);
    expect(chunks.every((chunk) => (chunk.match(/```/g)?.length ?? 0) % 2 === 0)).toBe(true);
    expect(chunks.join("\n")).toContain("After");
  });
});
