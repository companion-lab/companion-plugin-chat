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
import { attachmentKind, attachmentNote, truncatedAttachmentText } from "./attachments";
import type { ChatAttachment } from "./protocol";

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

export type MediaVideo = {
  mime: string;
  data_base64: string;
  duration_ms?: number;
};

export type ToolMedia = {
  text: string;
  image?: MediaImage;
  audio?: MediaAudio;
  video?: MediaVideo;
};

const AUDIO_UNSUPPORTED_NOTE =
  "[an audio clip was captured but this provider cannot consume audio]";

/** Ordinary tool output rides the text path; cap it so a malformed envelope
 *  (or a huge non-media result) can't flood the prompt with raw base64. */
export function truncateToolOutput(output: string, max = 2000): string {
  return output.length <= max
    ? output
    : `${output.slice(0, max)}…[truncated ${output.length - max} chars]`;
}

/** Recognize the companion_media envelope; null for ordinary tool output.
 *  Tolerant on purpose: a missing `text` defaults to "" (a plugin must not
 *  lose its capture over a caption), a double-stringified envelope is
 *  unwrapped once, and unknown media kinds (video) are read forward. */
export function parseToolMedia(output: string): ToolMedia | null {
  if (!output) return null;
  // Bare envelopes start with "{"; double-stringified ones with a quote.
  if (!output.startsWith("{") && !output.startsWith('"')) return null;
  try {
    let v: unknown = JSON.parse(output);
    if (typeof v === "string") {
      if (!v.startsWith("{")) return null;
      v = JSON.parse(v);
    }
    const m = (v as { companion_media?: Record<string, unknown> })?.companion_media;
    if (!m || typeof m !== "object") return null;
    const out: ToolMedia = { text: typeof m.text === "string" ? m.text : "" };
    const img = m.image as MediaImage | undefined;
    if (img && typeof img.data_base64 === "string" && img.data_base64) {
      out.image = { ...img, mime: img.mime || "image/jpeg" };
    }
    const aud = m.audio as MediaAudio | undefined;
    if (aud && typeof aud.data_base64 === "string" && aud.data_base64) {
      out.audio = { ...aud, format: aud.format || "wav" };
    }
    const vid = m.video as MediaVideo | undefined;
    if (vid && typeof vid.data_base64 === "string" && vid.data_base64) {
      out.video = { ...vid, mime: vid.mime || "video/mp4" };
    }
    // Text-only envelopes don't need the parts path.
    if (!out.image && !out.audio && !out.video) return null;
    return out;
  } catch {
    return null;
  }
}

// --- Tool-media → provider-native parts ---
//
// Shared builders so tool results and the OpenAI split below (and the video
// branch of user attachments) emit the same shapes.

/** OpenAI: image → image_url, audio → input_audio, video → note. */
export function openAIMediaParts(media: ToolMedia): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
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
  if (media.video) {
    parts.push({
      type: "text",
      text: "[a video clip was captured but this provider cannot consume video]",
    });
  }
  return parts;
}

/** Anthropic: image → base64 source block; audio and video → notes. */
export function anthropicMediaBlocks(media: ToolMedia): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  if (media.image) {
    blocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: media.image.mime,
        data: media.image.data_base64,
      },
    });
  }
  if (media.audio) {
    blocks.push({ type: "text", text: AUDIO_UNSUPPORTED_NOTE });
  }
  if (media.video) {
    blocks.push({
      type: "text",
      text: "[a video clip was captured but this provider cannot consume video]",
    });
  }
  return blocks;
}

/** Gemini: image and audio ride inline_data (Gemini hears wav/mp3 fine);
 *  video → note. */
export function geminiMediaParts(media: ToolMedia): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  if (media.image) {
    parts.push({ inline_data: { mime_type: media.image.mime, data: media.image.data_base64 } });
  }
  if (media.audio) {
    parts.push({ inline_data: { mime_type: `audio/${media.audio.format}`, data: media.audio.data_base64 } });
  }
  if (media.video) {
    parts.push({
      text: "[a video clip was captured but this provider cannot consume video]",
    });
  }
  return parts;
}

