import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";

const roots = ["README.md", "CONTRIBUTING.md", "SECURITY.md", "AGENTS.md", "docs", ".github"];

async function markdownFiles(path) {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => undefined);
  if (!entries) return extname(path) === ".md" ? [path] : [];
  const nested = await Promise.all(entries.map((entry) => markdownFiles(resolve(path, entry.name))));
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

const files = (await Promise.all(roots.map(markdownFiles))).flat();
const cache = new Map();
const errors = [];
for (const file of files) {
  const markdown = await readFile(file, "utf8");
  const prose = withoutCode(markdown);
  for (const match of prose.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].trim().split(/\s+/)[0].replace(/^<|>$/g, "");
    if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
    const [pathPart, fragment] = target.split("#", 2);
    const targetFile = resolve(dirname(file), pathPart || file);
    let targetMarkdown = cache.get(targetFile);
    if (targetMarkdown === undefined) {
      targetMarkdown = await readFile(targetFile, "utf8").catch(() => null);
      cache.set(targetFile, targetMarkdown);
    }
    const line = markdown.slice(0, match.index).split("\n").length;
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
  console.log(`Checked ${files.length} Markdown files.`);
}
