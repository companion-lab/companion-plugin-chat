// Port of the host's app/src/net/tools.ts: MCP-style tool discovery and wire
// encoding — fetching the tool list from the plugin host, stripping schemas
// down to what function-calling tolerates, and turning them into each
// provider's tool declaration shape.
//
// Differences from the host:
// - @tauri-apps/api/core invoke is replaced by the vendored tauri bridge
//   (./tauri.ts) — plugin bundles cannot resolve @tauri-apps packages.
// - The frontend tool registry (app/src/plugins/registry.ts) is reached
//   through the `__companion_host__.tools.get()` host-bridge global instead
//   of a direct import: this bundle runs as a blob module and cannot import
//   host modules. Absent outside the main window (and in non-Tauri runs),
//   where frontend-registered tools simply don't exist.
// - The chat-owned ask_user tool stays local (see ./ask-user.ts): the
//   providers append it to every turn's tool list and execMcpCall intercepts
//   it before any backend call.

import { tauriInvoke } from "../tauri";
import type { McpWireTool } from "./types";
import { ASK_USER_QUALIFIED, execAskUser } from "./ask-user";

/** Mirror of the Rust `PluginToolInfo` (camelCase over IPC). */
export type PluginToolInfo = {
  pluginId: string;
  name: string;
  description: string;
  inputSchema: unknown;
};

/** Shape of a frontend-registered tool (sdk `ToolContribution`). */
type FrontendTool = {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  execute: (args: unknown, signal?: AbortSignal) => Promise<string> | string;
};

/** Frontend tools from the host registry, keyed by qualified name. Empty
 * when the host bridge hasn't published a registry (non-main windows). */
function frontendTools(): Map<string, FrontendTool> {
  const get = globalThis.__companion_host__?.tools?.get;
  return get ? get() : new Map();
}

export async function fetchMcpTools(): Promise<McpWireTool[]> {
  // Every tool arrives through the plugin paths: frontend-registered tools
  // from the registry, each plugin's Rust backend tools via
  // `plugin_list_tools` (the MCP plugin re-publishes its servers' tools as
  // backend tools named `{server}__{tool}`, so they qualify as
  // `mcp__{server}__{tool}`), and chat's own ask_user appended by the
  // providers.
  return fetchPluginTools();
}

async function fetchPluginTools(): Promise<McpWireTool[]> {
  const out: McpWireTool[] = [];
  // Frontend-executed tools registered through ctx.tools.register.
  for (const [qualified, tool] of frontendTools()) {
    const serverId = qualified.slice(0, qualified.indexOf("__"));
    out.push({
      server_id: serverId,
      name: tool.name,
      qualified,
      description: tool.description,
      schema: sanitizeJsonSchema(tool.inputSchema ?? { type: "object" }),
    });
  }
  // Backend tools declared by Rust plugin dylibs.
  try {
    const infos = await tauriInvoke<PluginToolInfo[]>("plugin_list_tools");
    for (const t of infos) {
      const qualified = `${t.pluginId}__${t.name}`;
      // A plugin offering the same name front and back: the frontend
      // registration wins (execMcpCall routes it there first).
      if (out.some((x) => x.qualified === qualified)) continue;
      out.push({
        server_id: t.pluginId,
        name: t.name,
        qualified,
        description: t.description || `${t.name} (via plugin ${t.pluginId})`,
        schema: sanitizeJsonSchema(t.inputSchema),
      });
    }
  } catch {
    // Plugin host unavailable (non-Tauri run) — plugin tools simply absent.
  }
  if (out.length) {
    console.log(
      `[plugins] tools: ${out.length} (${out.map((t) => t.qualified).join(", ")})`,
    );
  }
  return out;
}

// Ollama / small local models choke on exotic JSON-schema keywords
// (e.g. $schema, format, nested additionalProperties from Playwright).
// Keep only the subset function-calling needs.
function sanitizeJsonSchema(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return { type: "object" };
  const out: Record<string, unknown> = { type: "object" };
  const src = input as Record<string, unknown>;
  if (typeof src.description === "string")
    out.description = src.description.slice(0, 500);
  if (
    src.properties &&
    typeof src.properties === "object" &&
    !Array.isArray(src.properties)
  ) {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(
      src.properties as Record<string, unknown>,
    )) {
      props[k] = sanitizeProp(v);
    }
    out.properties = props;
  }
  if (Array.isArray(src.required))
    out.required = src.required.filter((r) => typeof r === "string");
  return out;
}

function sanitizeProp(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const src = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof src.type === "string") out.type = src.type;
  if (typeof src.description === "string")
    out.description = src.description.slice(0, 500);
  if (Array.isArray(src.enum)) out.enum = src.enum.slice(0, 50);
  if (
    src.properties &&
    typeof src.properties === "object" &&
    !Array.isArray(src.properties)
  ) {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(
      src.properties as Record<string, unknown>,
    )) {
      props[k] = sanitizeProp(v);
    }
    out.properties = props;
  }
  if (Array.isArray(src.required))
    out.required = src.required.filter((r) => typeof r === "string");
  if (src.items && typeof src.items === "object")
    out.items = sanitizeProp(src.items);
  return out;
}

