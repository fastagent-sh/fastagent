/**
 * Pi TUI editor & autocomplete interception for `@fastagent-sh/pi-remote`: routes native built-in commands
 * (`/model`, `/name`, `/new`, `/resume`, `/fork`, `/thinking`) and keybindings (`Alt+Enter` queue, model/thinking
 * cycling, session shortcuts) through `/fa` while connected, and merges remote `/commands` into autocomplete.
 */
import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider, EditorTheme, TUI } from "@earendil-works/pi-tui";
import type { RemoteViewState } from "./controller.ts";

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
    case "session":
      return { command: "status", args };
    case "copy":
      return { command: "copy", args };
    case "new":
      return { command: "new", args };
    case "resume":
      return { command: "sessions", args };
    case "fork":
    case "clone":
      return { command: "fork", args };
    case "thinking":
      return { command: "thinking", args };
    case "login":
      return { command: "provider-auth-hint", args: "login" };
    case "logout":
      return { command: "provider-auth-hint", args: "logout" };
    default:
      return undefined;
  }
}

export interface RemoteEditorCallbacks {
  isConnected: () => boolean;
  isRunning: () => boolean;
  onQueueMessage: (text: string) => void;
}

export class RemoteEditor extends CustomEditor {
  private readonly kb: KeybindingsManager;
  private readonly callbacks: RemoteEditorCallbacks;
  private hostOnSubmit?: (text: string) => void;
  private wrappedOnSubmit?: (text: string) => void;

  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, callbacks: RemoteEditorCallbacks) {
    super(tui, theme, keybindings);
    this.kb = keybindings;
    this.callbacks = callbacks;
    // Wrap host-assigned onSubmit so every submit path (including slash-command autocomplete fall-through)
    // rewrites intercepted built-in commands (/model, /name, /new, /resume, /fork, /thinking) to /fa.
    Object.defineProperty(this, "onSubmit", {
      configurable: true,
      enumerable: true,
      get: (): ((text: string) => void) | undefined => this.wrappedOnSubmit,
      set: (fn: ((text: string) => void) | undefined) => {
        this.hostOnSubmit = fn;
        this.wrappedOnSubmit = fn
          ? (text: string) => {
              if (this.callbacks.isConnected()) {
                const builtin = parseInterceptedRemoteBuiltin(text);
                if (builtin) {
                  const line = builtin.args ? `/fa ${builtin.command} ${builtin.args}` : `/fa ${builtin.command}`;
                  fn(line);
                  return;
                }
              }
              fn(text);
            }
          : undefined;
      },
    });
  }

  private submitFa(command: string, args = ""): void {
    const line = args ? `/fa ${command} ${args}` : `/fa ${command}`;
    this.hostOnSubmit?.(line);
  }

  override handleInput(data: string): void {
    if (this.callbacks.isConnected() && !this.isShowingAutocomplete()) {
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
      if (this.kb.matches(data, "app.model.cycleForward")) {
        this.submitFa("model-cycle", "next");
        return;
      }
      if (this.kb.matches(data, "app.model.cycleBackward")) {
        this.submitFa("model-cycle", "prev");
        return;
      }
      if (this.kb.matches(data, "app.thinking.cycle")) {
        this.submitFa("thinking-cycle");
        return;
      }
      if (this.kb.matches(data, "app.message.copy")) {
        this.submitFa("copy");
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

export function wrapAutocompleteWithRemoteCommands(
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
