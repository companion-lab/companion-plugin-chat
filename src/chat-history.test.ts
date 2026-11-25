import { describe, expect, it } from "vitest";
import { PERSIST_KEEP_BUDGET_BASE64 } from "./net/attachments";
import {
  MAX_STORED_MSGS,
  sanitize,
  stripAllAttachmentData,
  stripAttachmentsForPersist,
  type Msg,
} from "./chat-history";

const att = (name: string, dataBase64?: string) => ({
  name,
  mime: "image/png",
  size: dataBase64?.length ?? 0,
  ...(dataBase64 ? { dataBase64 } : {}),
});

describe("sanitize", () => {
  it("keeps plain text messages", () => {
    const msgs: unknown[] = [
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
    ];
    expect(sanitize(msgs)).toEqual(msgs);
  });

  it("keeps compact markers but drops other system entries", () => {
    const msgs: unknown[] = [
      { role: "system", text: "persona", kind: "compact" },
      { role: "system", text: "injected" },
      { role: "system", text: "no kind" },
    ];
    expect(sanitize(msgs)).toEqual([{ role: "system", text: "persona", kind: "compact" }]);
  });

  it("drops entries without a string text", () => {
    expect(sanitize([{ role: "user", text: 42 }, null, "x"])).toEqual([]);
  });

  it("keeps well-formed user attachments (with frames) and strips assistant ones", () => {
    const msgs: unknown[] = [
      {
        role: "user",
        text: "look",
        attachments: [
          { name: "a.png", mime: "image/png", size: 3, dataBase64: "AAA" },
          {
            name: "clip.mp4",
            mime: "video/mp4",
            size: 2,
            frames: [{ dataBase64: "F0", atMs: 0 }],
          },
        ],
      },
      { role: "assistant", text: "ok", attachments: [att("b.png", "BBB")] },
    ];
    expect(sanitize(msgs)).toEqual([
      {
        role: "user",
        text: "look",
        attachments: [
          { name: "a.png", mime: "image/png", size: 3, dataBase64: "AAA" },
          {
            name: "clip.mp4",
            mime: "video/mp4",
            size: 2,
            frames: [{ dataBase64: "F0", atMs: 0 }],
          },
        ],
      },
      { role: "assistant", text: "ok" },
    ]);
  });

  it("drops attachments with malformed frames", () => {
    const msgs: unknown[] = [
      {
        role: "user",
        text: "look",
        attachments: [
          { name: "bad.mp4", mime: "video/mp4", size: 1, frames: [{ dataBase64: 5, atMs: 0 }] },
          { name: "good.mp4", mime: "video/mp4", size: 1, frames: [{ dataBase64: "F0", atMs: 0 }] },
        ],
      },
    ];
    expect(sanitize(msgs)).toEqual([
      {
        role: "user",
        text: "look",
        attachments: [{ name: "good.mp4", mime: "video/mp4", size: 1, frames: [{ dataBase64: "F0", atMs: 0 }] }],
      },
    ]);
  });

  it("drops malformed attachments and clears the field when none survive", () => {
    const msgs: unknown[] = [
      {
        role: "user",
        text: "look",
        attachments: [null, { mime: "image/png" }, { name: "", mime: "x" }, att("a.png", "AAA")],
      },
      { role: "user", text: "nope", attachments: [{ name: "b.png" }] },
    ];
    expect(sanitize(msgs)).toEqual([
      { role: "user", text: "look", attachments: [att("a.png", "AAA")] },
      { role: "user", text: "nope" },
    ]);
  });

  it("caps the stored message count", () => {
    const msgs: unknown[] = Array.from({ length: MAX_STORED_MSGS + 5 }, (_, i) => ({
      role: "user",
      text: `m${i}`,
    }));
    const out = sanitize(msgs);
    expect(out.length).toBe(MAX_STORED_MSGS);
    expect(out[0].text).toBe("m5");
  });
});

describe("stripAttachmentsForPersist", () => {
  it("passes messages without attachments through untouched", () => {
    const msgs: Msg[] = [
      { role: "user", text: "hi" },
      { role: "assistant", text: "yo" },
    ];
    expect(stripAttachmentsForPersist(msgs)).toEqual(msgs);
  });

  it("counts keyframe bytes in the budget and strips them together", () => {
    const frames = [{ dataBase64: "F".repeat(40), atMs: 0 }];
    const video: Msg = {
      role: "user",
      text: "watch",
      attachments: [{ name: "clip.mp4", mime: "video/mp4", size: 0, frames }],
    };
    // One small frames-only attachment: budget covers it, nothing stripped.
    const out = stripAttachmentsForPersist([video]);
    expect(out[0].attachments![0].frames).toEqual(frames);
    // Strip-all removes frame bytes too, keeping the chip metadata.
    const bare = stripAllAttachmentData([video]);
    expect(bare[0].attachments![0]).toEqual({
      name: "clip.mp4",
      mime: "video/mp4",
      size: 0,
    });
  });

  it("keeps the newest attachment bytes within budget, strips older ones", () => {
    const big = "A".repeat(1500);
    const old: Msg = { role: "user", text: "old", attachments: [att("old.png", big)] };
    const mid: Msg = { role: "user", text: "mid", attachments: [att("mid.png", big)] };
    const newest: Msg = { role: "user", text: "newest", attachments: [att("new.png", big)] };
    const out = stripAttachmentsForPersist([old, mid, newest]);
    // Budget 2 MB — all three fit; nothing stripped.
    expect(out.map((m) => m.attachments![0].dataBase64)).toEqual([big, big, big]);
  });

  it("strips bytes once the budget is spent, keeping metadata", () => {
    // Exactly the budget: the newest message keeps its bytes, which spends
    // the whole budget, so the older one loses them.
    const huge = "A".repeat(Math.floor(PERSIST_KEEP_BUDGET_BASE64 / 4) * 4);
    const older: Msg = { role: "user", text: "older", attachments: [att("older.png", huge)] };
    const newer: Msg = { role: "user", text: "newer", attachments: [att("newer.png", huge)] };
    const out = stripAttachmentsForPersist([older, newer]);
    // Newest-first: "newer" keeps its bytes, "older" loses them.
    expect(out[1].attachments![0].dataBase64).toBe(huge);
    expect(out[0].attachments![0].dataBase64).toBeUndefined();
    expect(out[0].attachments![0].name).toBe("older.png");
    expect(out[0].attachments![0].mime).toBe("image/png");
  });

  it("keeps a message whose newest bytes exactly exhaust the budget", () => {
    const exact = "B".repeat(Math.floor(PERSIST_KEEP_BUDGET_BASE64 / 4) * 4);
    const only: Msg = { role: "user", text: "only", attachments: [att("only.png", exact)] };
    const out = stripAttachmentsForPersist([only]);
    expect(out[0].attachments![0].dataBase64).toBe(exact);
  });
});

describe("stripAllAttachmentData", () => {
  it("removes every dataBase64 but keeps name/mime/size", () => {
    const msgs: Msg[] = [
      { role: "user", text: "hi", attachments: [att("a.png", "AAA")] },
      { role: "user", text: "plain" },
    ];
    expect(stripAllAttachmentData(msgs)).toEqual([
      { role: "user", text: "hi", attachments: [{ name: "a.png", mime: "image/png", size: 3 }] },
      { role: "user", text: "plain" },
    ]);
  });
});
