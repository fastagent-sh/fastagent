/**
 * Self-contained status page served during OAuth browser redirects.
 */
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export function setupRequestUrl(request: IncomingMessage, response: ServerResponse): URL | undefined {
  const url = URL.parse(request.url ?? "/", "http://127.0.0.1");
  if (url === null) {
    response.writeHead(400).end("invalid request URL\n");
    return undefined;
  }
  return url;
}

const escapeHtml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const CSS = `
:root{color-scheme:light dark;--bg:#f4f5f7;--card:#fff;--ink:#11151a;--muted:#4f5a67;--line:#d7dce2;
--accent:#0a6a7d;--accent-tint:#e2f2f5;--ok:#17713f;--ok-tint:#e2f4ea;--bad:#b3261e;--bad-tint:#fdecea}
@media (prefers-color-scheme:dark){:root{--bg:#0d1014;--card:#161a20;--ink:#f2f4f7;--muted:#a3adba;--line:#2c333d;
--accent:#46bfd4;--accent-tint:#123039;--ok:#5ccd91;--ok-tint:#11301f;--bad:#ff948b;--bad-tint:#3a1815}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
h1{text-wrap:balance}p{text-wrap:pretty}
main{max-width:520px;margin:48px auto;padding:0 16px}
.brand{margin:0 0 16px;font-weight:700;letter-spacing:-.01em}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:32px}
h1{font-size:28px;line-height:1.2;font-weight:700;letter-spacing:-.011em;margin:0 0 32px}
.state{display:flex;align-items:center;gap:16px;margin:0 0 16px}
.state h1{margin:0}
.glyph{flex:none;width:40px;height:40px;border-radius:50%;display:grid;place-items:center}
.glyph.ok{background:var(--ok-tint);color:var(--ok)}
.glyph.bad{background:var(--bad-tint);color:var(--bad)}
.glyph.wait{border:4px solid var(--accent-tint);border-top-color:var(--accent);animation:r 1s linear infinite}
@keyframes r{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.glyph.wait{animation:none}}
.lede{margin:0;color:var(--muted)}
.next{margin:32px 0 0;padding-top:24px;border-top:1px solid var(--line);font-weight:600}
@media (max-width:480px){.card{padding:24px 20px}h1{font-size:24px}}
`;

const TICK = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;
const CROSS = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`;

/** A page that says where things stand: working (it moves on by itself), done, or stopped. */
export function statusCard(input: {
  state: "working" | "done" | "failed";
  heading: string;
  lede?: string;
  /** What the person does now, set apart under the status. */
  next?: string;
}): string {
  const glyph =
    input.state === "working"
      ? `<span class="glyph wait" role="status" aria-label="Working"></span>`
      : `<span class="glyph ${input.state === "done" ? "ok" : "bad"}">${input.state === "done" ? TICK : CROSS}</span>`;
  return (
    `<div class="card"><div class="state">${glyph}<h1>${escapeHtml(input.heading)}</h1></div>` +
    `${input.lede ? `<p class="lede">${escapeHtml(input.lede)}</p>` : ""}` +
    `${input.next ? `<p class="next">${escapeHtml(input.next)}</p>` : ""}</div>`
  );
}

/**
 * Send a page. The headers keep secrets uncached, unframed, and free of external scripts/styles.
 */
export function sendPage(
  response: ServerResponse,
  status: number,
  page: { title: string; card: string; head?: string },
): void {
  const nonce = randomBytes(16).toString("base64");
  response.statusCode = status;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader(
    "content-security-policy",
    `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`,
  );
  response.end(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
      `${page.head ?? ""}<title>${escapeHtml(page.title)}</title><style nonce="${nonce}">${CSS}</style>` +
      `<main><p class="brand">FastAgent</p>${page.card}</main>`,
  );
}
