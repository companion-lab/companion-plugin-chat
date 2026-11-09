// Port of the host's app/src/net/types.ts. The only change: the Emotion type
// is a plain string here — the host imports it from its expression
// controller, which a plugin cannot reach. Values are canonical emotion names
// resolved against the avatar capabilities (see ./capabilities.ts) and handed
// to ctx.avatar.setEmotion.

import type { ChatMessage } from "./protocol";

// Shared provider contract: what every provider implementation receives and
// returns, plus the MCP wire tool shape the tool loop passes around.

/** Canonical emotion name (validated against ctx.avatar capabilities). */
export type Emotion = string;

export type ProviderKind = "openai" | "anthropic" | "gemini";

export type ProviderConfig = {
  url: string;
  apiKey: string;
  model: string;
  persona?: {
    companionName: string;
    userName: string;
    promptAppend: string;
  };
};

export type ProviderRequest = {
  messages: ChatMessage[];
  signal: AbortSignal;
  /** Memory plugin recall block for this turn's user message ("" when the
   *  memory plugin is absent/disabled). Appended to the system prompt —
   *  Anthropic/Gemini drop non-leading system messages, so it must ride in
   *  the single system message rather than as a wire system message. */
  memoryContext?: string;
  onToken?: (t: string) => void;
  /** Reasoning deltas from thinking models (reasoning_content, thinking
   *  blocks, thought summaries). Never goes to TTS; display only. */
  onThinking?: (t: string) => void;
  /** Fired mid-stream as soon as an inline tag resolves, so the avatar
   *  reacts while the reply is still being spoken. */
  onEmotion?: (e: Emotion) => void;
  onMotion?: (m: Motion) => void;
};

export type ProviderResult = {
  text: string;
  emotion: Emotion;
  motion: Motion;
  mcpCalls: string[];
};

export interface Provider {
  readonly kind: ProviderKind;
  chat(req: ProviderRequest): Promise<ProviderResult>;
}

export type McpWireTool = {
  server_id: string;
  name: string;
  qualified: string;
  description: string;
  schema: unknown;
};

/** One native tool call emitted by a model, before it is turned into a
 *  provider-specific tool message. */
export type McpNativeCall = { id: string; qualified: string; args: unknown };

// Re-exported Motion (host: net/structured; same string alias here).
export type Motion = string;
