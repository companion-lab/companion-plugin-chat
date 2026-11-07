// Port of the host's app/src/chat-history.ts. The stored copy moves from
// localStorage "companion:chat-history" to ctx.storage key "chatHistory"
// (one-time migration in initChatHistory; the localStorage key is left in
// place as legacy, never deleted).
//
// The host read the history synchronously at ChatPanel mount; plugin storage
// is async, so the panel reads a module snapshot (useSyncExternalStore) that
// hydrates once the storage read lands. Writes update the snapshot
// immediately and persist debounced (the panel already debounces 500ms).

import type { PluginContext } from "../../../sdk/js/@companion/plugin";

export type Msg = { role: "user" | "assistant"; text: string };

export const MAX_STORED_MSGS = 100;

// Plugin storage key (manifest permission: storage).
const STORAGE_KEY = "chatHistory";
// Legacy host key — read once during migration, then left untouched.
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
  void (async () => {
    try {
      let stored = await ctx.storage.get<unknown>(STORAGE_KEY);
      if (stored == null) {
        // One-time migration from the host's localStorage key. Not deleted —
        // the host may still be reading it during the transition.
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

export function saveChatHistory(msgs: Msg[]): void {
  setHistorySnapshot(msgs);
  void ctxRef?.storage.set(STORAGE_KEY, snapshot).catch(() => {});
}

export function clearChatHistory(): void {
  snapshot = [];
  hydrated = true;
  notify();
  void ctxRef?.storage.remove(STORAGE_KEY).catch(() => {});
}
