/**
 * Pi ExtensionAPI host glue for `@fastagent-sh/pi-remote`:
 * mounts the 2-line footer, live widget, RemoteEditor, session banner/entries, terminal status,
 * session_start/resume/input lifecycle hooks, and `/fa` command registration.
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import type { Entry } from "@fastagent-sh/client";
import { createCommandDispatcher, getFaArgumentCompletions } from "./commands.ts";
import { RemoteController, type RemoteViewState, buildSendContent } from "./controller.ts";
import { RemoteEditor, wrapAutocompleteWithRemoteCommands } from "./editor.ts";
import { hostEnv } from "./host-env.ts";
import { type HttpRemoteConfig, type RemoteConfig, connectRemote, isHttpUrl } from "./remotes.ts";
import { addRemoteFlow, errorText, loadConfigSafe } from "./remotes-ui.ts";
import {
  type RemoteBannerPayload,
  type RemoteEntryPayload,
  createLiveWidgetComponent,
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

/**
 * Plain handoff slot crossing Pi's `ctx.newSession()` replacement boundary (the new extension instance's
 * `session_start` fires before `options.setup` runs). Never holds session-bound Pi objects or secrets on disk.
 */
const sessionHandoff = {
  pending: undefined as PendingHandoff | undefined,
  take(): PendingHandoff | undefined {
    const next = this.pending;
    this.pending = undefined;
    return next;
  },
  async run(ctx: ExtensionContext, handoff: PendingHandoff): Promise<"handed_off" | "cancelled" | "unsupported"> {
    const cmdCtx = ctx as Partial<ExtensionCommandContext>;
    if (typeof cmdCtx.newSession !== "function") return "unsupported";
    this.pending = handoff;
    try {
      const res = await cmdCtx.newSession({
        setup: async (sessionManager) => {
          const binding: RemoteBinding = { remoteName: handoff.remoteName, sessionId: handoff.sessionId };
          sessionManager.appendCustomEntry(REMOTE_BINDING_TYPE, binding);
        },
      });
      if (res.cancelled) {
        this.pending = undefined;
        return "cancelled";
      }
      return "handed_off";
    } catch (error) {
      this.pending = undefined;
      throw error;
    }
  },
};

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
      const outcome = await sessionHandoff.run(ctx, { remoteName: name, remote, sessionId: session.id });
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
    if (!apiKey && !hostEnv().FASTAGENT_API_KEY?.trim() && ctx.hasUI) {
      const entered = await ctx.ui.input(
        "API key for remote FastAgent",
        "$FASTAGENT_API_KEY or raw key (leave empty if set in env)",
        { blockedKind: "auth" },
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

  const { dispatchAction, openSmartHome } = createCommandDispatcher({
    controller,
    attachContext,
    getActiveRemoteConfig: () => activeRemoteConfig,
    clearActiveRemoteConfig: () => {
      activeRemoteConfig = undefined;
    },
    connectByName,
    connectDirectUrl,
    connectResolved,
    handoffToCleanView: (ctx, handoff) => sessionHandoff.run(ctx, handoff),
  });

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

    const handoff = sessionHandoff.take();
    if (handoff) {
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
    getArgumentCompletions: (prefix: string) => getFaArgumentCompletions(prefix, controller),
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
