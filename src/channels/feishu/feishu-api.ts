/**
 * Feishu Open API transport, reused by the Lark compatibility profile. ONE pipeline (`call`) carries every JSON call — per-method wire code
 * does not exist, so a transport rule can never be missing from one call site. The transport invariants
 * live here and nowhere else:
 *
 *  1. Every call has a per-attempt timeout (API_TIMEOUT_MS; resource bytes DOWNLOAD_TIMEOUT_MS) — a
 *     wedged connection cannot hang a turn or its session queue.
 *  2. The tenant_access_token is fetched lazily, cached to its `expire` minus a refresh margin, and
 *     invalidated + refetched ONCE when the platform says the token is bad (auth codes below) — no
 *     other failure class is retried with a fresh token.
 *  3. Only a rate-limit reject is retried (bounded attempts, linear backoff); nothing else — the
 *     request may have been processed, and a retried send would double-deliver.
 *  4. Success requires the body's own `code === 0` — an intermediary's HTTP 200 is not a sent message.
 *  5. Every failure is a {@link FeishuApiError} naming the call; self-description is a property of the
 *     error type, not per-call-site string assembly.
 *
 * On top of the pipeline sit thin typed methods (send/reply/edit/card/resource) — adding one is adding
 * a wrapper, not wire code. SDK tripwire: if this surface ever needs WebSocket long-connection ingress
 * or grows past ~a dozen methods, adopt @larksuiteoapi/node-sdk instead of growing it — the methods
 * here are shape-compatible with the SDK's `client.im.*` style, so the policy layer survives that swap.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ImageRef } from "../../agent.ts";
import type { FeishuCloudKind } from "./cloud.ts";

/** Per-attempt timeout for a JSON API call — small JSON round-trips, so 30s is generous. */
const API_TIMEOUT_MS = 30_000;
/** Timeout for downloading resource bytes — sized for a slow link, not a JSON call. */
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** How many rate-limit rejects one call absorbs before giving up. */
const RETRIES = 3;
/** Download sanity cap; a larger resource is rejected visibly (the engine resizes vision images
 *  anyway, so this is a transport guard, not a model limit). */
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
/** Refresh the cached tenant token this long before its stated expiry. */
const TOKEN_REFRESH_MARGIN_S = 300;

/** The platform's "this token is bad" codes: expired/invalid tenant token → invalidate + refetch once. */
const AUTH_ERROR_CODES = new Set([99991661, 99991663, 99991664, 99991668]);
/** The platform's frequency-limit code (arrives with HTTP 429 or 400). */
const RATE_LIMIT_CODE = 99991400;

/** Where a reply goes: a chat, optionally quote-replying a message (in-thread in topic groups). */
export interface FeishuTarget {
  chatId: string;
  /** Message to reply to (the summoning message). Set in groups so the answer threads under the asker. */
  replyTo?: string;
  /** Reply into the message's topic thread (topic groups). */
  replyInThread?: boolean;
}

/** A downloaded inbound file: an absolute local path the agent's tools (read/bash) can open. */
export interface DownloadedFile {
  path: string;
  name: string;
  size: number;
}

/** A named Open API failure. `status` 0 = the transport itself failed (network error / timeout) before
 *  any HTTP status existed; `code` is the platform's own error code (0 when none was readable).
 *  Module-private: no external caller matches on the type; the pipeline's own retry logic reads `code`. */
class FeishuApiError extends Error {
  readonly call: string;
  readonly status: number;
  readonly code: number;
  readonly description: string;
  // No constructor parameter properties: the CLI runs source under Node's strip-only TS mode.
  constructor(
    kind: FeishuCloudKind,
    call: string,
    status: number,
    code: number,
    description: string,
    options?: { cause?: unknown },
  ) {
    super(
      status === 0
        ? `${kind} ${call}: ${description}`
        : `${kind} ${call} failed: ${status}${code ? ` code ${code}` : ""} ${description}`.trim(),
      options,
    );
    this.name = "FeishuApiError";
    this.call = call;
    this.status = status;
    this.code = code;
    this.description = description;
  }
}

