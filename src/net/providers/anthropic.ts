import type {
  Provider,
  ProviderConfig,
  ProviderRequest,
  ProviderResult,
  McpNativeCall,
} from "../types";
import {
  fetchMcpTools,
  mcpSystemHint,
  toAnthropicTools,
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
  lastUserText,
} from "../loop";
import {
  buildStructuredSchema,
  buildMessages,
  msgText,
  emitDiff,
  emitFinalText,
  finalAvatarResult,
} from "../avatar";
import { doFetch, canStream, throwIfHttpError } from "../fetch";
import { anthropicToolResultBlocks } from "../media-parts";
import { readSse, extractPartialText } from "../sse";

export class AnthropicProvider implements Provider {
  readonly kind = "anthropic" as const;
  constructor(private cfg: ProviderConfig) {}

  async chat({
    messages,
    signal,
    memoryContext,
    onToken,
    onThinking,
  }: ProviderRequest): Promise<ProviderResult> {
    const base = this.cfg.url.replace(/\/+$/, "").replace(/\/v1$/, "");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (this.cfg.apiKey) headers["x-api-key"] = this.cfg.apiKey;

    const probeTools = await fetchMcpTools();
    const mcpArmed = shouldUseMcp(messages, probeTools);
    // ask_user rides along on every message so unclear instructions can be
    // clarified; the nudge gate below stays keyed to mcpArmed so casual
    // chat never gets "keep working" nudges.
    const mcpTools = mcpArmed ? [...probeTools, askUserTool()] : [askUserTool()];
    if (!mcpArmed && probeTools.length)
      console.log("[mcp] idle for this message");
    const hint = mcpSystemHint(mcpTools);
    const anthropicTools: Record<string, unknown>[] = [
      {
        name: "avatar_response",
        description: "Emit a structured avatar reply.",
        input_schema: buildStructuredSchema(),
      },
      ...toAnthropicTools(mcpTools),
    ];
    const built0 = buildMessages(messages, this.cfg.persona, memoryContext);
    const sysBase = msgText(built0[0]);
    const convo: any[] = built0
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: msgText(m) }));
    const goal = originalGoal(convo);
    const callsSoFar: Array<{ qualified: string; args: unknown }> = [];

    for (let step = 0; step <= MCP_MAX_STEPS; step++) {
      const body = {
        model: this.cfg.model,
        max_tokens: 1024,
        ...(typeof sysBase === "string"
          ? { system: step === 0 && hint ? `${sysBase}${hint}` : sysBase }
          : {}),
        messages: convo,
        stream: true,
        tools: anthropicTools,
        tool_choice:
          step === MCP_MAX_STEPS
            ? { type: "tool", name: "avatar_response" }
            : { type: "auto" },
      };

      const res = await doFetch(`${base}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
      await throwIfHttpError(res);
      if (!canStream(res)) return this.chatNonStream(body, headers, signal);
      type Block = {
        kind: "avatar" | "mcp" | "text" | "thinking";
        id: string;
        name: string;
        json: string;
        text: string;
      };
      const blocks = new Map<number, Block>();
      const st = { emitted: "" };
      await readSse(res, signal, (data) => {
        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          return;
        }
        if (chunk?.type === "content_block_start") {
          const cb = chunk.content_block ?? {};
          const kind: Block["kind"] =
            cb.type === "tool_use"
              ? cb.name === "avatar_response"
                ? "avatar"
                : "mcp"
              : cb.type === "thinking"
                ? "thinking"
                : "text";
          blocks.set(chunk.index, {
            kind,
            id: String(cb.id ?? ""),
            name: String(cb.name ?? ""),
            json: "",
            text: "",
          });
        } else if (chunk?.type === "content_block_delta") {
          const b = blocks.get(chunk.index);
          if (!b) return;
          const d = chunk.delta;
          if (
            d?.type === "input_json_delta" &&
            typeof d.partial_json === "string"
          ) {
            b.json += d.partial_json;
            if (b.kind === "avatar")
              emitDiff(extractPartialText(b.json), st, onToken);
          } else if (d?.type === "thinking_delta" && typeof d.thinking === "string") {
            b.text += d.thinking;
            if (b.kind === "thinking") onThinking?.(d.thinking);
          } else if (d?.type === "text_delta" && typeof d.text === "string") {
            b.text += d.text;
            if (b.kind === "text") emitDiff(b.text, st, onToken);
          }
        }
      });
      const ordered = [...blocks.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, b]) => b);
      const mcpCalls: McpNativeCall[] = [];
      let avatarJson = "";
      for (const b of ordered) {
        if (b.kind === "mcp" && b.name) {
          let args: unknown = {};
          try {
            args = b.json ? JSON.parse(b.json) : {};
          } catch {
            args = {};
          }
          mcpCalls.push({
            id: b.id || `${step}-${b.name}`,
            qualified: b.name,
            args,
          });
        } else if (b.kind === "avatar") {
          avatarJson = b.json;
        }
      }
      // Stream any remaining avatar text (falls back to plain text
      // when the model skips the avatar JSON shape so TTS still speaks).
      emitFinalText(avatarJson, st, onToken);
      const avatarText =
        extractPartialText(avatarJson) ||
        (() => {
          try {
            return finalAvatarResult(avatarJson || "{}").text;
          } catch {
            return "";
          }
        })();
      if (!mcpCalls.length || step === MCP_MAX_STEPS) {
        if (!mcpCalls.length && step < MCP_MAX_STEPS && mcpArmed) {
          const fbRaw = keywordFallback(
            lastUserText(convo),
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
            convo.push({
              role: "assistant",
              content: avatarText || avatarJson,
            });
            convo.push({
              role: "user",
              content: anthropicToolResultBlocks(fb.qualified, output, goal),
            });
            continue;
          }
          if (!taskLooksComplete(goal, callsSoFar)) {
            console.log(
              `[mcp] step ${step + 1}: task incomplete, nudging for next tool`,
            );
            convo.push({
              role: "assistant",
              content: avatarText || avatarJson,
            });
            convo.push({
              role: "user",
              content: `${toolResultMessage("none", "No tool was called.", goal)} Keep working: call the next MCP tool now.`,
            });
            continue;
          }
        }
        console.log(`[mcp] step ${step + 1}: no tool call, replying direct`);
        const parsed = finalAvatarResult(avatarJson || "{}");
        const finalText = parsed.text || avatarText;
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
        };
      }
      const freshIds = new Set(
        dropDuplicateAlarms(mcpCalls, callsSoFar).map((c) => c.id),
      );
      if (!freshIds.size && step < MCP_MAX_STEPS) {
        console.log(
          `[mcp] step ${step + 1}: only duplicate alarm calls, nudging to reply`,
        );
        convo.push({ role: "assistant", content: avatarText || avatarJson });
        convo.push({
          role: "user",
          content: [
            {
              type: "text",
              text: toolResultMessage(
                "alarms__alarm_create",
                "The alarm is already set — do not call alarms__alarm_create again. Now reply to the user confirming the alarm.",
                goal,
              ),
            },
          ],
        });
        continue;
      }
      const assistantContent: any[] = [];
      for (const b of ordered) {
        if (b.kind === "text" && b.text)
          assistantContent.push({ type: "text", text: b.text });
        else if (b.kind === "avatar" && b.json) {
          let input: unknown = {};
          try {
            input = JSON.parse(b.json);
          } catch {
            input = {};
          }
          assistantContent.push({
            type: "tool_use",
            id: b.id,
            name: "avatar_response",
            input,
          });
        } else if (b.kind === "mcp" && freshIds.has(b.id)) {
          let input: unknown = {};
          try {
            input = b.json ? JSON.parse(b.json) : {};
          } catch {
            input = {};
          }
          assistantContent.push({
            type: "tool_use",
            id: b.id,
            name: b.name,
            input,
          });
        }
      }
      const freshCalls = mcpCalls.filter((c) => freshIds.has(c.id));
      convo.push({ role: "assistant", content: assistantContent });
      const results: any[] = [];
      for (const c of freshCalls) {
        console.log(`[mcp] step ${step + 1}: ${c.qualified}`);
        callsSoFar.push({ qualified: c.qualified, args: c.args });
        const output = await execMcpCall(c.qualified, c.args, signal);
        results.push({
          type: "tool_result",
          tool_use_id: c.id,
          content: anthropicToolResultBlocks(c.qualified, output, goal),
        });
      }
      convo.push({ role: "user", content: results });
    }
    throw new Error("mcp loop exhausted");
  }

  private async chatNonStream(
    body: Record<string, unknown>,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<ProviderResult> {
    const base = this.cfg.url.replace(/\/+$/, "").replace(/\/v1$/, "");
    const norm = {
      ...body,
      stream: false,
      tool_choice: { type: "tool", name: "avatar_response" },
    };
    const res = await doFetch(`${base}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(norm),
      signal,
    });
    await throwIfHttpError(res);
    const raw = await res.json();
    const avatar = raw?.content?.find(
      (b: any) => b.type === "tool_use" && b.name === "avatar_response",
    );
    const json = avatar?.input ?? "{}";
    return finalAvatarResult(
      typeof json === "string" ? json : JSON.stringify(json),
    );
  }
}
