// Port of the host's app/src/net/providers/index.ts (unchanged): public entry
// point for the provider layer. Everything outside net/ imports from here, so
// the per-provider implementations stay private.

import type { Provider, ProviderConfig, ProviderKind } from "../types";
import { OpenAIProvider } from "./openai";
import { AnthropicProvider } from "./anthropic";
import { GeminiProvider } from "./gemini";

export type {
  Provider,
  ProviderConfig,
  ProviderKind,
  ProviderRequest,
  ProviderResult,
  McpWireTool,
} from "../types";

export { fetchMcpTools } from "../tools";

export {
  shouldUseMcp,
  keywordFallback,
  taskLooksComplete,
  dropDuplicateAlarms,
} from "../loop";

export {
  SYSTEM_PROMPT,
  buildAvatarDirectives,
  finalAvatarResult,
  emitDiff,
} from "../avatar";

export function createProvider(
  kind: ProviderKind,
  cfg: ProviderConfig,
): Provider {
  const providers: Record<ProviderKind, new (cfg: ProviderConfig) => Provider> =
    {
      openai: OpenAIProvider,
      anthropic: AnthropicProvider,
      gemini: GeminiProvider,
    };

  const ProviderClass = providers[kind];
  if (!ProviderClass) throw new Error(`Unknown provider kind: ${kind}`);
  return new ProviderClass(cfg);
}
