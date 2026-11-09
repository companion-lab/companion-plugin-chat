// Port of the host's app/src/net/loop.ts (unchanged): the MCP tool loop
// helpers shared by all three providers, plus the lenient time/weekday value
// parsers the keyword fallback needs.

import type { ChatMessage } from "./protocol";
import type { McpWireTool } from "./types";

export const MCP_MAX_STEPS = Number.POSITIVE_INFINITY;

// Alarm tool schemas live in the backend builtin MCP server (mcp.rs); the
// model receives them through the normal listTools() flow. Only the
// lenient value parsers stay here, for the keyword fallback.
const WEEKDAY_WORDS: Record<string, number> = {
  everyday: 0x7f,
  daily: 0x7f,
  weekday: 0x1f,
  weekdays: 0x1f,
  workday: 0x1f,
  workdays: 0x1f,
  weekend: 0x60,
  weekends: 0x60,
  mon: 1 << 0,
  tue: 1 << 1,
  tues: 1 << 1,
  wed: 1 << 2,
  thu: 1 << 3,
  thur: 1 << 3,
  thurs: 1 << 3,
  fri: 1 << 4,
  sat: 1 << 5,
  sun: 1 << 6,
};

// Accepts ["Mon","Wed"], "weekday", "every day", "monday and friday".
function parseWeekdays(input: unknown): number {
  if (input == null) return 0;
  if (typeof input === "number" && Number.isFinite(input)) return input & 0x7f;
  const words: string[] = [];
  const collect = (v: unknown): void => {
    if (typeof v === "string") words.push(...v.toLowerCase().split(/[^a-z]+/));
    else if (Array.isArray(v)) v.forEach(collect);
  };
  collect(input);
  let mask = 0;
  for (const w of words) {
    const key = w.length > 3 ? w.slice(0, 3) : w;
    if (key in WEEKDAY_WORDS) mask |= WEEKDAY_WORDS[key];
  }
  return mask & 0x7f;
}

// "7am", "7:30", "19:05" -> {hour, minute}
function parseClock(input: unknown): { hour: number; minute: number } | null {
  if (typeof input === "number") return { hour: input, minute: 0 };
  if (typeof input !== "string") return null;
  const m = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(input.trim());
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const mer = m[3]?.toLowerCase();
  if (mer === "pm" && hour < 12) hour += 12;
  if (mer === "am" && hour === 12) hour = 0;
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return { hour: Math.min(23, hour), minute: Math.min(59, minute) };
}

// Pending-goal tracking: the original user request stays pinned in every
// tool-result message so small models don't lose the plot mid-loop.
export function originalGoal(
  convo: Array<{ role?: unknown; content?: unknown }>,
): string {
  for (const m of convo) {
    const r = m as { role?: string; content?: unknown };
    if (
      r?.role === "user" &&
      typeof r.content === "string" &&
      !String(r.content).startsWith("[tool ")
    ) {
      return String(r.content);
    }
  }
  return "";
}

export function toolResultMessage(
  qualified: string,
  output: string,
  goal: string,
): string {
  const pinned = goal
    ? `Original user goal (still pending until ALL steps done): ${goal}\n`
    : "";
  return `${pinned}[tool ${qualified} result]\n${output}\nDecide the NEXT tool call now, or reply with the final text/emotion/motion only if every requested action is complete.`;
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

// Unqualified tool name from a "{server}__{name}" qualified id. Tool
// matching is name-based so it works across server/plugin ids.
function toolName(qualified: string): string {
  const i = qualified.lastIndexOf("__");
  return i === -1 ? qualified : qualified.slice(i + 2);
}

// One shared alarm-intent test for every stage (arming, fallback,
// completion). "remind" matches via \w* so reminder/reminders/reminding all
// arm — a bare \bremind\b missed "set reminder at 10pm" and the request died
// with zero tools offered.
const ALARM_INTENT_RE =
  /\b(alarm|remind\w*|timer|wake\s*(me|up)?|countdown)\b/i;

// Dated happenings route to the calendar tools, not the daily alarms.
const CALENDAR_INTENT_RE =
  /\b(calendar|event|appointment|meeting|birthday|anniversary)\b/i;

// A task is only done when no credentials/actions from the request remain
// unattempted. Heuristic: email/password-like tokens in the goal that never
// appeared in any tool argument so far.
export function taskLooksComplete(
  goal: string,
  callsSoFar: Array<{ qualified: string; args: unknown }>,
): boolean {
  if (!goal) return true;
  // Alarm goal with no builtin__ call yet (or a browser call instead): not
  // done. Nudges the model to call the alarm tool rather than answering in
  // text or, worse, reaching for the browser.
  if (ALARM_INTENT_RE.test(goal)) {
    return callsSoFar.some((c) => toolName(c.qualified).startsWith("alarm"));
  }
  if (CALENDAR_INTENT_RE.test(goal)) {
    return callsSoFar.some((c) => toolName(c.qualified).startsWith("calendar"));
  }
  const tokens =
    goal.match(
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|localhost(?::\d+)?(?:\/\S*)?|https?:\/\/\S+/g,
    ) ?? [];
  if (!tokens.length) return true;
  const used = JSON.stringify(callsSoFar.map((c) => c.args ?? {}));
  return tokens.every((t) => used.includes(t));
}

// Canonical identity for an alarm_create call: same fire time = duplicate.
// Labels/messages are ignored — two creates for the same moment are never
// both wanted.
function alarmCreateKey(args: unknown): string | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const a = args as Record<string, unknown>;
  const rel = a.in_minutes ?? a.minutes ?? a.in;
  if (typeof rel === "number" && Number.isFinite(rel) && rel > 0) {
    return `alarm:+${rel}`;
  }
  let hour: unknown = a.hour;
  let minute: unknown = a.minute;
  if (hour == null || minute == null) {
    const clock = parseClock(
      typeof a.time === "string"
        ? a.time
        : typeof a.at === "string"
          ? a.at
          : "",
    );
    if (!clock) return null;
    hour = clock.hour;
    minute = clock.minute;
  }
  const h = Number(hour);
  const m = Number(minute);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  const mask = parseWeekdays(a.weekdays ?? a.days ?? a.repeat);
  return `alarm:${h}:${m}:${mask}`;
}

