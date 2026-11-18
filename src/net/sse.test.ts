import { describe, expect, it, vi } from "vitest";
import {
  applyOpenAiDelta,
  extractPartialText,
  openAiDeltaState,
  openAiToolCalls,
  readSse,
} from "./sse";

const enc = new TextEncoder();

function sseResponse(...chunks: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream);
}

async function collect(textChunks: string[]): Promise<string[]> {
  const seen: string[] = [];
  await readSse(
    sseResponse(...textChunks.map((c) => enc.encode(c))),
    new AbortController().signal,
    (d) => seen.push(d),
  );
  return seen;
}

describe("readSse", () => {
  it("emits every data field in order", async () => {
    await expect(collect(["data: hello\n\n", "data: world\n\n"])).resolves.toEqual([
      "hello",
      "world",
    ]);
  });

  it("reassembles events split across chunk boundaries", async () => {
    // Chunks can break anywhere — mid-line and even mid-"data:" prefix.
    await expect(collect(["data: hel", "lo\n\ndata: wor", "ld\n\n"])).resolves.toEqual([
      "hello",
      "world",
    ]);
    await expect(collect(["dat", "a: x\n\n"])).resolves.toEqual(["x"]);
  });

  it("treats each multi-line data field as its own event", async () => {
    await expect(collect(["data: a\ndata: b\n\ndata: c\n\n"])).resolves.toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("skips [DONE] and blank data lines", async () => {
    // [DONE] is the OpenAI stream terminator, never model content.
    await expect(
      collect(['data: {"ok":1}\n\n', "data: [DONE]\n\ndata:\n\n"]),
    ).resolves.toEqual(['{"ok":1}']);
  });

  it("ignores non-data lines and comment-only events", async () => {
    await expect(
      collect(["event: add\nid: 7\ndata: payload\n\n: keepalive\n\ndata: after\n\n"]),
    ).resolves.toEqual(["payload", "after"]);
  });

  it("flushes a trailing event that never got its blank line", async () => {
    // A server that dies mid-event must not lose its last data line.
    await expect(collect(["data: partial line\ndata: tail"])).resolves.toEqual([
      "partial line",
      "tail",
    ]);
  });

  it("ignores a whitespace-only tail", async () => {
    await expect(collect(["data: x\n\n   \n"])).resolves.toEqual(["x"]);
  });

  it("decodes multi-byte characters split across chunks", async () => {
    // The decoder runs in streaming mode, so a partial UTF-8 sequence must
    // stay buffered until its continuation bytes arrive.
    const seen: string[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode("data: h"));
        controller.enqueue(new Uint8Array([0xc3, 0xa9])); // é, raw bytes
        controller.enqueue(enc.encode("llo\n\n"));
        controller.close();
      },
    });
    await readSse(new Response(stream), new AbortController().signal, (d) => seen.push(d));
    expect(seen).toEqual(["héllo"]);
  });

  it("reads nothing when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    // The stream below would produce data if it were ever read — the
    // pre-aborted signal must cancel the reader before that happens.
    await expect(readSSE(abortedResponse(), ac.signal)).resolves.toEqual([]);
  });

  it("stops reading when the signal aborts mid-stream", async () => {
    // Abort raised from inside onData: the current event is delivered, then
    // the loop breaks before pulling further chunks (the reader is cancelled).
    const seen: string[] = [];
    const ac = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode("data: first\n\n"));
      },
      // No pull and no further enqueues: a second read would hang forever,
      // so a resolution here proves the abort stopped the pump.
    });
    const done = readSse(new Response(stream), ac.signal, (d) => {
      seen.push(d);
      ac.abort();
    });
    await expect(done).resolves.toBeUndefined();
    expect(seen).toEqual(["first"]);
  });
});

// Helper for the pre-aborted case: a stream that would produce data if read.
function abortedResponse(): Response {
  return sseResponse(enc.encode("data: never\n\n"));
}
function readSSE(res: Response, signal: AbortSignal): Promise<string[]> {
  const seen: string[] = [];
  return readSse(res, signal, (d) => seen.push(d)).then(() => seen);
}

// ─── OpenAI delta accumulator ───

