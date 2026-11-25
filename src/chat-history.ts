// Port of the host's app/src/chat-history.ts. The stored copy lives in
// ctx.storage key "chatHistory" (one-time migration from the host's
// localStorage "companion:chat-history" in initChatHistory); every save
// mirrors back into that localStorage key — the same transition pattern as
// the api/persona settings stores — so the history stays visible there and
// a failed storage write still leaves a recent copy. Clearing removes both.
//
// The host read the history synchronously at ChatPanel mount; plugin storage
// is async, so the panel reads a module snapshot (useSyncExternalStore) that
// hydrates once the storage read lands. Writes update the snapshot
// immediately and persist debounced (the panel already debounces 500ms).

import type { PluginContext } from "@companion-lab/plugin";
import { tauriListen } from "./tauri";
import { PERSIST_KEEP_BUDGET_BASE64 } from "./net/attachments";
import type { VideoFrame } from "./net/protocol";

// A history entry is a chat message, or — with role "system" + kind
// "compact" — the auto-compact summary note (net/compact.ts): it renders as
// a collapsed divider, stays out of the memory backfill, and buildWire
// turns it into the summary user message instead of re-sending the older
// messages it stands for.
//
// User entries may carry file attachments. `dataBase64` is kept only while
// it's fresh (see stripAttachmentsForPersist): the persisted copy keeps the
// bytes for recent attachment-bearing messages within a small budget and
// drops them from older ones — the chip keeps showing name/mime and the
// wire degrades those to a text note (context.ts buildWire). Video
// attachments carry `frames` (keyframes) under the same budget.
export type MsgAttachment = {
  name: string;
  mime: string;
  size: number;
  dataBase64?: string;
  frames?: VideoFrame[];
};

export type Msg = {
  role: "user" | "assistant" | "system";
  text: string;
  kind?: "compact";
  attachments?: MsgAttachment[];
};

export const MAX_STORED_MSGS = 100;

// Plugin storage key (manifest permission: storage).
const STORAGE_KEY = "chatHistory";
// Legacy host key — read once during migration, then kept in sync on every
// save (mirror) and removed on clear.
const LEGACY_STORE_KEY = "companion:chat-history";

let ctxRef: PluginContext | null = null;
let snapshot: Msg[] = [];
let hydrated = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      /* listener errors must not break the store */
    }
  }
}

/** Validate an array of unknown objects into the stored Msg shape (exported
 *  for tests; initChatHistory applies it to whatever storage returns). */
export function sanitize(parsed: unknown): Msg[] {
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((m): m is Msg => {
      if (!m || typeof m !== "object" || typeof (m as Msg).text !== "string") {
        return false;
      }
      const role = (m as Msg).role;
      // "system" entries are only ever the auto-compact summary note —
      // anything else would leak into the wire unprompted.
      if (role === "system") return (m as Msg).kind === "compact";
      return role === "user" || role === "assistant";
    })
    .map(sanitizeAttachments)
    .slice(-MAX_STORED_MSGS);
}

/** Attachments are user-only and must carry name+mime (bytes are optional —
 *  persistence strips them from older messages). Anything malformed drops
 *  the whole attachment rather than leaking into provider requests. */
function sanitizeAttachments(m: Msg): Msg {
  if (!Array.isArray(m.attachments)) return m;
  if (m.role !== "user") {
    const { attachments: _drop, ...rest } = m;
    return rest;
  }
  const ok = m.attachments.filter(
    (a): a is MsgAttachment =>
      !!a &&
      typeof a === "object" &&
      typeof a.name === "string" &&
      !!a.name &&
      typeof a.mime === "string" &&
      !!a.mime &&
      (a.dataBase64 === undefined || typeof a.dataBase64 === "string") &&
      (a.frames === undefined ||
        (Array.isArray(a.frames) &&
          a.frames.every(
            (f) => !!f && typeof f === "object" && typeof f.dataBase64 === "string" && Number.isFinite(f.atMs),
          ))),
  );
  return ok.length ? { ...m, attachments: ok } : { ...m, attachments: undefined };
}

/** Idempotent. Loads the stored history (after the one-time legacy
 *  migration) into the snapshot the panel subscribes to. */
