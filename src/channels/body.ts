import { text } from "./respond.ts";

/**
 * Refuse a request to one of OUR routes that does not declare a JSON body — `undefined` when it does.
 *
 * This is what makes "a foreign origin simply gets no CORS headers" safe. Withholding the headers stops a page from
 * READING the reply; it does not stop the request. A cross-origin POST carrying `text/plain` (or a form's
 * `multipart/form-data`) is a CORS *simple request*: no preflight, sent regardless, and the turn it asks for runs.
 * Demanding `application/json` takes the request out of that class, so the browser must preflight it — and a
 * preflight we do not answer is a request that is never sent.
 *
 * Asked of the ROUTE, never of "does this have a body": the control plane reads an empty body as `{}`, so a
 * body-less POST would otherwise walk straight through the gate.
 *
 * NOT applied to channel routes. Their caller is a platform's server with its own content types (Slack posts
 * `application/x-www-form-urlencoded` for some payloads) and its own signature check, and a page cannot forge that.
 */
export function refuseNonJsonBody(req: Request): Response | undefined {
  // Parameters are part of the header (`application/json; charset=utf-8`), so compare the media type alone.
  const mediaType = (req.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (mediaType === "application/json") return undefined;
  // Says what is required, and does not echo what arrived: reflecting a request header into a response body is a
  // habit worth not having, and the sender already knows what they sent.
  return text("content-type must be application/json\n", 415);
}

/** Read a request body with a hard byte cap (real bytes). */
export async function readBodyCapped(req: Request, max: number): Promise<{ text: string } | { tooLarge: true }> {
  if (!req.body) return { text: "" };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > max) {
      await reader.cancel();
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return { text: new TextDecoder().decode(buf) };
}
