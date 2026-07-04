import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultTelegramRoute,
  type TelegramUpdate,
  telegramChannel as buildTelegramChannel,
  telegramEnvelope,
} from "../src/telegram.ts";
import { callApi, chunkText, resolveImages, sendMessage } from "../src/channels/telegram/telegram-api.ts";
import type { Agent, AgentEvent, Prompt, Scope } from "../src/index.ts";

/** A faux Agent that records each invocation's prompt and replies with `reply`. */
function replyingAgent(reply = "") {
  const calls: Prompt[] = [];
  const agent: Agent = {
    async *invoke(_scope: Scope, prompt: Prompt): AsyncIterable<AgentEvent> {
      calls.push(prompt);
      if (reply !== "") yield { type: "text", delta: reply };
      yield { type: "completed" };
    },
  };
  return { agent, calls };
}

/** Let fire-and-forget turns (started after the 200) run before asserting. The streaming flow has
 *  several hops, so rather than couple to a fixed tick count, settle until the Bot API mock goes quiet
 *  (no new fetch for a full tick) — robust to adding/removing an await. (Real-timer tests only; the
 *  fake-timer tests drive their own clock with advanceTimersByTimeAsync.) */
const flush = async () => {
  const f = globalThis.fetch as unknown as { mock?: { calls: unknown[] } };
  let prev = -1;
  for (let i = 0; i < 100 && (f.mock?.calls.length ?? 0) !== prev; i++) {
    prev = f.mock?.calls.length ?? 0;
    await new Promise((r) => setImmediate(r));
  }
};

const SECRET = "tg-secret";
const API = "http://tg.test";
const act = () => ({}); // route: always answer, all defaults
const ignore = () => null; // route: never answer

function tgRequest(update: unknown, opts: { secret?: string } = {}): Request {
  return new Request("http://app/telegram", {
    method: "POST",
    body: JSON.stringify(update),
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": opts.secret ?? SECRET },
  });
}

const MSG: TelegramUpdate = { update_id: 5, message: { message_id: 1, text: "hi", chat: { id: 42, type: "private" } } };
const callsTo = (m: ReturnType<typeof vi.fn>, method: string) =>
  m.mock.calls.filter((c) => String(c[0]).endsWith(`/${method}`)) as [string, RequestInit][];
const bodyOf = (call: [string, RequestInit] | undefined) => {
  if (!call) throw new Error("expected a matching fetch call");
  return JSON.parse(String(call[1].body));
};

/** Bot API fetch mock: sendMessage returns a message_id (so the channel edits its ONE preview message),
 *  getMe returns a username, everything else is ok. */
function okFetch() {
  let id = 100;
  return vi.fn(async (url: string) => {
    const method = String(url).split("/").pop();
    if (method === "getMe")
      return new Response(JSON.stringify({ ok: true, result: { username: "mybot" } }), { status: 200 });
    const result = method === "sendMessage" ? { message_id: id++ } : {};
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const d of stateDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fresh throwaway state dir (cleaned up in afterEach). */
const stateDirs: string[] = [];
const freshStateDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "tg-state-"));
  stateDirs.push(d);
  return d;
};

/** telegramChannel with an isolated default stateDir, so tests never write the repo's `.fastagent`.
 *  Persistence tests pass an explicit shared `stateDir` to simulate a restart. */
const telegramChannel: typeof buildTelegramChannel = (agent, opts) =>
  buildTelegramChannel(agent, { stateDir: freshStateDir(), ...opts });

describe("chunkText (HTML-aware split)", () => {
  it("returns one chunk under the limit, and prefers a newline boundary over it", () => {
    expect(chunkText("short")).toEqual(["short"]);
    const long = `${"a".repeat(4000)}\n${"b".repeat(200)}`; // > 4096 with a newline before the limit
    expect(chunkText(long)).toEqual(["a".repeat(4000), "b".repeat(200)]);
  });

  it("(html) closes a tag that spans a boundary and reopens it, so every chunk is valid, size-capped HTML", () => {
    const code = "line\n".repeat(1300); // ~6500 chars → forced split, inside one <pre>
    const chunks = chunkText(`<pre>${code}</pre>`, { html: true });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(4096);
      expect(c.startsWith("<pre>")).toBe(true); // reopened at the head
      expect(c.endsWith("</pre>")).toBe(true); // closed at the tail
    }
    // the code survives LOSSLESSLY — strip each chunk's <pre>…</pre> wrapper and rejoin; boundary newlines
    // (content inside <pre>) are preserved, so this reconstructs the original exactly
    const rejoined = chunks.map((c) => c.slice(5, -6)).join("");
    expect(rejoined).toBe(code);
  });

  it("(html) balances NESTED tags across a boundary in the correct order (close innermost, reopen outermost)", () => {
    const code = "print(x)\n".repeat(700); // > 4096 inside <pre><code> — the real fenced-code-with-language shape
    const wrapped = `<pre><code class="language-python">${code}</code></pre>`;
    const chunks = chunkText(wrapped, { html: true });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(4096);
      expect(c.startsWith('<pre><code class="language-python">')).toBe(true); // reopen outermost-first, attrs kept
      expect(c.endsWith("</code></pre>")).toBe(true); // close innermost-first
    }
    const openLen = '<pre><code class="language-python">'.length;
    const rejoined = chunks.map((c) => c.slice(openLen, -"</code></pre>".length)).join("");
    expect(rejoined).toBe(code); // lossless
  });

  it("(html) reopens a spanning tag WITH its attributes", () => {
    const long = `<a href="https://example.com/x">${"word ".repeat(1200)}</a>`; // link text > 4096
    const chunks = chunkText(long, { html: true });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c).toContain('href="https://example.com/x"'); // attr preserved on each chunk
  });

  it("(html) backs the cut up before a tag token that straddles the boundary", () => {
    const long = `${"a".repeat(4030)}<b>${"c".repeat(300)}</b>`; // the `<b>` straddles the ~4032 cut
    const chunks = chunkText(long, { html: true });
    expect(chunks[0]).toBe("a".repeat(4030)); // cut BEFORE the `<b`, not mid-token
    expect(chunks[1]?.startsWith("<b>")).toBe(true); // the whole tag moved to the next chunk
    for (const c of chunks) expect(/<[a-z]*$/i.test(c)).toBe(false); // no chunk ends with a partial tag
  });

  it("(html) does not cut through an HTML entity that straddles the boundary", () => {
    const long = `<pre>${"a".repeat(4025)}&amp;${"b".repeat(300)}</pre>`; // `&amp;` straddles the ~4032 cut
    const chunks = chunkText(long, { html: true });
    expect(chunks.some((c) => c.includes("&amp;"))).toBe(true); // intact somewhere, never `&am` | `p;`
    // no chunk ends with a dangling `&…` (ignoring the appended `</…>` closer)
    expect(chunks.some((c) => /&[a-z#0-9]*$/i.test(c.replace(/<\/[a-z]+>$/i, "")))).toBe(false);
  });

  it("(html) does not back up to a raw `&` inside a tag token (an href with query params)", () => {
    // The tag ends just before the ~4032 cut; the href's `&` (no `;`) sits within 12 chars of the cut —
    // an unguarded entity back-up would move the cut INTO the tag (`…?a` | `&b">…` debris).
    const tag = '<a href="https://x.com/?a&b">';
    const long = `${"a".repeat(4000)}${tag}link</a>${"c".repeat(300)}`;
    const chunks = chunkText(long, { html: true });
    expect(chunks[0]).toContain(tag); // the tag survives intact, `&` and all
    expect(chunks.every((c) => !/<[^>]*$/.test(c))).toBe(true); // no chunk ends inside a tag token
  });

  it("(html) progresses — no empty chunk / infinite loop — on an unclosed `<` at the head", () => {
    const long = `<${"a".repeat(6000)}`; // a lone `<` then a huge run, never closed
    const chunks = chunkText(long, { html: true });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length > 0)).toBe(true); // terminates, no empty chunk
  });

  it("(plain) ignores tags — a `<` is literal content, split at the limit", () => {
    const chunks = chunkText("a".repeat(4200)); // no html, no newline
    expect(chunks.length).toBe(2);
    expect(chunks[0]?.length).toBe(4096);
  });
});

