/**
 * Cross-deploy durability for the state root on AgentCore.
 *
 * WHY THIS EXISTS: AgentCore's managed SessionStorage — the `/mnt/state` mount — is reset on every
 * runtime VERSION UPDATE, i.e. on EVERY deploy ("On runtime version update: Data wiped — fresh file
 * system on next invoke", AWS file-system configuration docs), and again after 14 idle days. The
 * mount is therefore a fast LOCAL disk, not the source of truth. Without this module a deploy
 * silently resurrects the agent with no sessions, no channel dedup, no pending wake-ups — and the
 * wake ALARM, which lives in the operator's EventBridge and survives independently, still fires into
 * that empty store: a miss with no error anywhere (exactly the silent-failure class the repo's
 * fail-visibly rule exists to prevent).
 *
 * The durable copy is ONE S3 object reached through PRESIGNED URLS minted per-envelope by the
 * forwarder Lambda. The container holds no AWS credentials (the platform injects none — verified on
 * a live deployment) and stays AWS-SDK-free: a snapshot is one `fetch` GET and one `fetch` PUT.
 *
 * Format: gzip(JSON `{ v, files: { relPath: base64 } }`). Deliberately NOT tar — the state root is a
 * handful of small JSON/JSONL files, and a single self-describing object makes restore ATOMIC: a
 * half-applied state root is far worse than a slightly stale one.
 */
import { Buffer } from "node:buffer";
import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { log } from "../log.ts";
import type { StateUrls } from "./agentcore-protocol.ts";
import { beginWork } from "./busy.ts";

/** Snapshot envelope version — an unknown version fails the restore loudly (never a silent skip). */
export const SNAPSHOT_VERSION = 1;

/** Refuse to pack beyond this (before gzip): a runaway state root would OOM the microVM silently. */
export const MAX_SNAPSHOT_BYTES = 64 << 20;

/** Warn past this — the operator should know the snapshot is getting expensive to round-trip. */
const WARN_SNAPSHOT_BYTES = 16 << 20;

/** Upload deadline. Generous (a large snapshot on a cold network) but finite. */
const PUT_TIMEOUT_MS = 60_000;

/**
 * Files the snapshot must NOT carry. `control.json` is a PER-BOOT artifact (this process's control
 * URL + token, written once the port is known): snapshotting it would hand the next boot a file
 * advertising a dead endpoint and a token that no longer matches the one in memory.
 *
 * Everything else is durable and restores VERBATIM — including `auth.json`. The deploy seeds that
 * file from the builder machine, but the box's own copy is the one that has been REFRESHED, and this
 * snapshot is its volume: the same rule every other host states ("a credential already refreshed on
 * the volume is never overwritten"). The seed is bootstrap for a snapshot that has none.
 *
 * That sentence is only true because the generated template points FASTAGENT_SECRETS_DIR INSIDE the
 * state root (deploy/agentcore/plan.ts `SECRETS_DIR`) — nothing here special-cases credentials, the
 * walk below simply reaches them. Moving the secrets dir back out (e.g. to the sibling layout the
 * volume-backed hosts use) silently un-does it: the file stops being copied, the platform wipes it
 * with the microVM, and a single-use OAuth refresh token dies with it. `restores VERBATIM` is a
 * statement about where that directory is, not a property this module can enforce on its own.
 */
const EXCLUDED = new Set(["control.json"]);

interface StateSnapshot {
  v: number;
  files: Record<string, string>;
}

/** Every regular file under `root`, as root-relative POSIX paths (stable across platforms). */
async function walk(root: string, dir = root, out: string[] = []): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return out;
    throw e;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    // Symlinks/sockets/FIFOs are skipped on purpose: the state root holds plain files, and
    // AgentCore's session storage does not support special files anyway.
    if (entry.isDirectory()) await walk(root, full, out);
    else if (entry.isFile()) out.push(relative(root, full).split(sep).join("/"));
  }
  return out;
}

/** Pack the whole state root into one gzipped snapshot object. */
export async function packStateRoot(stateRoot: string, maxBytes = MAX_SNAPSHOT_BYTES): Promise<Buffer> {
  const files: Record<string, string> = {};
  let raw = 0;
  for (const rel of await walk(stateRoot)) {
    if (EXCLUDED.has(rel)) continue;
    const content = await readFile(join(stateRoot, rel));
    raw += content.byteLength;
    if (raw > maxBytes) {
      throw new Error(`state root exceeds ${maxBytes} bytes — it cannot be snapshotted for cross-deploy durability`);
    }
    files[rel] = content.toString("base64");
  }
  if (raw > WARN_SNAPSHOT_BYTES) {
    log.warn(`[agentcore] state snapshot is large (${Math.round(raw / (1 << 20))} MiB) — every turn round-trips it`);
  }
  return gzipSync(Buffer.from(JSON.stringify({ v: SNAPSHOT_VERSION, files } satisfies StateSnapshot)));
}