export function mcpSystemHint(tools: McpWireTool[]): string {
  if (!tools.length) return "";
  // Ask-only turns (request didn't look tool-needy, so no MCP tools were
  // armed) get a short hint: the full multi-step preamble would push small
  // models toward tool calls on ordinary chat.
  if (tools.length === 1 && tools[0].qualified === ASK_USER_QUALIFIED) {
    const now = new Date();
    return `\n\nCurrent local time: ${now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}, ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")} (24h).\nIf the user's request is unclear or is missing a detail you would need (a time, a date, which item, what text, etc.), call builtin__ask_user with {"question": "..."} and optionally 2-4 short "options" choices, then use the answer from the tool result. If the request is clear, do NOT call any tool and reply normally with text/emotion/motion.`;
  }
  const lines = tools.map((t) => `- ${t.qualified}: ${t.description}`);
  const nav = tools.find((t) => t.name.toLowerCase().includes("navigat"));
  const navExample = nav
    ? `\nExample multi-step task: user says "open localhost:3000 and login with email X password Y" -> step 1: call ${nav.qualified} with {"url": "http://localhost:3000"}. Step 2: inspect the page, then call the fill/click tools for the email field, password field, and login button.`
    : "";
  // Symmetric priming: alarm requests must reach the local tools, never the
  // browser. Without this the only worked example points at Playwright.
  const alarmExample = tools.some(
    (t) => t.qualified === "alarms__alarm_create",
  )
    ? `\nExample alarm task: user says "wake me at 7am" -> call alarms__alarm_create with {"hour": 7, "minute": 0}. User says "remind me in 10 minutes" -> call alarms__alarm_create with {"in_minutes": 10}. User says "move my 7am alarm to 8am" -> call alarms__alarm_list, then alarms__alarm_update with {"id": "<id from the list>", "hour": 8}. Alarm and timer requests NEVER use browser tools (no navigate, snapshot, or screenshot).`
    : "";
  const calendarExample = tools.some(
    (t) => t.qualified === "calendar__calendar_create",
  )
    ? `\nExample calendar task: user says "dentist appointment next Friday at 3pm" -> call calendar__calendar_create with {"title": "Dentist appointment", "date": "next Friday", "hour": 15, "minute": 0}. User says "what's on Friday?" -> call calendar__calendar_list. Dated events and birthdays NEVER use the alarm tools — alarms are for daily times, calendar is for specific dates.`
    : "";
  const askExample = tools.some((t) => t.qualified === ASK_USER_QUALIFIED)
    ? `\nClarifying questions: if the request is ambiguous or missing required information (no time, no date, unclear which item), call builtin__ask_user with {"question": "...", "options": ["..."]} (options optional) instead of guessing. Ask ONE question, read the answer from the tool result, then continue. NEVER call ask_user when the request is already clear.`
    : "";
  // Models have no clock of their own: "in a bit", "tonight", and 12-hour
  // times all depend on the current moment. Stamp it into every system hint.
  const now = new Date();
  const timeLine = `\nCurrent local time: ${now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}, ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")} (24h). Use it to resolve relative requests ("in 10 minutes", "tonight") into concrete times.`;
  return `\n\nYou have MCP tools available via native function calls (tool_choice auto). Tool use is optional: for ordinary conversation that needs no action (greetings, feelings, general questions), reply directly and call no tool. Work step by step: call ONE tool, read its result, then call the NEXT tool the task needs. NEVER stop after the first tool if the user's request has more steps (e.g. open page THEN fill form THEN submit). Only reply with the final text/emotion/motion once every requested action is done. Do not describe actions in text instead of calling tools. Do not reveal passwords or secrets in your reply text.${timeLine}${navExample}${alarmExample}${calendarExample}${askExample}\nAvailable:\n${lines.join("\n")}\nAfter each tool result, either call the next needed tool or reply normally with text/emotion/motion.`;
}

export function toOpenAITools(tools: McpWireTool[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.qualified,
      description: t.description.slice(0, 1024),
      parameters: t.schema,
    },
  }));
}

export function toAnthropicTools(tools: McpWireTool[]): Record<string, unknown>[] {
  return tools.map((t) => ({
    name: t.qualified,
    description: t.description.slice(0, 1024),
    input_schema: t.schema,
  }));
}

export function toGeminiDeclarations(tools: McpWireTool[]): unknown[] {
  return tools.map((t) => ({
    name: t.qualified,
    description: t.description.slice(0, 1024),
    parameters: t.schema,
  }));
}

export async function execMcpCall(
  tool: string,
  args: unknown,
  signal?: AbortSignal,
): Promise<string> {
  // ask_user never reaches a backend: it asks the user in the webview
  // and their answer becomes the tool result.
  if (tool === ASK_USER_QUALIFIED) return execAskUser(args, signal);
  const split = pluginQualified(tool);
  if (!split) return `unknown tool "${tool}"`;
  return execPluginTool(tool, split.serverId, split.tool, args, signal);
}

/** Split "{pluginId}__{name}" (plugin ids never contain "__"). */
function pluginQualified(tool: string): { serverId: string; tool: string } | null {
  const i = tool.indexOf("__");
  if (i <= 0) return null;
  return { serverId: tool.slice(0, i), tool: tool.slice(i + 2) };
}

async function execPluginTool(
  qualified: string,
  pluginId: string,
  name: string,
  args: unknown,
  signal?: AbortSignal,
): Promise<string> {
  // Frontend-registered tool (ctx.tools.register): runs in this webview.
  const frontend = frontendTools().get(qualified);
  if (frontend) {
    try {
      return String(await frontend.execute(args, signal));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[plugins] ${qualified} failed: ${msg}`);
      return `error: ${msg}`;
    }
  }
  // Backend convention (see PLUGINS.md): handle("tool", {"name", "args"}).
  try {
    const result = await tauriInvoke<unknown>("plugin_call", {
      plugin_id: pluginId,
      method: "tool",
      payload: { name, args: args ?? {} },
    });
    console.log(`[plugins] ${qualified} -> ok`);
    return typeof result === "string" ? result : JSON.stringify(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[plugins] ${qualified} failed: ${msg}`);
    return `error: ${msg}`;
  }
}
