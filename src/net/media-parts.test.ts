import { describe, expect, it } from "vitest";
import {
  anthropicToolResultBlocks,
  convoHasMedia,
  geminiToolResultParts,
  openAIToolResultContent,
  parseToolMedia,
  stripConvoMedia,
} from "./media-parts";

const AUDIO_NOTE = "[an audio clip was captured but this provider cannot consume audio]";

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
    // Missing/non-string text → not the envelope.
    expect(parseToolMedia(envelope({ image: { data_base64: "I" } }))).toBeNull();
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
  it("always emits a text part, then inline_data and an audio note", () => {
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
      { text: AUDIO_NOTE },
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
    expect(convoHasMedia([{ role: "user", content: "plain" }])).toBe(false);
    expect(convoHasMedia([{ role: "assistant", content: null }])).toBe(false);
    expect(convoHasMedia([])).toBe(false);
  });

  it("strips media parts in place, keeping text and adding one note", () => {
    const convo = [{ role: "user", content: "hi" }, { ...mediaToolMessage }];
    stripConvoMedia(convo);
    // String content is left alone; the tool message keeps its text part and
    // gains a single counted note, not one per dropped part.
    expect(convo[0].content).toBe("hi");
    expect(convo[1].content).toEqual([
      { type: "text", text: "note" },
      { type: "text", text: "[2 media part(s) omitted — this server rejected them]" },
    ]);
    expect(convoHasMedia(convo)).toBe(false);
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
