// Port of the host's app/src/net/avatar.ts: the system prompt, the
// per-provider response schemas, and the parsers that accept either the
// avatar_response JSON shape or an inline-tag prose reply.
//
// The only change from the host: the motion/expression manifests come from
// the avatar capabilities snapshot (./capabilities.ts — refreshed from
// ctx.avatar.describeCapabilities()) instead of the host registries. Custom
// motion descriptions are not part of the capabilities surface, so the
// prompt text for non-built-in motions uses the host's humanized fallback
// (see motionDescription).

import type { ChatMessage } from "./protocol";
import type { Emotion, ProviderConfig, ProviderResult } from "./types";
import {
  BUILTIN_MOTION_NAMES,
  getAvatarCapabilities,
  motionDescription,
  resolveEmotionName,
  resolveMotionName,
} from "./capabilities";
import {
  StructuredStream,
  stripStructuredTags,
  parseStructured,
  type Motion,
} from "./structured";
import { extractPartialText } from "./sse";

// Final-turn function that carries text/emotion/motion for OpenAI-compatible
// servers, which have no structured-output mode to lean on.
export function openAiAvatarTool(): unknown {
  return {
    type: "function",
    function: {
      name: "avatar_response",
      description:
        "Emit the avatar's structured reply. Always call this exactly once to speak to the user.",
      parameters: buildStructuredSchema(),
    },
  };
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

function listMotionNames(): string[] {
  return getAvatarCapabilities().motions;
}

function listEmotionNames(): string[] {
  return getAvatarCapabilities().emotions;
}

function buildMotionDescription(): string {
  const all = listMotionNames();
  const customs = all.filter(
    (m) => m !== "none" && !BUILTIN_MOTION_NAMES.has(m),
  );
  const builtinEntries = all.filter(
    (m) => m !== "none" && BUILTIN_MOTION_NAMES.has(m),
  );
  const fmt = (m: string) => `${m} (${motionDescription(m)})`;
  const parts: string[] = [];
  if (customs.length) parts.push(`Custom: ${customs.map(fmt).join(", ")}`);
  if (builtinEntries.length)
    parts.push(`Built-in: ${builtinEntries.map(fmt).join(", ")}`);
  parts.push(`none (${motionDescription("none")})`);
  return `The physical motion to accompany the response. Available motions: ${parts.join(". ")}. Rules: default to "none" unless the user explicitly asks for a motion or the reply clearly matches a description. Prefer a matching custom motion over built-ins. Return the exact name.`;
}

// Single source of truth for what the avatar can do, injected as plain text so
// it reaches every provider — including the ones with no JSON schema (OpenAI).
export function buildAvatarDirectives(): string {
  const lines: string[] = [buildMotionDescription()];
  const emotions = listEmotionNames();
  lines.push(`Available expressions: ${emotions.join(", ")}.`);
  lines.push(
    'When the user explicitly requests a motion or an expression by name, you MUST honour it: pick that exact name in the motion or emotion field even if your reply text does not imply it. If a custom motion or expression name closely matches what they asked for, prefer the custom one over the built-ins. Never invent a name that is not in the lists above — if nothing matches, use "none" for motion and "neutral" for emotion, and describe in text what you cannot do instead of pretending.',
  );
  lines.push(
    "If you are answering as plain text instead of calling the avatar_response function, mark them inline instead: write <<motion:name>> and <<emotion:name>> somewhere in the reply. Those tags are stripped before the text is spoken, so never mention them to the user.",
  );
  return lines.join("\n");
}

export function buildStructuredSchema() {
  return {
    type: "object",
    properties: {
      text: { type: "string" },
      emotion: {
        type: "string",
        description: "The emotional expression to accompany the response",
        enum: listEmotionNames(),
      },
      motion: {
        type: "string",
        description: buildMotionDescription(),
        enum: listMotionNames(),
      },
    },
    required: ["text", "emotion", "motion"],
    additionalProperties: false,
  };
}

export function buildGeminiSchema() {
  return {
    type: "OBJECT",
    properties: {
      text: {
        type: "STRING",
        description: "The spoken response text to the user",
      },
      emotion: {
        type: "STRING",
        description: "The emotional expression to accompany the response",
        enum: listEmotionNames(),
      },
      motion: {
        type: "STRING",
        description: buildMotionDescription(),
        enum: listMotionNames(),
      },
    },
    required: ["text", "emotion", "motion"],
  };
}

export const SYSTEM_PROMPT =
  "You are a helpful support avatar. Respond to the user with helpful text, and select the most appropriate emotion and physical motion to accompany your response. " +
  'Motion selection: default motion to "none" (stay still). Only pick a motion when the user explicitly asks (e.g. dance, nod) or the reply clearly matches a motion description. ' +
  "Use TTS expression tags in the text to make speech more expressive only this tags. " +
  "Tags: <laugh>,<breath>,<surprise>,<sigh>,<scream>,<throatclear>,<sad>,<angry>,<cough>,<yawn>. " +
  "Place double or triple tags at the start or end of sentences for emphasis. " +
  "Example: <laugh><laugh> Hello! How can I help you today? <breath><breath>";

function buildSystemPrompt(
  persona?: ProviderConfig["persona"],
  memoryContext?: string,
): string {
  const parts: string[] = [SYSTEM_PROMPT, buildAvatarDirectives()];
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

// Parses the avatar_response JSON shape (and half-streamed variants).
// Deliberately NOT named parseStructured: the tag-aware parser imported from
// ./structured is the one every text path must go through.
function parseAvatarJson(raw: string): ProviderResult {
  let parsed: any = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const m = /"motion"\s*:\s*"([^"]+)"/.exec(raw);
    const t = /"text"\s*:\s*"([\s\S]*?)"\s*,\s*"(emotion|motion)"/.exec(raw);
    const e = /"emotion"\s*:\s*"([^"]+)"/.exec(raw);
    parsed = { text: t?.[1] ?? raw, emotion: e?.[1], motion: m?.[1] };
  }
  const rawEmotion = String(parsed.emotion ?? "neutral");
  const rawMotion = String(parsed.motion ?? "none");
  const emotionKey = resolveEmotionName(rawEmotion) ?? "neutral";
  const motionKey = resolveMotionName(rawMotion) ?? "none";
  if (rawMotion && motionKey === "none" && rawMotion.toLowerCase() !== "none") {
    console.warn(
      `[llm] unknown motion "${rawMotion}", falling back to none. Known: ${listMotionNames().join(", ")}`,
    );
  }
  return {
    text: String(parsed.text ?? ""),
    emotion: emotionKey as Emotion,
    motion: motionKey as Motion,
    mcpCalls: [],
  };
}

