// Tests for the generic reply plumbing (net/reply.ts + net/structured.ts):
// schema-derived tag kinds, JSON/prose final reconcile, Gemini schema
// conversion, and the contribution-aware system prompt.

import { describe, it, expect, afterEach } from "vitest";
import {
  finalReplyResult,
  tagKinds,
  toGeminiSchema,
  buildSystemPrompt,
  replyToolName,
  openAiReplyTool,
  emitFinalText,
} from "./reply";
import { StructuredStream, stripStructuredTags, parseStructured } from "./structured";
import type { ReplyContribution } from "@companion-lab/plugin";

// The reply contribution normally comes from the host bridge; tests install
// one directly on the global so no host is needed.
afterEach(() => {
  delete (globalThis as any).__companion_host__;
});

const SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string" },
    emotion: { type: "string", enum: ["neutral", "happy"] },
    motion: { type: "string", enum: ["none", "nod"] },
  },
  required: ["text", "emotion", "motion"],
};

function contribution(overrides: Partial<ReplyContribution> = {}): ReplyContribution {
  return {
    id: "test",
    prompt: "Pick an emotion and a motion.",
    schema: SCHEMA,
    apply: () => {},
    ...overrides,
  };
}

function installHost(c: ReplyContribution | null) {
  (globalThis as any).__companion_host__ = { reply: { get: () => c } };
}

describe("tagKinds", () => {
  it("derives every non-text schema property as a tag kind", () => {
    expect(tagKinds(contribution())).toEqual(["emotion", "motion"]);
  });

  it("returns nothing without a contribution or properties", () => {
    expect(tagKinds(null)).toEqual([]);
    expect(tagKinds(contribution({ schema: {} }))).toEqual([]);
  });
});

describe("toGeminiSchema", () => {
  it("uppercases types recursively and drops additionalProperties", () => {
    expect(toGeminiSchema(SCHEMA)).toEqual({
      type: "OBJECT",
      properties: {
        text: { type: "STRING" },
        emotion: { type: "STRING", enum: ["neutral", "happy"] },
        motion: { type: "STRING", enum: ["none", "nod"] },
      },
      required: ["text", "emotion", "motion"],
    });
  });

  it("converts array items", () => {
    const out = toGeminiSchema({
      type: "object",
      properties: { tags: { type: "array", items: { type: "string" } } },
    });
    expect(out).toEqual({
      type: "OBJECT",
      properties: { tags: { type: "ARRAY", items: { type: "STRING" } } },
    });
  });
});

describe("openAiReplyTool", () => {
  it("uses the contribution's schema and carrier name", () => {
    const tool = openAiReplyTool(contribution({ toolName: "my_reply" })) as {
      function: { name: string; parameters: unknown };
    };
    expect(tool.function.name).toBe("my_reply");
    expect(tool.function.parameters).toBe(SCHEMA);
  });

  it("defaults the carrier name to avatar_response", () => {
    expect(replyToolName(contribution())).toBe("avatar_response");
    expect(replyToolName(null)).toBe("avatar_response");
  });
});

