// Port of the host's app/src/context.ts (unchanged).

import type { ChatMessage } from "./net/protocol";
import type { Msg } from "./chat-history";

// Newest-first budget: 30 user+assistant pairs (60 msgs). The leading
// system/persona message is always pinned — providers build it into
// messages[0], so trimming it would silently drop persona + MCP hints.
export const MAX_WIRE_TURNS = 30;
const MAX_WIRE_MSGS = MAX_WIRE_TURNS * 2;

export function buildWire(history: Array<Msg | { role: "system"; text: string }>): ChatMessage[] {
  const sys: ChatMessage[] = [];
  let rest = history;
  if (rest.length && rest[0]?.role === "system") {
    const s = rest[0];
    sys.push({ role: "system", content: s.text });
    rest = rest.slice(1);
  }
  const tail = rest.slice(-MAX_WIRE_MSGS);
  return [
    ...sys,
    ...tail.map((m) => ({ role: m.role, content: m.text }) as ChatMessage),
  ];
}

/** Rough token estimate for future budget UI. Not enforced anywhere yet. */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}
