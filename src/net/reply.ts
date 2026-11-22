// Generic structured-reply plumbing for the chat loop.
//
// The reply SHAPE is owned by whichever plugin contributes a ReplyContribution
// via ctx.reply.register (the avatar engine plugin registers the
// emotion/motion contract); this module only knows the generic mechanics:
//
// - the system prompt carries the contribution's `prompt` fragment,
// - providers offer the contribution's `schema` as the reply carrier (forced
//   function tool / structured output) named `toolName` (default
//   "avatar_response"),
// - every parsed reply becomes { text, data }: `text` feeds display/TTS/
//   history, `data` is forwarded to the contribution's `apply` (ChatPanel).
//
// With no contribution (no avatar engine installed) every provider path
// degrades to plain prose chat: no directives, no forced tool, no tags.
//
// Ported from the host's app/src/net/avatar.ts after that file's avatar
// knowledge moved into the vrm plugin (the prompt/schema live there now).

import type { ReplyContribution } from "@companion-lab/plugin";
import type { ChatMessage } from "./protocol";
import type { ProviderConfig } from "./types";
import {
  StructuredStream,
  stripStructuredTags,
  parseStructured,
} from "./structured";
import { extractPartialText } from "./sse";

// Voice-tag instructions are deliberately NOT baked in here: each voice
// plugin contributes its own gated "voice-tags" fragment via
// ctx.systemPrompt.register (stock tts plugin for Supertonic, sakura plugin
// for GPT-SoVITS), so the tags always match the engine that actually owns
// the voice slot. The reply owner contributes its field instructions the
// same way it contributes the schema (see ReplyContribution.prompt).

/** Host-bridge reader for the active reply contribution (mirrors tools.ts). */
export function getReplyContribution(): ReplyContribution | null {
  const get = (globalThis as any).__companion_host__?.reply?.get;
  return typeof get === "function" ? get() : null;
}

/** Carrier tool name for the final-turn structured reply. */
export function replyToolName(c: ReplyContribution | null): string {
  return c?.toolName ?? "avatar_response";
}

/** Inline-tag kinds: every reply-schema property except `text`. */
export function tagKinds(c: ReplyContribution | null): string[] {
  const props = c?.schema?.properties;
  return props && typeof props === "object"
    ? Object.keys(props as Record<string, unknown>).filter((k) => k !== "text")
    : [];
}

// Final-turn function tool that carries the structured reply for
// OpenAI-compatible servers, which have no structured-output mode to lean on.
export function openAiReplyTool(c: ReplyContribution): unknown {
  return {
    type: "function",
    function: {
      name: replyToolName(c),
      description:
        "Emit the structured reply. Always call this exactly once to speak to the user.",
      parameters: c.schema,
    },
  };
}

// Gemini's responseSchema wants UPPERCASE type names; convert mechanically
// (the reply owner authors plain JSON Schema).
export function toGeminiSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const conv = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(conv);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === "type" && typeof v === "string") out.type = v.toUpperCase();
        else if (k === "properties" && v && typeof v === "object") {
          const props: Record<string, unknown> = {};
          for (const [pk, pv] of Object.entries(v as Record<string, unknown>))
            props[pk] = conv(pv);
          out.properties = props;
        } else if (k === "items") out.items = conv(v);
        else if (k === "additionalProperties") continue; // no Gemini equivalent
        else out[k] = v;
      }
      return out;
    }
    return node;
  };
  return conv(schema) as Record<string, unknown>;
}

export function msgText(m: ChatMessage): string {
  if (typeof m.content === "string") return m.content;
  if (m.content == null) return "";
  return JSON.stringify(m.content);
}

export function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

const GENERIC_BASE =
  "You are a helpful assistant. Respond to the user with helpful text.";

