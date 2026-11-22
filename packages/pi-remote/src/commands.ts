/**
 * `/fa` command router, smart action menu, and argument autocomplete for `@fastagent-sh/pi-remote`.
 */
import { type ExtensionCommandContext, type ExtensionContext, copyToClipboard } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ModelRef, ThinkingLevel } from "@fastagent-sh/client";
import type { RemoteController } from "./controller.ts";
import {
  type HttpRemoteConfig,
  type RemoteConfig,
  connectRemote,
  isHttpRemote,
  isHttpUrl,
  loadRemotes,
  saveRemote,
} from "./remotes.ts";
import { addRemoteFlow, errorText, loadConfigSafe, openRemotesPanel, removeRemoteFlow } from "./remotes-ui.ts";
import { formatContextSummary, formatRelativeTime, formatUsageSummary, shortId } from "./render.ts";

const PRIMARY_SUBCOMMANDS: readonly { name: string; description: string }[] = [
  { name: "sessions", description: "Switch, create, or delete remote sessions" },
  { name: "new", description: "Start a new remote session" },
  { name: "title", description: "Rename the current remote session [title|--clear]" },
  { name: "fork", description: "Fork the current remote session" },
  { name: "model", description: "Select remote model [provider/modelId]" },
  { name: "key", description: "Update or clear remote server API key [--clear] [remote]" },
  { name: "remotes", description: "Add, remove, or switch saved remotes" },
  { name: "off", description: "Disconnect and return to local Pi" },
];

const RESERVED_SUBCOMMANDS = new Set([
  "connect",
  "disconnect",
  "off",
  "status",
  "sessions",
  "title",
  "delete",
  "new",
  "fork",
  "clone",
  "copy",
  "key",
  "model",
  "model-cycle",
  "thinking",
  "thinking-cycle",
  "compact",
  "cancel",
  "remotes",
  "add",
  "remove",
]);

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function parseModelSpec(spec: string): ModelRef | undefined {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) return undefined;
  return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
}

export interface CommandHost {
  readonly controller: RemoteController;
  attachContext(ctx: ExtensionContext): void;
  getActiveRemoteConfig(): RemoteConfig | undefined;
  clearActiveRemoteConfig(): void;
  connectByName(ctx: ExtensionContext, requestedName?: string, secondArg?: string): Promise<void>;
  connectDirectUrl(ctx: ExtensionContext, url: string, explicitKey?: string): Promise<void>;
  connectResolved(
    ctx: ExtensionContext,
    name: string,
    remote: RemoteConfig,
    options?: {
      sessionId?: string;
      after?: string;
      seenEntryIds?: Iterable<string>;
      persistBinding?: boolean;
      allowHandoff?: boolean;
      showBanner?: boolean;
    },
  ): Promise<void>;
  handoffToCleanView(
    ctx: ExtensionContext,
    handoff: { remoteName: string; remote: RemoteConfig; sessionId: string },
  ): Promise<"handed_off" | "cancelled" | "unsupported">;
}

type CommandHandler = (rest: string[], ctx: ExtensionContext) => Promise<void>;

