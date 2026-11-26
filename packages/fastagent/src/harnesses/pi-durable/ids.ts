/**
 * The ids the Agent hands out: the storage's incarnation, then pi-durable's id. pi-durable counts ids per storage and a
 * new storage counts from the start again, so an id kept from a storage that is gone must not name what the new one
 * gives the same number. An encoding, not a lookup: nothing is stored per id.
 */
import { randomBytes } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import {
  type Extension,
  type Harness,
  type RegistryReader,
  type RegistrySnapshot,
  type ToolExecutionApi,
  type ToolRegistration,
  defineDoc,
} from "@earendil-works/pi-durable";
import { MessageId, SessionId } from "@fastagent-sh/client/agent-api";
import { RESOLVE_SESSION_ID } from "../tool.ts";
import { isSession } from "./sessions.ts";

const StorageDoc = defineDoc<{ incarnation: string }>({
  kind: "fastagent.storage",
  version: 1,
  scope: "session",
  initial: () => ({ incarnation: "" }),
  // Written once, when the storage is first opened: no deltas pile up to bound.
  checkpointWhen: () => false,
});

export interface Ids {
  encode(id: number): string;
  encodeSession(id: number): SessionId;
  encodeMessage(id: number): MessageId;
  /** The pi-durable id `text` names in this storage, or undefined for any other text. */
  decode(text: string): number | undefined;
  /** A position among this storage's ids as a cursor, which no id reads as. */
  encodeCursor(position: number): string;
  decodeCursor(text: string): number | undefined;
}

export async function storageIds(harness: Harness, context: Context): Promise<Ids> {
  const incarnation = await harness.commit(async (tx) => {
    const doc = await tx.doc(StorageDoc);
    if (doc.incarnation === "") doc.incarnation = randomBytes(8).toString("base64url");
    return doc.incarnation;
  }, context);
  return idsOf(incarnation);
}

/**
 * The session id of the conversation a tool runs in, as the Agent hands it out, or undefined when that conversation is
 * not a session (a subagent's): from the storage the tool runs on.
 */
async function sessionIdOf(
  api: Pick<ToolExecutionApi, "conversationId" | "snapshot" | "commit">,
  context: Context,
): Promise<SessionId | undefined> {
  const record = await api.commit((tx) => tx.conversation(api.conversationId), context);
  if (record === undefined || !isSession(record)) return undefined;
  const incarnation = (await api.snapshot(StorageDoc, context))?.incarnation;
  if (!incarnation) throw new Error("this storage has no incarnation: the Agent did not open it");
  return idsOf(incarnation).encodeSession(api.conversationId);
}

function withSessionResolver<T extends ToolExecutionApi>(api: T, context: Context): T {
  return Object.defineProperties(Object.create(Object.getPrototypeOf(api)), {
    ...Object.getOwnPropertyDescriptors(api),
    [RESOLVE_SESSION_ID]: { value: () => sessionIdOf(api, context), enumerable: false },
  }) as T;
}

/**
 * Decorate `registry` so every tool invocation (`execute` and `cancel`) receives a bound `[RESOLVE_SESSION_ID]`
 * resolver while preserving live getters (`models`, `env`) and symbol properties on `api`.
 */
export function bindSessionResolverRegistry(registry: RegistryReader): RegistryReader {
  const boundTools = new WeakMap<ToolRegistration, ToolRegistration>();
  const boundExtensions = new WeakMap<Extension, Extension>();
  const boundSnapshots = new WeakMap<RegistrySnapshot, RegistrySnapshot>();

  const bindTool = (tool: ToolRegistration): ToolRegistration => {
    const cached = boundTools.get(tool);
    if (cached !== undefined) return cached;
    const cancelTool = tool.cancel;
    const wrapped: ToolRegistration = {
      ...tool,
      execute: (args, api, context) => tool.execute(args, withSessionResolver(api, context), context),
      ...(cancelTool === undefined
        ? {}
        : { cancel: (args, api, context) => cancelTool(args, withSessionResolver(api, context), context) }),
    };
    boundTools.set(tool, wrapped);
    return wrapped;
  };

  const bindExtension = (extension: Extension): Extension => {
    const rawTools = extension.tools;
    const rawWraps = extension.wraps;
    const hasTools = rawTools !== undefined && rawTools.length > 0;
    const hasToolWraps = rawWraps?.some((w) => w.kind === "tool") === true;
    if (!hasTools && !hasToolWraps) return extension;
    const cached = boundExtensions.get(extension);
    if (cached !== undefined) return cached;
    const wrapped: Extension = {
      ...extension,
      ...(rawTools !== undefined && hasTools ? { tools: rawTools.map(bindTool) } : {}),
      ...(rawWraps !== undefined && hasToolWraps
        ? {
            wraps: rawWraps.map((w) =>
              w.kind === "tool" ? { ...w, wrap: (base: ToolRegistration) => bindTool(w.wrap(base)) } : w,
            ),
          }
        : {}),
    };
    boundExtensions.set(extension, wrapped);
    return wrapped;
  };

  const bindSnapshot = (raw: RegistrySnapshot): RegistrySnapshot => {
    const cached = boundSnapshots.get(raw);
    if (cached !== undefined) return cached;
    const installed = raw.installed().map(bindExtension);
    const byName = new Map(installed.map((ext) => [ext.name, ext]));
    const tools = installed.flatMap((extension) => (extension.tools ?? []).map((tool) => ({ extension, tool })));
    const wrapped: RegistrySnapshot = {
      installed: () => installed,
      extension: (name) => byName.get(name),
      tools: () => tools,
      sections: () => raw.sections(),
      tasks: () => raw.tasks(),
      task: (name) => raw.task(name),
    };
    boundSnapshots.set(raw, wrapped);
    return wrapped;
  };

  return {
    snapshot: () => bindSnapshot(registry.snapshot()),
    subscribe: (listener) => registry.subscribe(listener),
  };
}

function idsOf(incarnation: string): Ids {
  const prefix = `${incarnation}.`;
  const cursorPrefix = `${incarnation}~`;
  return {
    encode: (id) => `${prefix}${id}`,
    encodeSession: (id) => SessionId.make(`${prefix}${id}`),
    encodeMessage: (id) => MessageId.make(`${prefix}${id}`),
    decode: (text) => numberAfter(prefix, text),
    encodeCursor: (position) => `${cursorPrefix}${position}`,
    decodeCursor: (text) => numberAfter(cursorPrefix, text),
  };
}

function numberAfter(prefix: string, text: string): number | undefined {
  if (!text.startsWith(prefix)) return undefined;
  const digits = text.slice(prefix.length);
  if (!/^[1-9][0-9]{0,15}$/.test(digits)) return undefined;
  const id = Number(digits);
  return Number.isSafeInteger(id) ? id : undefined;
}
