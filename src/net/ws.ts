// Port of the host's app/src/net/ws.ts (unchanged apart from the Emotion
// type now coming from ./types).

import type { ChatMessage } from "./protocol";
import type { Emotion, Motion } from "./types";
import type { Provider, ProviderConfig, ProviderKind } from "./providers";
import { createProvider } from "./providers";

export type ClientEvents = {
  onToken: (text: string) => void;
  /** Reasoning deltas from thinking models; display only, never spoken. */
  onThinking?: (t: string) => void;
  onEmotion: (e: Emotion) => void;
  onMotion: (m: Motion) => void;
  onDone: (fullText: string) => void;
  onError: (e: Error) => void;
  /** Fired instead of onDone/onError when cancel() aborts the stream. */
  onAbort?: () => void;
  onMcpCalls?: (calls: string[]) => void;
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

  async chat(messages: ChatMessage[], h: ClientEvents) {
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
        onToken: (t) => h.onToken(t),
        onThinking: (t) => h.onThinking?.(t),
        onEmotion: (e) => h.onEmotion(e),
        onMotion: (m) => {
          if (m && m !== "none") h.onMotion(m);
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
    console.log("[llm] emotion: " + result.emotion);
    console.log("[llm] motion:  " + result.motion);
    if (result.mcpCalls.length) console.log("[llm] mcp:     " + result.mcpCalls.join(", "));

    h.onEmotion(result.emotion);
    h.onMotion(result.motion);
    h.onMcpCalls?.(result.mcpCalls);
    h.onDone(result.text);
  }
}
