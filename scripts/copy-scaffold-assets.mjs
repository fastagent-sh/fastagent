// Postbuild: copy the scaffold payload (excluded from tsc) into dist verbatim, and chmod the CLI.
// The base workspace kit lives under src/scaffold/templates/; each channel's bundle lives with the
// channel at src/channels/<kind>/scaffold/. The loader resolves these relative to its own module URL,
// so the dist tree must mirror src.
import { chmodSync, cpSync, existsSync, readdirSync } from "node:fs";

cpSync("src/scaffold/templates", "dist/scaffold/templates", { recursive: true });

for (const entry of readdirSync("src/channels", { withFileTypes: true })) {
  const bundle = `src/channels/${entry.name}/scaffold`;
  if (entry.isDirectory() && existsSync(bundle)) {
    cpSync(bundle, `dist/channels/${entry.name}/scaffold`, { recursive: true });
  }
}

chmodSync("dist/cli.js", 0o755);