// Canonical identity for a calendar_create call: same title + date + time
// = duplicate. Covers the same N-identical-calls failure as alarms.
function calendarCreateKey(args: unknown): string | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const a = args as Record<string, unknown>;
  const date = typeof a.date === "string" ? a.date : typeof a.on === "string" ? a.on : null;
  if (!date) return null;
  const title = typeof a.title === "string" ? a.title.trim().toLowerCase() : "";
  const h = Number(a.hour ?? 0);
  const m = Number(a.minute ?? 0);
  return `calendar:${date}:${Number.isFinite(h) ? h : 0}:${Number.isFinite(m) ? m : 0}:${title}`;
}

// Drop alarm_create / calendar_create calls that duplicate an earlier call
// (same step or a previous step). The tool loop runs the fallback on EVERY
// text-only step, so without this one request spawns N identical alarms.
// Non-alarm tools pass through untouched — repeats can be legitimate there
// (e.g. snapshot). Exported for the self-test.
export function dropDuplicateAlarms<
  T extends { qualified: string; args: unknown },
>(calls: T[], callsSoFar: Array<{ qualified: string; args: unknown }>): T[] {
  const seen = new Set<string>();
  for (const c of callsSoFar) {
    const name = toolName(c.qualified);
    const k =
      name === "alarm_create"
        ? alarmCreateKey(c.args)
        : name === "calendar_create"
          ? calendarCreateKey(c.args)
          : null;
    if (k) seen.add(k);
  }
  return calls.filter((c) => {
    const name = toolName(c.qualified);
    const keyFn =
      name === "alarm_create"
        ? alarmCreateKey
        : name === "calendar_create"
          ? calendarCreateKey
          : null;
    if (!keyFn) return true;
    const k = keyFn(c.args);
    if (!k) return true; // unparseable: let it through rather than swallow
    if (seen.has(k)) {
      console.log(
        `[mcp] dropping duplicate alarm call ${JSON.stringify(c.args)}`,
      );
      return false;
    }
    seen.add(k);
    return true;
  });
}

