// Port of the host's app/src/net/protocol.ts (unchanged).

/** A keyframe extracted from a video attachment (attachments.ts). Providers
 *  without video ingest (OpenAI/Anthropic) receive these as image parts. */
export type VideoFrame = {
  dataBase64: string;
  atMs: number;
};

/** A user file attachment, provider-agnostic. Providers (media-parts.ts)
 *  turn these into their native content parts alongside the text part. */
export type ChatAttachment = {
  name: string;
  mime: string;
  base64: string;
  /** Present on video attachments: frames ride as images for providers
   *  that can't ingest video; Gemini prefers the raw `base64` when kept. */
  frames?: VideoFrame[];
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[] | null;
  attachments?: ChatAttachment[];
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
};

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };
