// Chat plugin settings store — port of the host's api/persona settings
// plumbing (App.tsx loadApiSettings/loadPersona, SettingsPage persistence,
// events.ts settings-changed delivery):
//
// - API + persona settings live in ctx.storage keys "api" and "persona".
//   One-time migration (initChatSettings, called from activate): when the
//   storage key is still empty, the host's localStorage values
//   ("companion:settings" / "companion:persona") are copied over. The
//   localStorage keys are NOT deleted — they stay as legacy during the
//   transition, and saves keep mirroring into them so the transition-period
//   host App keeps working.
// - The API key lives in the OS keychain via ctx.secrets name "api"
//   (account "chat:api"). One-time migration reads the host's legacy GLOBAL
//   "api-key" account (secret_get with no name) through the vendored tauri
//   invoke escape hatch. Saves additionally mirror the key into that legacy
//   global account so the transition-period host App (which loads its key
//   from there) keeps working; failures are logged, never thrown.
// - Cross-window sync: saves emit the plugin-namespaced events
//   "api-settings-changed" / "persona-settings-changed" with full payloads
//   (the key rides in-band, like the host's settings-changed api.key, so the
//   main window never re-reads the keychain at runtime). The chat panel and
//   both settings sections subscribe via useSyncExternalStore.

import type { PluginContext } from "../../sdk/js/@companion/plugin";
import type { ProviderKind } from "./net/providers";
import { tauriInvoke, tauriListen } from "./tauri";

// ─── Shapes (host: ApiSettingsSection.tsx / events.ts PersonaSettings) ───

export type ApiSettings = {
  provider: ProviderKind;
  url: string;
  key: string;
  model: string;
  opacity: number;
};

export type PersonaSettings = {
  companionName: string;
  userName: string;
  promptAppend: string;
};

export const DEFAULT_API_SETTINGS: ApiSettings = {
  provider: "openai",
  url: "https://api.openai.com",
  key: "",
  model: "gpt-4o-mini",
  opacity: 1.0,
};

export const DEFAULT_PERSONA_SETTINGS: PersonaSettings = {
  companionName: "",
  userName: "",
  promptAppend: "",
};

// localStorage keys — MUST match the host's so the transition works.
const LEGACY_SETTINGS_KEY = "companion:settings";
const LEGACY_PERSONA_KEY = "companion:persona";

// ctx.storage keys.
const API_STORE_KEY = "api";
const PERSONA_STORE_KEY = "persona";

// ctx.secrets name (account becomes "chat:api").
export const API_KEY_NAME = "api";

// ─── Store: snapshots + subscribe/emit + cross-window sync ───

type Listener = () => void;

let ctxRef: PluginContext | null = null;
let apiSnapshot: ApiSettings = (() => {
  try {
    const raw = localStorage.getItem(LEGACY_SETTINGS_KEY);
    if (raw) {
      const legacy = JSON.parse(raw) as Record<string, unknown>;
      if (legacy && typeof legacy === "object") {
        return normalizeApi(legacy);
      }
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_API_SETTINGS };
})();
let personaSnapshot: PersonaSettings = { ...DEFAULT_PERSONA_SETTINGS };
let loaded = false;
const listeners = new Set<Listener>();

function notify(): void {
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      /* listener errors must not break the store */
    }
  }
}

function normalizeApi(value: unknown): ApiSettings {
  const v = (value ?? {}) as Partial<ApiSettings>;
  return {
    provider: (v.provider ?? DEFAULT_API_SETTINGS.provider) as ProviderKind,
    url: typeof v.url === "string" ? v.url : DEFAULT_API_SETTINGS.url,
    model: typeof v.model === "string" ? v.model : DEFAULT_API_SETTINGS.model,
    opacity:
      typeof v.opacity === "number" && Number.isFinite(v.opacity)
        ? v.opacity
        : DEFAULT_API_SETTINGS.opacity,
    key: typeof v.key === "string" ? v.key : "",
  };
}

function normalizePersona(value: unknown): PersonaSettings {
  const v = (value ?? {}) as Partial<PersonaSettings>;
  return {
    companionName:
      typeof v.companionName === "string"
        ? v.companionName
        : DEFAULT_PERSONA_SETTINGS.companionName,
    userName:
      typeof v.userName === "string" ? v.userName : DEFAULT_PERSONA_SETTINGS.userName,
    promptAppend:
      typeof v.promptAppend === "string"
        ? v.promptAppend
        : DEFAULT_PERSONA_SETTINGS.promptAppend,
  };
}

/** The API settings without the key — the persisted shape (host: SettingsPage
 *  strips the key before writing localStorage). */
function persistedApi(api: ApiSettings): Omit<ApiSettings, "key"> {
  const { key: _key, ...rest } = api;
  return rest;
}

/** Read the host's legacy GLOBAL "api-key" keychain account (secret_get with
 *  no name). Transitional escape hatch for the one-time migration and the
 *  legacy mirror write only. */
function legacyGlobalKey(): Promise<string | null> {
  return tauriInvoke<string | null>("secret_get").catch(() => null);
}

/** One-time key migration: namespaced "chat:api" first, else copy the legacy
 *  global account value over. Returns the live key ("" when unset). */
async function loadApiKey(): Promise<string> {
  const ctx = ctxRef;
  if (!ctx) return "";
  const direct = (await ctx.secrets.get(API_KEY_NAME).catch(() => null)) ?? "";
  if (direct) return direct;
  const legacy = (await legacyGlobalKey()) ?? "";
  if (!legacy) return "";
  await ctx.secrets.set(API_KEY_NAME, legacy).catch(() => {});
  return legacy;
}

