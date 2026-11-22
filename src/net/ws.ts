// Port of the host's app/src/net/ws.ts (unchanged apart from the reply
// `data` record now coming from ./types instead of typed Emotion/Motion).

import type { ChatMessage } from "./protocol";
import type { ProviderUsage } from "./types";
import type { Provider, ProviderConfig, ProviderKind } from "./providers";
import { createProvider } from "./providers";

export type ClientEvents = {
  onToken: (text: string) => void;
  /** Reasoning deltas from thinking models; display only, never spoken. */
  onThinking?: (t: string) => void;
  /** Structured reply fields (e.g. emotion/motion from the avatar engine's
   *  reply contribution). Fired mid-stream as inline tags resolve, then once
   *  more with the final record — the consumer dedups per key. */
  onData: (data: Record<string, unknown>) => void;
  onDone: (fullText: string) => void;
  onError: (e: Error) => void;
  /** Fired instead of onDone/onError when cancel() aborts the stream. */
  onAbort?: () => void;
  onMcpCalls?: (calls: string[]) => void;
  /** Token usage of the final (largest) request of the turn — the real
   *  context fill the auto-compact trigger and the header indicator read.
   *  Absent when the server reports no usage. */
  onUsage?: (u: ProviderUsage) => void;
};

export class RouterClient {
  private provider: Provider;
  private aborter: AbortController | null = null;

  constructor(
    kind: ProviderKind,
    url: string,
    apiKey: string,
    model: string,
    persona?: ProviderConfig["persona"],
  ) {
    this.provider = createProvider(kind, { url, apiKey, model, persona });
  }

  cancel() {
    const ac = this.aborter;
    this.aborter = null;
    try {
      ac?.abort();
    } catch {
      /* already settled */
    }
  }

  get active(): boolean {
    return this.aborter !== null;
  }

  /** `memoryContext` is the memory plugin's recall block for this turn (see
   *  net/memory.ts); ""/undefined = no memory. Threaded into the provider
   *  request so it lands in the system prompt, not as a wire message. */
  async chat(messages: ChatMessage[], h: ClientEvents, memoryContext?: string) {
    const ac = new AbortController();
    this.aborter = ac;
    console.log("[llm] ── request ──");
    console.log("[llm] provider: " + this.provider.kind);
    for (const m of messages) {
      const c =
        typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      console.log("[llm]   " + m.role + ": " + JSON.stringify(c));
    }

    let result;
    try {
      result = await this.provider.chat({
        messages,
        signal: ac.signal,
        memoryContext: memoryContext || undefined,
        onToken: (t) => h.onToken(t),
        onThinking: (t) => h.onThinking?.(t),
        onData: (d) => {
          if (d && Object.keys(d).length) h.onData(d);
        },
      });
    } catch (e) {
      if (ac.signal.aborted) {
        h.onAbort?.();
        return;
      }
      h.onError(e instanceof Error ? e : new Error(String(e)));
      return;
    } finally {
      if (this.aborter === ac) this.aborter = null;
    }

    console.log("[llm] ── response ──");
    console.log("[llm] text:    " + JSON.stringify(result.text));
    const dataKeys = Object.keys(result.data ?? {});
    if (dataKeys.length) console.log("[llm] data:    " + JSON.stringify(result.data));
    if (result.mcpCalls.length) console.log("[llm] mcp:     " + result.mcpCalls.join(", "));
    if (result.usage)
      console.log("[llm] usage:   " + result.usage.inputTokens + " in / " + result.usage.outputTokens + " out");

    if (result.usage) h.onUsage?.(result.usage);
    if (result.data && Object.keys(result.data).length) h.onData(result.data);
    h.onMcpCalls?.(result.mcpCalls);
    h.onDone(result.text);
  }

  /** Plain completion (history compaction — net/compact.ts): no tools, no
   *  reply shaping, no streaming. One-shot; cancellation is via the signal
   *  the caller passes in. */
  async complete(messages: ChatMessage[], signal: AbortSignal): Promise<string> {
    console.log("[llm] ── complete ──");
    return this.provider.complete(messages, signal);
  }
}
