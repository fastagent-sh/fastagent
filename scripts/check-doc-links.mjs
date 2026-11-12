import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const docsDir = resolve(repoRoot, "docs");
const roots = ["README.md", "CONTRIBUTING.md", "SECURITY.md", "AGENTS.md", "llms.txt", "docs", ".github"].map(
  (entry) => resolve(repoRoot, entry),
);

async function docFiles(path, explicit = false) {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => undefined);
  if (!entries) return explicit || extname(path) === ".md" ? [resolve(path)] : [];
  const nested = await Promise.all(entries.map((entry) => docFiles(resolve(path, entry.name))));
  return nested.flat();
}

function withoutCode(markdown) {
  let fence;
  return markdown
    .split("\n")
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker) {
        if (!fence) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
        return " ".repeat(line.length);
      }
      if (fence) return " ".repeat(line.length);
      return line.replace(/(`+).*?\1/g, (code) => " ".repeat(code.length));
    })
    .join("\n");
}

function anchors(markdown) {
  const seen = new Map();
  const out = new Set();
  for (const line of markdown.split("\n")) {
    const match = /^#{1,6}\s+(.+?)\s*#*$/.exec(line);
    if (!match) continue;
    const base = match[1]
      .toLowerCase()
      .replace(/<[^>]*>/g, "")
      .replace(/[^\p{L}\p{N}_ -]/gu, "")
      .trim()
      .replace(/\s+/g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    out.add(count === 0 ? base : `${base}-${count}`);
  }
  return out;
}

function resolveTarget(file, target) {
  if (!target || /^mailto:/.test(target)) return undefined;
  if (/^https?:/.test(target)) {
    const url = URL.parse(target);
    if (url?.origin !== "https://fastagent.sh") return undefined;
    if (url.pathname !== "/docs" && !url.pathname.startsWith("/docs/")) return undefined;
    const raw = url.pathname.slice("/docs".length).replace(/^\/+|\/+$/g, "");
    const slug = raw === "index.md" ? "" : raw.endsWith("/index.md") ? raw.slice(0, -"/index.md".length) : raw;
    if (extname(slug)) return { invalid: true };
    return {
      targetFile: resolve(docsDir, slug ? `${slug}.md` : "README.md"),
      fragment: url.hash ? url.hash.slice(1) : undefined,
    };
  }
  const [pathPart, fragment] = target.split("#", 2);
  return { targetFile: resolve(dirname(file), pathPart || file), fragment };
}

const files = (await Promise.all(roots.map((root) => docFiles(root, true)))).flat();
const cache = new Map();
const errors = [];
for (const file of files) {
  const markdown = await readFile(file, "utf8");
  const prose = withoutCode(markdown);
  for (const match of prose.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].trim().split(/\s+/)[0].replace(/^<|>$/g, "");
    const resolved = resolveTarget(file, target);
    if (!resolved) continue;
    const line = markdown.slice(0, match.index).split("\n").length;
    if (resolved.invalid) {
      errors.push(`${file}:${line}: missing ${target}`);
      continue;
    }
    const { targetFile, fragment } = resolved;
    let targetMarkdown = cache.get(targetFile);
    if (targetMarkdown === undefined) {
      targetMarkdown = await readFile(targetFile, "utf8").catch(() => null);
      cache.set(targetFile, targetMarkdown);
    }
    if (targetMarkdown === null) errors.push(`${file}:${line}: missing ${target}`);
    else if (fragment && !anchors(targetMarkdown).has(decodeURIComponent(fragment).toLowerCase())) {
      errors.push(`${file}:${line}: missing anchor ${target}`);
    }
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Checked ${files.length} documentation files.`);
}