export function createCommandDispatcher(host: CommandHost) {
  const { controller } = host;

  const requireConnected = (ctx: ExtensionContext): boolean => {
    if (controller.isConnected()) return true;
    ctx.ui.notify("Connect first with /fa", "warning");
    return false;
  };

  const handleDisconnect: CommandHandler = async (_rest, ctx) => {
    if (controller.getState().status === "disconnected") {
      ctx.ui.notify("Not connected to any remote", "info");
      return;
    }
    const name = controller.getState().remoteName;
    host.clearActiveRemoteConfig();
    controller.disconnect();
    ctx.ui.notify(`Disconnected from ${name ?? "remote"}`, "info");
  };

  const handleStatus: CommandHandler = async (_rest, ctx) => {
    const state = controller.getState();
    if (!controller.isConnected()) {
      const loaded = loadConfigSafe(ctx);
      const names = loaded ? Object.keys(loaded.config.remotes) : [];
      ctx.ui.notify(
        names.length > 0
          ? `Disconnected. Configured remotes: ${names.join(", ")} (run /fa or /fa <name>)`
          : `Disconnected. No remotes configured in ${loaded?.path ?? "remotes.json"} (run /fa to set up)`,
        "info",
      );
      return;
    }
    const model = state.session?.model ?? state.agentInfo?.defaultModel;
    const modelStr = model ? `${model.provider}/${model.modelId}` : "default";
    const parts = [`Connected to ${state.remoteName}`];
    if (state.session?.title) parts.push(`"${state.session.title}"`);
    parts.push(`session ${state.session?.id}`);
    parts.push(String(state.session?.status ?? "idle"));
    parts.push(modelStr);
    const ctxStr = formatContextSummary(state.session?.contextUsage);
    if (ctxStr) parts.push(`ctx ${ctxStr}`);
    const usageStr = formatUsageSummary(state.session?.usage);
    if (usageStr) parts.push(usageStr);
    ctx.ui.notify(parts.join(" · "), "info");
  };

  const handleSessions: CommandHandler = async (_rest, ctx) => {
    if (!requireConnected(ctx)) return;
    try {
      const sessions = await controller.listSessions(30);
      const currentId = controller.getState().session?.id;
      const labels = sessions.map((s) => {
        const mark = s.id === currentId ? "* " : "  ";
        const title = s.title ? `${s.title} · ` : "";
        const age = formatRelativeTime(s.updatedAt ?? s.createdAt);
        const agePart = age ? ` · ${age}` : "";
        const model = s.model ? ` [${s.model.provider}/${s.model.modelId}]` : "";
        return `${mark}${title}${s.id} (${s.status}${agePart})${model}`;
      });
      const newOption = "+ New remote session…";
      const picked = await ctx.ui.select("Switch remote session", [...labels, newOption]);
      if (!picked) return;
      if (picked === newOption) {
        await handleNew([], ctx);
        return;
      }
      const chosen = sessions[labels.indexOf(picked)];
      if (!chosen || chosen.id === currentId) return;
      const remoteName = controller.getState().remoteName;
      const activeRemoteConfig = host.getActiveRemoteConfig();
      if (remoteName && activeRemoteConfig) {
        const outcome = await host.handoffToCleanView(ctx, {
          remoteName,
          remote: activeRemoteConfig,
          sessionId: chosen.id,
        });
        if (outcome !== "unsupported") return;
      }
      await controller.switchSession(chosen.id);
      ctx.ui.notify(`Switched to session ${shortId(chosen.id)}`, "info");
    } catch (error) {
      ctx.ui.notify(`Failed to list sessions: ${errorText(error)}`, "error");
    }
  };

  const handleTitle: CommandHandler = async (rest, ctx) => {
    if (!requireConnected(ctx)) return;
    let nextTitle: string | null | undefined;
    if (rest[0] === "--clear") {
      nextTitle = null;
    } else if (rest.length > 0) {
      nextTitle = rest.join(" ").trim();
    } else {
      const entered = await ctx.ui.input(
        "Session title",
        controller.getState().session?.title ?? "Enter a title (leave empty to clear)",
      );
      if (entered === undefined) return;
      nextTitle = entered.trim() === "" ? null : entered.trim();
    }
    try {
      const updated = await controller.updateSession({ title: nextTitle });
      ctx.ui.notify(updated.title ? `Session title set to "${updated.title}"` : "Session title cleared", "info");
    } catch (error) {
      ctx.ui.notify(`Failed to update title: ${errorText(error)}`, "error");
    }
  };

  const handleDelete: CommandHandler = async (rest, ctx) => {
    if (!requireConnected(ctx)) return;
    let targetId = rest[0]?.trim() || undefined;
    if (!targetId) {
      try {
        const sessions = await controller.listSessions(30);
        if (sessions.length === 0) {
          ctx.ui.notify("No remote sessions to delete", "info");
          return;
        }
        const currentId = controller.getState().session?.id;
        const labels = sessions.map((s) => {
          const mark = s.id === currentId ? "* " : "  ";
          const title = s.title ? `${s.title} · ` : "";
          return `${mark}${title}${s.id} (${s.status})`;
        });
        const picked = await ctx.ui.select("Delete remote session", labels);
        if (!picked) return;
        targetId = sessions[labels.indexOf(picked)]?.id;
      } catch (error) {
        ctx.ui.notify(`Failed to list sessions: ${errorText(error)}`, "error");
        return;
      }
    }
    if (!targetId) return;
    const confirmed = ctx.hasUI
      ? await ctx.ui.confirm("Delete remote session", `Delete remote session ${targetId}?`)
      : true;
    if (!confirmed) return;
    try {
      const deletingCurrent = controller.getState().session?.id === targetId;
      await controller.deleteSession(targetId);
      if (deletingCurrent) host.clearActiveRemoteConfig();
      ctx.ui.notify(`Deleted remote session ${shortId(targetId)}`, "info");
    } catch (error) {
      ctx.ui.notify(`Failed to delete session: ${errorText(error)}`, "error");
    }
  };

  const handleNew: CommandHandler = async (_rest, ctx) => {
    if (!requireConnected(ctx)) return;
    try {
      const remoteName = controller.getState().remoteName;
      const activeRemoteConfig = host.getActiveRemoteConfig();
      if (
        remoteName &&
        activeRemoteConfig &&
        typeof (ctx as Partial<ExtensionCommandContext>).newSession === "function"
      ) {
        const created = await controller.createRemoteSession();
        const outcome = await host.handoffToCleanView(ctx, {
          remoteName,
          remote: activeRemoteConfig,
          sessionId: created.id,
        });
        if (outcome !== "unsupported") return;
      }
      const session = await controller.createSession();
      ctx.ui.notify(`Started new remote session ${shortId(session.id)}`, "info");
    } catch (error) {
      ctx.ui.notify(`Failed to create session: ${errorText(error)}`, "error");
    }
  };

  const handleFork: CommandHandler = async (_rest, ctx) => {
    if (!requireConnected(ctx)) return;
    try {
      const remoteName = controller.getState().remoteName;
      const activeRemoteConfig = host.getActiveRemoteConfig();
      if (
        remoteName &&
        activeRemoteConfig &&
        typeof (ctx as Partial<ExtensionCommandContext>).newSession === "function"
      ) {
        const forked = await controller.forkRemoteSession();
        const outcome = await host.handoffToCleanView(ctx, {
          remoteName,
          remote: activeRemoteConfig,
          sessionId: forked.id,
        });
        if (outcome !== "unsupported") return;
      }
      const forked = await controller.forkSession();
      ctx.ui.notify(`Forked into session ${shortId(forked.id)}`, "info");
    } catch (error) {
      ctx.ui.notify(`Failed to fork session: ${errorText(error)}`, "error");
    }
  };

  const handleCopy: CommandHandler = async (_rest, ctx) => {
    if (!requireConnected(ctx)) return;
    const text = controller.getLastAssistantText();
    if (!text) {
      ctx.ui.notify("No remote assistant reply to copy yet", "warning");
      return;
    }
    try {
      await copyToClipboard(text);
      ctx.ui.notify("Copied last remote assistant reply to clipboard", "info");
    } catch (error) {
      ctx.ui.notify(`Failed to copy to clipboard: ${errorText(error)}`, "error");
    }
  };

  const handleProviderAuthHint: CommandHandler = async (rest, ctx) => {
    const verb = rest[0] === "logout" ? "logout" : "login";
    const remoteName = controller.getState().remoteName;
    const target =
      remoteName === undefined
        ? "--url <url>"
        : isHttpUrl(remoteName)
          ? `--url ${remoteName}`
          : `--remote ${remoteName}`;
    ctx.ui.notify(
      `To ${verb} a model provider on the remote FastAgent server, run: fastagent ${verb} ${target}. ` +
        "To update or clear the FastAgent server API key in remotes.json, run: /fa key [--clear].",
      "info",
    );
  };

  const handleKey = async (clearOnly: boolean, rest: string[], ctx: ExtensionContext): Promise<void> => {
    const clear = clearOnly || rest.includes("--clear");
    const argsWithoutFlag = rest.filter((token) => token !== "--clear");
    const loaded = loadConfigSafe(ctx);
    if (!loaded) return;
    const targetName = argsWithoutFlag[0]?.trim() || controller.getState().remoteName;
    if (!targetName) {
      ctx.ui.notify("No remote connected or specified. Usage: /fa key [--clear] <remote>", "warning");
      return;
    }
    const savedRemote = loaded.config.remotes[targetName];
    const isCurrent = controller.isConnected() && controller.getState().remoteName === targetName;
    const currentRemote = savedRemote ?? (isCurrent ? host.getActiveRemoteConfig() : undefined);
    if (!currentRemote) {
      ctx.ui.notify(`Unknown remote "${targetName}". Use /fa remotes add to save one first.`, "error");
      return;
    }
    if (!isHttpRemote(currentRemote)) {
      if (clear && isCurrent) {
        host.clearActiveRemoteConfig();
        controller.disconnect();
      }
      ctx.ui.notify(
        `Remote "${targetName}" uses the "${currentRemote.type}" transport (no saved HTTP API key). Manage credentials via that platform's CLI.`,
        "info",
      );
      return;
    }
    if (clear) {
      let clearedSaved = false;
      if (savedRemote && isHttpRemote(savedRemote) && savedRemote.apiKey !== undefined) {
        const { apiKey: _dropped, ...withoutKey } = savedRemote;
        try {
          saveRemote(targetName, withoutKey);
          clearedSaved = true;
        } catch (error) {
          ctx.ui.notify(`Failed to clear saved key: ${errorText(error)}`, "error");
          return;
        }
      }
      if (isCurrent) {
        host.clearActiveRemoteConfig();
        controller.disconnect();
      }
      ctx.ui.notify(
        clearedSaved
          ? `Cleared saved server API key for "${targetName}"${isCurrent ? " and disconnected" : ""}`
          : `No stored server API key for "${targetName}" (env FASTAGENT_API_KEY applies)${isCurrent ? "; disconnected" : ""}`,
        "info",
      );
      return;
    }
    const entered = await ctx.ui.input(
      `Server API key for remote "${targetName}"`,
      currentRemote.apiKey?.startsWith("$")
        ? `Current: ${currentRemote.apiKey} — enter new $ENV_VAR or raw key`
        : "$FASTAGENT_API_KEY or raw API key",
    );
    if (entered === undefined) return;
    const nextKey = entered.trim();
    if (!nextKey) {
      ctx.ui.notify("Server API key unchanged (use /fa key --clear to clear a stored key)", "info");
      return;
    }
    const updatedRemote: HttpRemoteConfig = { ...currentRemote, apiKey: nextKey };
    try {
      const { agent } = await connectRemote(targetName, updatedRemote);
      await agent.info();
      if (savedRemote) saveRemote(targetName, updatedRemote);
      if (isCurrent) {
        const currentState = controller.getState();
        const currentSessionId = currentState.session?.id;
        await host.connectResolved(ctx, targetName, updatedRemote, {
          ...(currentSessionId !== undefined ? { sessionId: currentSessionId } : {}),
          ...(currentState.lastEntryId !== undefined ? { after: currentState.lastEntryId } : {}),
          seenEntryIds: controller.getSeenEntryIds(),
          persistBinding: false,
          allowHandoff: false,
          showBanner: false,
        });
        ctx.ui.notify(`Verified server API key and reconnected to "${targetName}"`, "info");
      } else {
        ctx.ui.notify(`Verified and updated server API key for "${targetName}" in ${loaded.path}`, "info");
      }
    } catch (error) {
      ctx.ui.notify(`Failed to authenticate "${targetName}" (existing config unchanged): ${errorText(error)}`, "error");
    }
  };

  const handleModel: CommandHandler = async (rest, ctx) => {
    if (!requireConnected(ctx)) return;
    const info = controller.getState().agentInfo;
    let target: ModelRef | undefined;
    if (rest[0]) {
      target = parseModelSpec(rest[0]);
      if (!target) {
        ctx.ui.notify('Expected "provider/modelId"', "error");
        return;
      }
    } else {
      const models = info?.models ?? [];
      if (models.length === 0) {
        ctx.ui.notify("Remote reports no selectable models", "warning");
        return;
      }
      const current = controller.getState().session?.model ?? info?.defaultModel;
      const labels = models.map((m) => {
        const isCurrent = current?.provider === m.provider && current?.modelId === m.modelId;
        return `${isCurrent ? "* " : "  "}${m.provider}/${m.modelId}`;
      });
      const picked = await ctx.ui.select("Select remote model", labels);
      if (!picked) return;
      const chosen = models[labels.indexOf(picked)];
      if (chosen) target = { provider: chosen.provider, modelId: chosen.modelId };
    }
    if (!target) return;
    try {
      await controller.updateSession({ model: target });
      ctx.ui.notify(`Remote model set to ${target.provider}/${target.modelId}`, "info");
    } catch (error) {
      ctx.ui.notify(`Failed to switch model: ${errorText(error)}`, "error");
    }
  };

  const handleModelCycle: CommandHandler = async (rest, ctx) => {
    if (!controller.isConnected()) return;
    const models = controller.getState().agentInfo?.models ?? [];
    if (models.length <= 1) {
      ctx.ui.notify(
        models.length === 0 ? "Remote reports no selectable models" : "Only one model available on this remote",
        models.length === 0 ? "warning" : "info",
      );
      return;
    }
    const current = controller.getState().session?.model ?? controller.getState().agentInfo?.defaultModel;
    const idx = current
      ? models.findIndex((m) => m.provider === current.provider && m.modelId === current.modelId)
      : -1;
    const delta = rest[0] === "prev" ? -1 : 1;
    const next = models[idx === -1 ? 0 : (idx + delta + models.length) % models.length];
    if (!next) return;
    try {
      await controller.updateSession({ model: { provider: next.provider, modelId: next.modelId } });
      ctx.ui.notify(`Remote model: ${next.provider}/${next.modelId}`, "info");
    } catch (error) {
      ctx.ui.notify(`Failed to switch remote model: ${errorText(error)}`, "error");
    }
  };

  const handleThinking: CommandHandler = async (rest, ctx) => {
    if (!requireConnected(ctx)) return;
    let level = rest[0] as ThinkingLevel | undefined;
    if (!level) {
      const picked = await ctx.ui.select("Select remote thinking level", [...THINKING_LEVELS]);
      if (!picked) return;
      level = picked as ThinkingLevel;
    }
    if (!THINKING_LEVELS.includes(level)) {
      ctx.ui.notify(`Invalid thinking level "${level}". Expected one of: ${THINKING_LEVELS.join(", ")}`, "error");
      return;
    }
    try {
      await controller.updateSession({ thinkingLevel: level });
      ctx.ui.notify(`Remote thinking level set to ${level}`, "info");
    } catch (error) {
      ctx.ui.notify(`Failed to update thinking level: ${errorText(error)}`, "error");
    }
  };

  const handleThinkingCycle: CommandHandler = async (_rest, ctx) => {
    if (!controller.isConnected()) return;
    const info = controller.getState().agentInfo;
    const current = controller.getState().session?.model ?? info?.defaultModel;
    const declared = current
      ? info?.models.find((m) => m.provider === current.provider && m.modelId === current.modelId)?.thinkingLevels
      : undefined;
    const levels = declared && declared.length > 0 ? declared : THINKING_LEVELS;
    if (levels.length <= 1) {
      ctx.ui.notify("Current remote model does not support changing thinking level", "info");
      return;
    }
    const activeLevel = controller.getState().session?.thinkingLevel ?? levels[0];
    const idx = activeLevel ? levels.indexOf(activeLevel) : -1;
    const next = levels[(idx + 1) % levels.length];
    if (!next) return;
    try {
      await controller.updateSession({ thinkingLevel: next });
      ctx.ui.notify(`Remote thinking level: ${next}`, "info");
    } catch (error) {
      ctx.ui.notify(`Failed to update remote thinking level: ${errorText(error)}`, "error");
    }
  };

  const handleCompact: CommandHandler = async (rest, ctx) => {
    if (!requireConnected(ctx)) return;
    try {
      await controller.compact(rest.length > 0 ? rest.join(" ") : undefined);
      ctx.ui.notify("Requested remote compaction", "info");
    } catch (error) {
      ctx.ui.notify(`Remote compaction failed: ${errorText(error)}`, "error");
    }
  };

  const handleCancel: CommandHandler = async (_rest, ctx) => {
    if (!controller.isConnected()) {
      ctx.ui.notify("Not connected to any remote", "warning");
      return;
    }
    try {
      const res = await controller.cancel();
      ctx.ui.notify(
        res.stopped.length > 0 ? `Canceled ${res.stopped.length} message(s)` : "Remote session is idle",
        "info",
      );
    } catch (error) {
      ctx.ui.notify(`Cancel failed: ${errorText(error)}`, "error");
    }
  };

  const handlers: Record<string, CommandHandler> = {
    connect: (rest, ctx) => host.connectByName(ctx, rest[0], rest[1]),
    add: async (rest, ctx) => {
      const added = await addRemoteFlow(ctx, rest[0], rest[1], rest[2]);
      if (added) await host.connectByName(ctx, added);
    },
    remove: (rest, ctx) => removeRemoteFlow(ctx, rest[0]),
    remotes: (rest, ctx) => openRemotesPanel(ctx, rest, (c, name) => host.connectByName(c, name)),
    off: handleDisconnect,
    disconnect: handleDisconnect,
    status: handleStatus,
    sessions: handleSessions,
    title: handleTitle,
    delete: handleDelete,
    new: handleNew,
    clone: handleFork,
    fork: handleFork,
    copy: handleCopy,
    "provider-auth-hint": handleProviderAuthHint,
    key: (rest, ctx) => handleKey(false, rest, ctx),
    "key-clear": (rest, ctx) => handleKey(true, rest, ctx),
    model: handleModel,
    "model-cycle": handleModelCycle,
    thinking: handleThinking,
    "thinking-cycle": handleThinkingCycle,
    compact: handleCompact,
    cancel: handleCancel,
  };

  const dispatchAction = async (sub: string, rest: string[], ctx: ExtensionContext): Promise<void> => {
    host.attachContext(ctx);
    const handler = handlers[sub];
    if (handler !== undefined) {
      await handler(rest, ctx);
      return;
    }
    if (isHttpUrl(sub)) {
      await host.connectDirectUrl(ctx, sub, rest[0]);
      return;
    }
    const loaded = loadConfigSafe(ctx);
    if (loaded?.config.remotes[sub]) {
      await host.connectByName(ctx, sub, rest[0]);
      return;
    }
    ctx.ui.notify(
      `Unknown remote or /fa subcommand "${sub}". Run /fa for menu, or /fa remotes to manage remotes.`,
      "error",
    );
  };

  const openSmartHome = async (ctx: ExtensionContext): Promise<void> => {
    if (!controller.isConnected()) {
      const loaded = loadConfigSafe(ctx);
      if (!loaded) return;
      const names = Object.keys(loaded.config.remotes);
      if (names.length === 0) {
        const added = await addRemoteFlow(ctx);
        if (added) await host.connectByName(ctx, added);
        return;
      }
      const options = [...names.map((n) => (n === loaded.config.default ? `${n} (default)` : n)), "+ Add a remote…"];
      const picked = await ctx.ui.select("Connect to FastAgent remote", options);
      if (!picked) return;
      if (picked === "+ Add a remote…") {
        const added = await addRemoteFlow(ctx);
        if (added) await host.connectByName(ctx, added);
        return;
      }
      const chosen = names[options.indexOf(picked)];
      if (chosen) await host.connectByName(ctx, chosen);
      return;
    }

    const state = controller.getState();
    const label = state.session?.title
      ? `${state.remoteName} · ${state.session.title}`
      : (state.remoteName ?? "remote");
    const actions: Array<{ label: string; cmd: string }> = [
      { label: "Resume / switch session (/resume)", cmd: "sessions" },
      { label: "New remote session (/new)", cmd: "new" },
      { label: "Rename session (/name)", cmd: "title" },
      { label: "Fork session (/fork)", cmd: "fork" },
      { label: "Switch model (/model)", cmd: "model" },
      { label: "Thinking level (/thinking)", cmd: "thinking" },
      { label: "Compact session (/compact)", cmd: "compact" },
      { label: "Copy last assistant reply (/copy)", cmd: "copy" },
      { label: "Delete a session (/fa delete)", cmd: "delete" },
      { label: "Update remote server API key (/fa key)", cmd: "key" },
      { label: "Clear remote server API key (/fa key --clear)", cmd: "key-clear" },
      { label: "Switch / manage remotes (/fa remotes)", cmd: "remotes" },
      { label: "Disconnect to local Pi (/fa off)", cmd: "off" },
    ];
    const picked = await ctx.ui.select(
      `FastAgent (${label})`,
      actions.map((a) => a.label),
    );
    if (!picked) return;
    const action = actions.find((a) => a.label === picked);
    if (action) await dispatchAction(action.cmd, [], ctx);
  };

  return { dispatchAction, openSmartHome };
}

