/**
 * Railway's upload is filtered before Docker receives the build context. Its custom .railwayignore rules outrank
 * .ignore and git ignore files; required context declarations and snapshots must survive that upload too.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import ignore from "ignore";
import { loadContexts } from "../../content/file.ts";
import { contextCopyFiles } from "../../contexts/copy.ts";
import { gitFor } from "../../git.ts";
import { isUnderDir, readTextIfExists } from "../../paths.ts";

export async function excludedRailwayContexts(agentDir: string): Promise<string[]> {
  const paths = loadContexts(agentDir).flatMap((context) => contextCopyFiles(context.name));
  if (paths.length === 0) return [];
  const directory = realpathSync(agentDir);
  const root = resolve(directory, "/");
  const ancestors = new Set<string>();
  for (const path of paths) {
    let current = dirname(join(directory, path));
    while (true) {
      ancestors.add(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  const scopes = [...ancestors].sort((a, b) => a.split("/").length - b.split("/").length);
  const matcher = ignore({ ignorecase: false });
  const addFile = async (path: string, scope: string): Promise<void> => {
    const text = await readTextIfExists(path);
    if (text !== undefined) matcher.add(scopedPatterns(text, relative(root, scope)));
  };
  const git = gitFor("checking Railway's git ignore rules before uploading contexts");
  const repository = git.answer(["rev-parse", "--show-toplevel"], directory);
  // WalkBuilder requires a repository for git ignores; .ignore and .railwayignore apply without one.
  if (repository !== undefined) {
    const configured = git.answer(["config", "--path", "--get", "core.excludesfile"], directory);
    const global = configured ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "git", "ignore");
    if (global !== "") await addFile(resolve(directory, global), repository);
    const info = git.answer(["rev-parse", "--git-path", "info/exclude"], directory);
    if (info !== undefined) await addFile(resolve(directory, info), repository);
    for (const scope of scopes) {
      if (isUnderDir(scope, repository)) await addFile(join(scope, ".gitignore"), scope);
    }
  }
  for (const filename of [".ignore", ".railwayignore"]) {
    for (const scope of scopes) await addFile(join(scope, filename), scope);
  }
  return paths.filter((path) => {
    // Railway hard-skips these path components regardless of whitelist rules.
    if (path.split("/").some((component) => component === ".git" || component === "node_modules")) return true;
    return matcher.ignores(relative(root, join(directory, path)));
  });
}

function scopedPatterns(text: string, scope: string): string[] {
  const prefix = scope ? `${scope}/` : "";
  return text.split(/\r?\n/).flatMap((line) => {
    if (line.trim() === "" || line.startsWith("#")) return [];
    const negative = line.startsWith("!");
    const pattern = negative ? line.slice(1) : line;
    if (pattern === "") return [];
    const anchored = pattern.startsWith("/") || pattern.replace(/\/$/, "").includes("/");
    const local = anchored ? pattern.replace(/^\//, "") : `**/${pattern}`;
    return [`${negative ? "!" : ""}/${prefix}${local}`];
  });
}
