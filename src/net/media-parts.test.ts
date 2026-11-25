import { describe, expect, it } from "vitest";
import {
  anthropicAttachmentBlocks,
  anthropicToolResultBlocks,
  convoHasMedia,
  geminiAttachmentParts,
  geminiToolResultParts,
  openAIAttachmentParts,
  openAIMediaParts,
  openAIToolResultContent,
  openAIToolResultSplit,
  parseToolMedia,
  stripConvoMedia,
  truncateToolOutput,
} from "./media-parts";

const AUDIO_NOTE = "[an audio clip was captured but this provider cannot consume audio]";

const STRIP_NOTE = (n: number) =>
  `[${n} media part(s) omitted — this server rejected them. The capture/file could not be viewed with the current provider; tell the user.]`;

const envelope = (media: Record<string, unknown>): string =>
  JSON.stringify({ companion_media: media });

describe("parseToolMedia", () => {
  it("recognizes the envelope with image and audio", () => {
    expect(
      parseToolMedia(
        envelope({
          text: "saw a cat",
          image: { mime: "image/png", data_base64: "IMG", width: 8, height: 8 },
          audio: { format: "wav", data_base64: "AUD" },
        }),
      ),
    ).toEqual({
      text: "saw a cat",
      image: { mime: "image/png", data_base64: "IMG", width: 8, height: 8 },
      audio: { format: "wav", data_base64: "AUD" },
    });
  });

  it("defaults the image mime to image/jpeg and audio format to wav", () => {
    const m = parseToolMedia(
      envelope({ text: "x", image: { data_base64: "I" }, audio: { data_base64: "A" } }),
    );
    expect(m?.image?.mime).toBe("image/jpeg");
    expect(m?.audio?.format).toBe("wav");
  });

  it("returns null for anything that is not a media envelope", () => {
    expect(parseToolMedia("plain tool output")).toBeNull();
    expect(parseToolMedia("")).toBeNull();
    expect(parseToolMedia("[]")).toBeNull();
    expect(parseToolMedia('{"other": 1}')).toBeNull();
    // A missing caption no longer kills a real capture — text defaults "".
    expect(parseToolMedia(envelope({ image: { data_base64: "I" } }))).toEqual({
      text: "",
      image: { mime: "image/jpeg", data_base64: "I" },
    });
    // Non-media text-only envelopes with no caption → not the parts path.
    expect(parseToolMedia(envelope({ text: 42 }))).toBeNull();
    // Media entries without data are ignored...
    expect(
      parseToolMedia(envelope({ text: "x", image: { mime: "image/png" } })),
    ).toBeNull();
  });

  it("returns null for a text-only envelope (plain path suffices)", () => {
    // Only actual media needs the parts path — text flows through the
    // existing string path unchanged.
    expect(parseToolMedia(envelope({ text: "just words" }))).toBeNull();
  });
});

describe("openAIToolResultContent", () => {
  const TAIL =
    "\nDecide the NEXT tool call now, or reply with the final text only if every requested action is complete.";

  it("returns a plain string for non-media output", () => {
    expect(openAIToolResultContent("mcp__vision__snapshot", "out", "")).toBe(
      "[tool mcp__vision__snapshot result]\nout" + TAIL,
    );
  });

  it("pins the original goal to the plain string too", () => {
    expect(openAIToolResultContent("t", "out", "GOAL")).toBe(
      "Original user goal (still pending until ALL steps done): GOAL\n[tool t result]\nout" + TAIL,
    );
  });

  it("converts the envelope into OpenAI content parts", () => {
    const out = envelope({
      text: "saw a cat",
      image: { mime: "image/png", data_base64: "IMG" },
      audio: { format: "wav", data_base64: "AUD" },
    });
    expect(openAIToolResultContent("vision__capture_screen", out, "")).toEqual([
      {
        type: "text",
        text: "[tool vision__capture_screen result]\nsaw a cat" + TAIL,
      },
      { type: "image_url", image_url: { url: "data:image/png;base64,IMG" } },
      { type: "input_audio", input_audio: { data: "AUD", format: "wav" } },
    ]);
  });
});

