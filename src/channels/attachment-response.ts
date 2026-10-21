/** An image attachment's bytes and safe browser headers, shared by both HTTP protocol bindings. */
const RASTER = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function attachmentResponse(image: { mimeType: string; data: string } | undefined): Response {
  if (image === undefined) return new Response(null, { status: 404 });
  const bytes = Uint8Array.from(atob(image.data), (char) => char.charCodeAt(0));
  return new Response(bytes, {
    headers: {
      "content-type": RASTER.has(image.mimeType) ? image.mimeType : "application/octet-stream",
      "x-content-type-options": "nosniff",
      // Preserve the declared type for clients without letting a browser execute sender-controlled HTML or SVG.
      "x-mime-type": image.mimeType,
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}
