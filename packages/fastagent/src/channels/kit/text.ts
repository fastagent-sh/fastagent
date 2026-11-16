/** Pure Unicode-safe text slicing and inbound attachment path helpers shared by messaging channels. */
import { join, resolve, sep } from "node:path";

/** How much of a replied-to message is quoted back into a prompt. */
export const REFERENT_MAX_CODE_POINTS = 4096;

/** Inbound attachment root inside a channel's state directory. */
export const attachmentsDir = (stateHome: string): string => join(stateHome, "files");

export function attachmentPath(
  filesDir: string,
  conversationId: string | number,
  fileName: string,
): { dir: string; name: string; path: string } {
  const id = String(conversationId).replace(/\p{Surrogate}/gu, "\uFFFD");
  const dir = resolve(filesDir, `c-${encodeURIComponent(id)}`);
  const cleaned = fileName.replace(/[/\\]/g, "_");
  const name = resolve(dir, cleaned).startsWith(dir + sep) ? cleaned : "file";
  return { dir, name, path: resolve(dir, name) };
}

/** Take at most `maxPoints` Unicode code points from the start, without adding a marker. */
export function codePointPrefix(text: string, maxPoints: number): string {
  if (maxPoints <= 0) return "";
  const out: string[] = [];
  for (const point of text) {
    if (out.length >= maxPoints) break;
    out.push(point);
  }
  return out.join("");
}

/**
 * How much of `text` survives beside `marker`, or the finished answer when the marker alone decides it: nothing to
 * cut, no room at all, or room for less than the marker. Both truncations answer those three the same way, so they
 * are decided once.
 */
function budget(
  text: string,
  maxPoints: number,
  marker: string,
): { points: string[]; keep: number } | { done: string } {
  const points = Array.from(text);
  if (points.length <= maxPoints) return { done: text };
  if (maxPoints <= 0) return { done: "" };
  const markerPoints = Array.from(marker);
  if (markerPoints.length >= maxPoints) return { done: markerPoints.slice(0, maxPoints).join("") };
  return { points, keep: maxPoints - markerPoints.length };
}

/** Ellipsize from the right while keeping the result within `maxPoints` Unicode code points. */
export function truncateCodePointPrefix(text: string, maxPoints: number, marker = "…"): string {
  const fit = budget(text, maxPoints, marker);
  if ("done" in fit) return fit.done;
  return `${fit.points.slice(0, fit.keep).join("")}${marker}`;
}

/** Ellipsize from the left while keeping the result within `maxPoints` Unicode code points. */
export function truncateCodePointSuffix(text: string, maxPoints: number, marker = "…"): string {
  const fit = budget(text, maxPoints, marker);
  if ("done" in fit) return fit.done;
  return `${marker}${fit.points.slice(fit.points.length - fit.keep).join("")}`;
}

/** Largest code-point-aligned prefix whose UTF-8 encoding fits `maxBytes`. */
export function utf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const out: string[] = [];
  let bytes = 0;
  for (const point of text) {
    const pointBytes = Buffer.byteLength(point, "utf8");
    if (bytes + pointBytes > maxBytes) break;
    out.push(point);
    bytes += pointBytes;
  }
  return out.join("");
}

/** Ellipsize a UTF-8 string without exceeding `maxBytes` or tearing a code point. */
export function truncateUtf8(text: string, maxBytes: number, marker = "…"): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (markerBytes > maxBytes) return utf8Prefix(marker, maxBytes);
  return `${utf8Prefix(text, maxBytes - markerBytes)}${marker}`;
}
