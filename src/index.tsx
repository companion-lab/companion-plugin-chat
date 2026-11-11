// Chat feature plugin: the avatar's AI conversation, ported from the host
// app (app/src/net/*, ui/organisms/ChatPanel.tsx + molecules, settings
// sections, chat-history, context).
//
// Registrations:
// - "general.chatbox" section (chat box show/hide, moved from the host's
//   InterfaceSection; the voice-interrupt toggle lives in the stt plugin's
//   Voice Input section) and "general.persona" section on the General tab,
//   "connection.api" section (AI backend/provider/key) — same stable ids
//   the core used, so overrides and user habits carry over unchanged.
//   This plugin also registers the Connection tab itself (moved from the
//   voice plugins): the AI backend is the tab's primary card, and the
//   stt/tts cloud endpoint sections render on it keyed by tabId.
// - The main-window chat panel via ctx.main.overrideWidget("chatPanel", …):
//   the host App renders that target with extra props (onEmotion/onMotion,
//   ttsSpeaking, …) both now and after the slimming step — the panel ignores
//   all of them and reads api/persona from the plugin store, speaks through
//   ctx.services, and drives the avatar through ctx.avatar.
//
// All chat logic is frontend-only (providers are HTTP via the vendored
// fetch); there is no Rust backend.

import { definePlugin, type PluginContext } from "@companion-lab/plugin";
import { initChatSettings } from "./settings";
import { initChatHistory } from "./chat-history";
import { setAvatarCapabilities } from "./net/capabilities";
import { ApiSettingsSection } from "./ApiSettingsSection";
import { ChatBoxSettingsSection } from "./ChatBoxSettingsSection";
import { PersonaSettingsSection } from "./PersonaSettingsSection";
import { ChatPanel } from "./ChatPanel";

export default definePlugin((ctx: PluginContext) => {
  ctx.log.info("activating chat plugin");

  // Settings store first: sections + panel read it. Runs the one-time
  // migrations (localStorage api/persona → ctx.storage, legacy global
  // "api-key" keychain account → ctx.secrets "api").
  initChatSettings(ctx);
  // Chat transcript store (ctx.storage "chatHistory", one-time migration
  // from the host's localStorage "companion:chat-history").
  initChatHistory(ctx);

  // Seed the avatar capabilities snapshot from the live bus (defaults apply
  // until the main window's model is up; the panel refreshes per turn).
  try {
    const caps = ctx.avatar.describeCapabilities();
    if (caps.emotions.length || caps.motions.length) setAvatarCapabilities(caps);
  } catch {
    /* defaults stay (see net/capabilities.ts) */
  }

  // Settings: the Connection TAB is registered here (the AI backend is its
  // primary card); the stt/tts cloud endpoint sections render on it keyed
  // by tabId regardless of tab owner.
  ctx.settings.registerTab({
    id: "connection",
    label: "Connection",
    group: "Companion",
    order: 15,
    desc: "AI backend, speech endpoints, and API keys.",
    icon: ({ className }: { className?: string }) => (
      <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0" /><path d="M1.42 9a16 16 0 0 1 21.16 0" /><path d="M8.53 16.11a6 6 0 0 1 6.95 0" /><line x1="12" y1="20" x2="12.01" y2="20" /></svg>
    ),
  });
  ctx.settings.registerSection({
    id: "general.chatbox",
    tabId: "general",
    slot: "top",
    order: 100,
    component: function ChatBoxSectionViaCtx() {
      return <ChatBoxSettingsSection ctx={ctx} />;
    },
  });
  ctx.settings.registerSection({
    id: "general.persona",
    tabId: "general",
    slot: "top",
    order: 100,
    component: function PersonaSectionViaCtx() {
      return <PersonaSettingsSection ctx={ctx} />;
    },
  });
  ctx.settings.registerSection({
    id: "connection.api",
    tabId: "connection",
    slot: "top",
    order: 100,
    component: function ApiSectionViaCtx() {
      return <ApiSettingsSection ctx={ctx} />;
    },
  });

  // Main window: the chat panel itself. The host renders the "chatPanel"
  // target with more props than this needs (both during the transition and
  // after its slimming step, which passes only onEmotion/onMotion); the
  // panel ignores every prop and pulls from the plugin surfaces.
  ctx.main.overrideWidget("chatPanel", function ChatPanelOverride() {
    return <ChatPanel ctx={ctx} />;
  });
});