describe("anthropicToolResultBlocks", () => {
  it("always emits a text block, then base64 image and an audio note", () => {
    const out = envelope({
      text: "saw a cat",
      image: { mime: "image/png", data_base64: "IMG" },
      audio: { format: "wav", data_base64: "AUD" },
    });
    expect(anthropicToolResultBlocks("vision__capture_screen", out, "")).toEqual([
      {
        type: "text",
        text: "[tool vision__capture_screen result]\nsaw a cat\nDecide the NEXT tool call now, or reply with the final text only if every requested action is complete.",
      },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "IMG" },
      },
      { type: "text", text: AUDIO_NOTE },
    ]);
  });

  it("emits only the text block for non-media output", () => {
    expect(anthropicToolResultBlocks("t", "out", "")).toEqual([
      {
        type: "text",
        text: "[tool t result]\nout\nDecide the NEXT tool call now, or reply with the final text only if every requested action is complete.",
      },
    ]);
  });
});

describe("geminiToolResultParts", () => {
  it("always emits a text part, then inline_data for image and audio", () => {
    const out = envelope({
      text: "saw a cat",
      image: { mime: "image/png", data_base64: "IMG" },
      audio: { format: "wav", data_base64: "AUD" },
    });
    expect(geminiToolResultParts("vision__capture_screen", out, "")).toEqual([
      {
        text: "[tool vision__capture_screen result]\nsaw a cat\nDecide the NEXT tool call now, or reply with the final text only if every requested action is complete.",
      },
      { inline_data: { mime_type: "image/png", data: "IMG" } },
      { inline_data: { mime_type: "audio/wav", data: "AUD" } },
    ]);
  });
});

describe("convoHasMedia / stripConvoMedia", () => {
  const mediaToolMessage = {
    role: "tool",
    content: [
      { type: "text", text: "note" },
      { type: "image_url", image_url: { url: "data:image/png;base64,IMG" } },
      { type: "input_audio", input_audio: { data: "AUD", format: "wav" } },
    ],
  };

  it("detects media parts across all three provider shapes", () => {
    expect(convoHasMedia([mediaToolMessage])).toBe(true);
    expect(
      convoHasMedia([{ role: "tool", content: [{ type: "image", source: {} }] }]),
    ).toBe(true);
    expect(
      convoHasMedia([{ role: "tool", content: [{ type: "inline_data", data: "x" }] }]),
    ).toBe(true);
    expect(
      convoHasMedia([{ role: "user", content: [{ type: "input_file", input_file: {} }] }]),
    ).toBe(true);
    expect(
      convoHasMedia([{ role: "user", content: [{ type: "document", source: {} }] }]),
    ).toBe(true);
    expect(convoHasMedia([{ role: "user", content: "plain" }])).toBe(false);
    expect(convoHasMedia([{ role: "assistant", content: null }])).toBe(false);
    expect(convoHasMedia([])).toBe(false);
  });

  it("detects and strips Gemini parts arrays too", () => {
    const contents = [
      {
        role: "user",
        parts: [
          { text: "hi" },
          { inline_data: { mime_type: "image/png", data: "IMG" } },
        ],
      },
    ];
    expect(convoHasMedia(contents)).toBe(true);
    stripConvoMedia(contents);
    // The note rides in Gemini's own part shape (bare {text}).
    expect(contents[0].parts).toEqual([
      { text: "hi" },
      { text: STRIP_NOTE(1) },
    ]);
    expect(convoHasMedia(contents)).toBe(false);
  });

  it("strips media parts in place, keeping text and adding one note", () => {
    const convo = [{ role: "user", content: "hi" }, { ...mediaToolMessage }];
    stripConvoMedia(convo);
    // String content is left alone; the tool message keeps its text part and
    // gains a single counted note, not one per dropped part.
    expect(convo[0].content).toBe("hi");
    expect(convo[1].content).toEqual([
      { type: "text", text: "note" },
      { type: "text", text: STRIP_NOTE(2) },
    ]);
    expect(convoHasMedia(convo)).toBe(false);
  });

  it("detects and strips media nested inside Anthropic tool_result blocks", () => {
    const convo = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: [
            { type: "text", text: "Screen captured." },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "IMG" } },
          ] },
        ],
      },
    ];
    expect(convoHasMedia(convo)).toBe(true);
    stripConvoMedia(convo);
    expect(convoHasMedia(convo)).toBe(false);
    // Media removed from the block; the aggregate note rides top-level.
    expect(convo[0].content).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "Screen captured." }] },
      { type: "text", text: STRIP_NOTE(1) },
    ]);
  });

  it("ignores tool_result blocks without media", () => {
    const convo = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "ok" }] },
        ],
      },
    ];
    expect(convoHasMedia(convo)).toBe(false);
    stripConvoMedia(convo);
    expect((convo[0].content as Array<{ content: unknown }>)[0].content).toEqual([
      { type: "text", text: "ok" },
    ]);
  });

  it("leaves messages without media parts untouched", () => {
    const convo = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: null },
    ];
    stripConvoMedia(convo);
    expect(convo[0].content).toEqual([{ type: "text", text: "hello" }]);
    expect(convo[1].content).toBeNull();
  });
});