/** Apply a snapshot over the state root. Returns how many files were written. */
export async function unpackIntoStateRoot(stateRoot: string, packed: Buffer): Promise<number> {
  let snapshot: StateSnapshot;
  try {
    snapshot = JSON.parse(gunzipSync(packed).toString()) as StateSnapshot;
  } catch (e) {
    throw new Error(`state snapshot is unreadable (${String(e)})`);
  }
  if (snapshot?.v !== SNAPSHOT_VERSION || typeof snapshot.files !== "object" || snapshot.files === null) {
    throw new Error(`state snapshot has an unsupported shape (v=${String(snapshot?.v)})`);
  }
  let written = 0;
  for (const [rel, b64] of Object.entries(snapshot.files)) {
    // A snapshot is written by this same code, but it arrives over the network: refuse anything
    // that could escape the state root.
    if (rel.startsWith("/") || rel.split("/").includes("..")) {
      throw new Error(`state snapshot contains an unsafe path (${rel})`);
    }
    if (EXCLUDED.has(rel)) continue; // never write a per-boot artifact from an older boot
    const target = join(stateRoot, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(b64, "base64"));
    written += 1;
  }
  return written;
}

export interface StateSyncOptions {
  stateRoot: string;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

/**
 * The per-process snapshot lifecycle: restore ONCE before anything reads the state root, then push a
 * coalesced snapshot whenever work settles.
 */
export interface StateSync {
  /** Remember the newest presigned URLs (each envelope carries a fresh pair). */
  use(urls: StateUrls): void;
  /** Resolve once the state root is authoritative. REJECTS if a snapshot exists but cannot be
   *  restored — the caller must fail the request rather than serve from an empty state root (and a
   *  failed restore also blocks {@link StateSync.save}, so bad state is never written back).
   *  Resolves immediately while no URLs are known: a direct programmatic invoke runs in its OWN
   *  isolated session/storage and must neither read nor overwrite the ingress snapshot. */
  ready(): Promise<void>;
  /** Whether snapshotting is active (URLs seen). Lets the caller flag a forwarder envelope that
   *  arrived WITHOUT them — a topology fault that would otherwise lose state silently. */
  configured(): boolean;
  /** Request a snapshot upload; coalesces while one is in flight. Errors are logged, not thrown —
   *  the next settle retries, and the local mount still holds the data until the version changes. */
  save(): void;
  /** Await the in-flight (and any queued) upload — the shutdown/test seam. */
  flush(): Promise<void>;
  /**
   * Push a snapshot NOW and report whether one was actually written — the pre-stop checkpoint
   * (`--run`, before `stop-runtime-session`). Distinct from {@link StateSync.save} on both counts:
   * it forces a fresh round rather than joining a coalescing window (the caller is about to lose
   * this process, so "an upload from a second ago" is not good enough), and it THROWS on failure
   * instead of logging, because the whole point of the call is to know.
   *
   * `written: false` is a legitimate outcome, not an error: a session that never served a forwarder
   * envelope has no URLs and nothing of the shared state to write. The caller must not report that
   * as a successful checkpoint — it is exactly the case where an operator would otherwise believe an
   * in-flight turn had been protected.
   */
  checkpoint(): Promise<{ written: boolean; reason?: string }>;
}

export function createStateSync(options: StateSyncOptions): StateSync {
  const { stateRoot } = options;
  const doFetch = options.fetchImpl ?? fetch;
  let urls: StateUrls | undefined;
  let restore: Promise<void> | undefined;
  let restored = false;
  let saving: Promise<void> | undefined;
  let queued = false;
  // Whether the upload loop is still able to pick up another round. Counting the upload as in-flight
  // work (below) means ITS completion is itself a 0-in-flight edge, which re-enters save() — without
  // this the snapshot would queue a redundant follow-up after every single upload.
  let looping = false;

  const runRestore = async (urls: StateUrls): Promise<void> => {
    const res = await doFetch(urls.getUrl, { method: "GET" });
    // ONLY a proven 404 is "first deploy". A missing key answers 404 only because the generated
    // template grants the signer s3:ListBucket on the snapshot prefix — without it S3 folds "absent"
    // into 403 (anti-enumeration). A 403 therefore means an expired or malformed signature, a
    // revoked permission, or a template from before that grant — i.e. the snapshot may well exist.
    // Reading 403 as "absent" would serve an empty agent and then overwrite the real snapshot with
    // that emptiness.
    if (res.status === 404) {
      log.info("[agentcore] no state snapshot yet — starting from an empty state root (first deploy)");
      restored = true;
      return;
    }
    if (!res.ok) {
      const hint =
        res.status === 403
          ? " (an expired presigned URL, a revoked permission, or a template generated before the " +
            "ForwarderRole granted s3:ListBucket — S3 answers 403 even for a MISSING first-deploy " +
            "snapshot without it; regenerate with `fastagent deploy agentcore --force` and redeploy)"
          : "";
      throw new Error(`state snapshot GET failed: ${res.status}${hint}`);
    }
    const written = await unpackIntoStateRoot(stateRoot, Buffer.from(await res.arrayBuffer()));
    log.info(`[agentcore] restored ${written} state file(s) from the snapshot`);
    restored = true;
  };

  const refreshUrls = async (): Promise<void> => {
    if (!urls?.refresh) return;
    const res = await doFetch(urls.refresh.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ auth: urls.refresh.auth }),
      signal: AbortSignal.timeout(PUT_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`state snapshot URL refresh failed: ${res.status}`);
    const fresh = (await res.json()) as { getUrl?: unknown; putUrl?: unknown };
    if (typeof fresh.getUrl !== "string" || typeof fresh.putUrl !== "string") {
      throw new Error("state snapshot URL refresh returned an invalid response");
    }
    urls = { ...urls, getUrl: fresh.getUrl, putUrl: fresh.putUrl };
  };

