/**
 * The pages a person sees while FastAgent sets an app up with them: where they paste a credential, and what happens next.
 * One design for every channel (Slack's tokens, Lark's credentials), so a second page is a repetition of the first.
 *
 * The page is self-contained: no font, script or image comes from anywhere else, and it follows the system's light or
 * dark. It is served to a browser on this machine (or through a tunnel), so a secret pasted into it goes from the browser
 * to this process and nowhere else — never through a coding agent's conversation or a file the person writes.
 *
 * Design rules it keeps, so a page added later keeps them too: one left edge; one primary button per page; a label is the
 * name the other site uses for the value; an error sits above the field it is about; red is for an error and green for
 * success only; every text is at least 4.5:1 against its background and an input's edge 3:1.
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
:root{color-scheme:light dark;--bg:#f4f5f7;--card:#fff;--ink:#11151a;--muted:#4f5a67;--line:#d7dce2;--field:#fff;--edge:#727c88;
--accent:#0a6a7d;--accent-hover:#085666;--on-accent:#fff;--accent-tint:#e2f2f5;--ok:#17713f;--ok-tint:#e2f4ea;--bad:#b3261e;--bad-tint:#fdecea}
@media (prefers-color-scheme:dark){:root{--bg:#0d1014;--card:#161a20;--ink:#f2f4f7;--muted:#a3adba;--line:#2c333d;--field:#0d1014;--edge:#6b7684;
--accent:#46bfd4;--accent-hover:#6bd0e1;--on-accent:#06222a;--accent-tint:#123039;--ok:#5ccd91;--ok-tint:#11301f;--bad:#ff948b;--bad-tint:#3a1815}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
h1,h2{text-wrap:balance}p{text-wrap:pretty}
main{max-width:520px;margin:48px auto;padding:0 16px}
.brand{margin:0 0 16px;font-weight:700;letter-spacing:-.01em}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:32px}
h1{font-size:28px;line-height:1.2;font-weight:700;letter-spacing:-.011em;margin:0 0 32px}
.step+.step{margin-top:40px}
.step header{display:flex;align-items:center;gap:12px;margin:0 0 8px}
.step header.bare{margin-bottom:16px}
.num{flex:none;width:28px;height:28px;border-radius:50%;display:grid;place-items:center;background:var(--accent-tint);color:var(--accent);font-weight:700;font-size:14px}
.step h2{font-size:18px;line-height:28px;font-weight:700;margin:0}
.step p{margin:0 0 16px;color:var(--muted)}
.step p b{color:var(--ink);font-weight:600;white-space:nowrap}
label{display:block;font-weight:600;font-size:14px;margin:0 0 4px}
.field{position:relative;margin-bottom:16px}
input{width:100%;height:48px;padding:0 72px 0 16px;font:15px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink);background:var(--field);border:1px solid var(--edge);border-radius:8px}
input.plain{padding-right:16px}
input[aria-invalid=true]{border-color:var(--bad)}
input:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.toggle{position:absolute;right:4px;bottom:4px;height:40px;padding:0 12px;border:0;border-radius:6px;background:none;color:var(--accent);font:inherit;font-size:14px;font-weight:600;cursor:pointer}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:48px;padding:0 24px;border-radius:8px;font:inherit;font-size:16px;font-weight:700;line-height:1;text-decoration:none;cursor:pointer;border:2px solid var(--accent)}
.btn.primary{background:var(--accent);color:var(--on-accent)}
.btn.primary:hover{background:var(--accent-hover);border-color:var(--accent-hover)}
.btn.secondary{background:transparent;color:var(--accent)}
.btn.secondary:hover{background:var(--accent-tint)}
.btn[disabled]{opacity:.65;cursor:progress}
.btn.block{width:100%;margin-top:8px}
.step .privacy{display:flex;align-items:flex-start;gap:8px;margin:12px 0 0;color:var(--muted);font-size:14px;line-height:20px}
.privacy svg{flex:none;margin-top:2px}
.error{margin:0 0 16px;padding:12px 16px;border-left:4px solid var(--bad);background:var(--bad-tint);border-radius:0 8px 8px 0;font-size:15px}
.error b{display:block}
.error .why{display:block;margin-top:4px;font-size:13px;color:var(--muted);overflow-wrap:anywhere}
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

/** Show/hide for a secret, and a busy button so a second click cannot submit twice. */
const SCRIPT = `
document.querySelectorAll(".toggle").forEach(function(b){b.addEventListener("click",function(){
var i=document.getElementById(b.dataset.for),s=i.type==="password";i.type=s?"text":"password";b.textContent=s?"Hide":"Show"})});
document.querySelectorAll("form").forEach(function(f){f.addEventListener("submit",function(){
var g=f.querySelector(".btn.primary");if(g){g.disabled=true;g.textContent="Checking\\u2026"}})});
`;

