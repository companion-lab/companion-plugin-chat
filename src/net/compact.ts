// Auto-compact: when the projected LLM context reaches COMPACT_THRESHOLD of
// the configured window (context.ts), older history is summarized into a
// single compact note (through the plain completion pass — Provider
// .complete) and the wire is rebuilt from summary + recent messages.
//
// Non-destructive: older messages stay in the stored history and the
// visible transcript; they only stop being SENT — buildWire drops
// everything before the last compact marker. The memory plugin already
// keeps its own vector-store copy of every message.

import type { ChatMessage } from "./protocol";
import type { Msg } from "../chat-history";

/** Recent messages kept verbatim (not summarized) on compaction. */
export const COMPACT_KEEP_MSGS = 8;
/** Skip compaction until there is at least this much older material —
 *  summarizing 2 messages costs a request for near-nothing. */
export const COMPACT_MIN_SUMMARIZE = 4;
/** The summarize request must never stall a chat turn for long. */
export const COMPACT_TIMEOUT_MS = 30_000;

export const SUMMARIZE_SYSTEM =
  "You compress chat transcripts. Summarize the conversation below in under 200 words, written in third person. Preserve: key facts about the user, decisions made, ongoing tasks (alarms, reminders, plans), names, and open questions. Plain text only — no preamble, no commentary.";

/** The compact marker entry stored in history (role "system", kind
 *  "compact"): the transcript renders it as a collapsed divider and
 *  buildWire turns it into the summary user message. */
export function compactMarker(text: string): Msg {
  return { role: "system", kind: "compact", text };
}

/** Index of the last compact marker in history (-1 when none). */
export function lastCompactIndex(history: Msg[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === "system" && m.kind === "compact") return i;
  }
  return -1;
}

export type CompactSplit = { older: Msg[]; recent: Msg[] };

/** Split history at the last compact marker: `older` is everything the new
 *  summary must cover (including any previous summary, so a re-compaction
 *  carries it forward) except the recent keep-window; `recent` stays
 *  verbatim. Returns null when there is not enough older material to be
 *  worth a summary request. */
export function splitForCompact(history: Msg[]): CompactSplit | null {
  const marker = lastCompactIndex(history);
  const base = marker >= 0 ? history.slice(marker) : history;
  if (base.length <= COMPACT_KEEP_MSGS) return null;
  const older = base.slice(0, base.length - COMPACT_KEEP_MSGS);
  if (older.length < COMPACT_MIN_SUMMARIZE) return null;
  return { older, recent: base.slice(base.length - COMPACT_KEEP_MSGS) };
}

/** The summarize request wire: instructions, then the older material. A
 *  previous compact marker becomes a user message (Anthropic rejects
 *  system roles inside messages; only the first one is lifted). */
export function summarizeMessages(older: Msg[]): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: "system", content: SUMMARIZE_SYSTEM }];
  for (const m of older) {
    if (m.role === "system" && m.kind === "compact") {
      msgs.push({
        role: "user",
        content: `[Summary of an even earlier part of the conversation]\n${m.text}`,
      });
    } else {
      msgs.push({ role: m.role, content: m.text } as ChatMessage);
    }
  }
  // Merge consecutive same-role messages — some APIs (Anthropic) are
  // strict about alternation.
  const out: ChatMessage[] = [];
  for (const m of msgs) {
    const last = out[out.length - 1];
    if (
      last &&
      last.role === m.role &&
      typeof last.content === "string" &&
      typeof m.content === "string"
    ) {
      last.content = `${last.content}\n\n${m.content}`;
    } else {
      out.push(m);
    }
  }
  return out;
}

/** Apply a fresh summary: previous markers are replaced by the new one,
 *  placed right before the recent window; everything older stays in
 *  history for display. Returns the new history. */
export function applyCompact(
  history: Msg[],
  split: CompactSplit,
  summary: string,
): Msg[] {
  const recentStart = history.length - split.recent.length;
  const kept = history
    .slice(0, recentStart)
    .filter((m) => !(m.role === "system" && m.kind === "compact"));
  return [...kept, compactMarker(summary), ...split.recent];
}
