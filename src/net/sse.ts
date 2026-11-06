// Port of the host's app/src/net/sse.ts (unchanged).

export async function readSse(
  res: Response,
  signal: AbortSignal,
  onData: (data: string) => void,
): Promise<void> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const cancel = () => reader.cancel().catch(() => {});
  if (signal.aborted) cancel();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const event = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of event.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          onData(data);
        }
      }
      if (signal.aborted) break;
    }
    const tail = buf.trim() + decoder.decode();
    if (tail) {
      for (const line of tail.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        onData(data);
      }
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

// ─── OpenAI-compatible chat/completions stream accumulator ───

export type OpenAiToolCallAcc = { id: string; name: string; args: string };

export type OpenAiDeltaState = {
  content: string;
  /** Chain-of-thought deltas from reasoning models: `reasoning_content`
   *  (DeepSeek-style) or `reasoning` (OpenRouter-style). */
  reasoning: string;
  finishReason: string;
  frames: number;
  calls: Map<number, OpenAiToolCallAcc>;
};

export function openAiDeltaState(): OpenAiDeltaState {
  return { content: "", reasoning: "", finishReason: "", frames: 0, calls: new Map() };
}

// Tool-call `name` and `arguments` arrive split across deltas keyed by
// `index`; only the id is sent whole, so concatenate the rest.
export function applyOpenAiDelta(st: OpenAiDeltaState, data: string): void {
  let chunk: any;
  try {
    chunk = JSON.parse(data);
  } catch {
    return;
  }
  const choices = chunk?.choices;
  if (!Array.isArray(choices) || !choices.length) return;
  st.frames++;
  const choice = choices[0] ?? {};
  if (typeof choice.finish_reason === "string" && choice.finish_reason) {
    st.finishReason = choice.finish_reason;
  }
  const delta = choice.delta ?? choice.message;
  if (typeof delta?.content === "string" && delta.content) st.content += delta.content;
  if (typeof delta?.reasoning_content === "string" && delta.reasoning_content)
    st.reasoning += delta.reasoning_content;
  if (typeof delta?.reasoning === "string" && delta.reasoning)
    st.reasoning += delta.reasoning;
  if (!Array.isArray(delta?.tool_calls)) return;
  for (const tc of delta.tool_calls) {
    const idx = Number.isInteger(tc?.index) ? tc.index : st.calls.size;
    let cur = st.calls.get(idx);
    if (!cur) {
      cur = { id: "", name: "", args: "" };
      st.calls.set(idx, cur);
    }
    if (typeof tc.id === "string" && tc.id) cur.id = tc.id;
    if (typeof tc.function?.name === "string" && tc.function.name) cur.name += tc.function.name;
    if (typeof tc.function?.arguments === "string") cur.args += tc.function.arguments;
  }
}

export function openAiToolCalls(st: OpenAiDeltaState): OpenAiToolCallAcc[] {
  return [...st.calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, c]) => c)
    .filter((c) => c.name);
}

export function extractPartialText(acc: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(acc);
  } catch {
    parsed = null;
  }
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    typeof (parsed as { text?: unknown }).text === "string"
  ) {
    return (parsed as { text: string }).text;
  }
  const m = /"text"\s*:\s*"/.exec(acc);
  if (!m) return "";
  let raw = acc.slice(m.index + m[0].length);
  for (let trim = 0; trim <= 4; trim++) {
    let candidate = trim === 0 ? raw : raw.slice(0, -trim);
    candidate = candidate.replace(/\\u[0-9a-fA-F]{0,3}$/, "");
    if (candidate.endsWith("\\")) candidate = candidate.slice(0, -1);
    try {
      return JSON.parse('"' + candidate + '"');
    } catch {
      continue;
    }
  }
  return "";
}