  const runSave = async (): Promise<void> => {
    // Counted as in-flight work for its whole duration: `save()` fires on the 0-in-flight edge, the
    // exact moment /ping starts answering Healthy — without this the platform may reclaim the microVM
    // mid-upload and the turn that just finished is lost with only a log line. Bounded too: a hung
    // PUT would otherwise pin `saving` forever and block every later snapshot.
    const workDone = beginWork();
    looping = true;
    try {
      do {
        queued = false;
        if (!restored || !urls) return;
        // A webhook turn may settle hours after its envelope. Re-mint immediately before every PUT
        // instead of assuming the Lambda credentials that signed the envelope outlive the turn.
        await refreshUrls();
        const body = await packStateRoot(stateRoot);
        const res = await doFetch(urls.putUrl, {
          method: "PUT",
          body: new Uint8Array(body),
          signal: AbortSignal.timeout(PUT_TIMEOUT_MS),
        });
        if (!res.ok) {
          const hint =
            res.status === 403 ? " (presigned URL or its temporary signing credentials may have expired)" : "";
          throw new Error(`state snapshot PUT failed: ${res.status}${hint}`);
        }
      } while (queued);
    } finally {
      looping = false;
      workDone();
    }
  };

  return {
    use(next) {
      urls = next;
    },
    configured() {
      return urls !== undefined;
    },
    ready() {
      // No URLs = not an ingress envelope (a direct invoke has its own isolated storage): nothing to
      // restore, and deliberately NOT cached, so the first envelope that does carry them still runs
      // the restore.
      if (!urls) return Promise.resolve();
      // One attempt per process otherwise: a rejected restore stays rejected so every subsequent
      // envelope fails the same visible way instead of quietly serving an empty agent.
      restore ??= runRestore(urls);
      return restore;
    },
    save() {
      if (!restored) return; // never overwrite a good snapshot with a state root we failed to fill
      if (saving) {
        if (looping) queued = true; // otherwise this is the upload's own completion edge, not new work
        return;
      }
      saving = runSave()
        .catch((e) => {
          log.error(`[agentcore] could not save the state snapshot: ${String(e)} — retrying when work next settles`);
        })
        .finally(() => {
          saving = undefined;
        });
    },
    async flush() {
      while (saving) await saving;
    },
    async checkpoint() {
      if (!urls) {
        return { written: false, reason: "this session has never served a forwarder envelope" };
      }
      if (!restored) {
        return { written: false, reason: "the state root is not authoritative here (nothing restored)" };
      }
      // Never overlap an in-flight upload, then run a FRESH one: joining the running round could
      // return before the bytes written moments ago (the interrupted turn's intent) are included.
      while (saving) await saving;
      const run = runSave();
      // Stored form never rejects (an unawaited rejection would be an unhandled crash); the caller
      // awaits `run` itself and gets the error.
      saving = run.then(
        () => {},
        () => {},
      );
      const settle = saving.finally(() => {
        saving = undefined;
      });
      try {
        await run;
      } finally {
        await settle;
      }
      return { written: true };
    },
  };
}