describe("sendMessage HTML fallback", () => {
  it("re-chunks the whole body as plain when the first HTML chunk is rejected (no leaked boundary tags)", async () => {
    const sent: { text: string; parse_mode?: string }[] = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body));
      if (String(url).endsWith("/sendMessage")) {
        sent.push({ text: b.text, parse_mode: b.parse_mode });
        if (b.parse_mode === "HTML")
          return new Response(JSON.stringify({ ok: false, description: "can't parse entities" }), { status: 400 });
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const long = `<pre>${"a".repeat(5000)}</pre>`; // > 4096, spans → balancer injects boundary <pre>/</pre>
    await sendMessage(API, "BOT", { chatId: 42 }, long, { html: true });
    // after the HTML rejection everything is resent as PLAIN, re-chunked from the ORIGINAL — the injected
    // boundary tags are gone, so the plain parts reconstruct the original exactly (no leaked <pre></pre>)
    const plain = sent.filter((s) => s.parse_mode === undefined).map((s) => s.text);
    expect(plain.length).toBeGreaterThan(0);
    expect(plain.join("")).toBe(long);
  });

  it("resends only the failing LATER chunk as plain, same bytes (boundary tags leak — the named trade-off)", async () => {
    const sent: { text: string; parse_mode?: string }[] = [];
    let htmlSends = 0;
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body));
      if (String(url).endsWith("/sendMessage")) {
        sent.push({ text: b.text, parse_mode: b.parse_mode });
        // Only the SECOND HTML chunk fails to parse (first parsed cleanly — no whole-body restart).
        if (b.parse_mode === "HTML" && ++htmlSends === 2)
          return new Response(JSON.stringify({ ok: false, description: "can't parse entities" }), { status: 400 });
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const long = `<pre>${"a".repeat(5000)}</pre>`; // spans → balancer injects boundary </pre> / <pre>
    await sendMessage(API, "BOT", { chatId: 42 }, long, { html: true });
    const plain = sent.filter((s) => s.parse_mode === undefined);
    const secondHtml = sent.filter((s) => s.parse_mode === "HTML")[1];
    expect(plain.length).toBe(1); // ONLY the failing chunk is resent — no whole-body restart
    expect(plain[0]?.text).toBe(secondHtml?.text); // byte-for-byte, injected boundary <pre> included
    expect(plain[0]?.text.startsWith("<pre>")).toBe(true); // the frozen trade-off: the tag leaks as literal text
  });
});

// The transport invariants are tested ONCE, against the single pipeline (callApi) they live in — not
// per method: per-method transport behavior does not exist by construction.
describe("callApi transport pipeline", () => {
  const ok = (result: unknown = {}) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });

  it("carries a 30s timeout signal on every call (a wedged connection can't hang the turn)", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ok());
    vi.stubGlobal("fetch", fetchMock);
    await callApi(API, "BOT", "getMe", {});
    // Pin the MECHANISM, not just "some signal": the signal fetch received is the one
    // AbortSignal.timeout produced — a never-firing plain signal would pass an instanceof check.
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(timeoutSpy.mock.results[0]?.value);
  });

  it("retries a 429 after the server's retry_after — and actually WAITS, not hammers", async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        if (calls === 1)
          return new Response(JSON.stringify({ ok: false, parameters: { retry_after: 2 } }), { status: 429 });
        return ok({ username: "bot" });
      }),
    );
    const p = callApi(API, "BOT", "getMe", {});
    await vi.advanceTimersByTimeAsync(1000); // before (retry_after 2 + 1) s elapses…
    expect(calls).toBe(1); // …it is waiting, not retrying immediately
    await vi.advanceTimersByTimeAsync(2100); // past the wait
    expect((await p).username).toBe("bot");
    expect(calls).toBe(2);
  });

  it("retries a 429 WITHOUT retry_after with a short backoff", async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        if (calls === 1) return new Response(JSON.stringify({ ok: false }), { status: 429 }); // no parameters
        return ok();
      }),
    );
    const p = callApi(API, "BOT", "getMe", {});
    await vi.advanceTimersByTimeAsync(1000); // before the (attempt 0 → 1 + 1) s backoff elapses…
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1100);
    await p;
    expect(calls).toBe(2);
  });

  it("fails fast on a flood ban whose retry_after exceeds the wait cap (no silent hour-long park)", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ ok: false, description: "Too Many Requests", parameters: { retry_after: 3600 } }),
          { status: 429 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const t0 = Date.now();
    // The error self-describes the transport's own decision (not just the server's text).
    await expect(callApi(API, "BOT", "getMe", {})).rejects.toThrow(/exceeds the \d+s flood-wait cap/);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1); // and did not burn retries on it either
  });

  it("gives up after exhausting 429 retries — bounded, and the error says it retried", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, description: "Too Many Requests", parameters: { retry_after: 0 } }), {
          status: 429,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const p = callApi(API, "BOT", "getMe", {});
    const rejection = expect(p).rejects.toThrow(/Too Many Requests \(gave up after 3 retries\)/);
    await vi.advanceTimersByTimeAsync(3500); // three (0+1)s waits, then the 4th attempt fails for good
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(4); // bounded — not an infinite hammer
  });

  it("names the failing method when the transport throws (timeout/network)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }),
    );
    await expect(callApi(API, "BOT", "sendMessage", {})).rejects.toThrow(/telegram sendMessage: .*TimeoutError/);
  });

  it("a mid-body timeout throws named — never a silent fake success", async () => {
    // 200 arrives, but reading the body times out. A `.json().catch(() => ({}))` would turn this into a
    // fake success with no message_id; it must surface as a named transport failure.
    const res = {
      ok: true,
      status: 200,
      text: async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
    } as unknown as Response;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => res),
    );
    await expect(callApi(API, "BOT", "sendMessage", {})).rejects.toThrow(/telegram sendMessage: .*TimeoutError/);
  });

  it("a 200 with a non-JSON body (a proxy's error page) is a named failure, not a fake success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>gateway error</html>", { status: 200 })),
    );
    await expect(callApi(API, "BOT", "sendMessage", {})).rejects.toThrow(
      /telegram sendMessage failed: 200 Bot API response was not the expected JSON/,
    );
  });
});

describe("file download (the one non-JSON call)", () => {
  it("carries the 120s download timeout (same mechanism pin as the pipeline)", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).endsWith("/getFile"))
        return new Response(JSON.stringify({ ok: true, result: { file_path: "photos/x.jpg", file_size: 3 } }), {
          status: 200,
        });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const images = await resolveImages(API, "BOT", ["f1"]);
    expect(images?.length).toBe(1);
    expect(timeoutSpy).toHaveBeenCalledWith(120_000);
    const download = fetchMock.mock.calls.find((c) => String(c[0]).includes("/file/"));
    const produced = timeoutSpy.mock.results[timeoutSpy.mock.calls.findIndex((c) => c[0] === 120_000)];
    expect(download?.[1]?.signal).toBe(produced?.value);
  });

  it("names a failing download", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/getFile"))
        return new Response(JSON.stringify({ ok: true, result: { file_path: "photos/x.jpg" } }), { status: 200 });
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(resolveImages(API, "BOT", ["f1"])).rejects.toThrow(/telegram file download: .*TimeoutError/);
  });
});

describe("durable group buffer (single-process restarts)", () => {
  const okFetch = () =>
    vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }));
  const group = (id: number, text: string) => ({
    update_id: id,
    message: {
      message_id: id,
      text,
      chat: { id: -100, type: "supergroup" },
      from: { id: 7, username: "alice" },
    },
  });
  // Summon on "@go …" — an explicit route keeps these tests independent of bot-identity resolution.
  const route = (u: TelegramUpdate) =>
    (u.message as { text?: string } | undefined)?.text?.startsWith("@go") ? {} : null;

  it("the group buffer is persisted BEFORE the ACK and survives a restart", async () => {
    vi.stubGlobal("fetch", okFetch());
    const state = freshStateDir();
    const a1 = replyingAgent("first");
    const ch1 = telegramChannel(a1.agent, { secretToken: SECRET, botToken: "1:A", route, stateDir: state });
    expect((await ch1(tgRequest(group(1, "the deploy is broken")))).status).toBe(200);
    // durable by the time the 200 exists — an ACKed update is never redelivered
    const onDisk = JSON.parse(readFileSync(join(state, "buffers.json"), "utf8")) as Record<string, unknown[]>;
    expect(onDisk["-100"]?.length).toBe(1);
    expect(readFileSync(join(state, ".gitignore"), "utf8")).toBe("*\n"); // the state home self-ignores
    // "restart": a NEW channel instance over the same state dir
    const a2 = replyingAgent("second");
    const ch2 = telegramChannel(a2.agent, { secretToken: SECRET, botToken: "1:A", route, stateDir: state });
    await ch2(tgRequest(group(2, "@go what broke?")));
    await flush();
    expect(String(a2.calls[0]?.text)).toContain("the deploy is broken"); // folded from the RELOADED buffer
  });

  it("a FAILED turn keeps the folded discussion — the next summon re-folds it (commit on completed only)", async () => {
    vi.stubGlobal("fetch", okFetch());
    const state = freshStateDir();
    let fail = true;
    const calls: Prompt[] = [];
    const agent: Agent = {
      async *invoke(_s: Scope, p: Prompt): AsyncIterable<AgentEvent> {
        calls.push(p);
        if (fail) {
          yield { type: "failed", details: "boom", retryable: true };
          return;
        }
        yield { type: "completed" };
      },
    };
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "1:A", route, stateDir: state });
    await ch(tgRequest(group(1, "important context"))); // un-summoned → buffered
    await ch(tgRequest(group(2, "@go answer"))); // summoned → the turn FAILS
    await flush();
    expect(String(calls[0]?.text)).toContain("important context"); // folded into the failed turn…
    fail = false;
    await ch(tgRequest(group(3, "@go retry")));
    await flush();
    expect(String(calls[1]?.text)).toContain("important context"); // …and STILL there for the retry
  });

  it("a corrupt or wrong-shaped state file degrades to empty — the channel still boots and answers", async () => {
    vi.stubGlobal("fetch", okFetch());
    const state = freshStateDir();
    // buffers.json: syntactically valid JSON of the WRONG SHAPE — must degrade to empty, not boot-fail
    writeFileSync(join(state, "buffers.json"), JSON.stringify(["not", "a", "record"]));
    const { agent, calls } = replyingAgent("ok");
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "1:A", route: () => ({}), stateDir: state });
    await ch(tgRequest(group(1, "hello")));
    await flush();
    expect(calls.length).toBe(1); // works, with empty state (the warn is in the operator log)
  });
});