export function buildSystemPrompt(
  persona?: ProviderConfig["persona"],
  memoryContext?: string,
): string {
  const parts: string[] = [GENERIC_BASE];
  // The reply owner's field instructions (avatar engine: emotion/motion
  // directives). Absent without a reply contribution — plain chat then.
  const reply = getReplyContribution();
  if (reply?.prompt?.trim()) parts.push(reply.prompt.trim());
  // Plugin-contributed instruction fragments (ctx.systemPrompt.register).
  // Read from the host bridge so this bundle never imports host modules.
  const pluginPrompts =
    (globalThis as any).__companion_host__?.systemPrompts?.get?.() ?? [];
  if (Array.isArray(pluginPrompts) && pluginPrompts.length) {
    parts.push(pluginPrompts.filter(Boolean).join("\n\n"));
  }
  // Memory plugin recall block for this turn (see ./memory.ts). It rides in
  // the single system message because Anthropic/Gemini drop non-leading
  // system messages from the wire.
  if (memoryContext && memoryContext.trim()) {
    parts.push(memoryContext.trim());
  }
  if (!persona) return parts.join("\n\n");
  if (persona.companionName.trim())
    parts.push(`Your name is ${persona.companionName.trim()}.`);
  if (persona.userName.trim())
    parts.push(
      `The user's name is ${persona.userName.trim()}. Address them by name when natural.`,
    );
  if (persona.promptAppend.trim()) parts.push(persona.promptAppend.trim());
  return parts.join("\n\n");
}

export function buildMessages(
  messages: ChatMessage[],
  persona?: ProviderConfig["persona"],
  memoryContext?: string,
): ChatMessage[] {
  const sys = buildSystemPrompt(persona, memoryContext);
  const hasSystem = messages[0]?.role === "system";
  if (hasSystem) {
    return [{ role: "system", content: sys }, ...messages.slice(1)];
  }
  return [{ role: "system", content: sys }, ...messages];
}

// Matches a "text" string field in half-streamed JSON (escapes included).
const TEXT_FIELD_RE = /"text"\s*:\s*"((?:\\.|[^"\\])*)"/;

// Parses the structured-reply JSON shape (and half-streamed variants). Never
// throws; falls back to the raw string as text when nothing else matches.
// Deliberately NOT named parseStructured: the tag-aware parser imported from
// ./structured is the one every text path must go through.
function tryParseReply(
  raw: string,
): { text: string; data: Record<string, unknown> } {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const m = TEXT_FIELD_RE.exec(raw);
    if (m) {
      let text = m[1];
      try {
        text = JSON.parse('"' + m[1] + '"');
      } catch {
        /* keep the raw capture */
      }
      return { text, data: {} };
    }
    return { text: raw, data: {} };
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const { text, ...data } = parsed as Record<string, unknown>;
    return { text: typeof text === "string" ? text : "", data };
  }
  return { text: raw, data: {} };
}

// Reconciles the three shapes a final turn can take: the structured-reply
// JSON, an inline-tag prose reply, or prose whose tags already fired
// mid-stream. Fired tags are authoritative when present — a model that
// emitted <<motion:VRMA_02>> meant it, so a JSON value must not win.
export function finalReplyResult(
  content: string,
  kinds: string[],
  tags?: StructuredStream,
): { text: string; data: Record<string, unknown> } {
  const tagged = parseStructured(content, kinds);
  const json = tryParseReply(content);
  const partialText = extractPartialText(content);
  const isJson = partialText !== "" || content.trimStart().startsWith("{");
  const stream = tags?.getFinal() ?? {};
  const primary = isJson ? json : tagged;

  // Partial JSON has no closing brace, so tryParseReply falls back to the raw
  // string; the streaming extractor is what recovers the text field from it.
  const text =
    isJson && json.text === content && partialText !== ""
      ? partialText
      : primary.text;

  return { text, data: { ...primary.data, ...stream } };
}

export function emitDiff(
  next: string,
  st: { emitted: string },
  onToken?: (t: string) => void,
) {
  if (next.length > st.emitted.length && next.startsWith(st.emitted)) {
    onToken?.(next.slice(st.emitted.length));
    st.emitted = next;
  }
}

// Final-turn emitter: extractPartialText returns "" when the model
// answers in plain text instead of reply JSON. Fall back to the parsed
// text (or raw content) so StreamTts still receives tokens and speaks.
export function emitFinalText(
  rawContent: string,
  st: { emitted: string },
  onToken?: (t: string) => void,
  kinds: string[] = [],
): void {
  let text = extractPartialText(rawContent);
  if (!text) {
    try {
      text = parseStructured(rawContent, kinds).text;
    } catch {
      text = "";
    }
  }
  if (!text && rawContent.trim()) {
    // Tags already resolved above; never speak them, and never speak raw JSON.
    const stripped = stripStructuredTags(rawContent, kinds).trim();
    text = stripped.startsWith("{") || stripped.startsWith("[") ? "" : stripped;
  }
  if (text) emitDiff(text, st, onToken);
}