async function persistApiKey(key: string): Promise<void> {
  const ctx = ctxRef;
  if (!ctx) return;
  try {
    await ctx.secrets.set(API_KEY_NAME, key);
  } catch (e) {
    ctx.log.warn(
      `api keychain write failed — the key still works this session but won't survive a restart: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  // Legacy mirror: keep the host's global "api-key" account in sync so the
  // transition-period App.tsx (whose fallback ChatPanel loads the key from
  // there) keeps working while both copies exist.
  void tauriInvoke("secret_set", { value: key }).catch(() => {});
}

/** Idempotent. Must run before the panel/sections touch the store. */
export function initChatSettings(ctx: PluginContext): void {
  if (ctxRef) return;
  ctxRef = ctx;

  // Cross-window sync: the other window's saves land here as events (full
  // payloads, key in-band).
  ctx.events.on("api-settings-changed", (payload) => {
    apiSnapshot = normalizeApi(payload);
    loaded = true;
    notify();
  });
  ctx.events.on("persona-settings-changed", (payload) => {
    personaSnapshot = normalizePersona(payload);
    notify();
  });
  // Transitional ingest: while the host's own duplicate sections still exist
  // (until the host slimming step), the host settings page keeps broadcasting
  // its global "settings-changed" ({api, persona, tts, speech, …}) on every
  // save. Ingest the api/persona fields so edits through the CORE sections
  // reach this store too; after the slimming nobody emits it and this
  // listener just goes quiet.
  void tauriListen<Record<string, unknown>>("settings-changed", (payload) => {
    if (!payload || typeof payload !== "object") return;
    if ("api" in payload) {
      const next = normalizeApi(payload.api);
      if (
        JSON.stringify(persistedApi(next)) !==
          JSON.stringify(persistedApi(apiSnapshot)) ||
        next.key !== apiSnapshot.key
      ) {
        apiSnapshot = next;
        loaded = true;
        notify();
      }
    }
    if ("persona" in payload) {
      const next = normalizePersona(payload.persona);
      if (JSON.stringify(next) !== JSON.stringify(personaSnapshot)) {
        personaSnapshot = next;
        notify();
      }
    }
  }).catch(() => {});

  void (async () => {
    try {
      // One-time storage migrations from the host's localStorage keys.
      let storedApi = await ctx.storage.get<unknown>(API_STORE_KEY);
      if (storedApi == null) {
        try {
          const raw = localStorage.getItem(LEGACY_SETTINGS_KEY);
          if (raw) {
            const legacy = JSON.parse(raw) as Record<string, unknown>;
            if (legacy && typeof legacy === "object") {
              // Copy the api object; the key never migrates through
              // localStorage (it lives in the keychain).
              storedApi = persistedApi(normalizeApi(legacy));
              await ctx.storage.set(API_STORE_KEY, storedApi);
            }
          }
        } catch {
          /* ignore */
        }
      }
      let storedPersona = await ctx.storage.get<unknown>(PERSONA_STORE_KEY);
      if (storedPersona == null) {
        try {
          const raw = localStorage.getItem(LEGACY_PERSONA_KEY);
          if (raw) {
            const legacy = JSON.parse(raw);
            if (legacy && typeof legacy === "object") {
              storedPersona = legacy;
              await ctx.storage.set(PERSONA_STORE_KEY, storedPersona);
            }
          }
        } catch {
          /* ignore */
        }
      }

      const key = await loadApiKey();
      // An in-band event may have delivered settings while we loaded; only
      // fill the key in when the snapshot has none yet.
      if (!apiSnapshot.key) apiSnapshot = { ...normalizeApi(storedApi), key };
      loaded = true;
      personaSnapshot = normalizePersona(storedPersona);
      notify();
    } catch (e) {
      ctx.log.warn(
        `chat settings load failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      loaded = true;
      notify();
    }
  })();
}

export function subscribeChatSettings(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Stable snapshot references (useSyncExternalStore-friendly). */
export function getApiSettings(): ApiSettings {
  return apiSnapshot;
}

export function getPersonaSettings(): PersonaSettings {
  return personaSnapshot;
}

/** Persist the API settings: plugin storage + legacy localStorage mirror +
 *  keychain (namespaced, with legacy global mirror) + cross-window event. */
export function saveApiSettings(next: ApiSettings): void {
  const keyChanged = next.key !== apiSnapshot.key;
  apiSnapshot = normalizeApi(next);
  loaded = true;
  const ctx = ctxRef;
  void ctx?.storage.set(API_STORE_KEY, persistedApi(apiSnapshot)).catch(() => {});
  // Legacy localStorage mirror (key stripped, exactly like the host's
  // SettingsPage) so the transition-period App.tsx keeps working.
  try {
    localStorage.setItem(LEGACY_SETTINGS_KEY, JSON.stringify(persistedApi(apiSnapshot)));
  } catch {
    /* ignore */
  }
  if (keyChanged) void persistApiKey(apiSnapshot.key);
  // Full payload, key in-band (host settings-changed parity).
  ctx?.events.emit("api-settings-changed", apiSnapshot);
  notify();
}

/** Persist the persona settings: plugin storage + legacy localStorage mirror
 *  + cross-window event. */
export function savePersonaSettings(next: PersonaSettings): void {
  personaSnapshot = normalizePersona(next);
  const ctx = ctxRef;
  void ctx?.storage.set(PERSONA_STORE_KEY, personaSnapshot).catch(() => {});
  try {
    localStorage.setItem(LEGACY_PERSONA_KEY, JSON.stringify(personaSnapshot));
  } catch {
    /* ignore */
  }
  ctx?.events.emit("persona-settings-changed", personaSnapshot);
  notify();
}
