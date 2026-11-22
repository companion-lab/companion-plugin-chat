// Shared provider contract: what every provider implementation receives and
// returns, plus the MCP wire tool shape the tool loop passes around.
//
// Structured replies are generic: providers return { text, data } — `text`
// feeds display/TTS/history, `data` carries the reply owner's fields (e.g.
// emotion/motion from the avatar engine's reply contribution, see
// ./reply.ts) and is forwarded to that contribution's `apply`.

import type { ChatMessage } from "./protocol";

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
   *  the single system message rather than as a wire message. */
  memoryContext?: string;
  onToken?: (t: string) => void;
  /** Reasoning deltas from thinking models (reasoning_content, thinking
   *  blocks, thought summaries). Never goes to TTS; display only. */
  onThinking?: (t: string) => void;
  /** Fired mid-stream as soon as an inline reply tag resolves, so the reply
   *  owner reacts while the reply is still being spoken. */
  onData?: (data: Record<string, unknown>) => void;
};

export type ProviderResult = {
  text: string;
  /** Extra structured fields from the reply (empty when no reply
   *  contribution is active). Forwarded to the contribution's apply. */
  data: Record<string, unknown>;
  mcpCalls: string[];
  /** Token usage reported by the provider for the FINAL request of the turn
   *  (the largest one, after tool-loop growth). inputTokens is the actual
   *  context fill — the auto-compact trigger reads it (see ./ws.ts onUsage,
   *  net/compact.ts). Absent when the server reports no usage (some local
   *  OpenAI-compatible endpoints); callers then fall back to estimates. */
  usage?: ProviderUsage;
};

export type ProviderUsage = {
  inputTokens: number;
  outputTokens: number;
};

export interface Provider {
  readonly kind: ProviderKind;
  chat(req: ProviderRequest): Promise<ProviderResult>;
  /** Plain text completion without tools or reply shaping — history
   *  compaction summarizes older messages through this (net/compact.ts).
   *  A leading system message is allowed; providers lift it into their
   *  system field/first message as their API requires. */
  complete(messages: ChatMessage[], signal: AbortSignal): Promise<string>;
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
