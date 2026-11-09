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

export type Msg = { role: "user" | "assistant"; text: string };

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

function sanitize(parsed: unknown): Msg[] {
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(
      (m): m is Msg =>
        !!m &&
        typeof m === "object" &&
        ((m as Msg).role === "user" || (m as Msg).role === "assistant") &&
        typeof (m as Msg).text === "string",
    )
    .slice(-MAX_STORED_MSGS);
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
 *  storage write fails). */
function mirrorLegacy(msgs: Msg[]): void {
  try {
    localStorage.setItem(LEGACY_STORE_KEY, JSON.stringify(msgs));
  } catch {
    /* ignore */
  }
}

export function saveChatHistory(msgs: Msg[]): void {
  setHistorySnapshot(msgs);
  void ctxRef?.storage.set(STORAGE_KEY, snapshot).catch(() => {});
  mirrorLegacy(snapshot);
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
    // memory browser shows a plausible order.
    const now = Date.now();
    pending.forEach((m, i) => {
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
