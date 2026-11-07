// General tab, Chat Box section — moved from the host's InterfaceSection
// (app/src/ui/organisms/InterfaceSection.tsx): the chat box show/hide toggle.
// (The voice-interrupt toggle started here too but moved to the stt plugin's
// Voice Input section — it configures voice input, not the chat panel.)
// Registered under the stable id "general.chatbox"; when the chat plugin is
// disabled the section disappears with the rest of its contributions — the
// panel it configures is gone too.
//
// The pref stays in the host's localStorage "companion:ui" blob and saves
// emit the host-global "ui-prefs-changed" event, exactly like the host
// section did: the transition-period App.tsx hides its chatPanel wrapper from
// hideChat. The blob is read-merged (never overwritten) so the other owners'
// keys survive (micShortcut + bargeIn — host/stt plugin), and the event
// payload carries the full blob because App.tsx re-applies the shortcut from
// every event.

import { useEffect, useState } from "react";
import type { PluginContext } from "../../../sdk/js/@companion/plugin";
import { tauriEmit, tauriListen } from "./tauri";
import { injectStyles } from "./styles";

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

export function ChatBoxSettingsSection({ ctx }: { ctx: PluginContext }) {
  injectStyles();
  const [prefs, setPrefs] = useState<Required<UiPrefsShape>>(loadUiPrefs);
  const { FormField, SectionCard, Button } = ctx.ui as Record<string, any>;

  const apply = (patch: Partial<UiPrefsShape>) => {
    // Read-merge-write: the blob is shared with the host and other plugins.
    const next = { ...loadUiPrefs(), ...patch };
    setPrefs(next);
    try {
      localStorage.setItem(UI_PREFS_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
    void tauriEmit(UI_PREFS_EVENT, next).catch(() => {});
  };

  // Live sync when the other window saves (the host App and the stt plugin's
  // Voice Input section react to the same event; the section only reflects
  // the new state).
  useEffect(() => {
    let off: (() => void) | null = null;
    tauriListen<UiPrefsShape>(UI_PREFS_EVENT, (p) => {
      setPrefs({ ...loadUiPrefs(), ...p });
    })
      .then((f) => {
        off = f;
      })
      .catch(() => {});
    return () => {
      off?.();
    };
  }, []);

  return (
    <SectionCard title="Chat Box" badge="Chat">
      <FormField
        label="Chat box"
        hint="Hide the whole chat panel (history, input, mic) on the avatar window. Voice and mic keep working."
      >
        <div style={{ display: "flex", gap: 8 }}>
          <Button variant={!prefs.hideChat ? "primary" : "secondary"} onClick={() => apply({ hideChat: false })}>
            Show
          </Button>
          <Button variant={prefs.hideChat ? "primary" : "secondary"} onClick={() => apply({ hideChat: true })}>
            Hide
          </Button>
        </div>
      </FormField>
    </SectionCard>
  );
}