const LOCK = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;
const OUT = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>`;
const TICK = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;
const CROSS = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`;

/** `1  Title`: the number and the title on one line, so the step's content below shares the card's one left edge. */
export function step(number: number, title: string, content: string, options: { bare?: boolean } = {}): string {
  return (
    `<section class="step"><header${options.bare ? ' class="bare"' : ""}><span class="num" aria-hidden="true">${number}</span>` +
    `<h2>${escapeHtml(title)}</h2></header>${content}</section>`
  );
}

/** A sentence under a step's title. `html` is trusted markup: use `<b>` for a name the person must find on another site. */
export const prose = (html: string): string => `<p>${html}</p>`;

/** A button that opens another site in a new tab (secondary: the step's real action is the primary button below). */
export function openButton(label: string, href: string): string {
  return `<a class="btn secondary" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)} ${OUT}</a>`;
}

/**
 * A labelled input. `label` is the name the other site gives the value, so the person never has to map one to the other.
 * A secret gets a Show/Hide toggle; nothing is ever put back in a secret field after a refusal.
 */
export function field(input: {
  id: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  value?: string;
  invalid?: boolean;
  autofocus?: boolean;
}): string {
  const { id, label, placeholder, secret, value, invalid, autofocus } = input;
  return (
    `<div class="field"><label for="${id}">${escapeHtml(label)}</label>` +
    `<input id="${id}" name="${id}" class="${secret ? "" : "plain"}" type="${secret ? "password" : "text"}" ` +
    `${placeholder ? `placeholder="${escapeHtml(placeholder)}" ` : ""}${value ? `value="${escapeHtml(value)}" ` : ""}` +
    `${invalid ? 'aria-invalid="true" ' : ""}${autofocus ? "autofocus " : ""}` +
    `autocomplete="off" autocapitalize="off" spellcheck="false" required>` +
    `${secret ? `<button class="toggle" type="button" data-for="${id}">Show</button>` : ""}</div>`
  );
}

/**
 * What was refused, in bold, and what to do about it. Sits above the field it is about. `why` is the other side's own
 * words, for someone who has to look it up: small and set apart, so the sentence the person reads stays one they can act on.
 */
export function refusal(headline: string, detail?: string, why?: string): string {
  return (
    `<div class="error" role="alert"><b>${escapeHtml(headline)}</b>${detail ? escapeHtml(detail) : ""}` +
    `${why ? `<span class="why">${escapeHtml(why)}</span>` : ""}</div>`
  );
}

export const submit = (label: string): string =>
  `<button class="btn primary block" type="submit">${escapeHtml(label)}</button>`;

/** The promise about where a pasted value goes. Said once, the same way, on every page that asks for one. */
export const privacy = (): string =>
  `<p class="privacy">${LOCK}<span>Stays on this computer. Never shared with your coding agent.</span></p>`;

/** A page that asks for something: a heading, then the steps, in one form posting back to this address. */
export function formCard(heading: string, steps: string): string {
  return `<form class="card" method="post"><h1>${escapeHtml(heading)}</h1>${steps}</form>`;
}

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
 * Send a page. The headers are those of a page that takes a secret: nothing cached, nothing framed, nothing loaded from
 * elsewhere (a nonce admits only this page's own style and script). No `form-action`: browsers apply it to the redirects a
 * submission is answered with, and Slack's page answers one by sending the browser on to Slack.
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
      `<main><p class="brand">FastAgent</p>${page.card}</main><script nonce="${nonce}">${SCRIPT}</script>`,
  );
}
