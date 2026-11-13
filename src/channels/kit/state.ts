/**
 * Channel per-instance persistent state tables: bounded dedup ring (`SeenRing`), message ownership (`MessageOwners`),
 * group-thread participation (`ThreadParticipants`), and sender conversation keying.
 */
import { log } from "../../log.ts";
import { loadStateFile, saveStateFile } from "../../state-file.ts";

/** Conversation key for a sender on a group's main timeline. */
export function senderConversation(place: string, sender: string | number | undefined): string {
  return sender === undefined || sender === "" ? place : `${place}#${sender}`;
}

export function isSenderConversation(place: string, conversation: string): boolean {
  return conversation.startsWith(`${place}#`);
}

export interface SeenRing {
  has(id: string): boolean;
  add(id: string): void;
}

export function createSeenRing(path: string, label: string, cap = 2000): SeenRing {
  const raw = loadStateFile(path);
  const order =
    raw === undefined
      ? []
      : Array.isArray(raw) && raw.every((id) => typeof id === "string")
        ? raw.slice(-cap)
        : undefined;
  if (order === undefined) log.warn(`${label} unexpected shape in ${path} — starting with no seen ids`);
  const values = order ?? [];
  const ids = new Set(values);
  return {
    has: (id) => ids.has(id),
    add(id) {
      if (ids.has(id)) return;
      ids.add(id);
      values.push(id);
      while (values.length > cap) {
        const evicted = values.shift();
        if (evicted !== undefined) ids.delete(evicted);
      }
      try {
        saveStateFile(path, values);
      } catch (error) {
        log.warn(`${label} seen-ring write failed (delivery dedup is in-memory until restart): ${String(error)}`);
      }
    },
  };
}

const MAX_OWNERS = 1000;

interface MessageOwner {
  conversation: string;
  ask?: string;
}

export interface MessageOwners {
  record(key: string, owner: MessageOwner): void;
  ownerOf(key: string): MessageOwner | undefined;
}

export function createMessageOwners(options: { label: string; path: string; maxMessages?: number }): MessageOwners {
  const { label, path, maxMessages = MAX_OWNERS } = options;
  const owners = loadOwners(path, label);
  return {
    record(key, owner) {
      owners.delete(key);
      owners.set(key, owner);
      for (const victim of [...owners.keys()].slice(0, Math.max(0, owners.size - maxMessages))) owners.delete(victim);
      try {
        saveStateFile(path, Object.fromEntries(owners));
      } catch (error) {
        log.warn(
          `${label} could not write ${path}: after a restart a reply to an earlier message is no longer steered into ` +
            `the session it names: ${String(error)}`,
        );
      }
    },
    ownerOf: (key) => owners.get(key),
  };
}

function isOwner(value: unknown): value is MessageOwner {
  const owner = value as MessageOwner | null;
  return (
    typeof owner === "object" &&
    owner !== null &&
    typeof owner.conversation === "string" &&
    (owner.ask === undefined || typeof owner.ask === "string")
  );
}

function loadOwners(path: string, label: string): Map<string, MessageOwner> {
  const raw = loadStateFile(path);
  if (raw === undefined) return new Map();
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw) && Object.values(raw).every(isOwner)) {
    return new Map(Object.entries(raw as Record<string, MessageOwner>));
  }
  log.warn(
    `${label} unexpected shape in ${path} — replies are not steered into earlier sessions until it is rewritten`,
  );
  return new Map();
}

const MAX_THREADS = 1000;
const MAX_HUMANS = 2;

interface ThreadParticipation {
  humans: string[];
  agentSpoke: boolean;
}

export interface ThreadParticipants {
  admitsBareMessage(key: string): boolean;
  agentSpokeIn(key: string): boolean;
  merge(key: string, heard: { humans?: string[]; agentSpoke?: true }): void;
}

function isStoredParticipation(value: unknown): value is ThreadParticipation {
  const record = value as ThreadParticipation;
  return (
    Array.isArray(record?.humans) &&
    record.humans.every((human) => typeof human === "string") &&
    typeof record.agentSpoke === "boolean"
  );
}

export function createThreadParticipants(path: string, label: string): ThreadParticipants {
  const raw = loadStateFile(path);
  const records = new Map<string, ThreadParticipation>();
  if (raw !== undefined) {
    if (
      typeof raw === "object" &&
      raw !== null &&
      !Array.isArray(raw) &&
      Object.values(raw).every(isStoredParticipation)
    ) {
      for (const [key, record] of Object.entries(raw as Record<string, ThreadParticipation>)) {
        records.set(key, { humans: record.humans, agentSpoke: record.agentSpoke });
      }
    } else {
      log.warn(`${label} unexpected shape in ${path} — starting with no thread participation`);
    }
  }

  return {
    admitsBareMessage(key) {
      const heard = records.get(key);
      return heard?.agentSpoke === true && heard.humans.length <= 1;
    },
    agentSpokeIn(key) {
      return records.get(key)?.agentSpoke === true;
    },
    merge(key, heard) {
      const previous = records.get(key);
      const humans = new Set(previous?.humans ?? []);
      for (const human of heard.humans ?? []) {
        if (humans.size >= MAX_HUMANS) break;
        humans.add(human);
      }
      const next: ThreadParticipation = {
        humans: [...humans],
        agentSpoke: (previous?.agentSpoke ?? false) || (heard.agentSpoke ?? false),
      };
      const unchanged =
        previous !== undefined &&
        previous.agentSpoke === next.agentSpoke &&
        previous.humans.length === next.humans.length;
      records.delete(key);
      records.set(key, next);
      if (unchanged) return;
      while (records.size > MAX_THREADS) {
        let evict: string | undefined;
        for (const [candidate, record] of records) {
          if (candidate === key) continue;
          if (!record.agentSpoke) {
            evict = candidate;
            break;
          }
          evict ??= candidate;
        }
        if (evict === undefined) break;
        records.delete(evict);
      }
      try {
        saveStateFile(path, Object.fromEntries(records));
      } catch (error) {
        log.warn(`${label} could not persist thread participation ${path}: ${String(error)}`);
      }
    },
  };
}