/** OpenAI tool results split in two: official OpenAI (and many compatible
 *  servers) reject media parts inside `role:"tool"` messages, so the tool
 *  message stays a plain string and any media rides in the provider's
 *  immediately-following user message (see providers/openai.ts). */
export function openAIToolResultSplit(
  qualified: string,
  output: string,
  goal: string,
): { toolContent: string; media: ToolMedia | null } {
  const media = parseToolMedia(output);
  return {
    toolContent: toolResultMessage(
      qualified,
      media ? media.text : truncateToolOutput(output),
      goal,
    ),
    media,
  };
}

/** OpenAI wire: tool-result content for USER-role pushes (keyword fallback
 *  path, where media is allowed). */
export function openAIToolResultContent(
  qualified: string,
  output: string,
  goal: string,
): string | Array<Record<string, unknown>> {
  const media = parseToolMedia(output);
  const text = toolResultMessage(qualified, media ? media.text : truncateToolOutput(output), goal);
  if (!media) return text;
  return [{ type: "text", text }, ...openAIMediaParts(media)];
}

/** Anthropic wire: user-message content blocks for tool results. */
export function anthropicToolResultBlocks(
  qualified: string,
  output: string,
  goal: string,
): Array<Record<string, unknown>> {
  const media = parseToolMedia(output);
  const text = toolResultMessage(qualified, media ? media.text : truncateToolOutput(output), goal);
  return [{ type: "text", text }, ...(media ? anthropicMediaBlocks(media) : [])];
}

/** Gemini wire: user-message parts for tool results. */
export function geminiToolResultParts(
  qualified: string,
  output: string,
  goal: string,
): Array<Record<string, unknown>> {
  const media = parseToolMedia(output);
  const text = toolResultMessage(qualified, media ? media.text : truncateToolOutput(output), goal);
  return [{ text }, ...(media ? geminiMediaParts(media) : [])];
}

// --- User attachments: protocol → provider-native parts ---
//
// User turns carry `attachments` (ChatAttachment) as a separate protocol
// field; each provider appends these parts after the text part at convo
// build time. Anything a provider can't ingest becomes a text note so the
// message still reaches it (and convoHasMedia/stripConvoMedia only ever see
// real media parts, so the 4xx retry keeps working).

/** Image mimes all three providers accept natively. SVG is vector markup —
 *  no provider's image ingest takes it — and renders as a text note. */
const NATIVE_IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

function attachmentText(a: ChatAttachment): string {
  return `[attached file: ${a.name}]\n${truncatedAttachmentText(a.base64)}`;
}

function attachmentTextPart(a: ChatAttachment): Record<string, unknown> {
  return { type: "text", text: attachmentText(a) };
}

function unsupportedAttachmentPart(a: ChatAttachment, why: string): Record<string, unknown> {
  return { type: "text", text: `${attachmentNote(a.name, a.mime)} — ${why}` };
}

/** `[clip.mp4 — frames at 0.0s, 2.5s, 5.0s, 7.5s]` */
function videoFramesText(a: ChatAttachment): string {
  const stamps = (a.frames ?? []).map((f) => `${(f.atMs / 1000).toFixed(1)}s`).join(", ");
  return `${attachmentNote(a.name, a.mime)} — keyframes at ${stamps || "(none)"}`;
}

/** OpenAI: images as image_url data URLs, wav/mp3 audio, PDFs via
 *  input_file, text-like files inlined as text. Video rides as extracted
 *  keyframes (video/image parts); without frames it notes out. */