// Fallback for models that acknowledge tools but answer in text anyway
// (common with small local models). Runs on EVERY step, not just step 0,
// and skips actions already attempted so the loop keeps moving forward.
// Exported for the self-test.
export function keywordFallback(
  userText: string,
  tools: McpWireTool[],
  callsSoFar: Array<{ qualified: string; args: unknown }>,
): { qualified: string; args: unknown } | null {
  const text = userText;
  const usedArgs = JSON.stringify(callsSoFar.map((c) => c.args ?? {}));
  const nav = tools.find((t) => t.name.toLowerCase().includes("navigat"));
  const fill = tools.find((t) => /fill|type|input|enter/i.test(t.name));
  const click = tools.find((t) => /click|press|submit/i.test(t.name));
  const snapshot = tools.find((t) => /snapshot|snapshot/i.test(t.name));

  // Alarm requests must never touch the browser: handle them before any
  // Playwright branch so a text-only answer still creates the alarm.
  const alarmCreate = tools.find((t) => toolName(t.qualified) === "alarm_create");
  if (alarmCreate && ALARM_INTENT_RE.test(text)) {
    // message is required upstream; fall back to the request text so the
    // avatar always has something to say.
    const message = text.trim().slice(0, 200) || "Alarm";
    const rel =
      /in\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)/i.exec(
        text,
      );
    if (rel) {
      let mins = parseFloat(rel[1]);
      if (/hour|hr/i.test(rel[2])) mins *= 60;
      else if (/sec/i.test(rel[2])) mins /= 60;
      if (Number.isFinite(mins) && mins > 0) {
        return { qualified: alarmCreate.qualified, args: { in_minutes: mins, message } };
      }
    }
    const clock = parseClock(text);
    if (clock) {
      const args: Record<string, unknown> = {
        hour: clock.hour,
        minute: clock.minute,
        weekdays: parseWeekdays(text),
        message,
      };
      const dayNames = DAY_NAMES.filter(
        (_, d) => (Number(args.weekdays) & (1 << d)) !== 0,
      );
      if (dayNames.length) args.weekdays = dayNames;
      else delete args.weekdays;
      if (/\bloop\b|keep ringing|until i stop/i.test(text))
        args.loop_sound = true;
      return { qualified: alarmCreate.qualified, args };
    }
  }

  // Perception intents route to the vision plugin's capture tools before the
  // browser branches, and only fire once per tool per turn: after a capture
  // the model should be describing what it saw, not capturing in a loop.
  // (Alarm requests above return first, so they can never be hijacked.)
  const attempted = new Set(callsSoFar.map((c) => c.qualified));
  const visionListen = tools.find((t) => toolName(t.qualified) === "listen");
  const visionCamera = tools.find((t) => toolName(t.qualified) === "capture_camera");
  const visionScreen = tools.find((t) => toolName(t.qualified) === "capture_screen");
  if (
    visionListen &&
    !attempted.has(visionListen.qualified) &&
    /\b(listen|hear|ambient|what('s| is)? that (sound|noise)|music|audio)\b/i.test(text)
  ) {
    const dur = /(\d{1,2})\s*(seconds?|secs?)\b/i.exec(text);
    return {
      qualified: visionListen.qualified,
      args: dur ? { seconds: Number(dur[1]) } : {},
    };
  }
  if (
    visionCamera &&
    !attempted.has(visionCamera.qualified) &&
    /\b(camera|webcam|look at me|what do you see|what do i look|take a (photo|picture|selfie))\b/i.test(text)
  ) {
    return { qualified: visionCamera.qualified, args: {} };
  }
  if (
    visionScreen &&
    !attempted.has(visionScreen.qualified) &&
    /\b(screenshot|screen capture|my screen|the screen|read my screen|check my screen)\b/i.test(text)
  ) {
    return { qualified: visionScreen.qualified, args: {} };
  }

  if (nav && /\b(open|navigate|browse|go to|localhost)\b/i.test(text)) {
    const m =
      /(https?:\/\/[^\s"'<>]+|localhost(?::\d+)?(?:\/[^\s"'<>]*)?)/i.exec(text);
    if (m && !usedArgs.includes("localhost") && !usedArgs.includes(m[1])) {
      let url = m[1];
      if (/^localhost/i.test(url)) url = `http://${url}`;
      return { qualified: nav.qualified, args: { url } };
    }
  }
  // Refresh page state before interacting — but only when the request is
  // actually about the browser. An unconditional snapshot here opened the
  // browser for unrelated tasks (e.g. alarm requests).
  const browserIntent =
    /\b(open|navigate|browse|localhost|https?:|login|log in|sign in|click|fill|form|snapshot|screenshot|page)\b/i.test(
      text,
    );
  if (
    browserIntent &&
    snapshot &&
    !callsSoFar.some((c) => c.qualified === snapshot.qualified)
  ) {
    return { qualified: snapshot.qualified, args: {} };
  }
  const email = /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/.exec(
    text,
  )?.[1];
  const pass = /(?:password\s*(?:is\s*)?[:=]?\s*)([^\s"'<>]+)/i.exec(text)?.[1];
  if (email && fill && !usedArgs.includes(email)) {
    return { qualified: fill.qualified, args: { text: email } };
  }
  if (pass && fill && !usedArgs.includes(pass)) {
    return { qualified: fill.qualified, args: { text: pass } };
  }
  if (
    click &&
    /\b(login|log in|sign in|submit)\b/i.test(text) &&
    !callsSoFar.some((c) => c.qualified === click.qualified)
  ) {
    return { qualified: click.qualified, args: {} };
  }
  return null;
}

export function lastUserText(
  convo: Array<{ role?: unknown; content?: unknown }>,
): string {
  // Original request text (skip [tool ...] result messages).
  const goal = originalGoal(convo);
  if (goal) return goal;
  for (let i = convo.length - 1; i >= 0; i--) {
    const m = convo[i] as { role?: string; content?: unknown };
    if (m?.role === "user" && typeof m.content === "string") return m.content;
  }
  return "";
}

// Always arm: every default/plugin tool (alarms, calendar, the MCP plugin's
// servers, …) is offered on every message, so the avatar always has its
// tools and a newly added/enabled plugin's tools join on the next turn.
// Small models are kept from over-calling on casual chat by the system
// hint's "reply directly when no tool is needed" guard instead of hiding
// tools behind a keyword match (the old MCP_ACTION_RE gate, which left the
// avatar tool-less for most messages). Exported for the self-test.
export function shouldUseMcp(
  _messages: ChatMessage[],
  tools: McpWireTool[],
): boolean {
  return tools.length > 0;
}