describe("buffered attachments (files/photos from un-summoned discussion)", () => {
  const route = (u: TelegramUpdate) =>
    (u.message as { text?: string } | undefined)?.text?.startsWith("@go") ? {} : null;
  const attachFetch = () => {
    const gotFiles: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body && typeof init.body === "string" ? (JSON.parse(init.body) as { file_id?: string }) : {};
        if (String(url).endsWith("/getFile")) {
          gotFiles.push(body.file_id ?? "");
          return new Response(
            JSON.stringify({ ok: true, result: { file_path: `docs/${body.file_id}.pdf`, file_size: 3 } }),
            { status: 200 },
          );
        }
        if (String(url).includes("/file/bot")) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }),
    );
    return gotFiles;
  };
  const group = { id: -100, type: "supergroup" };
  const doc = (id: number, name: string) => ({
    update_id: id,
    message: {
      message_id: id,
      caption: "here",
      document: { file_id: name, file_name: `${name}.pdf` },
      chat: group,
      from: { id: 7, username: "alice" },
    },
  });
  const summon = (id: number, text: string) => ({
    update_id: id,
    message: { message_id: id, text, chat: group, from: { id: 8, username: "bob" } },
  });
  // File resolution interleaves fs work between fetches, which can outlast flush()'s quiet window.
  const until = async (cond: () => boolean): Promise<void> => {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  };

  it("a file posted WITHOUT summoning is downloadable by the next summon", async () => {
    const got = attachFetch();
    const { agent, calls } = replyingAgent("ok");
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "1:A", route });
    await ch(tgRequest(doc(1, "report"))); // un-summoned → only buffered, nothing downloaded
    expect(got).toEqual([]);
    await ch(tgRequest(summon(2, "@go summarize the file from earlier")));
    await until(() => calls.length > 0);
    expect(got).toEqual(["report"]); // downloaded at summon time
    const text = String(calls[0]?.text);
    expect(text).toMatch(/report\.pdf \(from @alice, msg 1, earlier discussion\)/); // attributed: "the file ALICE sent" resolves
    expect(text).toMatch(/attached files/);
  });

  it("a photo posted without summoning becomes a vision input on the next summon", async () => {
    attachFetch();
    const { agent, calls } = replyingAgent("ok");
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "1:A", route });
    const photo = {
      update_id: 1,
      message: {
        message_id: 1,
        caption: "look at this",
        photo: [{ file_id: "p1", file_unique_id: "u", width: 1, height: 1 }],
        chat: group,
        from: { id: 7, username: "alice" },
      },
    };
    await ch(tgRequest(photo));
    await ch(tgRequest(summon(2, "@go what was in that picture?")));
    await flush();
    expect(calls[0]?.images?.length).toBe(1); // the earlier photo rides along as vision input
  });

  it("caps buffered files at the most recent few", async () => {
    const got = attachFetch();
    const agentRef = replyingAgent("ok");
    const { agent } = agentRef;
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "1:A", route });
    for (let i = 1; i <= 5; i++) await ch(tgRequest(doc(i, `f${i}`)));
    await ch(tgRequest(summon(9, "@go the files?")));
    await until(() => got.length >= 3);
    await flush(); // settle — if the cap were broken, the extra downloads would land here
    expect(got).toEqual(["f3", "f4", "f5"]); // most recent three — not all five
    const { calls } = agentRef;
    await until(() => calls.length > 0);
    expect(String(calls[0]?.text)).toContain("2 attachment(s) from the earlier discussion are not loaded"); // cap-skipped ones are VISIBLE
  });

  it("a failed buffered download degrades PER FILE — the stale one is noted, its siblings still load", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body && typeof init.body === "string" ? (JSON.parse(init.body) as { file_id?: string }) : {};
        if (String(url).endsWith("/getFile")) {
          if (body.file_id === "expired")
            return new Response(JSON.stringify({ ok: false, description: "wrong file_id" }), { status: 400 });
          return new Response(
            JSON.stringify({ ok: true, result: { file_path: `docs/${body.file_id}.pdf`, file_size: 3 } }),
            { status: 200 },
          );
        }
        if (String(url).includes("/file/bot")) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }),
    );
    const { agent, calls } = replyingAgent("still answered");
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "1:A", route });
    await ch(tgRequest(doc(1, "expired")));
    await ch(tgRequest(doc(2, "valid")));
    await ch(tgRequest(summon(3, "@go what were those files?")));
    await until(() => calls.length > 0);
    expect(calls.length).toBe(1); // the agent RAN — a background-context failure does not fail the ask
    const text = String(calls[0]?.text);
    expect(text).toContain("1 attachment(s) from the earlier discussion are not loaded"); // the stale one, counted
    expect(text).toMatch(/valid\.pdf \(from @alice, msg 2, earlier discussion\)/); // …and it did NOT drag its sibling down
  });

  it("a failed buffered PHOTO also degrades — counted in the note, its sibling still lands as vision", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body && typeof init.body === "string" ? (JSON.parse(init.body) as { file_id?: string }) : {};
        if (String(url).endsWith("/getFile")) {
          if (body.file_id === "deadpic")
            return new Response(JSON.stringify({ ok: false, description: "wrong file_id" }), { status: 400 });
          return new Response(
            JSON.stringify({ ok: true, result: { file_path: `pics/${body.file_id}.jpg`, file_size: 3 } }),
            { status: 200 },
          );
        }
        if (String(url).includes("/file/bot")) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }),
    );
    const { agent, calls } = replyingAgent("ok");
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "1:A", route });
    const pic = (id: number, fid: string) => ({
      update_id: id,
      message: {
        message_id: id,
        caption: "pic",
        photo: [{ file_id: fid, file_unique_id: fid, width: 1, height: 1 }],
        chat: group,
        from: { id: 7, username: "alice" },
      },
    });
    await ch(tgRequest(pic(1, "deadpic")));
    await ch(tgRequest(pic(2, "livepic")));
    await ch(tgRequest(summon(3, "@go the pictures?")));
    await until(() => calls.length > 0);
    expect(calls.length).toBe(1); // the ask still ran
    expect(calls[0]?.images?.length).toBe(1); // the sibling photo landed
    expect(String(calls[0]?.text)).toContain("1 attachment(s) from the earlier discussion are not loaded");
  });

  it("a summon REPLYING to a still-buffered attachment downloads it once — not once per set", async () => {
    const got = attachFetch();
    const { agent, calls } = replyingAgent("ok");
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "1:A", route });
    await ch(tgRequest(doc(1, "report"))); // un-summoned → buffered (fileIds carries "report")
    // …then the user REPLIES to that very message to ask about it → primary extraction ALSO sees it
    const replySummon = {
      update_id: 2,
      message: {
        message_id: 2,
        text: "@go summarize this",
        chat: group,
        from: { id: 8, username: "bob" },
        reply_to_message: {
          message_id: 1,
          document: { file_id: "report", file_name: "report.pdf" },
          chat: group,
        },
      },
    };
    await ch(tgRequest(replySummon));
    await until(() => calls.length > 0);
    expect(got).toEqual(["report"]); // downloaded exactly ONCE
    const text = String(calls[0]?.text);
    expect(text.match(/- report\.pdf/g)?.length).toBe(1); // one manifest ENTRY — not primary + buffered twins
    expect(text).not.toContain("(from earlier discussion)"); // primary wins: it is what the user pointed at
  });

  it("the fold annotates message ids and replies, so references resolve", async () => {
    attachFetch();
    const { agent, calls } = replyingAgent("ok");
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "1:A", route });
    const reply = {
      update_id: 3,
      message: {
        message_id: 3,
        text: "agreed",
        chat: group,
        from: { id: 9, username: "carol" },
        reply_to_message: { message_id: 1, chat: group },
      },
    };
    await ch(tgRequest(reply));
    await ch(tgRequest(summon(4, "@go who agreed with what?")));
    await flush();
    expect(String(calls[0]?.text)).toMatch(/@carol \(msg 3, reply to msg 1\): agreed/);
  });
});

