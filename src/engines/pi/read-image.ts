/**
 * The image pipeline pi's `read` tool needs: normalize an unsupported format to PNG, resize below the
 * inline limit, and hand back the hints that tell the model what it is looking at.
 *
 * pi-agent-core's `createReadTool` takes this as an INJECTED processor and does nothing without one —
 * unlike pi-coding-agent's, which wires its private `processImage` internally. That function is not
 * exported (nor reachable: the package's `exports` map has no deep paths), so this rebuilds it from the
 * two halves that ARE public, `convertToPng` and `resizeImage`/`formatDimensionNote`.
 *
 * It is upstream logic restated, which is a real cost — without it `read` on a screenshot sends the raw
 * bytes (measured: 7.48 MB of base64 where pi-coding-agent sends 3.48 MB, and no dimension note for the
 * model's coordinate math), and a bmp is dropped entirely while the tool's own description still
 * advertises it. test/tools-parity.test.ts compares this against pi-coding-agent's real `read` on both
 * paths, so upstream changing the pipeline surfaces as a failing test rather than as drift.
 */
import { convertToPng, formatDimensionNote, resizeImage } from "@earendil-works/pi-coding-agent";
import type { ReadImageProcessor } from "@earendil-works/pi-agent-core";

/** Formats a provider takes inline as-is; everything else has to become a PNG first. */
const INLINE_MIME: Record<string, string> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/gif": "image/gif",
  "image/webp": "image/webp",
};

/** The `read` tool's image processor. Matches pi-coding-agent's messages verbatim: they reach the model
 *  as tool output, so a reworded one is a different prompt, not a different implementation detail. */
export const readImageProcessor: ReadImageProcessor = async (bytes, mimeType, options) => {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? mimeType.toLowerCase();
  const inline = INLINE_MIME[base];
  let normalized: { bytes: Uint8Array; mimeType: string; convertedFrom?: string };
  if (inline) {
    normalized = { bytes, mimeType: inline };
  } else {
    const png = await convertToPng(Buffer.from(bytes).toString("base64"), base);
    if (!png)
      return { ok: false, message: "[Image omitted: could not be converted to a supported inline image format.]" };
    normalized = { bytes: Buffer.from(png.data, "base64"), mimeType: png.mimeType, convertedFrom: base };
  }

  const hints: string[] = [];
  const converted = (to: string) =>
    normalized.convertedFrom && normalized.convertedFrom !== to
      ? `[Image converted from ${normalized.convertedFrom} to ${to}.]`
      : undefined;

  if (!options.autoResizeImages) {
    const hint = converted(normalized.mimeType);
    if (hint) hints.push(hint);
    return { ok: true, data: Buffer.from(normalized.bytes).toString("base64"), mimeType: normalized.mimeType, hints };
  }

  const resized = await resizeImage(normalized.bytes, normalized.mimeType);
  if (!resized)
    return { ok: false, message: "[Image omitted: could not be resized below the inline image size limit.]" };
  const hint = converted(resized.mimeType);
  if (hint) hints.push(hint);
  // The scale factor the model needs to map coordinates back onto the original — dropping it is what
  // makes a resized screenshot unusable for anything positional.
  const note = formatDimensionNote(resized);
  if (note) hints.push(note);
  return { ok: true, data: resized.data, mimeType: resized.mimeType, hints };
};