// ─── User attachment builders ───

const IMG: ChatAttachmentLite = { name: "shot.png", mime: "image/png", base64: "IMG" };
const GIF: ChatAttachmentLite = { name: "anim.gif", mime: "image/gif", base64: "GIF" };
const SVG: ChatAttachmentLite = { name: "icon.svg", mime: "image/svg+xml", base64: "PG..." };
const WAV: ChatAttachmentLite = { name: "clip.wav", mime: "audio/wav", base64: "AUD" };
const OGG: ChatAttachmentLite = { name: "song.ogg", mime: "audio/ogg", base64: "OGG" };
const PDF: ChatAttachmentLite = { name: "doc.pdf", mime: "application/pdf", base64: "PDF" };
const TXT: ChatAttachmentLite = { name: "main.py", mime: "text/plain", base64: b64("print(1)") };
const ZIP: ChatAttachmentLite = { name: "bundle.zip", mime: "application/zip", base64: "ZIP" };

type ChatAttachmentLite = {
  name: string;
  mime: string;
  base64: string;
  frames?: Array<{ dataBase64: string; atMs: number }>;
};

function b64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let latin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    latin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(latin);
}

describe("openAIAttachmentParts", () => {
  it("maps images, wav audio, pdf, text, and unknown files", () => {
    expect(openAIAttachmentParts([IMG, WAV, PDF, TXT, ZIP])).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,IMG" } },
      { type: "input_audio", input_audio: { data: "AUD", format: "wav" } },
      {
        type: "input_file",
        input_file: { filename: "doc.pdf", file_data: "data:application/pdf;base64,PDF" },
      },
      { type: "text", text: "[attached file: main.py]\nprint(1)" },
      {
        type: "text",
        text: "[attached file: bundle.zip (application/zip)] — this provider cannot read this file type",
      },
    ]);
  });

  it("notes out unsupported image formats and non-wav/mp3 audio", () => {
    const parts = openAIAttachmentParts([SVG, OGG]);
    expect(parts).toEqual([
      {
        type: "text",
        text: "[attached file: icon.svg (image/svg+xml)] — this provider cannot read this image format",
      },
      {
        type: "text",
        text: "[attached file: song.ogg (audio/ogg)] — this provider only consumes wav/mp3 audio",
      },
    ]);
  });

  it("accepts mp3 audio", () => {
    const mp3: ChatAttachmentLite = { name: "a.mp3", mime: "audio/mpeg", base64: "MP3" };
    expect(openAIAttachmentParts([mp3])).toEqual([
      { type: "input_audio", input_audio: { data: "MP3", format: "mp3" } },
    ]);
  });
});

describe("anthropicAttachmentBlocks", () => {
  it("maps images, pdf documents, text, and notes the rest", () => {
    expect(anthropicAttachmentBlocks([GIF, PDF, TXT, WAV, ZIP])).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/gif", data: "GIF" } },
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: "PDF" },
      },
      { type: "text", text: "[attached file: main.py]\nprint(1)" },
      {
        type: "text",
        text: "[attached file: clip.wav (audio/wav)] — this provider cannot consume audio",
      },
      {
        type: "text",
        text: "[attached file: bundle.zip (application/zip)] — this provider cannot read this file type",
      },
    ]);
  });
});