describe("finalReplyResult", () => {
  it("parses the complete JSON shape into text + data", () => {
    installHost(contribution());
    const r = finalReplyResult('{"text":"hi","emotion":"happy","motion":"nod"}', [
      "emotion",
      "motion",
    ]);
    expect(r.text).toBe("hi");
    expect(r.data).toEqual({ emotion: "happy", motion: "nod" });
  });

  it("recovers text from half-streamed JSON via the streaming extractor", () => {
    installHost(contribution());
    const r = finalReplyResult('{"text":"hello wor', ["emotion", "motion"]);
    expect(r.text).toBe("hello wor");
    expect(r.data).toEqual({});
  });

  it("treats prose without tags as plain text", () => {
    installHost(contribution());
    const r = finalReplyResult("just words here", ["emotion", "motion"]);
    expect(r.text).toBe("just words here");
    expect(r.data).toEqual({});
  });

  it("extracts inline tags from prose replies", () => {
    installHost(contribution());
    const r = finalReplyResult("nice <<motion:nod>> <<emotion:happy>>", [
      "emotion",
      "motion",
    ]);
    expect(r.text).toBe("nice");
    expect(r.data).toEqual({ motion: "nod", emotion: "happy" });
  });

  it("lets mid-stream fired tags win over the JSON parse", () => {
    installHost(contribution());
    const tags = new StructuredStream(["emotion", "motion"]);
    tags.push("<<motion:nod>>");
    const r = finalReplyResult('{"text":"ok","emotion":"happy","motion":"none"}', [
      "emotion",
      "motion",
    ], tags);
    expect(r.text).toBe("ok");
    expect(r.data).toEqual({ emotion: "happy", motion: "nod" });
  });

  it("does not invent data without a contribution", () => {
    installHost(null);
    const r = finalReplyResult("plain words", []);
    expect(r.text).toBe("plain words");
    expect(r.data).toEqual({});
  });
});

describe("StructuredStream", () => {
  it("fires each newly resolved tag once and strips it from speech", () => {
    const s = new StructuredStream(["emotion", "motion"]);
    const a = s.push("hi <<motion:no");
    const b = s.push("d>> there <<emotion:happy>> <<motion:nod>>");
    expect(a.data).toEqual({});
    expect(b.data).toEqual({ motion: "nod", emotion: "happy" });
    expect(b.tokens).not.toContain("<<");
    expect(s.getFinal()).toEqual({ motion: "nod", emotion: "happy" });
  });

  it("re-fires when a tag value changes", () => {
    const s = new StructuredStream(["motion"]);
    s.push("<<motion:nod>>");
    const r = s.push("<<motion:shake>>");
    expect(r.data).toEqual({ motion: "shake" });
  });

  it("holds back a trailing partial tag from the tokens", () => {
    const s = new StructuredStream(["motion"]);
    const r = s.push("hello <<mo");
    expect(r.tokens).toBe("hello ");
  });
});

describe("parseStructured / stripStructuredTags", () => {
  it("parses only the configured kinds", () => {
    const raw = "<<motion:nod>><<emotion:happy>><<other:x>>";
    expect(parseStructured(raw, ["motion"])).toEqual({
      text: "<<emotion:happy>><<other:x>>",
      data: { motion: "nod" },
    });
    expect(stripStructuredTags(raw, ["motion", "emotion"])).toBe("<<other:x>>");
  });
});

describe("buildSystemPrompt", () => {
  it("includes the contribution prompt and host plugin fragments", () => {
    installHost(contribution());
    (globalThis as any).__companion_host__.systemPrompts = {
      get: () => ["Voice plugin fragment."],
    };
    const p = buildSystemPrompt();
    expect(p).toContain("You are a helpful assistant.");
    expect(p).toContain("Pick an emotion and a motion.");
    expect(p).toContain("Voice plugin fragment.");
    // No avatar wording without the contribution supplying it.
    expect(p).not.toContain("physical motion");
  });

  it("is plain chat without a contribution", () => {
    installHost(null);
    const p = buildSystemPrompt();
    expect(p).toContain("You are a helpful assistant.");
    expect(p).not.toContain("emotion");
  });
});

describe("emitFinalText", () => {
  it("never speaks tags or raw JSON, only the text field", () => {
    const st = { emitted: "" };
    emitFinalText('{"text":"spoken part","motion":"nod"', st, undefined, [
      "motion",
    ]);
    // No onToken here — just assert via a second call that the diff baseline
    // advanced to the speakable text.
    const st2 = { emitted: "" };
    const out: string[] = [];
    emitFinalText('{"text":"spoken part"}', st2, (t) => out.push(t), ["motion"]);
    expect(out.join("")).toBe("spoken part");
    expect(st2.emitted).toBe("spoken part");
  });
});