export function openAIAttachmentParts(atts: ChatAttachment[]): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  for (const a of atts) {
    switch (attachmentKind(a.mime)) {
      case "image":
        if (NATIVE_IMAGE_MIMES.has(a.mime)) {
          parts.push({
            type: "image_url",
            image_url: { url: `data:${a.mime};base64,${a.base64}` },
          });
        } else {
          parts.push(unsupportedAttachmentPart(a, "this provider cannot read this image format"));
        }
        break;
      case "audio": {
        const format = a.mime === "audio/wav" || a.mime === "audio/x-wav" ? "wav" : a.mime === "audio/mpeg" || a.mime === "audio/mp3" ? "mp3" : "";
        if (format) {
          parts.push({ type: "input_audio", input_audio: { data: a.base64, format } });
        } else {
          parts.push(unsupportedAttachmentPart(a, "this provider only consumes wav/mp3 audio"));
        }
        break;
      }
      case "pdf":
        parts.push({
          type: "input_file",
          input_file: {
            filename: a.name,
            file_data: `data:application/pdf;base64,${a.base64}`,
          },
        });
        break;
      case "video":
        if (a.frames?.length) {
          parts.push({ type: "text", text: videoFramesText(a) });
          for (const f of a.frames) {
            parts.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${f.dataBase64}` } });
          }
        } else {
          parts.push(unsupportedAttachmentPart(a, "no keyframes could be extracted from it"));
        }
        break;
      case "text":
        parts.push(attachmentTextPart(a));
        break;
      case "binary":
        parts.push(unsupportedAttachmentPart(a, "this provider cannot read this file type"));
        break;
    }
  }
  return parts;
}

/** Anthropic: images as base64 source blocks, PDFs as document blocks;
 *  audio is not supported and everything else inlines as text or a note. */
export function anthropicAttachmentBlocks(atts: ChatAttachment[]): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  for (const a of atts) {
    switch (attachmentKind(a.mime)) {
      case "image":
        if (NATIVE_IMAGE_MIMES.has(a.mime)) {
          blocks.push({
            type: "image",
            source: { type: "base64", media_type: a.mime, data: a.base64 },
          });
        } else {
          blocks.push(unsupportedAttachmentPart(a, "this provider cannot read this image format"));
        }
        break;
      case "pdf":
        blocks.push({
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: a.base64 },
        });
        break;
      case "video":
        if (a.frames?.length) {
          blocks.push({ type: "text", text: videoFramesText(a) });
          for (const f of a.frames) {
            blocks.push({
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: f.dataBase64 },
            });
          }
        } else {
          blocks.push(unsupportedAttachmentPart(a, "no keyframes could be extracted from it"));
        }
        break;
      case "audio":
        blocks.push(unsupportedAttachmentPart(a, "this provider cannot consume audio"));
        break;
      case "text":
        blocks.push(attachmentTextPart(a));
        break;
      case "binary":
        blocks.push(unsupportedAttachmentPart(a, "this provider cannot read this file type"));
        break;
    }
  }
  return blocks;
}

/** Gemini: images, audio, and PDFs ride inline_data; text-like files
 *  inline as text; the rest note out. */
export function geminiAttachmentParts(atts: ChatAttachment[]): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  for (const a of atts) {
    switch (attachmentKind(a.mime)) {
      case "image":
        if (NATIVE_IMAGE_MIMES.has(a.mime)) {
          parts.push({ inline_data: { mime_type: a.mime, data: a.base64 } });
        } else {
          parts.push(unsupportedAttachmentPart(a, "this provider cannot read this image format"));
        }
        break;
      case "audio":
        parts.push({ inline_data: { mime_type: a.mime, data: a.base64 } });
        break;
      case "pdf":
        parts.push({ inline_data: { mime_type: a.mime, data: a.base64 } });
        break;
      case "video":
        // Gemini ingests video inline (with its audio track) when the raw
        // bytes are kept; keyframes are the fallback when they aren't.
        if (a.base64) {
          parts.push({ inline_data: { mime_type: a.mime, data: a.base64 } });
        } else if (a.frames?.length) {
          parts.push({ text: videoFramesText(a) });
          for (const f of a.frames) {
            parts.push({ inline_data: { mime_type: "image/jpeg", data: f.dataBase64 } });
          }
        } else {
          parts.push({ text: `${attachmentNote(a.name, a.mime)} — no keyframes could be extracted from it` });
        }
        break;
      case "text":
        parts.push({ text: attachmentText(a) });
        break;
      case "binary":
        parts.push({ text: `${attachmentNote(a.name, a.mime)} — this provider cannot read this file type` });
        break;
    }
  }
  return parts;
}

// --- 4xx degradation: strip media parts from a whole conversation ---

const MEDIA_PART_TYPES = new Set([
  "image_url",
  "input_audio",
  "image",
  "inline_data",
  "input_file",
  "document",
]);

function isMediaPart(part: unknown): boolean {
  if (!part || typeof part !== "object") return false;
  const p = part as Record<string, unknown>;
  if (MEDIA_PART_TYPES.has(String(p.type ?? ""))) return true;
  // Gemini wire parts key the media directly and carry no `type` field.
  return p.inline_data !== undefined;
}

/** Every media part of one message, at any nesting the wires use:
 *  OpenAI/Anthropic keep arrays under `content`, Gemini under `parts`, and
 *  Anthropic nests further inside `tool_result.content` blocks. */
function* mediaPartLocs(
  m: Record<string, unknown>,
): Generator<{ parts: Array<Record<string, unknown>>; index: number; nested: boolean }> {
  const top = Array.isArray(m.content) ? m.content : Array.isArray(m.parts) ? m.parts : null;
  if (!top) return;
  for (let i = 0; i < top.length; i++) {
    const part = top[i] as Record<string, unknown> | null;
    if (isMediaPart(part)) {
      yield { parts: top as Array<Record<string, unknown>>, index: i, nested: false };
    } else if (part && part.type === "tool_result" && Array.isArray(part.content)) {
      const nested = part.content as Array<Record<string, unknown>>;
      for (let j = 0; j < nested.length; j++) {
        if (isMediaPart(nested[j])) {
          yield { parts: nested, index: j, nested: true };
        }
      }
    }
  }
}

/** True when any message carries media content parts (including nested
 *  Anthropic tool_result blocks). */
export function convoHasMedia(
  convo: Array<Record<string, unknown>>,
): boolean {
  return convo.some((m) => {
    for (const _ of mediaPartLocs(m)) return true;
    return false;
  });
}

/** Condense a provider's rejection body into one short line for the
 *  strip note. Prefers the JSON `error.message` most servers send; falls
 *  back to a flattened excerpt of the raw body. Empty for unreadable
 *  bodies, so the note keeps its original shape. */
export function serverRejectionReason(body: string): string {
  if (!body) return "";
  try {
    const v = JSON.parse(body) as { error?: { message?: string } | string };
    const msg =
      typeof v.error === "string"
        ? v.error
        : typeof v.error?.message === "string"
          ? v.error.message
          : "";
    if (msg) return msg.slice(0, 160);
  } catch {
    // Not JSON — use the raw body below.
  }
  const flat = body.replace(/\s+/g, " ").trim();
  return flat ? flat.slice(0, 160) : "";
}

/**
 * Replace media parts with a text note so a server that rejected the request
 * can still answer. Mutates the conversation in place; nested Anthropic
 * tool_result media is removed from its block and the aggregate note rides
 * at the top level of the same message. `reason` (the server's own error
 * line) is appended when known, so the model can tell the user WHY the
 * capture was not viewable instead of a bare "rejected" — e.g. Ollama's
 * context-size error, which reads like the vision plugin is broken when
 * really the model's context window is too small.
 */
export function stripConvoMedia(
  convo: Array<Record<string, unknown>>,
  reason?: string,
): void {
  for (const m of convo) {
    const locs = [...mediaPartLocs(m)];
    if (!locs.length) continue;
    const count = locs.length;
    // Splice from the highest index first so positions stay valid.
    for (const loc of locs.sort((a, b) => b.index - a.index)) {
      loc.parts.splice(loc.index, 1);
    }
    const note = `[${count} media part(s) omitted — this server rejected them${reason ? `: ${reason}` : ""}. The capture/file could not be viewed with the current provider; tell the user.]`;
    const outer = Array.isArray(m.content) ? m.content : Array.isArray(m.parts) ? m.parts : null;
    if (!outer) continue;
    // The note rides in each wire's own part shape: typed parts for
    // OpenAI/Anthropic, bare {text} for Gemini.
    outer.push(
      Array.isArray(m.parts) && !Array.isArray(m.content)
        ? { text: note }
        : { type: "text", text: note },
    );
  }
}