/** Whether an error is the platform's "card streaming closed/timed out" reject — preview.ts re-enables
 *  streaming once when it sees this. A plain code check on the typed error, exported instead of the
 *  class so no caller can construct/throw one. */
export function isCardStreamingClosed(e: unknown): boolean {
  return e instanceof FeishuApiError && (e.code === 200850 || e.code === 300309);
}

/** Whether the platform origin has no application-config route at all. Onboarding uses this narrow
 * signal to fall back to a manual token/mode setup; auth/scope/network failures must remain visible. */
export function isFeishuConfigApiMissing(e: unknown): boolean {
  return e instanceof FeishuApiError && e.status === 404;
}

/** Sleep on the GLOBAL timer (not `node:timers/promises`) so tests can drive it with fake timers. */
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface FeishuApiOptions {
  /** Branded diagnostics; defaults to the canonical Feishu cloud. */
  kind?: FeishuCloudKind;
  /** API origin: `https://open.feishu.cn` (Feishu) or `https://open.larksuite.com` (Lark intl). */
  baseUrl: string;
  appId: string;
  appSecret: string;
}

interface ApiBody {
  code?: number;
  msg?: string;
  [k: string]: unknown;
}

/**
 * The Feishu Open API client: one instance per channel, holding the token cache. Every method rides the
 * single pipeline (module header). Throws {@link FeishuApiError} on any failure.
 */
export interface FeishuApi {
  /** Validate appId/appSecret by acquiring the tenant token through this pipeline. Does not require
   *  the bot capability (unlike botInfo), so guided onboarding can fail before persisting a typo. */
  verifyCredentials(): Promise<void>;
  /** GET /bot/v3/info — the bot's own identity (open_id drives @mention summon). */
  botInfo(): Promise<{ openId?: string; appName?: string }>;
  /** Send a message to a chat; returns the new message_id (undefined if the body carried none). */
  sendMessage(chatId: string, msgType: string, content: string): Promise<string | undefined>;
  /** Reply to a message (quote; `replyInThread` stays inside a topic group's thread). */
  replyMessage(
    messageId: string,
    msgType: string,
    content: string,
    opts?: { replyInThread?: boolean },
  ): Promise<string | undefined>;
  /** Send `text`, split at the platform's size cap: ordinary groups quote only the first chunk; topic
   *  groups reply_in_thread on every chunk. Returns the FIRST message_id. */
  sendText(target: FeishuTarget, text: string): Promise<string | undefined>;
  /** Edit a sent text message in place (PUT; the platform caps edits at 20 per message). */
  editTextMessage(messageId: string, text: string): Promise<void>;
  /** Recall (delete) a message the bot sent. */
  deleteMessage(messageId: string): Promise<void>;
  /** Fetch one message (the reply-referent path). Undefined when the API returns no item. */
  getMessage(
    messageId: string,
  ): Promise<
    | { message_id?: string; msg_type?: string; body?: { content?: string }; mentions?: unknown[]; sender?: unknown }
    | undefined
  >;
  /** Download a message resource (image/file bytes). Caps at {@link MAX_DOWNLOAD_BYTES}. */
  downloadResource(
    messageId: string,
    fileKey: string,
    type: "image" | "file",
  ): Promise<{ bytes: Buffer; contentType?: string }>;
  /** Download an image resource as a vision ImageRef. */
  fetchImage(messageId: string, fileKey: string): Promise<ImageRef>;
  /** Download a file resource to `<filesDir>/<chat>/<name>`. */
  fetchFile(
    messageId: string,
    fileKey: string,
    name: string,
    chatId: string,
    filesDir: string,
  ): Promise<DownloadedFile>;
  /** Read the app's own event-security config (the platform-generated verification token / encrypt
   *  key) — the scan-to-create flow copies these into .env so the operator never opens the console. */
  getAppConfig(appId: string): Promise<{ verificationToken?: string; encryptionKey?: string }>;
  /** Update the app's own event subscription (application-v7 config PATCH — tenant token can only
   *  operate on itself; the request-URL change takes effect immediately, no version publish). The
   *  platform VERIFIES `requestUrl` with a url_verification challenge during this call, so the server
   *  behind it must already be answering. */
  updateEventSubscription(appId: string, cfg: { subscriptionType: "webhook"; requestUrl: string }): Promise<void>;
  /** Create a card entity (card JSON 2.0). Returns its card_id. */
  createCard(cardJson: string): Promise<string>;
  /** Stream-update a card element's text (full-content snapshot + strictly increasing sequence). */
  updateCardElement(cardId: string, elementId: string, content: string, sequence: number): Promise<void>;
  /** Replace a card entity's content (the settle write; also flips streaming_mode off via the JSON). */
  updateCard(cardId: string, cardJson: string, sequence: number): Promise<void>;
}

