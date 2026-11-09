// Auto-injection hook for the memory plugin: before each LLM turn, ask the
// memory plugin's `memory__recall` frontend tool for memories relevant to
// the user's message. Fully defensive — the memory plugin may be absent,
// disabled, unconfigured, or slow, and every one of those cases degrades to
// "" (no memory this turn, chat unaffected).
//
// The tool returns a block starting with "Relevant memories from past
// conversations" when it has hits, "No relevant memories found." when the
// store is empty, or "error: …" on failure; only the first shape is worth
// injecting, so anything else is dropped here.

import { execMcpCall } from "./tools";

const MEMORY_TOOL = "memory__recall";
const MEMORY_HEADER = "Relevant memories from past conversations";
// The embedding API round trip must not delay the chat turn noticeably;
// a slow memory is a dropped memory, not a stalled reply.
const TIMEOUT_MS = 1500;

export async function fetchMemoryContext(query: string): Promise<string> {
  const text = query.trim();
  if (!text) return "";
  try {
    const result = await execMcpCall(
      MEMORY_TOOL,
      { query: text, limit: 5 },
      AbortSignal.timeout(TIMEOUT_MS),
    );
    if (typeof result !== "string" || !result.startsWith(MEMORY_HEADER)) return "";
    return result;
  } catch {
    return ""; // missing tool, timeout, aborted — plain chat proceeds
  }
}
