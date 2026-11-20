/**
 * Pi ExtensionAPI host glue for `@fastagent-sh/pi-remote`: wires `RemoteController` into Pi's input interception,
 * live widget, durable custom entries, footer, slash-command autocomplete, Esc cancellation, and `/fa` commands.
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, type AutocompleteProvider, matchesKey } from "@earendil-works/pi-tui";
import type { Entry, ModelRef, ThinkingLevel } from "@fastagent-sh/client";
import { RemoteController, type RemoteViewState, buildSendContent } from "./controller.ts";
import {
  type HttpRemoteConfig,
  type RemotesFile,
  connectRemote,
  isHttpUrl,
  loadRemotes,
  removeRemote,
  saveRemote,
} from "./remotes.ts";
import {
  type RemoteEntryPayload,
  createLiveWidgetComponent,
  hasLiveContent,
  renderRemoteEntry,
  renderRemoteFooterLine,
  shortId,
} from "./render.ts";
import { TerminalStatusReporter } from "./terminal-status.ts";

export const REMOTE_ENTRY_TYPE = "fastagent-remote-entry";
const LIVE_WIDGET_KEY = "fastagent-remote-live";

const SUBCOMMANDS: readonly { name: string; description: string }[] = [
  { name: "connect", description: "Connect to a remote FastAgent [name|url] [sessionId|apiKey]" },
  { name: "add", description: "Add and save a remote [name] [url] [apiKey]" },
  { name: "remove", description: "Remove a saved remote [name]" },
  { name: "disconnect", description: "Disconnect and return to local Pi" },
  { name: "status", description: "Show current remote connection and session status" },
  { name: "sessions", description: "List and switch remote sessions" },
  { name: "new", description: "Create a new session on the connected remote" },
  { name: "model", description: "Select remote model [provider/modelId]" },
  { name: "thinking", description: "Set remote thinking level [off|minimal|low|medium|high|xhigh|max]" },
  { name: "fork", description: "Fork the current remote session" },
  { name: "compact", description: "Compact the current remote session [instructions]" },
  { name: "cancel", description: "Cancel the currently running remote turn" },
  { name: "schedules", description: "List remote schedules" },
  { name: "run", description: "Run a remote schedule now <name>" },
  { name: "wakeups", description: "List pending remote wake-ups" },
];

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseModelSpec(spec: string): ModelRef | undefined {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) return undefined;
  return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
}

function wrapAutocompleteWithRemoteCommands(
  base: AutocompleteProvider,
  getState: () => RemoteViewState,
): AutocompleteProvider {
  return {
    ...(base.triggerCharacters ? { triggerCharacters: base.triggerCharacters } : {}),
    ...(base.shouldTriggerFileCompletion
      ? { shouldTriggerFileCompletion: base.shouldTriggerFileCompletion.bind(base) }
      : {}),
    applyCompletion: base.applyCompletion.bind(base),
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const baseResult = await base.getSuggestions(lines, cursorLine, cursorCol, options);
      const state = getState();
      if (state.status === "disconnected" || !state.agentInfo?.commands.length) return baseResult;
      const line = lines[cursorLine] ?? "";
      const beforeCursor = line.slice(0, cursorCol);
      if (!beforeCursor.startsWith("/") || beforeCursor.includes(" ")) return baseResult;

      const prefix = beforeCursor.slice(1).toLowerCase();
      const remoteItems: AutocompleteItem[] = state.agentInfo.commands
        .filter((cmd) => cmd.name.toLowerCase().startsWith(prefix))
        .map((cmd) => ({
          value: `/${cmd.name}`,
          label: `/${cmd.name}`,
          description: cmd.description ? `[remote] ${cmd.description}` : "[remote]",
        }));
      if (remoteItems.length === 0) return baseResult;

      const existing = new Set((baseResult?.items ?? []).map((item) => item.value));
      const merged = [...(baseResult?.items ?? []), ...remoteItems.filter((item) => !existing.has(item.value))];
      return { items: merged, prefix: baseResult?.prefix ?? beforeCursor };
    },
  };
}

export function registerFastAgentRemoteExtension(pi: ExtensionAPI): void {
  let activeCtx: ExtensionContext | undefined;
  let unsubscribeTerminalInput: (() => void) | undefined;
  let requestFooterRender: (() => void) | undefined;
  let requestWidgetRender: (() => void) | undefined;
  let autocompleteInstalled = false;
  let widgetMounted = false;
  let footerMounted = false;

  const terminalStatus = new TerminalStatusReporter();

  const syncUi = (state: RemoteViewState) => {
    const ctx = activeCtx;
    if (!ctx?.hasUI) return;

    if (state.status === "disconnected") {
      if (widgetMounted) {
        ctx.ui.setWidget(LIVE_WIDGET_KEY, undefined);
        widgetMounted = false;
        requestWidgetRender = undefined;
      }
      if (footerMounted) {
        ctx.ui.setFooter(undefined);
        footerMounted = false;
        requestFooterRender = undefined;
      }
      ctx.ui.setStatus("fastagent-remote", undefined);
      terminalStatus.clear();
      return;
    }

    if (ctx.mode === "tui") {
      if (!footerMounted) {
        footerMounted = true;
        ctx.ui.setFooter((tui, theme) => {
          requestFooterRender = () => tui.requestRender();
          return {
            invalidate() {},
            dispose() {
              requestFooterRender = undefined;
            },
            render(width: number) {
              return [renderRemoteFooterLine(controller.getState(), width, theme)];
            },
          };
        });
      } else {
        requestFooterRender?.();
      }

      const wantWidget = hasLiveContent(state);
      if (wantWidget && !widgetMounted) {
        widgetMounted = true;
        ctx.ui.setWidget(LIVE_WIDGET_KEY, (tui, theme) => {
          requestWidgetRender = () => tui.requestRender();
          const inner = createLiveWidgetComponent(() => controller.getState(), theme);
          return {
            invalidate() {
              inner.invalidate();
            },
            dispose() {
              requestWidgetRender = undefined;
            },
            render(width: number) {
              return inner.render(width);
            },
          };
        });
      } else if (!wantWidget && widgetMounted) {
        ctx.ui.setWidget(LIVE_WIDGET_KEY, undefined);
        widgetMounted = false;
        requestWidgetRender = undefined;
      } else if (wantWidget) {
        requestWidgetRender?.();
      }
    }

    const sessionStatus = state.session?.status;
    if (state.status === "reconnecting") {
      terminalStatus.report("working", `Reconnecting to ${state.remoteName ?? "remote"}`);
    } else if (sessionStatus === "running") {
      const toolName = state.activeTools.at(-1)?.name;
      terminalStatus.report("working", toolName ? `${state.remoteName}: ${toolName}` : state.remoteName);
    }
  };

  const controller = new RemoteController({
    onStateChange: (state) => {
      syncUi(state);
    },
    onEntry: (entry: Entry) => {
      const state = controller.getState();
      if (!state.remoteName || !state.session) return;
      pi.appendEntry<RemoteEntryPayload>(REMOTE_ENTRY_TYPE, {
        remoteName: state.remoteName,
        sessionId: state.session.id,
        entry,
      });
    },
    onDone: (message) => {
      const name = controller.getState().remoteName ?? "remote";
      if (message.status === "failed") {
        const reason = message.error?.message ?? "Remote turn failed";
        terminalStatus.report("error", `${name}: ${reason}`);
        activeCtx?.ui.notify(`[${name}] ${reason}`, "error");
      } else if (message.status === "canceled") {
        terminalStatus.report("idle", name);
        activeCtx?.ui.notify(`[${name}] Canceled`, "info");
      } else {
        terminalStatus.report("done", name);
      }
    },
    onError: (error) => {
      const name = controller.getState().remoteName ?? "remote";
      terminalStatus.report("error", `${name}: ${error.message}`);
      activeCtx?.ui.notify(`[${name}] ${error.message}`, "error");
    },
  });

  const attachContext = (ctx: ExtensionContext) => {
    activeCtx = ctx;
    if (ctx.mode === "tui") {
      if (!autocompleteInstalled) {
        autocompleteInstalled = true;
        ctx.ui.addAutocompleteProvider((base) => wrapAutocompleteWithRemoteCommands(base, () => controller.getState()));
      }
      unsubscribeTerminalInput?.();
      unsubscribeTerminalInput = ctx.ui.onTerminalInput((data) => {
        const state = controller.getState();
        if (!controller.isConnected() || state.session?.status !== "running") return undefined;
        if (!matchesKey(data, "escape")) return undefined;
        void controller.cancel().catch((error) => {
          activeCtx?.ui.notify(`Cancel failed: ${errorText(error)}`, "error");
        });
        return { consume: true };
      });
    }
  };

  const loadConfigSafe = (ctx: ExtensionContext): { path: string; config: RemotesFile } | undefined => {
    try {
      return loadRemotes();
    } catch (error) {
      ctx.ui.notify(errorText(error), "error");
      return undefined;
    }
  };

  const connectDirectUrl = async (ctx: ExtensionContext, url: string, explicitKey?: string): Promise<void> => {
    let apiKey = explicitKey?.trim() || undefined;
    if (!apiKey && !process.env.FASTAGENT_API_KEY?.trim() && ctx.hasUI) {
      const entered = await ctx.ui.input(
        "API key for remote FastAgent",
        "$FASTAGENT_API_KEY or raw key (leave empty if set in env)",
      );
      if (entered === undefined) return;
      apiKey = entered.trim() || undefined;
    }
    let displayName = url;
    try {
      displayName = new URL(url).host || url;
    } catch {
      // Keep raw string when URL parsing fails; connectRemote surfaces any bad URL.
    }
    const remote: HttpRemoteConfig = {
      type: "http",
      url,
      ...(apiKey !== undefined ? { apiKey } : {}),
    };
    try {
      const { agent } = await connectRemote(displayName, remote);
      const session = await controller.connect(displayName, agent);
      ctx.ui.notify(`Connected to ${displayName} (session ${shortId(session.id)})`, "info");
    } catch (error) {
      ctx.ui.notify(`Failed to connect to ${displayName}: ${errorText(error)}`, "error");
    }
  };

  const addRemoteFlow = async (
    ctx: ExtensionContext,
    argName?: string,
    argUrl?: string,
    argKey?: string,
  ): Promise<string | undefined> => {
    let name = argName?.trim() || undefined;
    if (!name) {
      const entered = await ctx.ui.input("Remote name", "e.g. ops or local");
      if (!entered?.trim()) return undefined;
      name = entered.trim();
    }

    let url = argUrl?.trim() || undefined;
    if (!url) {
      const entered = await ctx.ui.input(`URL for "${name}"`, "https://agent.example.com or http://127.0.0.1:4100");
      if (!entered?.trim()) return undefined;
      url = entered.trim();
    }

    let apiKey = argKey?.trim() || undefined;
    if (argKey === undefined && !argUrl) {
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
  };

  const connectByName = async (ctx: ExtensionContext, requestedName?: string, secondArg?: string): Promise<void> => {
    const trimmed = requestedName?.trim() || undefined;
    if (trimmed && isHttpUrl(trimmed)) {
      await connectDirectUrl(ctx, trimmed, secondArg);
      return;
    }

    const loaded = loadConfigSafe(ctx);
    if (!loaded) return;
    const names = Object.keys(loaded.config.remotes);
    if (names.length === 0) {
      if (!ctx.hasUI) {
        ctx.ui.notify(`No remotes configured in ${loaded.path}. Run /fa add or /fa connect <url>.`, "warning");
        return;
      }
      const added = await addRemoteFlow(ctx, trimmed);
      if (!added) return;
      await connectByName(ctx, added);
      return;
    }

    let name = trimmed;
    if (!name) {
      if (loaded.config.default && loaded.config.remotes[loaded.config.default]) {
        name = loaded.config.default;
      } else if (names.length === 1) {
        name = names[0];
      } else {
        const picked = await ctx.ui.select("Select FastAgent remote", names);
        if (!picked) return;
        name = picked;
      }
    }
    if (!name) return;

    const remote = loaded.config.remotes[name];
    if (!remote) {
      ctx.ui.notify(`Unknown remote "${name}". Configured: ${names.join(", ")}. Use /fa add to save one.`, "error");
      return;
    }

    try {
      const { agent, defaultSessionId } = await connectRemote(name, remote);
      const targetSession = secondArg ?? defaultSessionId;
      const session = await controller.connect(name, agent, {
        ...(targetSession !== undefined ? { sessionId: targetSession } : {}),
      });
      ctx.ui.notify(`Connected to ${name} (session ${shortId(session.id)})`, "info");
    } catch (error) {
      ctx.ui.notify(`Failed to connect to ${name}: ${errorText(error)}`, "error");
    }
  };

  pi.registerFlag("fa", {
    description: "Connect to a configured FastAgent remote on startup",
    type: "string",
  });

  pi.registerEntryRenderer<RemoteEntryPayload>(REMOTE_ENTRY_TYPE, (entry, options, theme) => {
    if (!entry.data) return undefined;
    return renderRemoteEntry(entry.data, options, theme);
  });

  pi.on("session_start", async (_event, ctx) => {
    attachContext(ctx);
    const startupRemote = pi.getFlag("fa");
    if (typeof startupRemote === "string" && startupRemote.trim() !== "") {
      await connectByName(ctx, startupRemote.trim());
    }
  });

  pi.on("session_shutdown", () => {
    unsubscribeTerminalInput?.();
    unsubscribeTerminalInput = undefined;
    controller.disconnect();
    terminalStatus.clear();
  });

  pi.on("input", async (event, ctx) => {
    if (!controller.isConnected()) return { action: "continue" };
    if (event.source === "extension") return { action: "continue" };
    attachContext(ctx);

    const content = buildSendContent(event.text, event.images);
    const whenBusy = event.streamingBehavior === "followUp" ? "queue" : undefined;
    try {
      await controller.send(content, whenBusy ? { whenBusy } : {});
    } catch (error) {
      ctx.ui.notify(`Remote send failed: ${errorText(error)}`, "error");
    }
    return { action: "handled" };
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (!controller.isConnected()) return undefined;
    try {
      await controller.compact(event.customInstructions);
      ctx.ui.notify("Requested remote compaction", "info");
    } catch (error) {
      ctx.ui.notify(`Remote compaction failed: ${errorText(error)}`, "error");
    }
    return { cancel: true };
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    if (!controller.isConnected()) return;
    try {
      await controller.updateSession({ thinkingLevel: event.level });
      ctx.ui.notify(`Remote thinking level set to ${event.level}`, "info");
    } catch (error) {
      ctx.ui.notify(`Failed to set remote thinking level: ${errorText(error)}`, "error");
    }
  });

  pi.on("session_before_tree", (_event, ctx) => {
    if (!controller.isConnected()) return undefined;
    ctx.ui.notify("Remote sessions are linear; use /fa fork to branch the remote session.", "warning");
    return { cancel: true };
  });

  const handleCommand = async (rawArgs: string, ctx: ExtensionCommandContext): Promise<void> => {
    attachContext(ctx);
    const tokens = rawArgs.trim() ? rawArgs.trim().split(/\s+/) : [];
    const sub = tokens[0] ?? "status";
    const rest = tokens.slice(1);

    switch (sub) {
      case "connect": {
        await connectByName(ctx, rest[0], rest[1]);
        return;
      }
      case "add": {
        const added = await addRemoteFlow(ctx, rest[0], rest[1], rest[2]);
        if (added) await connectByName(ctx, added);
        return;
      }
      case "remove": {
        const loaded = loadConfigSafe(ctx);
        if (!loaded) return;
        const names = Object.keys(loaded.config.remotes);
        if (names.length === 0) {
          ctx.ui.notify("No saved remotes to remove", "info");
          return;
        }
        let target = rest[0]?.trim() || undefined;
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
        return;
      }
      case "disconnect": {
        if (!controller.isConnected()) {
          ctx.ui.notify("Not connected to any remote", "info");
          return;
        }
        const name = controller.getState().remoteName;
        controller.disconnect();
        ctx.ui.notify(`Disconnected from ${name ?? "remote"}`, "info");
        return;
      }
      case "status": {
        const state = controller.getState();
        if (!controller.isConnected()) {
          const loaded = loadConfigSafe(ctx);
          const names = loaded ? Object.keys(loaded.config.remotes) : [];
          ctx.ui.notify(
            names.length > 0
              ? `Disconnected. Configured remotes: ${names.join(", ")} (use /fa connect <name>)`
              : `Disconnected. No remotes configured in ${loaded?.path ?? "remotes.json"}`,
            "info",
          );
          return;
        }
        const model = state.session?.model ?? state.agentInfo?.defaultModel;
        const modelStr = model ? `${model.provider}/${model.modelId}` : "default";
        ctx.ui.notify(
          `Connected to ${state.remoteName} · session ${state.session?.id} · ${state.session?.status} · ${modelStr}`,
          "info",
        );
        return;
      }
      case "sessions": {
        if (!controller.isConnected()) {
          ctx.ui.notify("Connect first with /fa connect <name>", "warning");
          return;
        }
        try {
          const sessions = await controller.listSessions(30);
          if (sessions.length === 0) {
            ctx.ui.notify("No remote sessions found", "info");
            return;
          }
          const currentId = controller.getState().session?.id;
          const labels = sessions.map((s) => {
            const mark = s.id === currentId ? "* " : "  ";
            const model = s.model ? ` [${s.model.provider}/${s.model.modelId}]` : "";
            return `${mark}${s.id} (${s.status})${model}`;
          });
          const picked = await ctx.ui.select("Switch remote session", labels);
          if (!picked) return;
          const idx = labels.indexOf(picked);
          const chosen = sessions[idx];
          if (!chosen || chosen.id === currentId) return;
          await controller.switchSession(chosen.id);
          ctx.ui.notify(`Switched to session ${shortId(chosen.id)}`, "info");
        } catch (error) {
          ctx.ui.notify(`Failed to list sessions: ${errorText(error)}`, "error");
        }
        return;
      }
      case "new": {
        if (!controller.isConnected()) {
          ctx.ui.notify("Connect first with /fa connect <name>", "warning");
          return;
        }
        try {
          const session = await controller.createSession();
          ctx.ui.notify(`Started new remote session ${shortId(session.id)}`, "info");
        } catch (error) {
          ctx.ui.notify(`Failed to create session: ${errorText(error)}`, "error");
        }
        return;
      }
      case "fork": {
        if (!controller.isConnected()) {
          ctx.ui.notify("Connect first with /fa connect <name>", "warning");
          return;
        }
        try {
          const forked = await controller.forkSession();
          ctx.ui.notify(`Forked into session ${shortId(forked.id)}`, "info");
        } catch (error) {
          ctx.ui.notify(`Failed to fork session: ${errorText(error)}`, "error");
        }
        return;
      }
      case "model": {
        if (!controller.isConnected()) {
          ctx.ui.notify("Connect first with /fa connect <name>", "warning");
          return;
        }
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
          const labels = models.map((m) => `${m.provider}/${m.modelId}`);
          const picked = await ctx.ui.select("Select remote model", labels);
          if (!picked) return;
          target = parseModelSpec(picked);
        }
        if (!target) return;
        try {
          await controller.updateSession({ model: target });
          ctx.ui.notify(`Remote model set to ${target.provider}/${target.modelId}`, "info");
        } catch (error) {
          ctx.ui.notify(`Failed to switch model: ${errorText(error)}`, "error");
        }
        return;
      }
      case "thinking": {
        if (!controller.isConnected()) {
          ctx.ui.notify("Connect first with /fa connect <name>", "warning");
          return;
        }
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
        return;
      }
      case "compact": {
        if (!controller.isConnected()) {
          ctx.ui.notify("Connect first with /fa connect <name>", "warning");
          return;
        }
        try {
          const instructions = rest.length > 0 ? rest.join(" ") : undefined;
          await controller.compact(instructions);
          ctx.ui.notify("Requested remote compaction", "info");
        } catch (error) {
          ctx.ui.notify(`Remote compaction failed: ${errorText(error)}`, "error");
        }
        return;
      }
      case "cancel": {
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
        return;
      }
      case "schedules": {
        if (!controller.isConnected()) {
          ctx.ui.notify("Connect first with /fa connect <name>", "warning");
          return;
        }
        try {
          const schedules = await controller.listSchedules();
          if (schedules.length === 0) {
            ctx.ui.notify("No schedules defined on this remote", "info");
            return;
          }
          const lines = schedules.map((s) => {
            const next = s.next ? `next ${s.next}` : "no next run";
            const last = s.last?.outcome ? `last ${s.last.outcome}` : s.last ? "running" : "never ran";
            return `${s.name} (${s.cron}) — ${next}, ${last}`;
          });
          ctx.ui.notify(lines.join("\n"), "info");
        } catch (error) {
          ctx.ui.notify(`Failed to list schedules: ${errorText(error)}`, "error");
        }
        return;
      }
      case "run": {
        if (!controller.isConnected()) {
          ctx.ui.notify("Connect first with /fa connect <name>", "warning");
          return;
        }
        const name = rest[0];
        if (!name) {
          ctx.ui.notify("Usage: /fa run <schedule-name>", "error");
          return;
        }
        try {
          const run = await controller.runSchedule(name);
          ctx.ui.notify(
            run.status === "sent"
              ? `Schedule "${name}" started (message ${shortId(run.message.id)})`
              : `Schedule "${name}" skipped: ${run.reason}`,
            run.status === "sent" ? "info" : "warning",
          );
        } catch (error) {
          ctx.ui.notify(`Failed to run schedule "${name}": ${errorText(error)}`, "error");
        }
        return;
      }
      case "wakeups": {
        if (!controller.isConnected()) {
          ctx.ui.notify("Connect first with /fa connect <name>", "warning");
          return;
        }
        try {
          const wakeups = await controller.listWakeups();
          if (wakeups.length === 0) {
            ctx.ui.notify("No pending wake-ups", "info");
            return;
          }
          const lines = wakeups.map((w) => `${shortId(w.id)} @ ${w.fireAt} — ${w.prompt}`);
          ctx.ui.notify(lines.join("\n"), "info");
        } catch (error) {
          ctx.ui.notify(`Failed to list wake-ups: ${errorText(error)}`, "error");
        }
        return;
      }
      default: {
        ctx.ui.notify(
          `Unknown /fa subcommand "${sub}". Available: ${SUBCOMMANDS.map((s) => s.name).join(", ")}`,
          "error",
        );
      }
    }
  };

  pi.registerCommand("fa", {
    description: "Connect to and control a remote FastAgent instance",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const trimmed = prefix.trimStart();
      if (!trimmed.includes(" ")) {
        const matches = SUBCOMMANDS.filter((s) => s.name.startsWith(trimmed)).map((s) => ({
          value: s.name,
          label: s.name,
          description: s.description,
        }));
        return matches.length > 0 ? matches : null;
      }
      const [sub, arg = ""] = trimmed.split(/\s+/, 2);
      if (sub === "connect" || sub === "remove") {
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
    },
    handler: handleCommand,
  });
}