describe("applyOpenAiDelta", () => {
  it("concatenates content deltas and counts frames", () => {
    const st = openAiDeltaState();
    applyOpenAiDelta(st, JSON.stringify({ choices: [{ delta: { content: "Hel" } }] }));
    applyOpenAiDelta(st, JSON.stringify({ choices: [{ delta: { content: "lo" } }] }));
    expect(st.content).toBe("Hello");
    expect(st.frames).toBe(2);
  });

  it("accepts the non-streaming message shape too", () => {
    const st = openAiDeltaState();
    applyOpenAiDelta(st, JSON.stringify({ choices: [{ message: { content: "hi" } }] }));
    expect(st.content).toBe("hi");
  });

  it("collects both reasoning field spellings", () => {
    const st = openAiDeltaState();
    applyOpenAiDelta(
      st,
      JSON.stringify({ choices: [{ delta: { reasoning_content: "thin" } }] }),
    );
    applyOpenAiDelta(st, JSON.stringify({ choices: [{ delta: { reasoning: "king" } }] }));
    expect(st.reasoning).toBe("thinking");
  });

  it("keeps the latest non-empty finish_reason", () => {
    const st = openAiDeltaState();
    applyOpenAiDelta(st, JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }));
    applyOpenAiDelta(st, JSON.stringify({ choices: [{ delta: {}, finish_reason: "" }] }));
    expect(st.finishReason).toBe("stop");
  });

  it("captures usage on a choices frame without counting extra frames", () => {
    const st = openAiDeltaState();
    applyOpenAiDelta(
      st,
      JSON.stringify({
        choices: [{ delta: { content: "x" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
    applyOpenAiDelta(
      st,
      // Standalone usage-only frame: empty choices array.
      JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } }),
    );
    expect(st.usage).toEqual({ promptTokens: 7, completionTokens: 2 });
    expect(st.frames).toBe(1);
  });

  it("ignores junk: invalid JSON, missing choices, non-object usage", () => {
    const st = openAiDeltaState();
    applyOpenAiDelta(st, "not json at all");
    applyOpenAiDelta(st, JSON.stringify({ usage: "junk" }));
    applyOpenAiDelta(st, JSON.stringify({ choices: "nope" }));
    expect(st.frames).toBe(0);
    expect(st.content).toBe("");
    expect(st.usage).toBeUndefined();
  });

  it("assembles tool calls keyed by index", () => {
    const st = openAiDeltaState();
    // id arrives whole; name and arguments arrive split across deltas.
    applyOpenAiDelta(
      st,
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", function: { name: "get_", arguments: '{"city":' } },
              ],
            },
          },
        ],
      }),
    );
    applyOpenAiDelta(
      st,
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { name: "weather", arguments: '"paris"}' } },
                { index: 1, id: "call_2", function: { name: "noop", arguments: "{}" } },
              ],
            },
          },
        ],
      }),
    );
    expect(openAiToolCalls(st)).toEqual([
      { id: "call_1", name: "get_weather", args: '{"city":"paris"}' },
      { id: "call_2", name: "noop", args: "{}" },
    ]);
  });

  it("sorts by index and drops nameless accumulators", () => {
    const st = openAiDeltaState();
    applyOpenAiDelta(
      st,
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 2, id: "b", function: { name: "second", arguments: "" } },
                { index: 0, id: "a", function: { name: "first", arguments: "" } },
                { index: 1, id: "c", function: { name: "", arguments: "" } },
              ],
            },
          },
        ],
      }),
    );
    expect(openAiToolCalls(st).map((c) => c.name)).toEqual(["first", "second"]);
  });
});

describe("extractPartialText", () => {
  it("reads the text field from complete JSON", () => {
    expect(extractPartialText('{"text": "hi there"}')).toBe("hi there");
  });

  it("salvages the text prefix from a truncated JSON frame", () => {
    // The raw prefix is re-wrapped in quotes and parsed, so every streamed
    // character survives — only dangling escapes get trimmed away.
    expect(extractPartialText('{"text": "hello wor')).toBe("hello wor");
  });

  it("trims a dangling backslash escape that would corrupt the string", () => {
    expect(extractPartialText('{"text": "dir\\')).toBe("dir");
  });

  it("keeps complete characters including escapes", () => {
    expect(extractPartialText('{"text": "héllo')).toBe("héllo");
    expect(extractPartialText('{"text": "caf\\u0041')).toBe("cafA");
  });

  it("recovers from a dangling partial \\u escape", () => {
    expect(extractPartialText('{"text": "caf\\u00')).toBe("caf");
  });

  it("returns empty for non-JSON or text-less payloads", () => {
    expect(extractPartialText("just words")).toBe("");
    expect(extractPartialText('{"a": 1}')).toBe("");
  });
});
