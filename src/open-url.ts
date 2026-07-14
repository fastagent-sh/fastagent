import { spawn } from "node:child_process";

/** Best-effort open a URL in the default browser. Callers must also print the URL for headless use. */
export function openExternalUrl(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).on("error", () => {});
}
