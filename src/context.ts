// Port of the host's app/src/context.ts. Local additions: the compact-marker
// handling in buildWire, the 80% auto-compact threshold, and token-estimate
// helpers for the context-usage indicator (see net/compact.ts).

import type { ChatAttachment, ChatMessage } from "./net/protocol";
import type { Msg } from "./chat-history";
import { attachmentNote, attachmentTokenEstimate } from "./net/attachments";

// Newest-first budget: 30 user+assistant pairs (60 msgs). The leading
// system/persona message is always pinned — providers build it into
// messages[0], so trimming it would silently drop persona + MCP hints.
export const MAX_WIRE_TURNS = 30;
const MAX_WIRE_MSGS = MAX_WIRE_TURNS * 2;

/** Auto-compact trigger: when the projected context reaches this share of
 *  the configured context window, older history is summarized before the
 *  turn is sent (net/compact.ts, ChatPanel.sendText). */
export const COMPACT_THRESHOLD = 0.8;

function msgContentText(c: ChatMessage["content"]): string {
  if (typeof c === "string") return c;
  return JSON.stringify(c ?? "");
}

export function buildWire(history: Array<Msg | { role: "system"; text: string }>): ChatMessage[] {
  const sys: ChatMessage[] = [];
  let rest = history;
  // A compact marker at the very front is NOT the pinned system/persona
  // message — it must take the summary-as-first-user-message path below
  // (buildMessages replaces the wire's system message with the built
  // persona prompt, which would silently drop the summary).
  if (
    rest.length &&
    rest[0]?.role === "system" &&
    (rest[0] as { kind?: string }).kind !== "compact"
  ) {
    const s = rest[0];
    sys.push({ role: "system", content: s.text });
    rest = rest.slice(1);
  }
  // Compact markers (chat-history entries with kind "compact"): everything
  // before the last one is already summarized — display-only, never
  // re-sent. The summary rides as the first wire message with a user role:
  // mid-wire system messages are dropped by Anthropic/Gemini, and
  // user-first after the system prompt is valid for all three providers.
  let summary: ChatMessage[] = [];
  for (let i = rest.length - 1; i >= 0; i--) {
    const m = rest[i];
    if (m.role === "system" && (m as { kind?: string }).kind === "compact") {
      summary = [
        { role: "user", content: `[Earlier conversation summary]\n${m.text}` },
      ];
      rest = rest.slice(i + 1);
      break;
    }
  }
  const tail = rest.slice(-MAX_WIRE_MSGS);
  return [
    ...sys,
    ...summary,
    ...tail.map((m) => wireMessage(m)),
  ];
}

/** A stored message as a provider-agnostic wire message. Attachments with
 *  bytes ride in the (provider-specific) `attachments` field; data-less
 *  ones — persistence strips old bytes — degrade to a text note so the
 *  model still learns a file existed. */
function wireMessage(m: Msg): ChatMessage {
  const atts = m.role === "user" ? m.attachments : undefined;
  if (!atts?.length) {
    return { role: m.role, content: m.text } as ChatMessage;
  }
  let text = m.text;
  const live: ChatAttachment[] = [];
  for (const a of atts) {
    if (a.dataBase64 || a.frames?.length) {
      live.push({
        name: a.name,
        mime: a.mime,
        base64: a.dataBase64 ?? "",
        ...(a.frames?.length ? { frames: a.frames } : {}),
      });
    } else {
      text = `${text}${text ? "\n" : ""}${attachmentNote(a.name, a.mime)}`;
    }
  }
  return { role: m.role, content: text, ...(live.length ? { attachments: live } : {}) } as ChatMessage;
}

/** Rough token estimate for future budget UI. Not enforced anywhere yet. */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/** Estimate the full request cost when no server-reported usage exists
 *  (first turn of a session, or local endpoints that report no usage):
 *  built system prompt + wire + this turn's memory recall block. Attachment
 *  bytes are NOT stringified — they'd dominate the estimate — so each one
 *  contributes a flat per-kind figure instead. */
export function estimateContextTokens(
  wire: ChatMessage[],
  systemText: string,
  memoryContext?: string,
): number {
  return (
    estimateTokens(systemText) +
    estimateTokens(memoryContext ?? "") +
    wire.reduce(
      (n, m) =>
        n +
        estimateTokens(msgContentText(m.content)) +
        (m.attachments ?? []).reduce(
          (k, a) => k + attachmentTokenEstimate(a.mime, a.base64, a.frames),
          0,
        ),
      0,
    )
  );
}
