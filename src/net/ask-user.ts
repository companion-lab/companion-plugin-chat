// Port of the host's app/src/net/ask-user.ts (unchanged): the chat-owned
// clarifying-question tool. The question surfaces as a card in the chat
// panel; the user's answer comes back as the tool result and the loop
// continues. It never crosses the plugin wire — execMcpCall() intercepts it
// before any backend call.

import type { McpWireTool } from "./types";

export const ASK_USER_QUALIFIED = "builtin__ask_user";

export type AskUserRequest = { question: string; options?: string[] };
export type AskUserHandler = (req: AskUserRequest) => Promise<string>;

let handler: AskUserHandler | null = null;

export function setAskUserHandler(h: AskUserHandler): void {
  handler = h;
}

// Only clears when the panel that registered it is the one unmounting, so a
// late unregister can't drop a handler a newer surface installed.
export function clearAskUserHandler(h: AskUserHandler): void {
  if (handler === h) handler = null;
}

export function askUserTool(): McpWireTool {
  return {
    server_id: "builtin",
    name: "ask_user",
    qualified: ASK_USER_QUALIFIED,
    description:
      "Ask the user a clarifying question when their request is ambiguous or missing details you need (e.g. no time given for an alarm, unclear which item or page they mean). Pass a short natural question and optionally 2-4 answer choices. Use it ONLY for genuinely unclear requests: never invent required details like times, dates, names or URLs, and never ask when the request is already clear.",
    schema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The clarifying question, one short sentence",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description: "Optional 2-4 short answer choices to offer as buttons",
        },
      },
      required: ["question"],
    },
  };
}

function questionFrom(args: unknown): AskUserRequest | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const a = args as Record<string, unknown>;
  if (typeof a.question !== "string" || !a.question.trim()) return null;
  const options = Array.isArray(a.options)
    ? a.options
        .filter((o): o is string => typeof o === "string" && !!o.trim())
        .slice(0, 4)
    : undefined;
  return {
    question: a.question.trim().slice(0, 500),
    options: options?.length ? options : undefined,
  };
}

// Backstop in case the registered handler never settles (its own shorter
// timeout normally dismisses the question first).
const HANDLER_BACKSTOP_MS = 300_000;

// Tool-result text for the loop: either the user's answer or an instruction
// to move on without re-asking. An empty handler result (skip, timeout,
// cancel) maps to the no-answer wording.
export async function execAskUser(
  args: unknown,
  signal?: AbortSignal,
): Promise<string> {
  const req = questionFrom(args);
  if (!req) return 'error: ask_user needs a non-empty "question" string';
  const h = handler;
  if (!h) return "error: ask_user is unavailable right now; decide with what you know";
  const answer = await new Promise<string>((resolve) => {
    let settled = false;
    const done = (v: string) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    if (signal?.aborted) {
      done("");
      return;
    }
    const onAbort = () => done("");
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => done(""), HANDLER_BACKSTOP_MS);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    h(req).then(
      (v) => {
        cleanup();
        done(typeof v === "string" ? v : "");
      },
      () => {
        cleanup();
        done("");
      },
    );
  });
  const text = answer.trim();
  if (!text) {
    return "The user did not answer (skipped, timed out, or the request was cancelled). Do not call ask_user again for this task; continue with a reasonable assumption or say what information is missing in your final reply.";
  }
  return `The user answered: "${text.slice(0, 500)}"`;
}
