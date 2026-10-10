/**
 * The literal `content: [ … ]` block of fastagent.config.ts, as text: found, checked to be a literal, and written back
 * from a list. Pure — `fastagent content` imports the result and compares it before anything replaces the real file
 * (docs/design/core.md §2), which is what makes editing a TypeScript module this way safe.
 */
import { CONTENT_KEYS, type ContentDeclaration } from "./declare.ts";

/** One declaration with its keys in {@link CONTENT_KEYS} order: the form written and the form compared. */
export function canonicalDeclaration(declaration: ContentDeclaration): ContentDeclaration {
  const record = declaration as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of CONTENT_KEYS) if (record[key] !== undefined) out[key] = record[key];
  return out as ContentDeclaration;
}

function entryText(declaration: ContentDeclaration): string {
  const parts = Object.entries(canonicalDeclaration(declaration)).map(
    ([key, value]) => `${key}: ${typeof value === "string" ? JSON.stringify(value) : String(value)}`,
  );
  return `{ ${parts.join(", ")} }`;
}

function blockText(declarations: readonly ContentDeclaration[], indent: string): string {
  if (declarations.length === 0) return "content: []";
  const inner = `${indent}  `;
  return `content: [\n${declarations.map((d) => `${inner}${entryText(d)},`).join("\n")}\n${indent}]`;
}

/**
 * `src` with its `content` replaced by `declarations`. A missing key is added as the first line of
 * `export default {`; a value that is not a literal array (a variable, a spread, a call) is refused with the reason
 * rather than overwritten by its current value.
 */
export function rewriteContent(src: string, declarations: readonly ContentDeclaration[]): string {
  const keys = [...src.matchAll(/^([ \t]*)content[ \t]*:/gm)];
  if (keys.length > 1) throw new Error(`it declares "content" more than once; leave one and run this again`);
  const [key] = keys;
  if (!key) {
    const opener = /^export default[ \t]*\{[ \t]*$/m.exec(src);
    if (!opener) {
      throw new Error(`it has no \`export default {\` line to add "content" to; add \`content: []\` to it by hand`);
    }
    const at = opener.index + opener[0].length;
    return `${src.slice(0, at)}\n  ${blockText(declarations, "  ")},${src.slice(at)}`;
  }
  const start = key.index;
  const end = literalArrayEnd(src, start + key[0].length);
  return `${src.slice(0, start)}${key[1]}${blockText(declarations, key[1] ?? "")}${src.slice(end)}`;
}

/**
 * The index just past the literal array that begins after `from`, or a refusal when the value is anything else. A
 * literal holds only brackets, braces, commas, colons, keys, quoted strings, `true`/`false`, and comments.
 */
function literalArrayEnd(src: string, from: number): number {
  const computed = (): never => {
    throw new Error(`its "content" is computed, not a literal list — edit it by hand`);
  };
  let i = skipSpace(src, from);
  if (src[i] !== "[") computed();
  let depth = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === "[" || ch === "{") {
      depth++;
      i++;
    } else if (ch === "]" || ch === "}") {
      depth--;
      i++;
      if (depth === 0) return i;
    } else if (ch === "," || ch === ":") {
      i++;
    } else if (ch === '"' || ch === "'") {
      i = stringEnd(src, i);
    } else if (/[A-Za-z_$]/.test(ch)) {
      const word = /^[A-Za-z_$][\w$]*/.exec(src.slice(i))?.[0] ?? "";
      const after = skipSpace(src, i + word.length);
      // A key, or a boolean value — any other name is a reference to something computed.
      if (src[after] !== ":" && word !== "true" && word !== "false") computed();
      i += word.length;
    } else if (/\s/.test(ch) || src.startsWith("//", i) || src.startsWith("/*", i)) {
      i = skipSpace(src, i);
    } else {
      computed();
    }
  }
  return computed();
}

function skipSpace(src: string, from: number): number {
  let i = from;
  for (;;) {
    while (i < src.length && /\s/.test(src[i] as string)) i++;
    if (src.startsWith("//", i)) {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl + 1;
    } else if (src.startsWith("/*", i)) {
      const close = src.indexOf("*/", i + 2);
      if (close === -1) throw new Error("it has an unterminated comment");
      i = close + 2;
    } else {
      return i;
    }
  }
}

function stringEnd(src: string, from: number): number {
  const quote = src[from];
  for (let i = from + 1; i < src.length; i++) {
    if (src[i] === "\\") i++;
    else if (src[i] === quote) return i + 1;
    else if (src[i] === "\n") break;
  }
  throw new Error("it has an unterminated string in content");
}