export function getFaArgumentCompletions(prefix: string, controller: RemoteController): AutocompleteItem[] | null {
  const trimmed = prefix.trimStart();
  if (!trimmed.includes(" ")) {
    const items: AutocompleteItem[] = [];
    try {
      const { config } = loadRemotes();
      for (const name of Object.keys(config.remotes)) {
        if (!RESERVED_SUBCOMMANDS.has(name) && name.startsWith(trimmed)) {
          items.push({ value: name, label: name, description: "connect to saved remote" });
        }
      }
    } catch {
      // Ignore malformed remotes.json during tab completion.
    }
    for (const s of PRIMARY_SUBCOMMANDS) {
      if (s.name.startsWith(trimmed)) {
        items.push({ value: s.name, label: s.name, description: s.description });
      }
    }
    return items.length > 0 ? items : null;
  }
  const [sub, arg = ""] = trimmed.split(/\s+/, 2);
  if (sub === "connect" || sub === "remove" || sub === "key") {
    try {
      const { config } = loadRemotes();
      const items = Object.keys(config.remotes)
        .filter((name) => name.startsWith(arg))
        .map((name) => ({ value: `${sub} ${name}`, label: name, description: "remote" }));
      return items.length > 0 ? items : null;
    } catch {
      return null;
    }
  }
  if (sub === "remotes") {
    const subs = [
      { value: "remotes add", label: "add", description: "Add and save a remote" },
      { value: "remotes remove", label: "remove", description: "Remove a saved remote" },
    ].filter((item) => item.label.startsWith(arg));
    return subs.length > 0 ? subs : null;
  }
  if (sub === "thinking") {
    const items = THINKING_LEVELS.filter((l) => l.startsWith(arg)).map((l) => ({
      value: `thinking ${l}`,
      label: l,
    }));
    return items.length > 0 ? items : null;
  }
  if (sub === "model") {
    const models = controller.getState().agentInfo?.models ?? [];
    const items = models
      .map((m) => `${m.provider}/${m.modelId}`)
      .filter((spec) => spec.startsWith(arg))
      .map((spec) => ({ value: `model ${spec}`, label: spec }));
    return items.length > 0 ? items : null;
  }
  return null;
}
