import type {
  Provider,
  ProviderConfig,
  ProviderRequest,
  ProviderResult,
  McpNativeCall,
} from "../types";
import { fetchMcpTools, mcpSystemHint, toOpenAITools, execMcpCall } from "../tools";
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
  buildMessages,
  msgText,
  safeJsonParse,
  openAiAvatarTool,
  emitDiff,
  emitFinalText,
  finalAvatarResult,
} from "../avatar";
import { doFetch, canStream } from "../fetch";
import {
  readSse,
  extractPartialText,
  openAiDeltaState,
  applyOpenAiDelta,
  openAiToolCalls,
} from "../sse";
import { StructuredStream } from "../structured";

export class OpenAIProvider implements Provider {
  readonly kind = "openai" as const;
  constructor(private cfg: ProviderConfig) {}

  async chat({
    messages,
    signal,
    onToken,
    onThinking,
    onEmotion,
    onMotion,
  }: ProviderRequest): Promise<ProviderResult> {
    const base = this.cfg.url.replace(/\/+$/, "").replace(/\/v1$/, "");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.cfg.apiKey) headers.Authorization = `Bearer ${this.cfg.apiKey}`;

    // Gate: skip tool discovery entirely unless the message looks like
    // it needs a tool.
    const probeTools = await fetchMcpTools();
    const mcpArmed = shouldUseMcp(messages, probeTools);
    // ask_user is offered on every message so the model can clarify an
    // unclear instruction; MCP tools only join when the request looks
    // tool-needy. The nudge gate below stays keyed to mcpArmed, or every
    // casual message would get "keep working" nudges.
    const mcpTools = mcpArmed ? [...probeTools, askUserTool()] : [askUserTool()];
    if (!mcpArmed && probeTools.length)
      console.log("[mcp] idle for this message");
    const hint = mcpSystemHint(mcpTools);
    const openAITools = toOpenAITools(mcpTools);
    // Raw OpenAI message list (supports tool role); converted at the end.
    let convo: any[] = buildMessages(messages, this.cfg.persona).map((m) => ({
      role: m.role,
      content: msgText(m),
    }));
    if (hint) {
      convo[0] = { role: "system", content: `${msgText(convo[0])}${hint}` };
    }

    const goal = originalGoal(convo);
    const callsSoFar: Array<{ qualified: string; args: unknown }> = [];
    // Some OpenAI-compatible servers (older Ollama builds) reject
    // stream:true or stream+tools. Flip off once and reuse for the
    // rest of the conversation.
    let streamDisabled = false;
    // Servers that reject a forced tool_choice (some OpenAI-compatible
    // runtimes) still work if we just ask for the JSON shape in prose.
    let avatarToolDisabled = false;

