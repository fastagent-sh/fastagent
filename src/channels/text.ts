/** Pure Unicode-safe text slicing helpers shared by channel rendering paths (Feishu/Lark cards, the preview kit). JavaScript string
 * indexes are UTF-16 code units, so direct `slice()` can tear a surrogate pair and send replacement
 * characters after JSON/UTF-8 encoding. These helpers only cut at Unicode code-point boundaries. */

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

/** Ellipsize from the right while keeping the result within `maxPoints` Unicode code points. */
export function truncateCodePointPrefix(text: string, maxPoints: number, marker = "…"): string {
  const points = Array.from(text);
  if (points.length <= maxPoints) return text;
  if (maxPoints <= 0) return "";
  const markerPoints = Array.from(marker);
  if (markerPoints.length >= maxPoints) return markerPoints.slice(0, maxPoints).join("");
  return `${points.slice(0, maxPoints - markerPoints.length).join("")}${marker}`;
}

/** Ellipsize from the left while keeping the result within `maxPoints` Unicode code points. */
export function truncateCodePointSuffix(text: string, maxPoints: number, marker = "…"): string {
  const points = Array.from(text);
  if (points.length <= maxPoints) return text;
  if (maxPoints <= 0) return "";
  const markerPoints = Array.from(marker);
  if (markerPoints.length >= maxPoints) return markerPoints.slice(0, maxPoints).join("");
  return `${marker}${points.slice(points.length - (maxPoints - markerPoints.length)).join("")}`;
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