describe("geminiAttachmentParts", () => {
  it("maps images, audio, pdf, and text via inline_data / text parts", () => {
    expect(geminiAttachmentParts([IMG, OGG, PDF, TXT, ZIP])).toEqual([
      { inline_data: { mime_type: "image/png", data: "IMG" } },
      { inline_data: { mime_type: "audio/ogg", data: "OGG" } },
      { inline_data: { mime_type: "application/pdf", data: "PDF" } },
      { text: "[attached file: main.py]\nprint(1)" },
      {
        text: "[attached file: bundle.zip (application/zip)] — this provider cannot read this file type",
      },
    ]);
  });

  it("sends video as keyframe images with a timestamp note", () => {
    const vid: ChatAttachmentLite = {
      name: "clip.mp4",
      mime: "video/mp4",
      base64: "",
      frames: [
        { dataBase64: "F0", atMs: 0 },
        { dataBase64: "F1", atMs: 2500 },
      ],
    };
    expect(openAIAttachmentParts([vid])).toEqual([
      { type: "text", text: "[attached file: clip.mp4 (video/mp4)] — keyframes at 0.0s, 2.5s" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,F0" } },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,F1" } },
    ]);
    expect(anthropicAttachmentBlocks([vid])).toEqual([
      { type: "text", text: "[attached file: clip.mp4 (video/mp4)] — keyframes at 0.0s, 2.5s" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "F0" } },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "F1" } },
    ]);
    expect(geminiAttachmentParts([vid])).toEqual([
      { text: "[attached file: clip.mp4 (video/mp4)] — keyframes at 0.0s, 2.5s" },
      { inline_data: { mime_type: "image/jpeg", data: "F0" } },
      { inline_data: { mime_type: "image/jpeg", data: "F1" } },
    ]);
  });

  it("prefers the raw video inline on Gemini when bytes are kept", () => {
    const vid: ChatAttachmentLite = {
      name: "clip.mp4",
      mime: "video/mp4",
      base64: "MP4",
      frames: [{ dataBase64: "F0", atMs: 0 }],
    };
    expect(geminiAttachmentParts([vid])).toEqual([
      { inline_data: { mime_type: "video/mp4", data: "MP4" } },
    ]);
    // OpenAI/Anthropic still ride the keyframes.
    expect(openAIAttachmentParts([vid])).toEqual([
      { type: "text", text: "[attached file: clip.mp4 (video/mp4)] — keyframes at 0.0s" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,F0" } },
    ]);
  });

  it("notes out videos without frames or bytes", () => {
    const vid: ChatAttachmentLite = { name: "clip.mkv", mime: "video/x-matroska", base64: "" };
    expect(openAIAttachmentParts([vid])).toEqual([
      { type: "text", text: "[attached file: clip.mkv (video/x-matroska)] — no keyframes could be extracted from it" },
    ]);
  });
});

// ─── Tool-media robustness + OpenAI split ───

describe("parseToolMedia robustness", () => {
  it("defaults a missing text to an empty string", () => {
    const m = parseToolMedia(envelope({ image: { mime: "image/png", data_base64: "IMG" } }));
    expect(m).toEqual({ text: "", image: { mime: "image/png", data_base64: "IMG" } });
  });

  it("unwraps a double-stringified envelope", () => {
    const m = parseToolMedia(JSON.stringify(envelope({ text: "x", image: { data_base64: "I" } })));
    expect(m?.image?.data_base64).toBe("I");
  });

  it("reads a video field forward", () => {
    const m = parseToolMedia(envelope({ text: "clip", video: { mime: "video/mp4", data_base64: "V" } }));
    expect(m?.video).toEqual({ mime: "video/mp4", data_base64: "V" });
  });

  it("still returns null for ordinary output and media-less envelopes", () => {
    expect(parseToolMedia("plain output")).toBeNull();
    expect(parseToolMedia(envelope({ text: "just words" }))).toBeNull();
    expect(parseToolMedia("not json {")).toBeNull();
  });
});

describe("truncateToolOutput", () => {
  it("caps huge non-media tool output", () => {
    const long = "x".repeat(5000);
    const out = truncateToolOutput(long);
    expect(out.length).toBeLessThan(2100);
    expect(out.endsWith("[truncated 3000 chars]")).toBe(true);
  });

  it("leaves short output alone", () => {
    expect(truncateToolOutput("ok")).toBe("ok");
  });
});

describe("openAIToolResultSplit", () => {
  const TAIL =
    "\nDecide the NEXT tool call now, or reply with the final text only if every requested action is complete.";

  it("keeps the tool message a plain string and hands the media back", () => {
    const out = envelope({ text: "Screen captured.", image: { mime: "image/png", data_base64: "IMG" } });
    const split = openAIToolResultSplit("vision__capture_screen", out, "");
    expect(split.toolContent).toBe("[tool vision__capture_screen result]\nScreen captured." + TAIL);
    expect(split.media?.image?.data_base64).toBe("IMG");
    // The parts the provider pushes into the following user message.
    expect(openAIMediaParts(split.media!)).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,IMG" } },
    ]);
  });

  it("returns null media for plain output and truncates raw fallback", () => {
    expect(openAIToolResultSplit("t", "plain", "").media).toBeNull();
    // A malformed envelope's raw JSON is capped, not dumped.
    const huge = `{"companion_media":{"image":{"data_base64":"${"A".repeat(4000)}"}}`;
    const split = openAIToolResultSplit("t", huge, "");
    expect(split.media).toBeNull();
    expect(split.toolContent.length).toBeLessThan(2200);
  });
});

