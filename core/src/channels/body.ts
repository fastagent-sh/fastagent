/**
 * Safe request-body reading, shared by channels. A streaming byte cap is the only robust defense
 * against an unauthenticated client buffering an arbitrarily large body on a public endpoint (a
 * Content-Length check is bypassable with chunked encoding), and it must live where the body is
 * consumed — hence here, used by each channel with its own limit, not in the transport.
 *
 * Platform-agnostic (web streams only): works on Node and serverless alike.
 */

/** Read the request body with a hard byte cap (counts real bytes, not JS characters). */
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
