import { describe, expect, it } from "vitest";
import {
  MAX_FILES,
  MAX_FILE_BYTES,
  PERSIST_KEEP_BUDGET_BASE64,
  attachmentKind,
  attachmentNote,
  attachmentTokenEstimate,
  classifyMime,
  fmtBytes,
  truncatedAttachmentText,
  type AttachmentKind,
} from "./attachments";

const b64 = (s: string): string => {
  const bytes = new TextEncoder().encode(s);
  let latin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    latin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(latin);
};

describe("classifyMime", () => {
  it("keeps a real file.type", () => {
    expect(classifyMime("photo.png", "image/png")).toBe("image/png");
    expect(classifyMime("doc.pdf", "application/pdf")).toBe("application/pdf");
  });

  it("falls back to the extension when the type is empty or generic", () => {
    expect(classifyMime("shot.PNG", "")).toBe("image/png");
    expect(classifyMime("song.mp3", "application/octet-stream")).toBe("audio/mp3");
    expect(classifyMime("notes.md", "")).toBe("text/markdown");
    expect(classifyMime("main.ts", "")).toBe("text/ts");
    expect(classifyMime("clip.webm", "")).toBe("video/webm");
    expect(classifyMime("clip.mov", "")).toBe("video/mp4");
    expect(classifyMime("paper", "")).toBe("application/octet-stream");
  });
});

describe("attachmentKind", () => {
  const kinds: Array<[string, AttachmentKind]> = [
    ["image/png", "image"],
    ["audio/wav", "audio"],
    ["application/pdf", "pdf"],
    ["video/mp4", "video"],
    ["video/x-matroska", "video"],
    ["text/plain", "text"],
    ["application/json", "text"],
    ["application/zip", "binary"],
    ["", "binary"],
  ];
  it.each(kinds)("classifies %s as %s", (mime, want) => {
    expect(attachmentKind(mime)).toBe(want);
  });
});

describe("attachmentNote", () => {
  it("names the file and mime", () => {
    expect(attachmentNote("a.png", "image/png")).toBe("[attached file: a.png (image/png)]");
  });
});

describe("attachmentTokenEstimate", () => {
  it("uses flat figures for media and derives text from decoded length", () => {
    expect(attachmentTokenEstimate("image/png", b64("x"))).toBe(1100);
    expect(attachmentTokenEstimate("audio/wav", b64("x"))).toBe(600);
    expect(attachmentTokenEstimate("application/pdf", b64("x"))).toBe(1500);
    expect(attachmentTokenEstimate("application/zip", b64("x"))).toBe(50);
    // 8 decoded chars ≈ 2 tokens; the base64 estimate rounds up to 3.
    expect(attachmentTokenEstimate("text/plain", b64("abcdefgh"))).toBe(3);
  });

  it("estimates video by transport: inline bytes or keyframes", () => {
    const frames = [
      { dataBase64: b64("f0"), atMs: 0 },
      { dataBase64: b64("f1"), atMs: 2500 },
    ];
    // Raw bytes kept (Gemini inline): one coarse flat figure.
    expect(attachmentTokenEstimate("video/mp4", b64("x"), frames)).toBe(4500);
    // Frames-only (OpenAI/Anthropic): per-frame figures plus a note.
    expect(attachmentTokenEstimate("video/mp4", "", frames)).toBe(2250);
    expect(attachmentTokenEstimate("video/mp4", "")).toBe(50);
  });
});

describe("truncatedAttachmentText", () => {
  it("decodes utf-8 text", () => {
    expect(truncatedAttachmentText(b64("héllo world"))).toBe("héllo world");
  });

  it("caps at MAX_TEXT_PART_CHARS without blowing up on big input", () => {
    const long = "a".repeat(50_000);
    const out = truncatedAttachmentText(b64(long));
    expect(out.length).toBeLessThanOrEqual(20_000);
    expect(out.startsWith("a")).toBe(true);
  });

  it("returns '' for garbage base64", () => {
    expect(truncatedAttachmentText("not base64!!!")).toBe("");
  });
});

describe("fmtBytes", () => {
  it("formats bytes and megabytes", () => {
    expect(fmtBytes(512)).toBe("1 KB");
    expect(fmtBytes(1536 * 1024)).toBe("1.5 MB");
  });
});

describe("limits", () => {
  it("keep the base64 of one max file inside the persist budget", () => {
    // A single max-size attachment must fit the persistence budget, or the
    // most recent message's bytes would be stripped immediately.
    const worstBase64 = Math.ceil(MAX_FILE_BYTES / 3) * 4;
    expect(worstBase64).toBeLessThanOrEqual(PERSIST_KEEP_BUDGET_BASE64);
    expect(MAX_FILES).toBeGreaterThanOrEqual(1);
  });
});
