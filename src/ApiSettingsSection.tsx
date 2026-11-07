// Connection tab, AI Backend section — port of the host's
// app/src/ui/organisms/ApiSettingsSection.tsx.
//
// Differences from the host:
// - State comes from the plugin settings store (ctx.storage "api" + ctx
//   .secrets "api") instead of the host settings context; saves write BOTH
//   the plugin storage and the legacy localStorage "companion:settings"
//   mirror (key stripped, host parity) so the transition-period App.tsx
//   keeps working (see ./settings.ts).
// - The API key lives in the keychain via ctx.secrets (account "chat:api"),
//   migrated one-time from the host's global "api-key" account. Clearing
//   deletes both the namespaced and the legacy global account.
// - UI kit components come from ctx.ui (the host's shared kit).

import { useSyncExternalStore, type ChangeEvent } from "react";
import type { PluginContext } from "../../../sdk/js/@companion/plugin";
import type { ProviderKind } from "./net/providers";
import {
  getApiSettings,
  saveApiSettings,
  subscribeChatSettings,
  type ApiSettings,
} from "./settings";
import { injectStyles } from "./styles";

const PROVIDERS: {
  id: ProviderKind;
  label: string;
  model: string;
  defaultUrl: string;
  defaultModel: string;
  keyHint: string;
  note: string;
}[] = [
  {
    id: "openai",
    label: "OpenAI-Compatible",
    model: "GPT-style chat API",
    defaultUrl: "https://api.openai.com",
    defaultModel: "gpt-4o-mini",
    keyHint: "sk-...",
    note: "Works with OpenAI, LocalAI, or any OpenAI-compatible endpoint you host locally.",
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    model: "Messages API",
    defaultUrl: "https://api.anthropic.com",
    defaultModel: "claude-3-5-sonnet-latest",
    keyHint: "sk-ant-...",
    note: "Official Anthropic Messages API. Provide your Claude console key.",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    model: "Generative Language",
    defaultUrl: "https://generativelanguage.googleapis.com",
    defaultModel: "gemini-1.5-flash",
    keyHint: "AIza...",
    note: "Google Gemini API using the Generative Language endpoint.",
  },
];

export function ApiSettingsSection({ ctx }: { ctx: PluginContext }) {
  injectStyles();
  const api = useSyncExternalStore(subscribeChatSettings, getApiSettings);
  const { FormField, SectionCard, TextInput, Button } = ctx.ui as Record<string, any>;
  const selected = PROVIDERS.find((p) => p.id === api.provider) ?? PROVIDERS[0];

  const onChange = (next: ApiSettings) => saveApiSettings(next);

  return (
    <SectionCard
      title="AI Backend"
      badge={selected.label}
    >
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 8 }}>
        Provider
      </div>

      <div className="provider-grid">
        {PROVIDERS.map((p) => {
          const active = p.id === api.provider;
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={active}
              className="provider-card"
              onClick={() =>
                onChange({
                  ...api,
                  provider: p.id,
                  url: p.defaultUrl,
                  model: p.defaultModel,
                })
              }
            >
              <span className="provider-card-name">{p.label}</span>
              <span className="provider-card-sub">{p.model}</span>
            </button>
          );
        })}
      </div>

      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 16 }}>
        {selected.note}
      </div>

      <FormField label="Endpoint URL">
        <TextInput
          value={api.url}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onChange({ ...api, url: e.target.value })}
          placeholder={selected.defaultUrl}
        />
      </FormField>

      <FormField
        label={`API Key ${api.key ? "✓ Secured" : "Not set"}`}
        hint="Isolated in your OS keychain — never logged, never committed"
      >
        <div style={{ display: "flex", gap: 6 }}>
          <TextInput
            type="password"
            value={api.key}
            onChange={(e: ChangeEvent<HTMLInputElement>) => onChange({ ...api, key: e.target.value })}
            placeholder={selected.keyHint}
          />
          <Button
            variant="ghost"
            onClick={() => onChange({ ...api, key: "" })}
          >
            Clear
          </Button>
        </div>
      </FormField>

      <FormField label="Chat Model ID" hint="Exact model name your provider expects">
        <TextInput
          value={api.model}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onChange({ ...api, model: e.target.value })}
          placeholder={selected.defaultModel}
        />
      </FormField>
    </SectionCard>
  );
}
