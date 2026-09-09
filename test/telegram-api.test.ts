import { afterEach, describe, expect, it, vi } from "vitest";
import { callApi, chunkText, resolveImages, sendMessage } from "../src/channels/telegram/telegram-api.ts";

const API = "http://tg.test";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("chunkText (HTML-aware split)", () => {
  it("returns one chunk under the limit, and prefers a newline boundary over it", () => {
    expect(chunkText("short")).toEqual(["short"]);
    const long = `${"a".repeat(4000)}\n${"b".repeat(200)}`; // > 4096 with a newline before the limit
    expect(chunkText(long)).toEqual(["a".repeat(4000), "b".repeat(200)]);
  });

  it("(html) closes a spanning tag and reopens it — nested, in order, with its attributes", () => {
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
    expect(chunks.map((c) => c.slice(5, -6)).join("")).toBe(code);

    // Nested: the real fenced-code-with-language shape. Reopen outermost-first, close innermost-first.
    const python = "print(x)\n".repeat(700); // > 4096 inside <pre><code>
    const open = '<pre><code class="language-python">';
    const nested = chunkText(`${open}${python}</code></pre>`, { html: true });
    expect(nested.length).toBeGreaterThan(1);
    for (const c of nested) {
      expect(c.length).toBeLessThanOrEqual(4096);
      expect(c.startsWith(open)).toBe(true); // attrs kept on every reopen
      expect(c.endsWith("</code></pre>")).toBe(true);
    }
    expect(nested.map((c) => c.slice(open.length, -"</code></pre>".length)).join("")).toBe(python); // lossless

    // An attribute-bearing inline tag is reopened the same way.
    const link = chunkText(`<a href="https://example.com/x">${"word ".repeat(1200)}</a>`, { html: true });
    expect(link.length).toBeGreaterThan(1);
    for (const c of link) expect(c).toContain('href="https://example.com/x"');
  });

  it("(html) never cuts INTO a tag token or an entity, and always makes progress", () => {
    // A `<b>` straddling the ~4032 cut moves whole to the next chunk.
    const straddling = chunkText(`${"a".repeat(4030)}<b>${"c".repeat(300)}</b>`, { html: true });
    expect(straddling[0]).toBe("a".repeat(4030)); // cut BEFORE the `<b`, not mid-token
    expect(straddling[1]?.startsWith("<b>")).toBe(true);
    for (const c of straddling) expect(/<[a-z]*$/i.test(c)).toBe(false); // no partial tag at a chunk end

    // An entity straddling the cut stays intact — never `&am` | `p;`.
    const entity = chunkText(`<pre>${"a".repeat(4025)}&amp;${"b".repeat(300)}</pre>`, { html: true });
    expect(entity.some((c) => c.includes("&amp;"))).toBe(true);
    // no chunk ends with a dangling `&…` (ignoring the appended `</…>` closer)
    expect(entity.some((c) => /&[a-z#0-9]*$/i.test(c.replace(/<\/[a-z]+>$/i, "")))).toBe(false);

    // …but the entity back-up must not reach a raw `&` INSIDE a tag: the tag ends just before the
    // ~4032 cut and its href's `&` (no `;`) sits within 12 chars of it, so an unguarded back-up would
    // move the cut into the tag (`…?a` | `&b">…` debris).
    const tag = '<a href="https://x.com/?a&b">';
    const href = chunkText(`${"a".repeat(4000)}${tag}link</a>${"c".repeat(300)}`, { html: true });
    expect(href[0]).toContain(tag); // survives intact, `&` and all
    expect(href.every((c) => !/<[^>]*$/.test(c))).toBe(true); // no chunk ends inside a tag token

    // A lone `<` then a huge run, never closed: terminates, no empty chunk.
    const unclosed = chunkText(`<${"a".repeat(6000)}`, { html: true });
    expect(unclosed.length).toBeGreaterThan(1);
    expect(unclosed.every((c) => c.length > 0)).toBe(true);
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

  it("retries a 429 after the server's retry_after, or its own backoff — and actually WAITS", async () => {
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

    // Without `parameters`, the transport's own (attempt 0 → 1 + 1) s backoff applies instead.
    calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        if (calls === 1) return new Response(JSON.stringify({ ok: false }), { status: 429 });
        return ok();
      }),
    );
    const bare = callApi(API, "BOT", "getMe", {});
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1100);
    await bare;
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
