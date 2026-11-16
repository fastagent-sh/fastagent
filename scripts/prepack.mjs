// Prepack, run in a package's directory: the repository's LICENSE goes into every package, and with `--readme` its
// README too (the package without one of its own). Both copies are ignored by git.
import { copyFileSync } from "node:fs";

copyFileSync("../../LICENSE", "LICENSE");
if (process.argv.includes("--readme")) copyFileSync("../../README.md", "README.md");
