/**
 * Read a request body with a hard byte cap (real bytes). A streaming cap is the only robust guard
 * against an unbounded body (Content-Length is bypassable with chunked encoding). Web-streams only.
 */
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