describe("queue feedback (⏳ while a session is busy)", () => {
  const recordingFetch = () => {
    const sends: { text: string; id: number; replyTo?: number }[] = [];
    const edits: { message_id: number; text: string }[] = [];
    let nextId = 100;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body
        ? (JSON.parse(String(init.body)) as {
            text?: string;
            message_id?: number;
            reply_parameters?: { message_id?: number };
          })
        : {};
      if (String(url).endsWith("/sendMessage")) {
        const id = nextId++;
        sends.push({ text: body.text ?? "", id, replyTo: body.reply_parameters?.message_id });
        return new Response(JSON.stringify({ ok: true, result: { message_id: id } }), { status: 200 });
      }
      if (String(url).endsWith("/editMessageText") && body.message_id !== undefined)
        edits.push({ message_id: body.message_id, text: body.text ?? "" });
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return { sends, edits };
  };
  const msg = (id: number, text: string) => ({
    update_id: id,
    message: { message_id: id, text, chat: { id: 5, type: "private" } },
  });

  it("a second ask in a busy session gets an immediate ⏳ notice, which its turn then takes over", async () => {
    const { sends, edits } = recordingFetch();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let call = 0;
    const agent: Agent = {
      async *invoke(): AsyncIterable<AgentEvent> {
        if (++call === 1) {
          await gate;
          yield { type: "completed" };
          return;
        }
        yield { type: "text", delta: "answer two" };
        yield { type: "completed" };
      },
    };
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "1:A", route: () => ({}) });
    await ch(tgRequest(msg(1, "first")));
    await flush(); // turn 1 is mid-flight, parked on the gate
    await ch(tgRequest(msg(2, "second")));
    await flush();
    const notice = sends.find((s) => s.text.includes("⏳"));
    expect(notice).toBeDefined(); // the asker heard back WHILE turn 1 was still running
    release();
    await flush();
    // turn 2's live preview + final answer took over the SAME message — the notice morphs, no orphan ⏳
    expect(edits.some((e) => e.message_id === notice?.id && e.text.includes("answer two"))).toBe(true);
    // and turn 2 never sent a second placeholder of its own
    expect(sends.filter((s) => s.text.includes("💭")).length).toBeLessThanOrEqual(1); // only turn 1's
  });

  it("in a group, the ⏳ notice reply-quotes the QUEUED asker — whose ask is waiting is visible", async () => {
    const { sends } = recordingFetch();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let call = 0;
    const agent: Agent = {
      async *invoke(): AsyncIterable<AgentEvent> {
        if (++call === 1) {
          await gate;
        }
        yield { type: "completed" };
      },
    };
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "1:A", route: () => ({}) });
    const g = (id: number, text: string, from: string) => ({
      update_id: id,
      message: { message_id: id, text, chat: { id: -100, type: "supergroup" }, from: { id, username: from } },
    });
    await ch(tgRequest(g(11, "first ask", "alice")));
    await flush();
    await ch(tgRequest(g(22, "second ask", "bob")));
    await flush();
    const notice = sends.find((s) => s.text.includes("⏳"));
    expect(notice?.replyTo).toBe(22); // quoted to BOB's message — not alice's, not unquoted
    release();
  });

  it("an idle session gets no ⏳ notice", async () => {
    const { sends } = recordingFetch();
    const { agent } = replyingAgent("hi");
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "1:A", route: () => ({}) });
    await ch(tgRequest(msg(1, "hello")));
    await flush();
    expect(sends.some((s) => s.text.includes("⏳"))).toBe(false);
  });
});

describe("defaultTelegramRoute + telegramEnvelope", () => {
  it("answers a private message; a group only on a mention ENTITY naming the bot or reply-to-bot, not a slash command", () => {
    expect(defaultTelegramRoute(MSG)).toEqual({}); // private → act
    const group = { id: -100, type: "supergroup" };
    const g = (text: string) => ({ update_id: 1, message: { message_id: 2, text, chat: group } });
    // A message whose text carries a server-parsed `mention` entity — the shape Telegram actually sends.
    const gm = (text: string, mention: string) => ({
      update_id: 1,
      message: {
        message_id: 2,
        text,
        entities: [{ type: "mention", offset: text.indexOf(mention), length: mention.length }],
        chat: group,
      },
    });
    expect(defaultTelegramRoute(g("chatter"))).toBeNull();
    // a group slash command does not summon — bare, or directed (its entity is bot_command, not mention)
    expect(defaultTelegramRoute(g("/ask"))).toBeNull();
    const directed = {
      update_id: 1,
      message: {
        message_id: 2,
        text: "/ask@mybot",
        entities: [{ type: "bot_command", offset: 0, length: 10 }],
        chat: group,
      },
    };
    expect(defaultTelegramRoute(directed, { botUsername: "mybot" })).toBeNull();
    const mention = gm("hey @mybot", "@mybot");
    expect(defaultTelegramRoute(mention)).toBeNull(); // no username → no @mention summon
    expect(defaultTelegramRoute(mention, { botUsername: "mybot" })).toEqual({});
    expect(defaultTelegramRoute(mention, { botUsername: "@mybot" })).toEqual({}); // a leading @ in the option is tolerated
    expect(defaultTelegramRoute(gm("yo @MyBot", "@MyBot"), { botUsername: "mybot" })).toEqual({}); // case-insensitive
    // the entity's exact range is compared — a mention of a DIFFERENT user whose name merely starts
    // with ours does not summon (the substring/boundary confusion class, gone by construction)
    expect(defaultTelegramRoute(gm("@mybottington rocks", "@mybottington"), { botUsername: "mybot" })).toBeNull();
    // raw text containing @mybot WITHOUT a mention entity does not summon — Telegram emits no mention
    // entity for a name inside a code block or a URL, so pasted code/links cannot false-summon
    expect(defaultTelegramRoute(g("see @mybot in that snippet"), { botUsername: "mybot" })).toBeNull();
    // a reply to THIS bot summons (no @mention needed); a reply to ANOTHER bot must not
    const reply = (username?: string) => ({
      update_id: 1,
      message: {
        message_id: 2,
        text: "thanks",
        chat: group,
        reply_to_message: { message_id: 1, chat: group, from: { id: 9, is_bot: true, username } },
      },
    });
    expect(defaultTelegramRoute(reply("MyBot"), { botUsername: "mybot" })).toEqual({}); // ours (case-insensitive)
    expect(defaultTelegramRoute(reply("otherbot"), { botUsername: "mybot" })).toBeNull(); // another bot — stay silent
    // the numeric id is the authoritative identity tier: it wins over username in BOTH directions
    expect(defaultTelegramRoute(reply("otherbot"), { botId: 9 })).toEqual({}); // id matches → ours
    expect(defaultTelegramRoute(reply("MyBot"), { botId: 42, botUsername: "mybot" })).toBeNull(); // id ≠ → silent
    // neither id nor username known (a bare route call) → fail CLOSED: "is this a reply to me?" cannot
    // be yes when the caller supplied no identity — otherwise every multi-bot group mis-summons
    expect(defaultTelegramRoute(reply("otherbot"))).toBeNull();
    // a reply to a HUMAN never summons
    const replyToHuman = reply(undefined);
    replyToHuman.message.reply_to_message.from.is_bot = false;
    expect(defaultTelegramRoute(replyToHuman, { botUsername: "mybot" })).toBeNull();
  });

  it("an edited message never summons — in groups or private (no duplicate answer per typo fix)", () => {
    const edited = {
      update_id: 1,
      edited_message: {
        message_id: 2,
        text: "hey @mybot now",
        entities: [{ type: "mention", offset: 4, length: 6 }],
        chat: { id: 5, type: "private" },
      },
    };
    expect(defaultTelegramRoute(edited, { botUsername: "mybot" })).toBeNull();
  });

  it("summons on a media caption @mention too, not just text", () => {
    const group = { id: -100, type: "supergroup" };
    const photo = {
      message_id: 7,
      caption: "@mybot look",
      caption_entities: [{ type: "mention", offset: 0, length: 6 }],
      photo: [{ file_id: "f", file_unique_id: "u", width: 1, height: 1 }],
      chat: group,
    };
    expect(defaultTelegramRoute({ update_id: 1, message: photo }, { botUsername: "mybot" })).toEqual({});
    // a caption with no mention stays silent in a group
    const plain = { ...photo, caption: "nice sunset", caption_entities: undefined };
    expect(defaultTelegramRoute({ update_id: 1, message: plain }, { botUsername: "mybot" })).toBeNull();
  });

  it("composes a context envelope: chat/thread/sender + reply (with msg id) + the user's text", () => {
    const env = telegramEnvelope({
      message_id: 2,
      text: "what is this",
      message_thread_id: 9,
      chat: { id: 42, type: "private" },
      from: { id: 7, username: "alice" },
      reply_to_message: {
        message_id: 1,
        text: "the log",
        chat: { id: 42, type: "private" },
        from: { id: 8, username: "bob" },
      },
    });
    expect(env).toMatch(/\[telegram: chat 42 \(private\), thread 9, from @alice\]/);
    expect(env).toMatch(/\[in reply to @bob \(msg 1\): the log\]/);
    expect(env).toMatch(/what is this$/);
    expect(env).not.toMatch(/group chat/); // a 1:1 DM gets no group note
  });

  it("attributes a username-less sender by name + id (a shared session must still tell who is who)", () => {
    const env = telegramEnvelope({
      message_id: 3,
      text: "hi",
      chat: { id: -100, type: "supergroup" },
      from: { id: 99, first_name: "Carol" },
    });
    expect(env).toMatch(/from Carol \(id 99\)/);
    expect(env).toMatch(/\[group chat — multiple people; each message is prefixed with its sender\]/);
  });

  it("summarizes a replied-to attachment when it has no text ('summarize this file')", () => {
    const env = telegramEnvelope({
      message_id: 4,
      text: "summarize this",
      chat: { id: 42, type: "private" },
      from: { id: 7, username: "alice" },
      reply_to_message: {
        message_id: 1,
        chat: { id: 42, type: "private" },
        from: { id: 8, username: "bob" },
        document: { file_id: "doc1", file_name: "report.pdf", mime_type: "application/pdf" },
      },
    });
    expect(env).toMatch(/\[in reply to @bob \(msg 1\): \[document: report\.pdf \(application\/pdf\)\]\]/);
  });
});