export function initChatHistory(ctx: PluginContext): void {
  if (ctxRef) return;
  ctxRef = ctx;
  startMemoryBackfill(ctx);
  void (async () => {
    try {
      let stored = await ctx.storage.get<unknown>(STORAGE_KEY);
      if (stored == null) {
        // One-time migration from the host's localStorage key. From here on
        // the mirror (see mirrorLegacy) keeps that key fresh instead.
        try {
          const raw = localStorage.getItem(LEGACY_STORE_KEY);
          if (raw) stored = JSON.parse(raw);
        } catch {
          /* ignore */
        }
        if (stored != null) {
          await ctx.storage.set(STORAGE_KEY, stored).catch(() => {});
        }
      }
      // A write may have landed while the read was in flight; don't clobber.
      if (!hydrated) {
        snapshot = sanitize(stored);
        hydrated = true;
        // Available for the memory plugin's backfill request (consumed once).
        pendingBackfill = snapshot.slice();
        notify();
      }
    } catch (e) {
      ctx.log.warn(
        `chat history load failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  })();
}

/** Stable snapshot reference (useSyncExternalStore-friendly). */
export function getChatHistory(): Msg[] {
  return snapshot;
}

export function subscribeChatHistory(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Update the in-memory snapshot only (storage write happens via
 *  saveChatHistory). Used for debounced saving: the snapshot must be
 *  immediate for the panel, the storage write can lag. */
export function setHistorySnapshot(msgs: Msg[]): void {
  const trimmed = msgs.slice(-MAX_STORED_MSGS);
  snapshot = trimmed;
  hydrated = true;
  notify();
}

/** Keep the host's legacy localStorage copy in sync with the plugin storage
 *  (transition parity: inspectable in devtools, and a recovery copy when a
 *  storage write fails). The mirror never carries attachment bytes — the
 *  ~5 MB localStorage quota would fill after a couple of images. */
function mirrorLegacy(msgs: Msg[]): void {
  try {
    localStorage.setItem(LEGACY_STORE_KEY, JSON.stringify(stripAllAttachmentData(msgs)));
  } catch {
    /* ignore */
  }
}

/** A copy with every attachment byte removed (name/mime/size survive, so
 *  chips still render and the wire degrades to notes). */
export function stripAllAttachmentData(msgs: Msg[]): Msg[] {
  return msgs.map((m) =>
    m.attachments?.some((a) => a.dataBase64 || a.frames?.length)
      ? {
          ...m,
          attachments: m.attachments.map(({ dataBase64: _b, frames: _f, ...a }) => a),
        }
      : m,
  );
}

/** The budget cost of one attachment: everything that would cross the wire
 *  with bytes — base64 and keyframes. */
function attachmentCost(a: MsgAttachment): number {
  return (a.dataBase64?.length ?? 0) + (a.frames?.reduce((n, f) => n + f.dataBase64.length, 0) ?? 0);
}

/** The persisted copy keeps attachment bytes only while they're worth their
 *  storage cost: newest-first, attachment-bearing user messages keep their
 *  base64 until a cumulative budget (~2 MB) is spent; older ones drop the
 *  bytes. Recent visual context survives restarts for multi-turn follow-ups
 *  ("what did I just show you?") without storage growing unbounded. */
export function stripAttachmentsForPersist(msgs: Msg[]): Msg[] {
  let budget = PERSIST_KEEP_BUDGET_BASE64;
  const out: Msg[] = [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    const hasData = m.role === "user" && m.attachments?.some((a) => attachmentCost(a) > 0);
    if (!hasData) {
      out.unshift(m);
      continue;
    }
    const cost = m.attachments!.reduce((n, a) => n + attachmentCost(a), 0);
    if (cost <= budget) {
      budget -= cost;
      out.unshift(m);
    } else {
      out.unshift({
        ...m,
        attachments: m.attachments!.map(({ dataBase64: _b, frames: _f, ...a }) => a),
      });
    }
  }
  return out;
}

export function saveChatHistory(msgs: Msg[]): void {
  setHistorySnapshot(msgs);
  // The snapshot the panel subscribes to keeps full bytes; only the
  // persisted copies are stripped (see stripAttachmentsForPersist).
  const persisted = stripAttachmentsForPersist(snapshot);
  void ctxRef?.storage.set(STORAGE_KEY, persisted).catch(() => {});
  mirrorLegacy(persisted);
}

export function clearChatHistory(): void {
  snapshot = [];
  hydrated = true;
  notify();
  void ctxRef?.storage.remove(STORAGE_KEY).catch(() => {});
  // Remove the mirror too — otherwise the one-time migration would resurrect
  // the cleared history from localStorage on the next start.
  try {
    localStorage.removeItem(LEGACY_STORE_KEY);
  } catch {
    /* ignore */
  }
}

// ─── Memory-plugin backfill ───
// The memory plugin (vector store of past messages) asks for the existing
// history once per session, via the raw "plugin:memory:backfill-request"
// event — cross-plugin, the same channel pattern as the alarm-fired events.
// We re-emit each stored message through the same ctx.events.emit("message")
// path the live capture uses; the memory backend dedupes exact role+text
// repeats, so serving a request can never double-store. pendingBackfill is
// per-session: set at hydration, consumed by the FIRST request — later
// requests get nothing (dedupe would catch re-emits, but re-embedding
// hundreds of messages would burn embedding API calls for nothing).

let pendingBackfill: Msg[] | null = null;
let backfillListenerStarted = false;

function startMemoryBackfill(ctx: PluginContext): void {
  if (backfillListenerStarted) return;
  backfillListenerStarted = true;
  void tauriListen("plugin:memory:backfill-request", () => {
    const pending = pendingBackfill;
    pendingBackfill = null;
    if (!pending?.length) return;
    // Synthetic timestamps spaced a minute apart, oldest first, so the
    // memory browser shows a plausible order. Compact markers are skipped:
    // the summary paraphrases messages the store already has.
    const now = Date.now();
    pending.forEach((m, i) => {
      if (m.role === "system") return;
      ctx.events.emit("message", {
        role: m.role,
        text: m.text,
        ts: now - (pending.length - 1 - i) * 60_000,
      });
    });
    ctx.log.info(`memory backfill: served ${pending.length} messages`);
  }).catch(() => {
    /* non-Tauri run — nothing to backfill */
  });
}
