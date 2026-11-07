// General tab, Persona Identity section — port of the host's
// app/src/ui/organisms/PersonaSettingsSection.tsx.
//
// Differences from the host: state comes from the plugin settings store
// (ctx.storage "persona") instead of the host settings context; saves write
// BOTH the plugin storage and the legacy localStorage "companion:persona"
// mirror so the transition-period App.tsx keeps working (see ./settings.ts).
// UI kit components come from ctx.ui (the host's shared kit).

import { useSyncExternalStore, type ChangeEvent } from "react";
import type { PluginContext } from "../../../sdk/js/@companion/plugin";
import {
  getPersonaSettings,
  savePersonaSettings,
  subscribeChatSettings,
  type PersonaSettings,
} from "./settings";
import { injectStyles } from "./styles";

export function PersonaSettingsSection({ ctx }: { ctx: PluginContext }) {
  injectStyles();
  const persona = useSyncExternalStore(subscribeChatSettings, getPersonaSettings);
  const { FormField, SectionCard, TextInput, TextArea } = ctx.ui as Record<string, any>;

  const onChange = (next: PersonaSettings) => savePersonaSettings(next);

  return (
    <SectionCard title="Persona Identity" badge="Chat">
      <FormField label="Companion name" hint="Display name used by the AI companion">
        <TextInput
          value={persona.companionName}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onChange({ ...persona, companionName: e.target.value })}
          placeholder="e.g. Hime"
        />
      </FormField>

      <FormField label="Your name" hint="How the companion addresses you">
        <TextInput
          value={persona.userName}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onChange({ ...persona, userName: e.target.value })}
          placeholder="e.g. Alex"
        />
      </FormField>

      <FormField
        label="Extra system prompt"
        hint="Appended to the system prompt (behavior, personality, tone quirks)"
      >
        <TextArea
          value={persona.promptAppend}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange({ ...persona, promptAppend: e.target.value })}
          placeholder="e.g. Speak in short sentences. Prefer playful, dry responses."
          rows={3}
          style={{ minHeight: 70 }}
        />
      </FormField>
    </SectionCard>
  );
}