/** The platform caps a text-message request body at 150 KB; stay well under it (the content is a JSON
 *  envelope around the text, and multi-byte characters inflate the byte count). */
export const FEISHU_MAX_TEXT_BYTES = 100 * 1024;

/** Split text into chunks whose UTF-8 size fits the message cap, preferring a newline boundary. */
export function chunkFeishuText(text: string, maxBytes: number = FEISHU_MAX_TEXT_BYTES): string[] {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (Buffer.byteLength(rest, "utf8") > maxBytes) {
    // Binary-search the largest prefix under the cap (byte-accurate, multi-byte safe), then prefer the
    // last newline inside it.
    let lo = 1;
    let hi = rest.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (Buffer.byteLength(rest.slice(0, mid), "utf8") <= maxBytes) lo = mid;
      else hi = mid - 1;
    }
    let cut = rest.lastIndexOf("\n", lo);
    if (cut <= 0) cut = lo;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.length > 0 || chunks.length === 0) chunks.push(rest);
  return chunks;
}

export function createFeishuApi(opts: FeishuApiOptions): FeishuApi {
  const { kind = "feishu", baseUrl, appId, appSecret } = opts;
  let cached: { token: string; expiresAt: number } | undefined;

  /** Fetch (or reuse) the tenant_access_token — the one call that carries no Authorization header. */
  const tenantToken = async (): Promise<string> => {
    if (cached && Date.now() < cached.expiresAt) return cached.token;
    const label = "tenant_access_token";
    let res: Response;
    let raw: string;
    try {
      res = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      raw = await res.text();
    } catch (e) {
      throw new FeishuApiError(kind, label, 0, 0, String(e), { cause: e });
    }
    let data: ApiBody & { tenant_access_token?: string; expire?: number };
    try {
      data = JSON.parse(raw) as typeof data;
    } catch {
      data = {};
    }
    if (!res.ok || data.code !== 0 || typeof data.tenant_access_token !== "string") {
      throw new FeishuApiError(
        kind,
        label,
        res.status,
        data.code ?? 0,
        data.msg ?? "response was not the expected JSON",
      );
    }
    const ttlS = Math.max(60, (data.expire ?? 0) - TOKEN_REFRESH_MARGIN_S);
    cached = { token: data.tenant_access_token, expiresAt: Date.now() + ttlS * 1000 };
    return cached.token;
  };

  /** The pipeline: one JSON API call, carrying every transport invariant (module header). */
  const call = async <T extends ApiBody>(
    label: string,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> => {
    let refreshedAuth = false;
    for (let attempt = 0; ; ) {
      const token = await tenantToken();
      let res: Response;
      let raw: string;
      try {
        res = await fetch(`${baseUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json; charset=utf-8",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(API_TIMEOUT_MS),
        });
        raw = await res.text(); // the body read shares the timeout — a mid-body stall is a transport failure too
      } catch (e) {
        throw new FeishuApiError(kind, label, 0, 0, String(e), { cause: e });
      }
      let data: T;
      try {
        data = JSON.parse(raw) as T;
      } catch {
        data = {} as T; // only the parse is forgiven — the code-gate below turns it into a named failure
      }
      if (res.ok && data.code === 0) return data;
      const code = data.code ?? 0;
      if (AUTH_ERROR_CODES.has(code) && !refreshedAuth) {
        // The platform says the token is bad (expired mid-cache-window, or revoked): refetch ONCE and
        // retry. Auth is the one failure class where a retry cannot double-deliver — the request was
        // rejected before it acted.
        refreshedAuth = true;
        cached = undefined;
        continue;
      }
      if ((res.status === 429 || code === RATE_LIMIT_CODE) && attempt < RETRIES) {
        attempt++;
        await wait(attempt * 1000);
        continue;
      }
      const exhausted = res.status === 429 || code === RATE_LIMIT_CODE ? ` (gave up after ${attempt} retries)` : "";
      throw new FeishuApiError(
        kind,
        label,
        res.status,
        code,
        `${data.msg ?? "response was not the expected JSON"}${exhausted}`,
      );
    }
  };

  const api: FeishuApi = {
    async verifyCredentials() {
      await tenantToken();
    },
    async botInfo() {
      // bot/v3/info answers at the TOP LEVEL (`bot`), not under `data` — an older API family.
      const data = await call<ApiBody & { bot?: { open_id?: string; app_name?: string } }>(
        "botInfo",
        "GET",
        "/open-apis/bot/v3/info",
      );
      return { openId: data.bot?.open_id, appName: data.bot?.app_name };
    },
    async sendMessage(chatId, msgType, content) {
      const data = await call<ApiBody & { data?: { message_id?: string } }>(
        "sendMessage",
        "POST",
        "/open-apis/im/v1/messages?receive_id_type=chat_id",
        { receive_id: chatId, msg_type: msgType, content },
      );
      return data.data?.message_id;
    },
    async replyMessage(messageId, msgType, content, opts2) {
      const data = await call<ApiBody & { data?: { message_id?: string } }>(
        "replyMessage",
        "POST",
        `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`,
        { msg_type: msgType, content, ...(opts2?.replyInThread ? { reply_in_thread: true } : {}) },
      );
      return data.data?.message_id;
    },
    async sendText(target, text) {
      const chunks = chunkFeishuText(text);
      let firstId: string | undefined;
      let first = true;
      for (const chunk of chunks) {
        const content = JSON.stringify({ text: chunk });
        // A normal group quote-replies only the first chunk — N reply-quotes would be noise. A topic
        // must reply_in_thread on EVERY chunk; a plain chat send would leak continuations to the main group.
        const reply = target.replyTo !== undefined && (first || target.replyInThread === true);
        const id = reply
          ? await api.replyMessage(target.replyTo as string, "text", content, {
              replyInThread: target.replyInThread,
            })
          : await api.sendMessage(target.chatId, "text", content);
        if (first) firstId = id;
        first = false;
      }
      return firstId;
    },
    async editTextMessage(messageId, text) {
      await call("editTextMessage", "PUT", `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
        msg_type: "text",
        content: JSON.stringify({ text }),
      });
    },
    async deleteMessage(messageId) {
      await call("deleteMessage", "DELETE", `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`);
    },
    async getMessage(messageId) {
      const data = await call<ApiBody & { data?: { items?: unknown[] } }>(
        "getMessage",
        "GET",
        `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
      );
      return data.data?.items?.[0] as Awaited<ReturnType<FeishuApi["getMessage"]>>;
    },
    async downloadResource(messageId, fileKey, type) {
      // The byte download is the one non-JSON call, so it cannot ride the pipeline — same token +
      // timeout + naming discipline, applied here once.
      const label = "downloadResource";
      const token = await tenantToken();
      let res: Response;
      let buf: ArrayBuffer | undefined;
      let errBody: string | undefined;
      try {
        res = await fetch(
          `${baseUrl}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=${type}`,
          { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) },
        );
        buf = res.ok ? await res.arrayBuffer() : undefined;
        errBody = res.ok ? undefined : await res.text(); // the error body self-describes (expired key etc.)
      } catch (e) {
        throw new FeishuApiError(kind, label, 0, 0, String(e), { cause: e });
      }
      if (!res.ok || buf === undefined) {
        let description: string | undefined;
        let code = 0;
        try {
          const parsed = JSON.parse(errBody ?? "") as ApiBody;
          description = parsed.msg;
          code = parsed.code ?? 0;
        } catch {
          /* non-JSON error body — fall through to the generic description */
        }
        throw new FeishuApiError(kind, label, res.status, code, description ?? "response was not the expected bytes");
      }
      const bytes = Buffer.from(buf);
      if (bytes.byteLength > MAX_DOWNLOAD_BYTES) throw new Error("resource is too large (max 20 MB)");
      return { bytes, contentType: res.headers.get("content-type") ?? undefined };
    },
    async fetchImage(messageId, fileKey) {
      const { bytes, contentType } = await api.downloadResource(messageId, fileKey, "image");
      const mime = contentType?.split(";")[0]?.trim();
      return { mimeType: mime?.startsWith("image/") ? mime : "image/jpeg", data: bytes.toString("base64") };
    },
    async fetchFile(messageId, fileKey, name, chatId, filesDir) {
      const { bytes } = await api.downloadResource(messageId, fileKey, "file");
      // The name is external input destined for a filesystem path — keep only its basename-safe core.
      const safe = name.replace(/[/\\]/g, "_").replace(/^\.+/, "_") || "file";
      const dir = join(filesDir, chatId);
      await mkdir(dir, { recursive: true });
      const dest = join(dir, safe);
      await writeFile(dest, bytes);
      return { path: dest, name: safe, size: bytes.byteLength };
    },
    async getAppConfig(appId) {
      // v6 app detail — the one read surface that returns the event-security material (under data.app).
      const data = await call<
        ApiBody & { data?: { app?: { encryption?: { encryption_key?: string; verification_token?: string } } } }
      >("getAppConfig", "GET", `/open-apis/application/v6/applications/${encodeURIComponent(appId)}?lang=zh_cn`);
      return {
        verificationToken: data.data?.app?.encryption?.verification_token,
        encryptionKey: data.data?.app?.encryption?.encryption_key,
      };
    },
    async updateEventSubscription(appId, cfg) {
      await call(
        "updateEventSubscription",
        "PATCH",
        `/open-apis/application/v7/applications/${encodeURIComponent(appId)}/config`,
        {
          event: { subscription_type: cfg.subscriptionType, request_url: cfg.requestUrl },
        },
      );
    },
    async createCard(cardJson) {
      const data = await call<ApiBody & { data?: { card_id?: string } }>(
        "createCard",
        "POST",
        "/open-apis/cardkit/v1/cards",
        {
          type: "card_json",
          data: cardJson,
        },
      );
      const id = data.data?.card_id;
      if (!id) throw new FeishuApiError(kind, "createCard", 200, 0, "response carried no card_id");
      return id;
    },
    async updateCardElement(cardId, elementId, content, sequence) {
      await call(
        "updateCardElement",
        "PUT",
        `/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}/elements/${encodeURIComponent(elementId)}/content`,
        { content, sequence },
      );
    },
    async updateCard(cardId, cardJson, sequence) {
      await call("updateCard", "PUT", `/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}`, {
        card: { type: "card_json", data: cardJson },
        sequence,
      });
    },
  };
  return api;
}
