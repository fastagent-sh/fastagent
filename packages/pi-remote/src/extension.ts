/**
 * Pi ExtensionAPI host glue for `@fastagent-sh/pi-remote`:
 * - Streamlined `/fa` entry (`/fa` smart picker/menu, `/fa <name|url>`, `/fa sessions`, `/fa clock`, `/fa remotes`, `/fa off`)
 * - Native Pi command & keybinding handoff while connected (`/model`, `/name`, `/new`, `/resume`, `/fork`, `/thinking`,
 *   `Alt+Enter` queue, `Enter` steer, `Esc` cancel, `/compact`, `Shift+Tab`) via a thin `CustomEditor` wrapper
 * - Pi-native 2-line footer (preserving other extensions' statuses), live widget, banner, and terminal/cmux title sync
 */
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  type AutocompleteItem,
  type AutocompleteProvider,
  type EditorTheme,
  type TUI,
  matchesKey,
} from "@earendil-works/pi-tui";
import { AgentError, type Entry, type ModelRef, type ThinkingLevel } from "@fastagent-sh/client";
import { RemoteController, type RemoteViewState, buildSendContent } from "./controller.ts";
import {
  type HttpRemoteConfig,
  type RemoteConfig,
  type RemotesFile,
  connectRemote,
  isHttpUrl,
  loadRemotes,
  removeRemote,
  saveRemote,
} from "./remotes.ts";
import {
  type RemoteBannerPayload,
  type RemoteEntryPayload,
  createLiveWidgetComponent,
  formatContextSummary,
  formatRelativeTime,
  formatUsageSummary,
  hasLiveContent,
  renderRemoteBanner,
  renderRemoteEntry,
  renderRemoteFooterLines,
  shortId,
} from "./render.ts";
import { TerminalStatusReporter } from "./terminal-status.ts";

export const REMOTE_ENTRY_TYPE = "fastagent-remote-entry";
const REMOTE_BANNER_TYPE = "fastagent-remote-banner";
const REMOTE_BINDING_TYPE = "fastagent-remote-binding";
const LIVE_WIDGET_KEY = "fastagent-remote-live";

interface RemoteBinding {
  remoteName: string;
  sessionId: string;
}

interface PendingHandoff extends RemoteBinding {
  remote: RemoteConfig;
}

// Plain data handed across Pi's ctx.newSession() replacement boundary (new extension instance runs session_start
// before options.setup executes). Never holds session-bound Pi objects or writes secrets to session JSONL.
let pendingHandoff: PendingHandoff | undefined;

const PRIMARY_SUBCOMMANDS: readonly { name: string; description: string }[] = [
  { name: "sessions", description: "Switch, create, or delete remote sessions" },
  { name: "new", description: "Start a new remote session" },
  { name: "title", description: "Rename the current remote session [title|--clear]" },
  { name: "fork", description: "Fork the current remote session" },
  { name: "model", description: "Select remote model [provider/modelId]" },
  { name: "clock", description: "View/run remote schedules and manage wake-ups" },
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
  "model",
  "thinking",
  "compact",
  "cancel",
  "clock",
  "schedules",
  "run",
  "wakeups",
  "remotes",
  "add",
  "remove",
]);

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withUpgradeHint(error: unknown, feature: string): string {
  const base = errorText(error);
  if (
    error instanceof AgentError &&
    ((error.code === "not_found" && base.includes("no such route")) ||
      (error.code === "invalid_request" && base.includes("Nothing to update")))
  ) {
    return `${base} (the remote FastAgent server may need an upgrade to support ${feature})`;
  }
  return base;
}

function parseModelSpec(spec: string): ModelRef | undefined {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) return undefined;
  return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
}

/** Match Pi's built-in slash commands that should route to the connected remote while in remote mode. */
export function parseInterceptedRemoteBuiltin(raw: string): { command: string; args: string } | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const space = trimmed.indexOf(" ");
  const cmd = (space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)).toLowerCase();
  const args = space === -1 ? "" : trimmed.slice(space + 1).trim();
  switch (cmd) {
    case "model":
      return { command: "model", args };
    case "name":
      return { command: "title", args };
    case "new":
      return { command: "new", args };
    case "resume":
      return { command: "sessions", args };
    case "fork":
      return { command: "fork", args };
    case "thinking":
      return { command: "thinking", args };
    default:
      return undefined;
  }
}

