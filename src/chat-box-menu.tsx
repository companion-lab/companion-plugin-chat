// Chat box show/hide as a context-menu item on the avatar window — moved
// from the old General-tab "Chat Box" section (ChatBoxSettingsSection.tsx):
// right-click the companion window → "Hide chat box" / "Show chat box".
//
// The pref stays in the host's localStorage "companion:ui" blob and the save
// emits the host-global "ui-prefs-changed" event exactly like the old
// section did: the transition-period App.tsx hides/shows its chatPanel
// wrapper from that event. The host's ctx.main.setUiPrefs (when present)
// persists + applies to THIS context synchronously and only emits for the
// other windows/tabs — the event echo alone made the toggle lag one round
// trip behind the click on the web bridge. The blob is read-merged (never
// overwritten) so
// the other owners' keys survive (micShortcut + bargeIn — host/stt plugin),
// and the payload carries the full blob because App.tsx re-applies the
// shortcut from every event.
//
// The label tracks the pref live. The registry keeps context-menu
// contributions by reference and re-reads them on every menu open, so the
// registered item's label is updated in place — re-registering would append
// a duplicate entry instead (registry keys are append-only). The
// ui-prefs-changed listener keeps the label honest when another window saves
// the blob: the host and the stt plugin write other keys into it and emit
// the full payload, so hideChat may change from outside this item too.

import type { ContextMenuItemContribution, PluginContext } from "@companion-lab/plugin";
import { tauriEmit, tauriListen } from "./tauri";

// Host ui-prefs store (app/src/ui-prefs.ts, localStorage "companion:ui").
// Defaults mirrored here so a fresh blob still carries the micShortcut the
// host App re-applies from every ui-prefs-changed payload.
const UI_PREFS_KEY = "companion:ui";
const UI_PREFS_EVENT = "ui-prefs-changed";

type UiPrefsShape = {
  hideChat?: boolean;
  micShortcut?: string;
  bargeIn?: boolean;
};

const DEFAULTS: Required<UiPrefsShape> = {
  hideChat: false,
  micShortcut: "Ctrl+Shift+M",
  bargeIn: true,
};

function loadUiPrefs(): Required<UiPrefsShape> {
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY);
    const stored = raw ? (JSON.parse(raw) as UiPrefsShape) : {};
    return { ...DEFAULTS, ...stored };
  } catch {
    return { ...DEFAULTS };
  }
}

function apply(ctx: PluginContext, patch: Partial<UiPrefsShape>): Required<UiPrefsShape> {
  // Read-merge-write: the blob is shared with the host and other plugins.
  const next = { ...loadUiPrefs(), ...patch };
  // Fast path: the host persists + applies to THIS context synchronously and
  // broadcasts for the other windows/tabs — no event-echo wait, which on the
  // web bridge is a WebSocket round trip (the toggle visibly lagged there).
  // Older hosts fall back to the event-echo path (write + emit).
  const host = ctx.main as typeof ctx.main & { setUiPrefs?: (p: UiPrefsShape) => void };
  if (typeof host.setUiPrefs === "function") {
    host.setUiPrefs(next);
  } else {
    try {
      localStorage.setItem(UI_PREFS_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
    void tauriEmit(UI_PREFS_EVENT, next).catch(() => {});
  }
  return next;
}

// Label states the action (not the state): visible → "Hide chat box".
const labelFor = (hide: boolean) => (hide ? "Show chat box" : "Hide chat box");

export function initChatBoxMenu(ctx: PluginContext): void {
  const item: ContextMenuItemContribution = {
    id: "chat.chatbox",
    label: labelFor(loadUiPrefs().hideChat),
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
    onSelect: () => {
      item.label = labelFor(apply(ctx, { hideChat: !loadUiPrefs().hideChat }).hideChat);
    },
  };
  ctx.main.registerContextMenuItem(item);

  // Live sync when another window saves the blob (payload is the full blob).
  // No Tauri IPC (plain-web dev) → the item label still tracks local toggles.
  void tauriListen<UiPrefsShape>(UI_PREFS_EVENT, (p) => {
    const hide = typeof p?.hideChat === "boolean" ? p.hideChat : loadUiPrefs().hideChat;
    item.label = labelFor(hide);
  }).catch(() => {});
}