describe("telegram channel", () => {
  it("rejects non-POST with 405", async () => {
    const { agent } = replyingAgent();
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "B", route: ignore });
    expect((await ch(new Request("http://app/telegram", { method: "GET" }))).status).toBe(405);
  });

  it("refuses an empty secretToken / botToken at construction", () => {
    const { agent } = replyingAgent();
    expect(() => telegramChannel(agent, { secretToken: "", botToken: "B", route: ignore })).toThrow(/secretToken/);
    expect(() => telegramChannel(agent, { secretToken: SECRET, botToken: "", route: ignore })).toThrow(/botToken/);
  });

  it("rejects a missing/wrong secret token with 401 and never routes", async () => {
    const { agent } = replyingAgent();
    let routed = false;
    const ch = telegramChannel(agent, {
      secretToken: SECRET,
      botToken: "B",
      route: () => {
        routed = true;
        return null;
      },
    });
    expect((await ch(tgRequest(MSG, { secret: "wrong" }))).status).toBe(401);
    expect((await ch(new Request("http://app/telegram", { method: "POST", body: "{}" }))).status).toBe(401);
    expect(routed).toBe(false);
  });

  it("reply-to-bot targeting is precise from the token's bot id — before getMe ever resolves", async () => {
    const { agent, calls } = replyingAgent("hi");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 })),
    );
    // Default route; the token "99:ZZ" carries bot id 99. getMe (mocked) never yields a username.
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "99:ZZ" });
    const g = (fromId: number) => ({
      update_id: 1,
      message: {
        message_id: 2,
        text: "thanks",
        chat: { id: -100, type: "supergroup" },
        reply_to_message: {
          message_id: 1,
          chat: { id: -100, type: "supergroup" },
          from: { id: fromId, is_bot: true, username: "otherbot" },
        },
      },
    });
    expect((await ch(tgRequest(g(7)))).status).toBe(200); // a reply to ANOTHER bot (id 7)
    await flush();
    expect(calls.length).toBe(0); // …does not summon — no fail-open window while getMe is unresolved
    await ch(tgRequest(g(99))); // a reply to THIS bot (id 99)
    await flush();
    expect(calls.length).toBe(1);
  });

  it("ACKs a non-actionable update without consulting route (dropped BEFORE the route boundary)", async () => {
    const { agent, calls } = replyingAgent("should not run");
    let routed = false;
    const ch = telegramChannel(agent, {
      secretToken: SECRET,
      botToken: "B",
      route: () => {
        routed = true;
        return {}; // an always-act route — if the handler consulted it, the agent WOULD run
      },
    });
    const m = { message_id: 2, text: "fixed typo", chat: { id: 5, type: "private" } };
    // Every kind the contract excludes — edits and callback queries (even with an embedded message).
    const updates = [
      { update_id: 9, edited_message: m },
      { update_id: 10, edited_channel_post: m },
      { update_id: 11, callback_query: { id: "cq", data: "x", message: m } },
    ];
    for (const update of updates) {
      expect((await ch(tgRequest(update))).status).toBe(200);
    }
    await flush();
    expect(routed).toBe(false); // the contract: route never sees these kinds
    expect(calls.length).toBe(0); // and the agent never ran
  });

  it("rejects an oversized body with 413 before parsing", async () => {
    const { agent } = replyingAgent();
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "B", route: ignore });
    const big = new Request("http://app/telegram", {
      method: "POST",
      body: "x".repeat((1 << 20) + 1),
      headers: { "x-telegram-bot-api-secret-token": SECRET },
    });
    expect((await ch(big)).status).toBe(413);
  });

  it("a verified body that isn't JSON is 400", async () => {
    const { agent } = replyingAgent();
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "B", route: ignore });
    const bad = new Request("http://app/telegram", {
      method: "POST",
      body: "not json{",
      headers: { "x-telegram-bot-api-secret-token": SECRET },
    });
    expect((await ch(bad)).status).toBe(400);
  });

  it("answers a routed update: composes the prompt (envelope) and sends the reply (model A)", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { agent, calls } = replyingAgent("hello back");
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", route: act, apiBaseUrl: API });

    expect((await ch(tgRequest(MSG))).status).toBe(200);
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toMatch(/\[telegram: chat 42/); // channel composed the envelope
    expect(calls[0]?.text).toMatch(/\bhi\b/); // …around the user's text
    const sent = callsTo(fetchMock, "sendMessage");
    expect(sent).toHaveLength(1); // ONE preview message, edited in place (no per-step spam)
    expect(bodyOf(sent[0])).toMatchObject({ chat_id: 42, text: "💭 Thinking…" }); // a plain placeholder
    const edits = callsTo(fetchMock, "editMessageText");
    expect(edits.length).toBeGreaterThan(0); // streamed live by editing the message
    expect(bodyOf(edits.at(-1))).toMatchObject({ text: "hello back", parse_mode: "HTML" }); // final = the HTML answer
  });

  it("uses the default route + getMe when route is omitted (no crash, answers a private chat)", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).endsWith("/getMe")
        ? new Response(JSON.stringify({ ok: true, result: { username: "mybot" } }), { status: 200 })
        : new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { agent } = replyingAgent("ok");
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", apiBaseUrl: API }); // no route → default
    expect((await ch(tgRequest(MSG))).status).toBe(200);
    await flush();
    expect(callsTo(fetchMock, "sendMessage")).toHaveLength(1);
  });

  it("auto-adapts to Threaded Mode: per-thread session + reply into the same thread", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { agent } = replyingAgent("yo");
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", route: act, apiBaseUrl: API });
    const threaded: TelegramUpdate = {
      update_id: 7,
      message: { message_id: 2, text: "hi", message_thread_id: 99, chat: { id: 42, type: "private" } },
    };
    expect((await ch(tgRequest(threaded))).status).toBe(200);
    await flush();
    expect(bodyOf(callsTo(fetchMock, "sendMessage")[0])).toMatchObject({
      chat_id: 42,
      message_thread_id: 99,
      text: "💭 Thinking…", // the placeholder threads into the topic; the answer follows by edit
    });
    expect(bodyOf(callsTo(fetchMock, "editMessageText").at(-1)).text).toBe("yo");
  });

  it("a custom route can override just the session (reuse the default for the rest)", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { agent, calls } = replyingAgent("ok");
    const ch = telegramChannel(agent, {
      secretToken: SECRET,
      botToken: "BOT",
      route: (u) => defaultTelegramRoute(u) && { session: `user:${u.message?.from?.id ?? "?"}` },
      apiBaseUrl: API,
    });
    const m: TelegramUpdate = {
      update_id: 8,
      message: { message_id: 1, text: "hi", chat: { id: 42, type: "private" }, from: { id: 7 } },
    };
    await ch(tgRequest(m));
    await flush();
    // (session isn't on the wire, but the turn ran with our key — assert it reached the agent once)
    expect(calls).toHaveLength(1);
  });

  it("streams reasoning (💭) and tool activity into the preview; persists only the clean final text", async () => {
    vi.useFakeTimers();
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const agent: Agent = {
      async *invoke(): AsyncIterable<AgentEvent> {
        yield { type: "thinking", delta: "weighing options" };
        yield { type: "tool_started", id: "t1", name: "word-count", args: { text: "the quick brown fox" } };
        yield { type: "tool_ended", id: "t1", isError: false, content: { words: 4 } };
        await new Promise((r) => setTimeout(r, 2000)); // a gap: the pump renders the accumulated view here
        yield { type: "text", delta: "4 words" };
        yield { type: "completed" };
      },
    };
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", route: act, apiBaseUrl: API });
    const done = ch(tgRequest(MSG));
    await vi.advanceTimersByTimeAsync(4000); // through the gap + the edit throttle
    expect((await done).status).toBe(200);
    const placeholder = bodyOf(callsTo(fetchMock, "sendMessage")[0]).text;
    expect(placeholder).toBe("💭 Thinking…"); // the preview opens with an explicit placeholder, never an empty "…"
    const edits = callsTo(fetchMock, "editMessageText").map((c) => bodyOf(c).text as string);
    // a mid-turn frame shows the reasoning + tool activity (process), edited into the one preview message
    expect(
      edits.some((t) => /💭/.test(t) && /weighing options/.test(t) && /word-count the quick brown fox/.test(t)),
    ).toBe(true);
    expect(edits.at(-1)).toBe("4 words"); // …but the final message is the answer alone, no thinking/tool noise
    expect(callsTo(fetchMock, "sendMessage")).toHaveLength(1); // one preview message, not per-step spam
  });

  it("replies to the summoning message in a group (threads under the asker), but not in a DM", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { agent } = replyingAgent("hi");
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", route: act, apiBaseUrl: API });

    await ch(
      tgRequest({ update_id: 1, message: { message_id: 77, text: "yo", chat: { id: -100, type: "supergroup" } } }),
    );
    await flush();
    // Full payload: allow_sending_without_reply lets a since-deleted original still deliver.
    expect(bodyOf(callsTo(fetchMock, "sendMessage")[0]).reply_parameters).toMatchObject({
      message_id: 77,
      allow_sending_without_reply: true,
    });

    fetchMock.mockClear();
    await ch(tgRequest(MSG)); // private chat (message_id 1)
    await flush();
    expect(bodyOf(callsTo(fetchMock, "sendMessage")[0]).reply_parameters).toBeUndefined();
  });

  it("still quotes when a custom route returns the same chat explicitly (compares value, not field-presence)", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { agent } = replyingAgent("hi");
    const ch = telegramChannel(agent, {
      secretToken: SECRET,
      botToken: "BOT",
      apiBaseUrl: API,
      route: (u) => ({ chatId: u.message?.chat.id, session: "custom" }), // same chat, returned explicitly
    });
    await ch(
      tgRequest({ update_id: 1, message: { message_id: 55, text: "yo", chat: { id: -100, type: "supergroup" } } }),
    );
    await flush();
    expect(bodyOf(callsTo(fetchMock, "sendMessage")[0]).reply_parameters).toMatchObject({ message_id: 55 });
  });

  it("on a split group reply, only the first chunk quotes the summoning message", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { agent } = replyingAgent("x".repeat(9000)); // > 4096 → multiple chunks
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", route: act, apiBaseUrl: API });
    await ch(
      tgRequest({ update_id: 1, message: { message_id: 88, text: "yo", chat: { id: -100, type: "supergroup" } } }),
    );
    await flush();
    // Long reply: placeholder deleted, answer sent as consecutive fresh messages — only the FIRST answer
    // message quotes the asker (N reply-quotes would be noise).
    const answerSends = callsTo(fetchMock, "sendMessage").filter((c) => bodyOf(c).text !== "💭 Thinking…");
    expect(answerSends.length).toBeGreaterThanOrEqual(2);
    expect(bodyOf(answerSends[0]).reply_parameters).toMatchObject({
      message_id: 88,
      allow_sending_without_reply: true,
    });
    for (const s of answerSends.slice(1)) expect(bodyOf(s).reply_parameters).toBeUndefined();
  });

  it("does not quote when the route redirects the reply to another chat/thread", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { agent } = replyingAgent("hi");
    const ch = telegramChannel(agent, {
      secretToken: SECRET,
      botToken: "BOT",
      apiBaseUrl: API,
      route: () => ({ chatId: 999 }), // redirect to another chat
    });
    await ch(
      tgRequest({ update_id: 1, message: { message_id: 77, text: "yo", chat: { id: -100, type: "supergroup" } } }),
    );
    await flush();
    const sent = bodyOf(callsTo(fetchMock, "sendMessage")[0]);
    expect(sent.chat_id).toBe(999);
    expect(sent.reply_parameters).toBeUndefined(); // redirected → no quote (avoids a wrong-target reply)
  });

  it("serializes same-session turns (FIFO) instead of dropping the second as 'busy'", async () => {
    let started = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const order: number[] = [];
    let release1 = (): void => {};
    const gate1 = new Promise<void>((r) => {
      release1 = r;
    });
    const agent: Agent = {
      async *invoke(): AsyncIterable<AgentEvent> {
        const id = ++started;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (id === 1) await gate1; // hold the first turn open while the second arrives
        inFlight--;
        order.push(id);
        yield { type: "text", delta: `r${id}` };
        yield { type: "completed" };
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 })),
    );
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", route: act, apiBaseUrl: API });
    const upd = (n: number) => ({
      update_id: n,
      message: { message_id: n, text: "yo", chat: { id: 7, type: "private" } },
    });
    const settle = async (): Promise<void> => {
      for (let k = 0; k < 6; k++) await new Promise((r) => setImmediate(r));
    };

    await ch(tgRequest(upd(1))); // session "7"
    await ch(tgRequest(upd(2))); // session "7" — queued behind #1, not run concurrently, not dropped
    await settle();
    expect(started).toBe(1); // only turn 1 has invoked; turn 2 waits its turn
    expect(maxInFlight).toBe(1);

    release1();
    await settle();
    expect(order).toEqual([1, 2]); // FIFO
    expect(maxInFlight).toBe(1); // never two at once for the same session
  });

  it("runs different sessions concurrently (no cross-session blocking)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let release = (): void => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const agent: Agent = {
      async *invoke(): AsyncIterable<AgentEvent> {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await gate; // both turns park here at once iff they run concurrently
        inFlight--;
        yield { type: "completed" };
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 })),
    );
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", route: act, apiBaseUrl: API });
    const settle = async (): Promise<void> => {
      for (let k = 0; k < 6; k++) await new Promise((r) => setImmediate(r));
    };

    await ch(tgRequest({ update_id: 1, message: { message_id: 1, text: "a", chat: { id: 1, type: "private" } } }));
    await ch(tgRequest({ update_id: 2, message: { message_id: 2, text: "b", chat: { id: 2, type: "private" } } }));
    await settle();
    expect(maxInFlight).toBe(2); // different sessions → both in flight at once
    release();
    await settle();
  });

  const groupSettle = async (): Promise<void> => {
    for (let k = 0; k < 6; k++) await new Promise((r) => setImmediate(r));
  };
  const onlyCommands = (u: TelegramUpdate) => (u.message?.text?.startsWith("/") ? {} : null);
  const grp = { id: -100, type: "supergroup" as const };
  const groupMsg = (n: number, user: string, t: string) => ({
    update_id: n,
    message: { message_id: n, text: t, chat: grp, from: { id: n, username: user } },
  });

  it("buffers un-summoned group messages and folds them into the next summoned turn, then clears", async () => {
    const { agent, calls } = replyingAgent("ok");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 })),
    );
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", apiBaseUrl: API, route: onlyCommands });

    await ch(tgRequest(groupMsg(1, "alice", "the deploy failed"))); // un-summoned → buffered
    await ch(tgRequest(groupMsg(2, "bob", "which service?"))); // un-summoned → buffered
    await ch(tgRequest(groupMsg(3, "alice", "/bot summarize"))); // summoned → folds the buffer in
    await groupSettle();
    const p1 = calls[0]?.text ?? "";
    expect(p1).toMatch(/recent group discussion/);
    expect(p1).toMatch(/@alice \(msg \d+\): the deploy failed/);
    expect(p1).toMatch(/@bob \(msg \d+\): which service\?/);

    await ch(tgRequest(groupMsg(4, "bob", "/bot again"))); // summoned → buffer already cleared
    await groupSettle();
    expect(calls[1]?.text ?? "").not.toMatch(/recent group discussion/);
  });

  it("keeps the group buffer under the char budget (drops the oldest un-summoned messages)", async () => {
    const { agent, calls } = replyingAgent("ok");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 })),
    );
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", apiBaseUrl: API, route: onlyCommands });
    for (let i = 0; i < 30; i++) await ch(tgRequest(groupMsg(i, "alice", `M${i}-${"x".repeat(290)}`))); // ~9000 chars
    await ch(tgRequest(groupMsg(99, "alice", "/bot go")));
    await groupSettle();
    const p = calls[0]?.text ?? "";
    expect(p).toMatch(/recent group discussion/);
    expect(p).toMatch(/M29-/); // newest kept
    expect(p).not.toMatch(/M0-/); // oldest dropped over budget
  });

  it("keeps the buffer when a pre-agent failure (attachment download) aborts the summoned turn", async () => {
    const { agent, calls } = replyingAgent("ok");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/getFile"))
          return new Response(JSON.stringify({ ok: true, result: { file_path: "photo.jpg" } }), { status: 200 });
        if (String(url).includes("/file/bot")) return new Response("nope", { status: 500 }); // download fails
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }),
    );
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", apiBaseUrl: API, route: onlyCommands });

    await ch(tgRequest(groupMsg(1, "alice", "the deploy failed"))); // un-summoned → buffered
    // summoned, but carries a photo whose download fails → the turn fails BEFORE the agent runs
    await ch(
      tgRequest({
        update_id: 2,
        message: {
          message_id: 2,
          text: "/bot look",
          chat: grp,
          from: { id: 2, username: "bob" },
          photo: [{ file_id: "p1", file_unique_id: "u", width: 1, height: 1 }],
        },
      }),
    );
    await groupSettle();
    expect(calls).toHaveLength(0); // agent never ran — attachment failed before it

    // retry with a plain command: the discussion was NOT lost; it is folded into this turn
    await ch(tgRequest(groupMsg(3, "bob", "/bot summarize")));
    await groupSettle();
    expect(calls[0]?.text ?? "").toMatch(/@alice \(msg \d+\): the deploy failed/);
  });

  it("a message arriving during the attachment-download window survives the commit (folded into the next turn)", async () => {
    const { agent, calls } = replyingAgent("ok");
    let releaseDownload = (): void => {};
    const downloadGate = new Promise<void>((r) => {
      releaseDownload = r;
    });
    let markDownloadStarted = (): void => {};
    const downloadStarted = new Promise<void>((r) => {
      markDownloadStarted = r;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/getFile"))
          return new Response(JSON.stringify({ ok: true, result: { file_path: "p.jpg", file_size: 3 } }), {
            status: 200,
          });
        if (String(url).includes("/file/bot")) {
          markDownloadStarted();
          await downloadGate; // hold the download open
          return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }),
    );
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", apiBaseUrl: API, route: onlyCommands });

    await ch(tgRequest(groupMsg(1, "alice", "the deploy failed"))); // un-summoned → buffered
    await ch(
      tgRequest({
        update_id: 2,
        message: {
          message_id: 2,
          text: "/bot look",
          chat: grp,
          from: { id: 2, username: "bob" },
          photo: [{ file_id: "p1", file_unique_id: "u", width: 1, height: 1 }],
        },
      }),
    ); // summoned + photo → enters the download window (peek already snapshotted [alice])
    await downloadStarted;
    await ch(tgRequest(groupMsg(3, "carol", "any update?"))); // arrives DURING the window
    releaseDownload();
    await groupSettle();

    expect(calls[0]?.text ?? "").toMatch(/@alice \(msg \d+\): the deploy failed/);
    expect(calls[0]?.text ?? "").not.toMatch(/@carol/); // carol was not in this turn's prompt

    await ch(tgRequest(groupMsg(4, "bob", "/bot summarize"))); // next summon
    await groupSettle();
    expect(calls[1]?.text ?? "").toMatch(/@carol \(msg \d+\): any update\?/); // carol survived the commit
  });

  it("warns once at startup when group privacy mode is on (can_read_all_group_messages: false)", async () => {
    const errs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m) => {
      errs.push(String(m));
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).endsWith("/getMe")
          ? new Response(
              JSON.stringify({ ok: true, result: { username: "bot", can_read_all_group_messages: false } }),
              {
                status: 200,
              },
            )
          : new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }),
      ),
    );
    const { agent } = replyingAgent();
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", apiBaseUrl: API }); // getMe fires once
    await groupSettle();
    const privacyWarnings = () => errs.filter((e) => /privacy mode is on/.test(e)).length;
    expect(privacyWarnings()).toBe(1); // exactly once, at startup

    // Driving group updates must NOT re-warn — it is a startup check, not a per-request one.
    await ch(tgRequest(groupMsg(1, "alice", "hi")));
    await ch(tgRequest(groupMsg(2, "bob", "there")));
    await groupSettle();
    expect(privacyWarnings()).toBe(1);
  });

  it("serializes the live preview: never two writes in flight (the out-of-order flicker)", async () => {
    vi.useFakeTimers();
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchMock = vi.fn(async (url: string) => {
      const method = String(url).split("/").pop();
      if (method === "sendMessage" || method === "editMessageText") {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 30)); // a real write takes time — events arrive during it
        inFlight--;
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const agent: Agent = {
      async *invoke(): AsyncIterable<AgentEvent> {
        for (let k = 0; k < 8; k++) yield { type: "thinking", delta: `r${k} ` };
        yield { type: "text", delta: "done" };
        yield { type: "completed" };
      },
    };
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", route: act, apiBaseUrl: API });
    await ch(tgRequest(MSG));
    await vi.advanceTimersByTimeAsync(5000);
    expect(maxInFlight).toBe(1); // single writer: concurrent edits are what reorder frames
    expect(callsTo(fetchMock, "editMessageText").length).toBeLessThan(9); // a burst coalesced, not 1/delta
    expect(callsTo(fetchMock, "sendMessage")).toHaveLength(1); // one preview message (the placeholder)
  });

  it("edits the final answer as HTML, falling back to plain text when Telegram rejects the markup", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).endsWith("/editMessageText")) {
        return JSON.parse(String(init.body)).parse_mode === "HTML"
          ? new Response(JSON.stringify({ ok: false, description: "Bad Request: can't parse entities: bad" }), {
              status: 400,
            })
          : new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { agent } = replyingAgent("<b>oops");
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", route: act, apiBaseUrl: API });
    expect((await ch(tgRequest(MSG))).status).toBe(200);
    await flush();
    const finalEdits = callsTo(fetchMock, "editMessageText").filter((c) => bodyOf(c).text === "<b>oops");
    expect(finalEdits.some((c) => bodyOf(c).parse_mode === "HTML")).toBe(true); // tried HTML
    expect(finalEdits.some((c) => bodyOf(c).parse_mode === undefined)).toBe(true); // …fell back to plain
  });

  it("splits a reply longer than 4096 chars into multiple messages", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { agent } = replyingAgent("x".repeat(9000));
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", route: act, apiBaseUrl: API });
    expect((await ch(tgRequest(MSG))).status).toBe(200);
    await flush();
    // A long reply gives up in-place editing: the preview placeholder is DELETED and the whole answer is
    // sent as consecutive fresh messages (so it stays together in an active group), each ≤4096.
    expect(callsTo(fetchMock, "deleteMessage")).toHaveLength(1);
    const answerSends = callsTo(fetchMock, "sendMessage").filter((c) => bodyOf(c).text !== "💭 Thinking…");
    expect(answerSends.length).toBeGreaterThanOrEqual(3); // 9000 chars → ≥3 chunks
    for (const s of answerSends) expect((bodyOf(s).text as string).length).toBeLessThanOrEqual(4096);
  });

  it("auto-extracts a photo from the message and passes it to the agent as a (vision) image", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/getFile"))
        return new Response(JSON.stringify({ ok: true, result: { file_path: "photos/x.jpg", file_size: 3 } }), {
          status: 200,
        });
      if (String(url).includes("/file/bot")) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { agent, calls } = replyingAgent("ok");
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", route: act, apiBaseUrl: API });
    const photo: TelegramUpdate = {
      update_id: 9,
      message: {
        message_id: 3,
        caption: "what is this",
        photo: [{ file_id: "f1", file_unique_id: "u", width: 9, height: 9 }],
        chat: { id: 42, type: "private" },
      },
    };
    expect((await ch(tgRequest(photo))).status).toBe(200);
    await flush();
    await flush();
    await flush();
    expect(calls[0]?.images).toHaveLength(1);
    expect(calls[0]?.images?.[0]).toMatchObject({
      mimeType: "image/jpeg",
      data: Buffer.from([1, 2, 3]).toString("base64"),
    });
  });

  it("downloads an inbound document into the state dir's files/ and appends its path to the prompt", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/getFile"))
        return new Response(JSON.stringify({ ok: true, result: { file_path: "documents/report.pdf", file_size: 5 } }), {
          status: 200,
        });
      if (String(url).includes("/file/bot")) return new Response(new Uint8Array([1, 2, 3, 4, 5]), { status: 200 });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const state = freshStateDir();
    const { agent, calls } = replyingAgent("ok");
    const ch = telegramChannel(agent, {
      secretToken: SECRET,
      botToken: "BOT",
      route: act,
      apiBaseUrl: API,
      stateDir: state,
    });
    const doc: TelegramUpdate = {
      update_id: 11,
      message: {
        message_id: 4,
        caption: "summarize",
        document: { file_id: "d1", file_name: "report.pdf" },
        chat: { id: 77, type: "private" },
      },
    };
    expect((await ch(tgRequest(doc))).status).toBe(200);
    for (let i = 0; i < 100 && calls.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    // files live UNDER the state dir — one home for all channel state, so `stateDir` moves everything
    const dest = join(state, "files/77/report.pdf");
    expect(existsSync(dest)).toBe(true);
    expect(calls[0]?.text).toMatch(/attached files/);
    expect(calls[0]?.text).toContain(dest);
  });

  it("surfaces an attachment fetch failure to the user (not a silent skip) and does not run the agent", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m) => {
      errors.push(String(m));
    });
    const fetchMock = vi.fn(async (url: string) =>
      String(url).endsWith("/getFile")
        ? new Response(JSON.stringify({ ok: false }), { status: 200 })
        : new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    let invoked = false;
    const agent: Agent = {
      async *invoke(): AsyncIterable<AgentEvent> {
        invoked = true;
        yield { type: "completed" };
      },
    };
    const ch = telegramChannel(agent, {
      secretToken: SECRET,
      botToken: "BOT",
      route: act,
      apiBaseUrl: API,
      onError: (f) => `ERR: ${f.details}`,
    });
    const photo: TelegramUpdate = {
      update_id: 9,
      message: {
        message_id: 3,
        photo: [{ file_id: "f1", file_unique_id: "u", width: 1, height: 1 }],
        chat: { id: 42, type: "private" },
      },
    };
    expect((await ch(tgRequest(photo))).status).toBe(200);
    await flush();
    await flush();
    await flush();
    expect(invoked).toBe(false);
    const writes = [...callsTo(fetchMock, "sendMessage"), ...callsTo(fetchMock, "editMessageText")].map(
      (c) => bodyOf(c).text as string,
    );
    expect(writes.some((t) => /could not load attachment/.test(t))).toBe(true);
    expect(errors.some((e) => /turn failed/.test(e))).toBe(true);
  });

  it("a failing live preview edit is logged once (not swallowed) and the final reply still lands", async () => {
    vi.useFakeTimers();
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m) => {
      errors.push(String(m));
    });
    const fetchMock = vi.fn(async (url: string) =>
      String(url).endsWith("/editMessageText")
        ? new Response(JSON.stringify({ ok: false, description: "nope" }), { status: 400 })
        : new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const agent: Agent = {
      async *invoke(): AsyncIterable<AgentEvent> {
        yield { type: "text", delta: "final answer" };
        await new Promise((r) => setTimeout(r, 2000)); // a gap so the pump attempts (and fails) a preview edit
        yield { type: "completed" };
      },
    };
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", route: act, apiBaseUrl: API });
    const done = ch(tgRequest(MSG));
    await vi.advanceTimersByTimeAsync(4000);
    expect((await done).status).toBe(200);
    const previewErrs = errors.filter((e) => /live preview failed/.test(e));
    expect(previewErrs).toHaveLength(1); // logged ONCE, not per failed edit
    expect(previewErrs[0]).toMatch(/nope/);
    // the edit keeps failing, so the final answer lands via a fresh send instead
    expect(callsTo(fetchMock, "sendMessage").map((c) => bodyOf(c).text)).toContain("final answer");
  });

  it("does not spam new messages when Telegram returns ok WITHOUT a message_id (preview disabled, not per-frame)", async () => {
    vi.useFakeTimers();
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m) => {
      errors.push(String(m));
    });
    // ok but no result.message_id (proxy / odd API base / unparseable body) — the channel cannot edit
    const fetchMock = vi.fn(async (url: string) =>
      String(url).endsWith("/getMe")
        ? new Response(JSON.stringify({ ok: true, result: { username: "mybot" } }), { status: 200 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const agent: Agent = {
      async *invoke(): AsyncIterable<AgentEvent> {
        yield { type: "thinking", delta: "a" };
        await new Promise((r) => setTimeout(r, 2000)); // a gap so the pump would retry preview writes
        yield { type: "text", delta: "done" };
        yield { type: "completed" };
      },
    };
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", route: act, apiBaseUrl: API });
    const done = ch(tgRequest(MSG));
    await vi.advanceTimersByTimeAsync(4000);
    expect((await done).status).toBe(200);
    expect(errors.filter((e) => /live preview failed/.test(e))).toHaveLength(1); // surfaced once, not silent
    // placeholder sent once + the final fresh send — NOT one send per changed view
    expect(callsTo(fetchMock, "sendMessage").length).toBeLessThanOrEqual(2);
  });

  it("a failed event tells the user (neutral by default) and logs the turn as failed", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((m) => {
      errors.push(String(m));
    });
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const agent: Agent = {
      async *invoke(): AsyncIterable<AgentEvent> {
        yield { type: "failed", details: "boom", retryable: false };
      },
    };
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", route: act, apiBaseUrl: API });
    expect((await ch(tgRequest(MSG))).status).toBe(200);
    await flush();
    expect(errors.some((e) => /turn failed/.test(e) && /boom/.test(e))).toBe(true); // dev log
    // the failed event is reported by editing the preview message (or a fresh send if none yet)
    const errWrite = callsTo(fetchMock, "editMessageText").at(-1) ?? callsTo(fetchMock, "sendMessage").at(-1);
    const userText = bodyOf(errWrite).text as string;
    expect(userText).not.toMatch(/boom/); // customer-facing: neutral, no leaked details
    expect(userText).toMatch(/something went wrong/i);
    spy.mockRestore();
  });

  it("a failed event still notifies the user when the preview can no longer be edited (fresh-send fallback)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // editMessageText always fails (preview deleted); sendMessage works
    const fetchMock = vi.fn(async (url: string) =>
      String(url).endsWith("/editMessageText")
        ? new Response(JSON.stringify({ ok: false, description: "Bad Request: message to edit not found" }), {
            status: 400,
          })
        : new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const agent: Agent = {
      async *invoke(): AsyncIterable<AgentEvent> {
        yield { type: "failed", details: "boom", retryable: false };
      },
    };
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", route: act, apiBaseUrl: API });
    await ch(tgRequest(MSG));
    await flush();
    // the neutral error lands via a fresh send (the edit failed), not silently lost — same fallback as completed
    const sends = callsTo(fetchMock, "sendMessage").map((c) => bodyOf(c).text as string);
    expect(sends.some((t) => /something went wrong/i.test(t))).toBe(true);
  });

  it("a failed turn with a suppressing formatError deletes the placeholder (no dead 'Thinking…')", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const agent: Agent = {
      async *invoke(): AsyncIterable<AgentEvent> {
        yield { type: "failed", details: "boom", retryable: false };
      },
    };
    const ch = telegramChannel(agent, {
      secretToken: SECRET,
      botToken: "BOT",
      route: act,
      apiBaseUrl: API,
      onError: () => "", // developer suppresses the user-facing notice
    });
    await ch(tgRequest(MSG));
    await flush();
    expect(callsTo(fetchMock, "sendMessage")).toHaveLength(1); // just the placeholder
    expect(callsTo(fetchMock, "deleteMessage")).toHaveLength(1); // …which is then removed, not left as dead "Thinking…"
  });

  it("deletes the placeholder before a fresh send when a single-chunk edit fails but the preview still exists", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // editMessageText fails with a NON-"gone" error (5xx) — the placeholder is still there, so a bare fresh
    // send would leave a "💭 Thinking…" residue above the answer
    const fetchMock = vi.fn(async (url: string) =>
      String(url).endsWith("/editMessageText")
        ? new Response(JSON.stringify({ ok: false, description: "Bad Gateway" }), { status: 502 })
        : new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { agent } = replyingAgent("the answer");
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", route: act, apiBaseUrl: API });
    await ch(tgRequest(MSG));
    await flush();
    expect(callsTo(fetchMock, "deleteMessage")).toHaveLength(1); // placeholder removed — no residue
    expect(callsTo(fetchMock, "sendMessage").map((c) => bodyOf(c).text)).toContain("the answer"); // answer lands fresh
  });

  it("shows (no reply) when a completed turn produced no text", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const agent: Agent = {
      async *invoke(): AsyncIterable<AgentEvent> {
        yield { type: "tool_started", id: "t1", name: "noop", args: {} };
        yield { type: "tool_ended", id: "t1", isError: false, content: {} };
        yield { type: "completed" }; // completed, but no text was ever produced
      },
    };
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", route: act, apiBaseUrl: API });
    await ch(tgRequest(MSG));
    await flush();
    // the preview is edited to an explicit "(no reply)" (a persisted message can't vanish like the old draft)
    expect(callsTo(fetchMock, "editMessageText").map((c) => bodyOf(c).text)).toContain("(no reply)");
  });

  it("shows a neutral notice when the stream ends without a terminal event (not silence, not a dead 'Thinking…')", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    // an agent that ends WITHOUT completed/failed (a SPEC violation) — the user must still be told, and the
    // preview (which may show real partial work) must not silently vanish
    const agent: Agent = {
      async *invoke(): AsyncIterable<AgentEvent> {
        yield { type: "thinking", delta: "…" };
      },
    };
    const ch = telegramChannel(agent, { secretToken: SECRET, botToken: "BOT", route: act, apiBaseUrl: API });
    await ch(tgRequest(MSG));
    await flush();
    // the preview is edited into the neutral failure notice (unknown retryability → "something went wrong"),
    // not deleted, not left stuck
    const edits = callsTo(fetchMock, "editMessageText").map((c) => bodyOf(c).text as string);
    expect(edits.some((t) => /something went wrong/i.test(t))).toBe(true);
    expect(callsTo(fetchMock, "deleteMessage")).toHaveLength(0);
  });
});