interface RemoteEditorCallbacks {
  isConnected: () => boolean;
  isRunning: () => boolean;
  onQueueMessage: (text: string) => void;
}

class RemoteEditor extends CustomEditor {
  private readonly kb: KeybindingsManager;
  private readonly callbacks: RemoteEditorCallbacks;

  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, callbacks: RemoteEditorCallbacks) {
    super(tui, theme, keybindings);
    this.kb = keybindings;
    this.callbacks = callbacks;
  }

  private submitFa(command: string, args = ""): void {
    const line = args ? `/fa ${command} ${args}` : `/fa ${command}`;
    this.onSubmit?.(line);
  }

  override handleInput(data: string): void {
    if (this.callbacks.isConnected() && !this.isShowingAutocomplete()) {
      if (this.kb.matches(data, "tui.input.submit")) {
        const text = this.getExpandedText?.() ?? this.getText();
        const builtin = parseInterceptedRemoteBuiltin(text);
        if (builtin) {
          this.addToHistory?.(text);
          this.setText("");
          this.submitFa(builtin.command, builtin.args);
          return;
        }
      }
      if (this.kb.matches(data, "app.message.followUp") && this.callbacks.isRunning()) {
        const text = (this.getExpandedText?.() ?? this.getText()).trim();
        if (text) {
          this.addToHistory?.(text);
          this.setText("");
          this.callbacks.onQueueMessage(text);
          return;
        }
      }
      if (this.kb.matches(data, "app.model.select")) {
        this.submitFa("model");
        return;
      }
      if (this.kb.matches(data, "app.session.new")) {
        this.submitFa("new");
        return;
      }
      if (this.kb.matches(data, "app.session.resume")) {
        this.submitFa("sessions");
        return;
      }
      if (this.kb.matches(data, "app.session.fork")) {
        this.submitFa("fork");
        return;
      }
    }
    super.handleInput(data);
  }
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
  let activeRemoteConfig: RemoteConfig | undefined;
  let autocompleteInstalled = false;
  let widgetMounted = false;
  let footerMounted = false;
  let editorMounted = false;
  let previousEditorFactory: ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;
  let lastWindowTitle: string | undefined;

  const terminalStatus = new TerminalStatusReporter();

  const updateWindowTitle = (ctx: ExtensionContext, state: RemoteViewState) => {
    if (ctx.mode !== "tui") return;
    if (state.status === "disconnected") {
      if (lastWindowTitle !== undefined) {
        ctx.ui.setTitle("");
        lastWindowTitle = undefined;
      }
      return;
    }
    const remote = state.remoteName ?? "remote";
    const suffix = state.session?.title
      ? ` · ${state.session.title}`
      : state.session
        ? ` · ${shortId(state.session.id)}`
        : "";
    const next = `☁ ${remote}${suffix}`;
    if (next !== lastWindowTitle) {
      lastWindowTitle = next;
      ctx.ui.setTitle(next);
    }
  };

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
      if (editorMounted) {
        ctx.ui.setEditorComponent?.(previousEditorFactory);
        previousEditorFactory = undefined;
        editorMounted = false;
      }
      ctx.ui.setStatus("fastagent-remote", undefined);
      updateWindowTitle(ctx, state);
      terminalStatus.clear();
      return;
    }

    if (ctx.mode === "tui") {
      if (!editorMounted && typeof ctx.ui.setEditorComponent === "function") {
        previousEditorFactory = ctx.ui.getEditorComponent?.();
        editorMounted = true;
        ctx.ui.setEditorComponent(
          (tui, theme, keybindings) =>
            new RemoteEditor(tui, theme, keybindings, {
              isConnected: () => controller.isConnected(),
              isRunning: () => controller.getState().session?.status === "running",
              onQueueMessage: (text) => {
                void controller.send(text, { whenBusy: "queue" }).catch((error) => {
                  activeCtx?.ui.notify(`Remote queue failed: ${errorText(error)}`, "error");
                });
              },
            }),
        );
      }

      if (!footerMounted) {
        footerMounted = true;
        ctx.ui.setFooter((tui, theme, footerData) => {
          requestFooterRender = () => tui.requestRender();
          const unsubBranch = footerData?.onBranchChange?.(() => tui.requestRender());
          return {
            invalidate() {},
            dispose() {
              unsubBranch?.();
              requestFooterRender = undefined;
            },
            render(width: number) {
              return renderRemoteFooterLines(controller.getState(), width, theme, footerData);
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

    updateWindowTitle(ctx, state);

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
    onSessionReady: (state, meta) => {
      if (!meta.resumed) appendBanner(state, meta.fresh);
    },
    onEntry: (entry: Entry) => {
      const state = controller.getState();
      if (!state.remoteName || !state.session) return;
      let toolArgs: RemoteEntryPayload["toolArgs"];
      if (entry.kind === "tool_result") {
        const data = entry.data as { toolCallId?: unknown } | null;
        if (data && typeof data.toolCallId === "string") {
          toolArgs = controller.getToolCallArgs(data.toolCallId);
        }
      }
      pi.appendEntry<RemoteEntryPayload>(REMOTE_ENTRY_TYPE, {
        remoteName: state.remoteName,
        sessionId: state.session.id,
        entry,
        ...(toolArgs === undefined ? {} : { toolArgs }),
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

  const handoffToCleanView = async (
    ctx: ExtensionContext,
    handoff: PendingHandoff,
  ): Promise<"handed_off" | "cancelled" | "unsupported"> => {
    const cmdCtx = ctx as Partial<ExtensionCommandContext>;
    if (typeof cmdCtx.newSession !== "function") return "unsupported";
    pendingHandoff = handoff;
    try {
      const res = await cmdCtx.newSession({
        setup: async (sessionManager) => {
          const binding: RemoteBinding = { remoteName: handoff.remoteName, sessionId: handoff.sessionId };
          sessionManager.appendCustomEntry(REMOTE_BINDING_TYPE, binding);
        },
      });
      if (res.cancelled) {
        pendingHandoff = undefined;
        return "cancelled";
      }
      return "handed_off";
    } catch (error) {
      pendingHandoff = undefined;
      throw error;
    }
  };

  const appendBanner = (state: RemoteViewState, isFresh: boolean) => {
    if (!state.remoteName || !state.session) return;
    const model = state.session.model ?? state.agentInfo?.defaultModel;
    const modelStr = model ? `${model.provider}/${model.modelId}` : undefined;
    pi.appendEntry<RemoteBannerPayload>(REMOTE_BANNER_TYPE, {
      remoteName: state.remoteName,
      agentName: state.agentInfo?.name ?? state.remoteName,
      sessionId: state.session.id,
      ...(state.session.title ? { title: state.session.title } : {}),
      ...(modelStr ? { model: modelStr } : {}),
      ...(state.session.thinkingLevel ? { thinkingLevel: state.session.thinkingLevel } : {}),
      ...(isFresh && state.agentInfo?.starters?.length ? { starters: state.agentInfo.starters } : {}),
    });
  };

  const connectResolved = async (
    ctx: ExtensionContext,
    name: string,
    remote: RemoteConfig,
    options: {
      sessionId?: string;
      after?: string;
      seenEntryIds?: Iterable<string>;
      persistBinding?: boolean;
      allowHandoff?: boolean;
      showBanner?: boolean;
    } = {},
  ): Promise<void> => {
    const { agent, defaultSessionId } = await connectRemote(name, remote);
    const targetSession = options.sessionId ?? defaultSessionId;
    if (
      options.allowHandoff !== false &&
      controller.isConnected() &&
      typeof (ctx as Partial<ExtensionCommandContext>).newSession === "function"
    ) {
      const session = targetSession ? await agent.sessions.get(targetSession) : await agent.sessions.create();
      const outcome = await handoffToCleanView(ctx, { remoteName: name, remote, sessionId: session.id });
      if (outcome !== "unsupported") return;
    }
    const session = await controller.connect(name, agent, {
      ...(targetSession !== undefined ? { sessionId: targetSession } : {}),
      ...(options.after !== undefined ? { after: options.after } : {}),
      ...(options.seenEntryIds !== undefined ? { seenEntryIds: options.seenEntryIds } : {}),
      ...(options.showBanner === false ? { resumed: true } : {}),
    });
    activeRemoteConfig = remote;
    if (options.persistBinding !== false) {
      pi.appendEntry<RemoteBinding>(REMOTE_BINDING_TYPE, { remoteName: name, sessionId: session.id });
    }
    ctx.ui.notify(`Connected to ${name} (session ${shortId(session.id)})`, "info");
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
      await connectResolved(ctx, displayName, remote);
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
        ctx.ui.notify(`No remotes configured in ${loaded.path}. Run /fa remotes add or /fa <url>.`, "warning");
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
        const picked = await ctx.ui.select("Connect to FastAgent remote", [...names, "+ Add a remote…"]);
        if (!picked) return;
        if (picked === "+ Add a remote…") {
          const added = await addRemoteFlow(ctx);
          if (added) await connectByName(ctx, added);
          return;
        }
        name = picked;
      }
    }
    if (!name) return;

    const remote = loaded.config.remotes[name];
    if (!remote) {
      ctx.ui.notify(`Unknown remote "${name}". Configured: ${names.join(", ")}. Use /fa remotes to add one.`, "error");
      return;
    }

    try {
      await connectResolved(ctx, name, remote, {
        ...(secondArg !== undefined ? { sessionId: secondArg } : {}),
      });
    } catch (error) {
      ctx.ui.notify(`Failed to connect to ${name}: ${errorText(error)}`, "error");
    }
  };

  const openSmartHome = async (ctx: ExtensionContext): Promise<void> => {
    if (!controller.isConnected()) {
      const loaded = loadConfigSafe(ctx);
      if (!loaded) return;
      const names = Object.keys(loaded.config.remotes);
      if (names.length === 0) {
        const added = await addRemoteFlow(ctx);
        if (added) await connectByName(ctx, added);
        return;
      }
      const options = [...names.map((n) => (n === loaded.config.default ? `${n} (default)` : n)), "+ Add a remote…"];
      const picked = await ctx.ui.select("Connect to FastAgent remote", options);
      if (!picked) return;
      if (picked === "+ Add a remote…") {
        const added = await addRemoteFlow(ctx);
        if (added) await connectByName(ctx, added);
        return;
      }
      const idx = options.indexOf(picked);
      const chosen = names[idx];
      if (chosen) await connectByName(ctx, chosen);
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
      { label: "Clock: schedules & wake-ups (/fa clock)", cmd: "clock" },
      { label: "Delete a session (/fa delete)", cmd: "delete" },
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

  const openClockPanel = async (ctx: ExtensionContext): Promise<void> => {
    if (!controller.isConnected()) {
      ctx.ui.notify("Connect first with /fa", "warning");
      return;
    }
    try {
      const [schedules, wakeups] = await Promise.all([controller.listSchedules(), controller.listWakeups()]);
      if (schedules.length === 0 && wakeups.length === 0) {
        ctx.ui.notify("No schedules or pending wake-ups on this remote", "info");
        return;
      }
      const items: Array<{ label: string; kind: "schedule" | "wakeup"; id: string }> = [];
      for (const s of schedules) {
        const next = s.next ? `next ${s.next}` : "no next run";
        const last = s.last?.outcome ? `last ${s.last.outcome}` : s.last ? "running" : "never ran";
        items.push({
          label: `[run schedule] ${s.name} (${s.cron}) — ${next}, ${last}`,
          kind: "schedule",
          id: s.name,
        });
      }
      for (const w of wakeups) {
        items.push({
          label: `[cancel wake-up] ${shortId(w.id)} @ ${w.fireAt} — ${w.prompt}`,
          kind: "wakeup",
          id: w.id,
        });
      }
      const picked = await ctx.ui.select(
        "Remote clock (select to run schedule or cancel wake-up)",
        items.map((i) => i.label),
      );
      if (!picked) return;
      const chosen = items.find((i) => i.label === picked);
      if (!chosen) return;
      if (chosen.kind === "schedule") {
        const run = await controller.runSchedule(chosen.id);
        ctx.ui.notify(
          run.status === "sent"
            ? `Schedule "${chosen.id}" started (message ${shortId(run.message.id)})`
            : `Schedule "${chosen.id}" skipped: ${run.reason}`,
          run.status === "sent" ? "info" : "warning",
        );
      } else {
        const confirmed = await ctx.ui.confirm("Cancel wake-up", `Cancel pending wake-up ${chosen.id}?`);
        if (!confirmed) return;
        await controller.cancelWakeup(chosen.id);
        ctx.ui.notify(`Canceled wake-up ${shortId(chosen.id)}`, "info");
      }
    } catch (error) {
      ctx.ui.notify(`Failed to read remote clock: ${errorText(error)}`, "error");
    }
  };

  const openRemotesPanel = async (ctx: ExtensionContext, rest: string[]): Promise<void> => {
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
  };

  const removeRemoteFlow = async (ctx: ExtensionContext, requested?: string): Promise<void> => {
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
  };

  const dispatchAction = async (sub: string, rest: string[], ctx: ExtensionContext): Promise<void> => {
    attachContext(ctx);
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
        await removeRemoteFlow(ctx, rest[0]);
        return;
      }
      case "remotes": {
        await openRemotesPanel(ctx, rest);
        return;
      }
      case "off":
      case "disconnect": {
        if (controller.getState().status === "disconnected") {
          ctx.ui.notify("Not connected to any remote", "info");
          return;
        }
        const name = controller.getState().remoteName;
        activeRemoteConfig = undefined;
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
        return;
      }
      case "sessions": {
        if (!controller.isConnected()) {
          ctx.ui.notify("Connect first with /fa", "warning");
          return;
        }
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
            await dispatchAction("new", [], ctx);
            return;
          }
          const idx = labels.indexOf(picked);
          const chosen = sessions[idx];
          if (!chosen || chosen.id === currentId) return;
          const remoteName = controller.getState().remoteName;
          if (remoteName && activeRemoteConfig) {
            const outcome = await handoffToCleanView(ctx, {
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
        return;
      }
      case "title": {
        if (!controller.isConnected()) {
          ctx.ui.notify("Connect first with /fa", "warning");
          return;
        }
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
          ctx.ui.notify(`Failed to update title: ${withUpgradeHint(error, "session titles")}`, "error");
        }
        return;
      }
      case "delete": {
        if (!controller.isConnected()) {
          ctx.ui.notify("Connect first with /fa", "warning");
          return;
        }
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
          if (deletingCurrent) activeRemoteConfig = undefined;
          ctx.ui.notify(`Deleted remote session ${shortId(targetId)}`, "info");
        } catch (error) {
          ctx.ui.notify(`Failed to delete session: ${withUpgradeHint(error, "session deletion")}`, "error");
        }
        return;
      }
      case "new": {
        if (!controller.isConnected()) {
          ctx.ui.notify("Connect first with /fa", "warning");
          return;
        }
        try {
          const remoteName = controller.getState().remoteName;
          if (
            remoteName &&
            activeRemoteConfig &&
            typeof (ctx as Partial<ExtensionCommandContext>).newSession === "function"
          ) {
            const created = await controller.createRemoteSession();
            const outcome = await handoffToCleanView(ctx, {
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
        return;
      }
      case "fork": {
        if (!controller.isConnected()) {
          ctx.ui.notify("Connect first with /fa", "warning");
          return;
        }
        try {
          const remoteName = controller.getState().remoteName;
          if (
            remoteName &&
            activeRemoteConfig &&
            typeof (ctx as Partial<ExtensionCommandContext>).newSession === "function"
          ) {
            const forked = await controller.forkRemoteSession();
            const outcome = await handoffToCleanView(ctx, {
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
        return;
      }
      case "model": {
        if (!controller.isConnected()) {
          ctx.ui.notify("Connect first with /fa", "warning");
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
          const current = controller.getState().session?.model ?? info?.defaultModel;
          const labels = models.map((m) => {
            const isCurrent = current?.provider === m.provider && current?.modelId === m.modelId;
            return `${isCurrent ? "* " : "  "}${m.provider}/${m.modelId}`;
          });
          const picked = await ctx.ui.select("Select remote model", labels);
          if (!picked) return;
          const idx = labels.indexOf(picked);
          const chosen = models[idx];
          if (chosen) target = { provider: chosen.provider, modelId: chosen.modelId };
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
          ctx.ui.notify("Connect first with /fa", "warning");
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
          ctx.ui.notify("Connect first with /fa", "warning");
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
      case "clock": {
        await openClockPanel(ctx);
        return;
      }
      case "schedules": {
        if (!controller.isConnected()) {
          ctx.ui.notify("Connect first with /fa", "warning");
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
          ctx.ui.notify("Connect first with /fa", "warning");
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
          ctx.ui.notify("Connect first with /fa", "warning");
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
        // Treat `/fa <name|url>` as direct connect so users do not need to type `/fa connect`.
        if (isHttpUrl(sub)) {
          await connectDirectUrl(ctx, sub, rest[0]);
          return;
        }
        const loaded = loadConfigSafe(ctx);
        if (loaded?.config.remotes[sub]) {
          await connectByName(ctx, sub, rest[0]);
          return;
        }
        ctx.ui.notify(
          `Unknown remote or /fa subcommand "${sub}". Run /fa for menu, or /fa remotes to manage remotes.`,
          "error",
        );
      }
    }
  };

  pi.registerFlag("fa", {
    description: "Connect to a configured FastAgent remote on startup",
    type: "string",
  });

  pi.registerEntryRenderer<RemoteBannerPayload>(REMOTE_BANNER_TYPE, (entry, _options, theme) => {
    if (!entry.data) return undefined;
    return renderRemoteBanner(entry.data, theme);
  });

  pi.registerEntryRenderer<RemoteEntryPayload>(REMOTE_ENTRY_TYPE, (entry, options, theme) => {
    if (!entry.data) return undefined;
    return renderRemoteEntry(entry.data, options, theme);
  });

  pi.on("session_start", async (event, ctx) => {
    autocompleteInstalled = false;
    widgetMounted = false;
    footerMounted = false;
    editorMounted = false;
    previousEditorFactory = undefined;
    lastWindowTitle = undefined;
    requestFooterRender = undefined;
    requestWidgetRender = undefined;
    attachContext(ctx);

    if (pendingHandoff) {
      const handoff = pendingHandoff;
      pendingHandoff = undefined;
      try {
        await connectResolved(ctx, handoff.remoteName, handoff.remote, {
          sessionId: handoff.sessionId,
          persistBinding: false,
          allowHandoff: false,
          showBanner: true,
        });
      } catch (error) {
        ctx.ui.notify(`Failed to connect to ${handoff.remoteName}: ${errorText(error)}`, "error");
      }
      return;
    }

    if (controller.isConnected()) {
      syncUi(controller.getState());
      return;
    }

    if (event.reason === "resume" && typeof ctx.sessionManager?.getEntries === "function") {
      const entries = ctx.sessionManager.getEntries();
      let latestBinding: RemoteBinding | undefined;
      for (const item of entries) {
        if (item.type === "custom" && item.customType === REMOTE_BINDING_TYPE && item.data) {
          latestBinding = item.data as RemoteBinding;
        }
      }
      if (latestBinding) {
        const loaded = loadConfigSafe(ctx);
        const remote = loaded?.config.remotes[latestBinding.remoteName];
        if (!remote) return;
        const seen: string[] = [];
        for (const item of entries) {
          if (item.type === "custom" && item.customType === REMOTE_ENTRY_TYPE && item.data) {
            const payload = item.data as RemoteEntryPayload;
            if (payload.sessionId === latestBinding.sessionId && payload.entry?.id) {
              seen.push(payload.entry.id);
            }
          }
        }
        try {
          await connectResolved(ctx, latestBinding.remoteName, remote, {
            sessionId: latestBinding.sessionId,
            after: seen.at(-1) ?? "start",
            seenEntryIds: seen,
            persistBinding: false,
            allowHandoff: false,
            showBanner: false,
          });
        } catch (error) {
          ctx.ui.notify(`Failed to resume ${latestBinding.remoteName}: ${errorText(error)}`, "error");
        }
        return;
      }
    }

    if (event.reason !== "startup") return;
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
    ctx.ui.notify("Remote sessions are linear; use /fork to branch the remote session.", "warning");
    return { cancel: true };
  });

  pi.registerCommand("fa", {
    description: "Connect to and control a remote FastAgent instance",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
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
    },
    handler: async (rawArgs, ctx) => {
      attachContext(ctx);
      const tokens = rawArgs.trim() ? rawArgs.trim().split(/\s+/) : [];
      if (tokens.length === 0) {
        await openSmartHome(ctx);
        return;
      }
      const [sub, ...rest] = tokens;
      if (sub) await dispatchAction(sub, rest, ctx);
    },
  });
}
