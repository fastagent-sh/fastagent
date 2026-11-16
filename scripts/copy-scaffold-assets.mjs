// Postbuild: copy the scaffold templates (excluded from tsc) into dist verbatim, and chmod the CLI. The loader
// resolves them relative to its own module URL, so the dist tree must mirror src.
import { chmodSync, cpSync } from "node:fs";

cpSync("src/scaffold/templates", "dist/scaffold/templates", { recursive: true });

chmodSync("dist/cli.js", 0o755);