// Reconciles the three shapes a final turn can take: the avatar_response JSON,
// an inline-tag prose reply, or prose whose tag already fired mid-stream.
// The tag is authoritative when present — a model that emitted
// <<motion:VRMA_02>> meant it, so a "none" from the JSON parse must not win.
export function finalAvatarResult(
  content: string,
  tags?: StructuredStream,
): ProviderResult {
  const tagged = parseStructured(content);
  const json = parseAvatarJson(content);
  const partialText = extractPartialText(content);
  const isJson = partialText !== "" || content.trimStart().startsWith("{");
  const stream = tags?.getFinal();
  const primary = isJson ? json : tagged;

  // Partial JSON has no closing brace, so parseAvatarJson falls back to the raw
  // string; the streaming extractor is what recovers the text field from it.
  const text =
    isJson && json.text === content && partialText !== ""
      ? partialText
      : primary.text;

  // Primary parse wins when it resolved something; otherwise fall back to what
  // already fired mid-stream, then to the primary parse's default.
  const motion =
    primary.motion !== "none" ? primary.motion : (stream?.motion ?? "none");
  const emotion = primary.emotion ?? stream?.emotion ?? "neutral";

  return { text, emotion, motion, mcpCalls: [] };
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
// answers in plain text instead of avatar JSON. Fall back to the parsed
// text (or raw content) so StreamTts still receives tokens and speaks.
export function emitFinalText(
  rawContent: string,
  st: { emitted: string },
  onToken?: (t: string) => void,
): void {
  let text = extractPartialText(rawContent);
  if (!text) {
    try {
      text = parseStructured(rawContent).text;
    } catch {
      text = "";
    }
  }
  if (!text && rawContent.trim()) {
    // Tags already resolved above; never speak them, and never speak raw JSON.
    const stripped = stripStructuredTags(rawContent).trim();
    text = stripped.startsWith("{") || stripped.startsWith("[") ? "" : stripped;
  }
  if (text) emitDiff(text, st, onToken);
}