    for (let step = 0; step <= MCP_MAX_STEPS; step++) {
      const lastStep = step === MCP_MAX_STEPS;
      const wantStream = !streamDisabled;
      const body: Record<string, unknown> = {
        model: this.cfg.model,
        messages: convo,
        stream: wantStream,
        // Final step: force the avatar reply shape so TTS/motion parse.
        // Earlier steps keep tools available for multi-step tasks.
        ...(lastStep && !avatarToolDisabled
          ? {
              tools: [openAiAvatarTool()],
              tool_choice: {
                type: "function",
                function: { name: "avatar_response" },
              },
            }
          : openAITools.length && !lastStep
            ? { tools: openAITools, tool_choice: "auto" }
            : {}),
      };

      const res = await doFetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        if (
          wantStream &&
          (res.status === 400 ||
            res.status === 404 ||
            res.status === 422 ||
            res.status === 501)
        ) {
          console.warn(
            `[llm] streaming rejected (HTTP ${res.status}), retrying non-stream`,
          );
          streamDisabled = true;
          step--;
          continue;
        }
        if (
          lastStep &&
          !avatarToolDisabled &&
          (res.status === 400 || res.status === 422)
        ) {
          console.warn(
            `[llm] forced avatar_response rejected (HTTP ${res.status}), retrying without tool_choice`,
          );
          avatarToolDisabled = true;
          step--;
          continue;
        }
        throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`);
      }

      const st = { emitted: "" };
      let content = "";
      let calls: McpNativeCall[] = [];
      // Survives past the streaming branch: the final reconcile needs whatever
      // motion/emotion already fired mid-stream.
      const tags = new StructuredStream();

      if (wantStream && canStream(res)) {
        const acc = openAiDeltaState();
        let seen = 0;
        let seenReasoning = 0;
        // Models that skip the avatar JSON shape reply in plain prose, where
        // extractPartialText never matches. Decide once on the first delta
        // and stream the raw text instead.
        let prose: boolean | null = null;
        await readSse(res, signal, (data) => {
          applyOpenAiDelta(acc, data);
          // Reasoning deltas carry no content, so they must be emitted
          // before the content early-return below.
          if (acc.reasoning.length > seenReasoning) {
            onThinking?.(acc.reasoning.slice(seenReasoning));
            seenReasoning = acc.reasoning.length;
          }
          if (acc.content.length === seen) return;
          const delta = acc.content.slice(seen);
          seen = acc.content.length;
          if (prose === null) prose = !acc.content.trimStart().startsWith("{");
          if (prose) {
            // Inline <<motion:x>> / <<emotion:x>> replies: fire the avatar as
            // soon as the tag resolves and keep the tags out of the speech.
            const r = tags.push(delta);
            if (r.emotion) onEmotion?.(r.emotion);
            if (r.motion && r.motion !== "none") onMotion?.(r.motion);
            // tags.push already returns only the new tail, so emit it as-is.
            // Feeding it to emitDiff would re-diff against st.emitted and
            // silently drop every delta after the first. Append instead to
            // keep st.emitted equal to the cumulative speakable text, which is
            // what emitFinalText's tail emit compares against.
            if (r.tokens) {
              onToken?.(r.tokens);
              st.emitted += r.tokens;
            }
          } else {
            emitDiff(extractPartialText(acc.content), st, onToken);
          }
        });
        if (!acc.frames) {
          // Server answered 200 with a plain JSON body instead of SSE.
          console.warn("[llm] no SSE frames from server, retrying non-stream");
          await res.body?.cancel().catch(() => {});
          streamDisabled = true;
          step--;
          continue;
        }
        content = acc.content;
        // Stream the tail too (plain-text replies never matched while
        // streaming, so nothing was emitted yet).
        emitFinalText(content, st, onToken);
        // avatar_response is our own final-turn carrier, never an MCP tool.
        calls = openAiToolCalls(acc)
          .filter((c) => !(lastStep && c.name === "avatar_response"))
          .map((c, i) => ({
            id: c.id || `${step}-${i}`,
            qualified: c.name,
            args: safeJsonParse(c.args || "{}"),
          }));
        // Forced tool call carries text/emotion/motion in its arguments, and
        // leaves content empty — promote it so the parser and TTS see it.
        if (lastStep && !content.trim()) {
          const avatar = openAiToolCalls(acc).find(
            (c) => c.name === "avatar_response",
          );
          if (avatar) {
            content = avatar.args;
            st.emitted = "";
            emitFinalText(content, st, onToken);
          }
        }
      } else {
        const raw = await res.json();
        const msg = raw?.choices?.[0]?.message;
        if (typeof msg?.reasoning_content === "string" && msg.reasoning_content)
          onThinking?.(msg.reasoning_content);
        else if (typeof msg?.reasoning === "string" && msg.reasoning)
          onThinking?.(msg.reasoning);
        content =
          typeof msg?.content === "string"
            ? msg.content
            : JSON.stringify(msg?.content ?? {});
        if (lastStep && !content.trim() && Array.isArray(msg?.tool_calls)) {
          const avatar = msg.tool_calls.find(
            (tc: any) => tc?.function?.name === "avatar_response",
          );
          if (avatar) {
            content = String(avatar?.function?.arguments ?? "");
            st.emitted = "";
          }
        }
        // Prose replies carry inline tags; resolve them here since there is no
        // delta callback to fire them from.
        if (!content.trimStart().startsWith("{")) {
          const r = tags.push(content);
          if (r.emotion) onEmotion?.(r.emotion);
          if (r.motion && r.motion !== "none") onMotion?.(r.motion);
        }
        emitFinalText(content, st, onToken);
        calls =
          !lastStep && Array.isArray(msg?.tool_calls)
            ? msg.tool_calls
                .filter(
                  (tc: any) =>
                    tc?.type === "function" &&
                    typeof tc?.function?.name === "string",
                )
                .map((tc: any) => ({
                  id: String(tc.id ?? `${step}-${Math.random()}`),
                  qualified: String(tc.function.name),
                  args: safeJsonParse(String(tc.function.arguments ?? "{}")),
                }))
            : [];
      }

      if (!calls.length) {
        // Model answered in text: try keyword fallback before giving up
        // (small local models often acknowledge tools but don't emit tool_calls).
        if (!lastStep && mcpArmed) {
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
            convo.push({ role: "assistant", content: content || null });
            convo.push({
              role: "user",
              content: toolResultMessage(fb.qualified, output, goal),
            });
            continue;
          }
          // Task still has unattempted steps but the model went silent:
          // don't accept a plain reply yet, nudge it to keep calling.
          if (!taskLooksComplete(goal, callsSoFar)) {
            console.log(
              `[mcp] step ${step + 1}: task incomplete, nudging for next tool`,
            );
            convo.push({ role: "assistant", content: content || null });
            convo.push({
              role: "user",
              content: `${toolResultMessage("none", "No tool was called.", goal)} Keep working: call the next MCP tool now.`,
            });
            continue;
          }
        }
        console.log(`[mcp] step ${step + 1}: no tool call, replying direct`);
        // Final avatar turn: text already streamed above for TTS/lipsync.
        // Content may be the avatar JSON shape or an inline-tag prose reply.
        return {
          ...finalAvatarResult(content, tags),
          mcpCalls: callsSoFar.map((c) => c.qualified),
        };
      }
      calls = dropDuplicateAlarms(calls, callsSoFar);
      if (!calls.length && !lastStep) {
        // Everything this step produced was a duplicate alarm create.
        // Tell the model the alarm already exists instead of looping.
        console.log(
          `[mcp] step ${step + 1}: only duplicate alarm calls, nudging to reply`,
        );
        convo.push({ role: "assistant", content: content || null });
        convo.push({
          role: "user",
          content: `${toolResultMessage("alarms__alarm_create", "The alarm is already set — do not call alarms__alarm_create again. Now reply to the user confirming the alarm.", goal)}`,
        });
        continue;
      }
      for (const c of calls) {
        console.log(`[mcp] step ${step + 1}: ${c.qualified}`);
        callsSoFar.push({ qualified: c.qualified, args: c.args });
      }
      convo.push({
        role: "assistant",
        content: content || null,
        tool_calls: calls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.qualified, arguments: JSON.stringify(c.args) },
        })),
      });
      for (const c of calls) {
        const output = await execMcpCall(c.qualified, c.args, signal);
        convo.push({
          role: "tool",
          tool_call_id: c.id,
          content: toolResultMessage(c.qualified, output, goal),
        });
      }
    }
    throw new Error("mcp loop exhausted");
  }
}
