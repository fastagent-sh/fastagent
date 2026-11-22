/**
 * Interactive Pi TUI flows for listing, adding, and removing saved FastAgent remotes (`remotes.json`).
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type RemotesFile, loadRemotes, removeRemote, saveRemote } from "./remotes.ts";

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function loadConfigSafe(ctx: ExtensionContext): { path: string; config: RemotesFile } | undefined {
  try {
    return loadRemotes();
  } catch (error) {
    ctx.ui.notify(errorText(error), "error");
    return undefined;
  }
}

export async function addRemoteFlow(
  ctx: ExtensionContext,
  argName?: string,
  argUrl?: string,
  argKey?: string,
): Promise<string | undefined> {
  let name = argName?.trim() || undefined;
  if (!name) {
    const entered = await ctx.ui.input("Remote name", "e.g. fly, ops, or local");
    if (!entered?.trim()) return undefined;
    name = entered.trim();
  }

  let url = argUrl?.trim() || undefined;
  if (!url) {
    const entered = await ctx.ui.input(`URL for "${name}"`, "https://agent.example.com or http://127.0.0.1:8787");
    if (!entered?.trim()) return undefined;
    url = entered.trim();
  }

  let apiKey = argKey?.trim() || undefined;
  if (argKey === undefined && ctx.hasUI) {
    const entered = await ctx.ui.input(
      `API key for "${name}" (optional)`,
      "$FASTAGENT_API_KEY, raw key, or leave empty to use env FASTAGENT_API_KEY",
    );
    if (entered === undefined) return undefined;
    apiKey = entered.trim() || undefined;
  }

  try {
    const saved = saveRemote(name, {
      type: "http",
      url,
      ...(apiKey !== undefined ? { apiKey } : {}),
    });
    ctx.ui.notify(`Saved remote "${name}" to ${saved.path}`, "info");
    return name;
  } catch (error) {
    ctx.ui.notify(`Failed to save remote: ${errorText(error)}`, "error");
    return undefined;
  }
}

export async function removeRemoteFlow(ctx: ExtensionContext, requested?: string): Promise<void> {
  const loaded = loadConfigSafe(ctx);
  if (!loaded) return;
  const names = Object.keys(loaded.config.remotes);
  if (names.length === 0) {
    ctx.ui.notify("No saved remotes to remove", "info");
    return;
  }
  let target = requested?.trim() || undefined;
  if (!target) {
    const picked = await ctx.ui.select("Remove saved remote", names);
    if (!picked) return;
    target = picked;
  }
  try {
    const res = removeRemote(target);
    ctx.ui.notify(
      res.removed ? `Removed remote "${target}" from ${res.path}` : `Remote "${target}" not found`,
      res.removed ? "info" : "warning",
    );
  } catch (error) {
    ctx.ui.notify(`Failed to remove remote: ${errorText(error)}`, "error");
  }
}

export async function openRemotesPanel(
  ctx: ExtensionContext,
  rest: string[],
  connectByName: (ctx: ExtensionContext, name?: string) => Promise<void>,
): Promise<void> {
  const sub = rest[0]?.toLowerCase();
  if (sub === "add") {
    const added = await addRemoteFlow(ctx, rest[1], rest[2], rest[3]);
    if (added) await connectByName(ctx, added);
    return;
  }
  if (sub === "rm" || sub === "remove") {
    await removeRemoteFlow(ctx, rest[1]);
    return;
  }

  const loaded = loadConfigSafe(ctx);
  if (!loaded) return;
  const names = Object.keys(loaded.config.remotes);
  const options = [
    ...names.map((n) => `Connect: ${n}${n === loaded.config.default ? " (default)" : ""}`),
    "+ Add a remote…",
    ...(names.length > 0 ? ["- Remove a remote…"] : []),
  ];
  const picked = await ctx.ui.select("FastAgent remotes", options);
  if (!picked) return;
  if (picked === "+ Add a remote…") {
    const added = await addRemoteFlow(ctx);
    if (added) await connectByName(ctx, added);
    return;
  }
  if (picked === "- Remove a remote…") {
    await removeRemoteFlow(ctx);
    return;
  }
  const idx = options.indexOf(picked);
  const chosen = names[idx];
  if (chosen) await connectByName(ctx, chosen);
}
