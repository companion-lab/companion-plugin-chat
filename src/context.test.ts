import { describe, expect, it } from "vitest";
import { buildWire, estimateContextTokens } from "./context";
import type { Msg } from "./chat-history";

const att = (name: string, dataBase64?: string) => ({
  name,
  mime: "image/png",
  size: dataBase64?.length ?? 0,
  ...(dataBase64 ? { dataBase64 } : {}),
});

describe("buildWire", () => {
  it("maps plain messages to string content", () => {
    const history: Msg[] = [
      { role: "user", text: "hi" },
      { role: "assistant", text: "yo" },
    ];
    expect(buildWire(history)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    ]);
  });

  it("passes live attachments in the protocol field, string content intact", () => {
    const history: Msg[] = [
      { role: "user", text: "look at this", attachments: [att("a.png", "AAA")] },
    ];
    expect(buildWire(history)).toEqual([
      {
        role: "user",
        content: "look at this",
        attachments: [{ name: "a.png", mime: "image/png", base64: "AAA" }],
      },
    ]);
  });

  it("degrades data-less attachments to an inline note", () => {
    const history: Msg[] = [
      {
        role: "user",
        text: "look at this",
        attachments: [att("old.png"), att("live.png", "BBB")],
      },
    ];
    expect(buildWire(history)).toEqual([
      {
        role: "user",
        content: "look at this\n[attached file: old.png (image/png)]",
        attachments: [{ name: "live.png", mime: "image/png", base64: "BBB" }],
      },
    ]);
  });

  it("passes video frames through as a bytes-less live attachment", () => {
    const history: Msg[] = [
      {
        role: "user",
        text: "watch",
        attachments: [
          { name: "clip.mp4", mime: "video/mp4", size: 0, frames: [{ dataBase64: "F0", atMs: 0 }] },
          att("gone.png"),
        ],
      },
    ];
    expect(buildWire(history)).toEqual([
      {
        role: "user",
        content: "watch\n[attached file: gone.png (image/png)]",
        attachments: [
          {
            name: "clip.mp4",
            mime: "video/mp4",
            base64: "",
            frames: [{ dataBase64: "F0", atMs: 0 }],
          },
        ],
      },
    ]);
  });

  it("emits only the note when no attachment has bytes", () => {
    const history: Msg[] = [
      { role: "user", text: "", attachments: [att("old.png")] },
    ];
    expect(buildWire(history)).toEqual([
      { role: "user", content: "[attached file: old.png (image/png)]" },
    ]);
  });

  it("never attaches anything to non-user messages", () => {
    const history: Msg[] = [
      { role: "system", text: "summary", kind: "compact" },
      { role: "assistant", text: "ok", attachments: [att("x.png", "X")] },
    ];
    expect(buildWire(history)).toEqual([
      { role: "user", content: "[Earlier conversation summary]\nsummary" },
      { role: "assistant", content: "ok" },
    ]);
  });
});

describe("estimateContextTokens", () => {
  it("counts attachments at flat per-kind figures, not base64 length", () => {
    const wire = buildWire([
      { role: "user", text: "look", attachments: [att("a.png", "A".repeat(1_000_000))] },
    ]);
    // A million base64 chars would be 250k tokens via chars/4; an image
    // counts as its flat 1100 instead.
    expect(estimateContextTokens(wire, "sys")).toBeLessThan(2000);
    expect(estimateContextTokens(wire, "sys")).toBeGreaterThanOrEqual(1100);
  });

  it("counts data-less notes as plain text", () => {
    const wire = buildWire([
      { role: "user", text: "", attachments: [att("old.png")] },
    ]);
    // "[attached file: old.png (image/png)]" = 36 chars → 9 tokens.
    expect(estimateContextTokens(wire, "")).toBe(9);
  });
});
