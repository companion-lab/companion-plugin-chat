// Media-carrying tool results: plugins (e.g. vision) may answer a tool call
// with a `companion_media` envelope instead of plain text:
//
//   {"companion_media": {"text": "...",
//                        "image": {"mime": "image/jpeg", "data_base64": "..."},
//                        "audio": {"format": "wav", "data_base64": "..."}}}
//
// This module turns that envelope into each provider's native content parts
// so omni models (OpenAI-compatible ones such as Ollama's lfm3-omni) can
// actually see and hear captures. Anything that isn't the envelope flows
// through the existing text-only path unchanged.

import { toolResultMessage } from "./loop";

export type MediaImage = {
  mime: string;
  data_base64: string;
  width?: number;
  height?: number;
};

export type MediaAudio = {
  format: string;
  data_base64: string;
  sample_rate?: number;
  duration_ms?: number;
};

export type ToolMedia = {
  text: string;
  image?: MediaImage;
  audio?: MediaAudio;
};

const AUDIO_UNSUPPORTED_NOTE =
  "[an audio clip was captured but this provider cannot consume audio]";

/** Recognize the companion_media envelope; null for ordinary tool output. */
export function parseToolMedia(output: string): ToolMedia | null {
  if (!output || !output.startsWith("{")) return null;
  try {
    const v = JSON.parse(output) as {
      companion_media?: { text?: unknown; image?: unknown; audio?: unknown };
    };
    const m = v?.companion_media;
    if (!m || typeof m !== "object" || typeof m.text !== "string") return null;
    const out: ToolMedia = { text: m.text };
    const img = m.image as MediaImage | undefined;
    if (img && typeof img.data_base64 === "string" && img.data_base64) {
      out.image = { ...img, mime: img.mime || "image/jpeg" };
    }
    const aud = m.audio as MediaAudio | undefined;
    if (aud && typeof aud.data_base64 === "string" && aud.data_base64) {
      out.audio = { ...aud, format: aud.format || "wav" };
    }
    // Text-only envelopes don't need the parts path.
    if (!out.image && !out.audio) return null;
    return out;
  } catch {
    return null;
  }
}

/** OpenAI wire: tool-role message content, string or content parts. */
export function openAIToolResultContent(
  qualified: string,
  output: string,
  goal: string,
): string | Array<Record<string, unknown>> {
  const media = parseToolMedia(output);
  const text = toolResultMessage(qualified, media ? media.text : output, goal);
  if (!media) return text;
  const parts: Array<Record<string, unknown>> = [{ type: "text", text }];
  if (media.image) {
    parts.push({
      type: "image_url",
      image_url: {
        url: `data:${media.image.mime};base64,${media.image.data_base64}`,
      },
    });
  }
  if (media.audio) {
    parts.push({
      type: "input_audio",
      input_audio: { data: media.audio.data_base64, format: media.audio.format },
    });
  }
  return parts;
}

/** Anthropic wire: user-message content blocks for tool results. */
export function anthropicToolResultBlocks(
  qualified: string,
  output: string,
  goal: string,
): Array<Record<string, unknown>> {
  const media = parseToolMedia(output);
  const text = toolResultMessage(qualified, media ? media.text : output, goal);
  const blocks: Array<Record<string, unknown>> = [{ type: "text", text }];
  if (media?.image) {
    blocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: media.image.mime,
        data: media.image.data_base64,
      },
    });
  }
  if (media?.audio) {
    blocks.push({ type: "text", text: AUDIO_UNSUPPORTED_NOTE });
  }
  return blocks;
}

/** Gemini wire: user-message parts for tool results. */
export function geminiToolResultParts(
  qualified: string,
  output: string,
  goal: string,
): Array<Record<string, unknown>> {
  const media = parseToolMedia(output);
  const text = toolResultMessage(qualified, media ? media.text : output, goal);
  const parts: Array<Record<string, unknown>> = [{ text }];
  if (media?.image) {
    parts.push({ inline_data: { mime_type: media.image.mime, data: media.image.data_base64 } });
  }
  if (media?.audio) {
    parts.push({ text: AUDIO_UNSUPPORTED_NOTE });
  }
  return parts;
}

// --- 4xx degradation: strip media parts from a whole conversation ---

const MEDIA_PART_TYPES = new Set(["image_url", "input_audio", "image", "inline_data"]);

function isMediaPart(part: unknown): boolean {
  return (
    !!part &&
    typeof part === "object" &&
    MEDIA_PART_TYPES.has(String((part as Record<string, unknown>).type ?? ""))
  );
}

/** True when any message carries media content parts. */
export function convoHasMedia(convo: Array<Record<string, unknown>>): boolean {
  return convo.some((m) => Array.isArray(m.content) && m.content.some(isMediaPart));
}

/**
 * Replace media parts with a text note so a server that rejected the request
 * can still answer. Mutates the conversation in place.
 */
export function stripConvoMedia(
  convo: Array<Record<string, unknown>>,
): void {
  for (const m of convo) {
    if (!Array.isArray(m.content)) continue;
    const parts = m.content as Array<Record<string, unknown>>;
    const kept: Array<Record<string, unknown>> = [];
    let stripped = 0;
    for (const part of parts) {
      if (isMediaPart(part)) {
        stripped++;
        continue;
      }
      kept.push(part);
    }
    if (stripped) {
      kept.push({ type: "text", text: `[${stripped} media part(s) omitted — this server rejected them]` });
      m.content = kept;
    }
  }
}
