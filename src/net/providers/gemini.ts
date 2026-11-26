import type {
  Provider,
  ProviderConfig,
  ProviderRequest,
  ProviderResult,
  ProviderUsage,
  McpNativeCall,
} from "../types";
import type { ChatMessage } from "../protocol";
import {
  fetchMcpTools,
  mcpSystemHint,
  toGeminiDeclarations,
  execMcpCall,
} from "../tools";
import { askUserTool } from "../ask-user";
import {
  MCP_MAX_STEPS,
  shouldUseMcp,
  keywordFallback,
  dropDuplicateAlarms,
  taskLooksComplete,
  originalGoal,
  toolResultMessage,
} from "../loop";
import {
  buildMessages,
  msgText,
  emitFinalText,
  finalReplyResult,
  getReplyContribution,
  toGeminiSchema,
  tagKinds,
} from "../reply";
import { doFetch, canStream, throwIfHttpError } from "../fetch";
import { geminiToolResultParts, geminiAttachmentParts, convoHasMedia, stripConvoMedia, serverRejectionReason } from "../media-parts";
import { readSse } from "../sse";

export class GeminiProvider implements Provider {
  readonly kind = "gemini" as const;
  constructor(private cfg: ProviderConfig) {}

  async chat({
    messages,
    signal,
    memoryContext,
    onToken,
    onThinking,
  }: ProviderRequest): Promise<ProviderResult> {
    const base = this.cfg.url.replace(/\/+$/, "").replace(/\/v1(beta)?$/, "");
    const key = encodeURIComponent(this.cfg.apiKey);

    const probeTools = await fetchMcpTools();
    const mcpArmed = shouldUseMcp(messages, probeTools);
    // ask_user rides along on every message so unclear instructions can be
    // clarified; the nudge gate below stays keyed to mcpArmed so casual
    // chat never gets "keep working" nudges.
    const mcpTools = mcpArmed ? [...probeTools, askUserTool()] : [askUserTool()];
    if (!mcpArmed && probeTools.length)
      console.log("[mcp] idle for this message");
    const hint = mcpSystemHint(mcpTools);
    const declarations = toGeminiDeclarations(mcpTools);
    // The reply shape (schema) comes from whichever plugin contributed a
    // ReplyContribution — null = plain prose chat, no response schema.
    const reply = getReplyContribution();
    const kinds = tagKinds(reply);
    const builtBase = buildMessages(messages, this.cfg.persona, memoryContext);
    const sysBase = msgText(builtBase[0]);
    // Gemini contents (model/user only); tool I/O replays as text parts.
    // User turns with attachments get media parts appended after the text.
    let contents: any[] = builtBase
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts:
          m.attachments?.length
            ? [
                { text: msgText(m) },
                ...geminiAttachmentParts(m.attachments),
              ]
            : [{ text: msgText(m) }],
      }));
    const goal = originalGoal(builtBase.filter((m) => m.role !== "system"));
    const callsSoFar: Array<{ qualified: string; args: unknown }> = [];
    // Context-fill detection (net/compact.ts): see openai.ts. Gemini reports
    // cumulative usageMetadata on every chunk.
    let lastUsage: ProviderUsage | undefined;

    for (let step = 0; step <= MCP_MAX_STEPS; step++) {
      const body: Record<string, unknown> = {
        ...(typeof sysBase === "string"
          ? {
              systemInstruction: {
                role: "system",
                parts: [
                  { text: step === 0 && hint ? `${sysBase}${hint}` : sysBase },
                ],
              },
            }
          : {}),
        contents,
        ...(declarations.length
          ? { tools: [{ functionDeclarations: declarations }] }
          : {}),
        // Structured output on every step so the reply always parses (only
        // with a reply contribution; plain chat keeps free-form text).
        ...(reply
          ? {
              generationConfig: {
                responseMimeType: "application/json",
                responseSchema: toGeminiSchema(reply.schema),
              },
            }
          : {}),
      };

      const streamUrl = `${base}/v1beta/models/${encodeURIComponent(this.cfg.model)}:streamGenerateContent?alt=sse&key=${key}`;
      const res = await doFetch(streamUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) {
        // Gemini rejects inline_data whose format it can't ingest (400) or
        // oversized requests (413/422). Strip media parts once and retry
        // with notes so the turn still completes.
        if (convoHasMedia(contents) && (res.status === 400 || res.status === 413 || res.status === 422)) {
          const t = await res.text().catch(() => "");
          console.warn(
            `[llm] media parts rejected (HTTP ${res.status}), retrying with media stripped${t ? `: ${t.slice(0, 160)}` : ""}`,
          );
          stripConvoMedia(contents, serverRejectionReason(t));
          step--;
          continue;
        }
        await throwIfHttpError(res);
      }
      if (!canStream(res)) {
        const nr = await this.chatNonStream(body, signal, kinds, (u) => { lastUsage = u; });
        return { ...nr, usage: lastUsage };
      }
      let accText = "";
      // Thought summaries stream as their own parts; keep them out of the
      // reply text (they must not reach TTS or the final reply parse).
      let accThought = "";
      let seenThought = 0;
      const mcpCalls: McpNativeCall[] = [];
      const seenCalls = new Set<string>();
      const st = { emitted: "" };
      let stepIn = 0;
      let stepOut = 0;
      await readSse(res, signal, (data) => {
        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          return;
        }
        const um = chunk?.usageMetadata;
        if (um && typeof um === "object") {
          const p = Number(um.promptTokenCount);
          const c = Number(um.candidatesTokenCount);
          if (Number.isFinite(p)) stepIn = p;
          if (Number.isFinite(c)) stepOut = c;
        }
        const parts = chunk?.candidates?.[0]?.content?.parts ?? [];
        for (const p of parts) {
          if (typeof p?.text === "string" && p.text) {
            if (p.thought === true) {
              accThought += p.text;
              if (accThought.length > seenThought) {
                onThinking?.(accThought.slice(seenThought));
                seenThought = accThought.length;
              }
            } else {
              accText += p.text;
              emitFinalText(accText, st, onToken, kinds);
            }
          }
          const fc = p?.functionCall;
          if (fc && typeof fc.name === "string") {
            const key = `${fc.name}:${JSON.stringify(fc.args ?? {})}`;
            if (seenCalls.has(key)) continue;
            seenCalls.add(key);
            mcpCalls.push({
              id: `${step}-${mcpCalls.length}`,
              qualified: fc.name,
              args: fc.args ?? {},
            });
          }
        }
      });
      emitFinalText(accText, st, onToken, kinds);
      if (stepIn || stepOut) {
        lastUsage = {
          inputTokens: stepIn || lastUsage?.inputTokens || 0,
          outputTokens: stepOut || lastUsage?.outputTokens || 0,
        };
      }
      if (!mcpCalls.length || step === MCP_MAX_STEPS) {
        if (!mcpCalls.length && step < MCP_MAX_STEPS && mcpArmed) {
          const lastUser = [...contents]
            .reverse()
            .find((c: any) => c?.role === "user");
          const fbRaw = keywordFallback(
            typeof lastUser?.parts?.[0]?.text === "string"
              ? lastUser.parts[0].text
              : goal,
            mcpTools,
            callsSoFar,
          );
          const fb = fbRaw && dropDuplicateAlarms([fbRaw], callsSoFar)[0];
          if (fb) {
            console.log(
              `[mcp] keyword fallback: ${fb.qualified} ${JSON.stringify(fb.args)}`,
            );
            callsSoFar.push(fb);
            const output = await execMcpCall(fb.qualified, fb.args, signal);
            contents = [
              ...contents,
              { role: "model", parts: [{ text: accText }] },
              {
                role: "user",
                parts: geminiToolResultParts(fb.qualified, output, goal),
              },
            ];
            continue;
          }
          if (!taskLooksComplete(goal, callsSoFar)) {
            console.log(
              `[mcp] step ${step + 1}: task incomplete, nudging for next tool`,
            );
            contents = [
              ...contents,
              { role: "model", parts: [{ text: accText }] },
              {
                role: "user",
                parts: [
                  {
                    text: `${toolResultMessage("none", "No tool was called.", goal)} Keep working: call the next MCP tool now.`,
                  },
                ],
              },
            ];
            continue;
          }
        }
        console.log(`[mcp] step ${step + 1}: no tool call, replying direct`);
        const parsed = finalReplyResult(accText, kinds);
        const finalText = parsed.text || st.emitted;
        if (
          finalText &&
          finalText.length > st.emitted.length &&
          finalText.startsWith(st.emitted)
        ) {
          onToken?.(finalText.slice(st.emitted.length));
        }
        return {
          ...parsed,
          text: finalText,
          mcpCalls: callsSoFar.map((c) => c.qualified),
          usage: lastUsage,
        };
      }
      const freshCalls = dropDuplicateAlarms(mcpCalls, callsSoFar);
      if (!freshCalls.length && step < MCP_MAX_STEPS) {
        console.log(
          `[mcp] step ${step + 1}: only duplicate alarm calls, nudging to reply`,
        );
        contents = [
          ...contents,
          { role: "model", parts: [{ text: accText }] },
          {
            role: "user",
            parts: [
              {
                text: toolResultMessage(
                  "alarms__alarm_create",
                  "The alarm is already set — do not call alarms__alarm_create again. Now reply to the user confirming the alarm.",
                  goal,
                ),
              },
            ],
          },
        ];
        continue;
      }
      contents = [...contents, { role: "model", parts: [{ text: accText }] }];
      for (const c of freshCalls) {
        console.log(`[mcp] step ${step + 1}: ${c.qualified}`);
        callsSoFar.push({ qualified: c.qualified, args: c.args });
        const output = await execMcpCall(c.qualified, c.args, signal);
        contents = [
          ...contents,
          {
            role: "user",
            parts: geminiToolResultParts(c.qualified, output, goal),
          },
        ];
      }
    }
    throw new Error("mcp loop exhausted");
  }

  private async chatNonStream(
    body: Record<string, unknown>,
    signal: AbortSignal,
    kinds: string[],
    onUsage?: (u: ProviderUsage) => void,
  ): Promise<ProviderResult> {
    const base = this.cfg.url.replace(/\/+$/, "").replace(/\/v1(beta)?$/, "");
    const url = `${base}/v1beta/models/${encodeURIComponent(this.cfg.model)}:generateContent?key=${encodeURIComponent(this.cfg.apiKey)}`;
    const res = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    await throwIfHttpError(res);
    const raw = await res.json();
    const um = raw?.usageMetadata;
    if (um && typeof um === "object" && Number.isFinite(Number(um.promptTokenCount))) {
      onUsage?.({
        inputTokens: Number(um.promptTokenCount),
        outputTokens: Number(um.candidatesTokenCount) || 0,
      });
    }
    const text = raw?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
    return { ...finalReplyResult(text, kinds), mcpCalls: [] };
  }

  /** Plain completion for history compaction (net/compact.ts): no tools, no
   *  structured response schema — just the text. */
  async complete(messages: ChatMessage[], signal: AbortSignal): Promise<string> {
    const base = this.cfg.url.replace(/\/+$/, "").replace(/\/v1(beta)?$/, "");
    // systemInstruction carries a leading system message (compaction sends
    // one); the rest map to user/model contents like chat() does.
    const hasSystem = messages[0]?.role === "system";
    const rest = hasSystem ? messages.slice(1) : messages;
    const body: Record<string, unknown> = {
      contents: rest.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: msgText(m) }],
      })),
    };
    if (hasSystem) {
      body.systemInstruction = {
        role: "system",
        parts: [{ text: msgText(messages[0]) }],
      };
    }
    const url = `${base}/v1beta/models/${encodeURIComponent(this.cfg.model)}:generateContent?key=${encodeURIComponent(this.cfg.apiKey)}`;
    const res = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`);
    }
    const raw = await res.json();
    const parts = raw?.candidates?.[0]?.content?.parts ?? [];
    return parts
      .filter((p: any) => typeof p?.text === "string")
      .map((p: any) => p.text)
      .join("");
  }
}
