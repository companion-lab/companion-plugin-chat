import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dropDuplicateAlarms, keywordFallback } from "./loop";
import type { McpWireTool } from "./types";

// parseClock / parseWeekdays are private in loop.ts; the tests reach them
// through their exported entry points: the keyword fallback's alarm branch
// (clock + weekday words → args) and the alarm dedupe keys (canonical
// hour/minute/mask strings, which expose the parsers' normalization).

const alarm: McpWireTool = {
  server_id: "builtin",
  name: "alarm_create",
  qualified: "builtin__alarm_create",
  description: "create an alarm",
  schema: {},
};

function alarmArgs(text: string): Record<string, unknown> {
  const call = keywordFallback(text, [alarm], []);
  if (!call) throw new Error(`expected an alarm call for ${JSON.stringify(text)}`);
  return call.args as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("clock parsing (via the alarm keyword fallback)", () => {
  it("parses 12-hour times with am", () => {
    expect(alarmArgs("set an alarm at 7am")).toEqual({
      hour: 7,
      minute: 0,
      message: "set an alarm at 7am",
    });
  });

  it("parses zero-padded 24-hour times", () => {
    expect(alarmArgs("remind me at 07:30")).toMatchObject({ hour: 7, minute: 30 });
    expect(alarmArgs("set alarm for 19:05")).toMatchObject({ hour: 19, minute: 5 });
  });

  it("shifts pm into 24-hour time", () => {
    expect(alarmArgs("wake me up at 7:30pm")).toMatchObject({ hour: 19, minute: 30 });
    expect(alarmArgs("set an alarm at 11pm")).toMatchObject({ hour: 23, minute: 0 });
  });

  it("maps 12am/12pm to midnight/noon, not 0/24 off by one", () => {
    expect(alarmArgs("alarm at 12am")).toMatchObject({ hour: 0, minute: 0 });
    expect(alarmArgs("alarm at 12pm")).toMatchObject({ hour: 12, minute: 0 });
  });

  it("clamps out-of-range components instead of rejecting", () => {
    // The regex grabs the first number pair it can find; anything over 23/59
    // is clamped so an alarm still lands somewhere valid.
    expect(alarmArgs("set alarm at 99:99")).toMatchObject({ hour: 23, minute: 59 });
    expect(alarmArgs("set alarm at 32:00")).toMatchObject({ hour: 23, minute: 0 });
  });

  it("parses relative durations into in_minutes", () => {
    expect(alarmArgs("set a timer in 5 minutes")).toEqual({
      in_minutes: 5,
      message: "set a timer in 5 minutes",
    });
    expect(alarmArgs("start a timer in 90 seconds")).toMatchObject({ in_minutes: 1.5 });
    expect(alarmArgs("set a timer in 2 hours")).toMatchObject({ in_minutes: 120 });
  });

  it("arms the looping sound only on loop-y requests", () => {
    expect(alarmArgs("set alarm at 7am and keep ringing")).toMatchObject({
      loop_sound: true,
    });
    expect(alarmArgs("set alarm at 7am to loop until i stop")).toMatchObject({
      loop_sound: true,
    });
    expect(alarmArgs("set alarm at 7am")).not.toHaveProperty("loop_sound");
  });

  it("truncates the message fallback at 200 chars", () => {
    const text = "alarm at 7am " + "x".repeat(300);
    const args = alarmArgs(text);
    expect(args.message).toBe(text.trim().slice(0, 200));
    expect((args.message as string).length).toBe(200);
  });
});

describe("weekday-word parsing (via the alarm keyword fallback)", () => {
  it("maps full and short day names to their day list", () => {
    expect(alarmArgs("set an alarm at 7am on monday").weekdays).toEqual(["Mon"]);
    expect(alarmArgs("set an alarm at 7am on tuesday").weekdays).toEqual(["Tue"]);
    expect(alarmArgs("set an alarm at 7am on wednesday").weekdays).toEqual(["Wed"]);
    expect(alarmArgs("set an alarm at 7am on thursday").weekdays).toEqual(["Thu"]);
    expect(alarmArgs("set an alarm at 7am on friday").weekdays).toEqual(["Fri"]);
    expect(alarmArgs("set an alarm at 7am on saturday").weekdays).toEqual(["Sat"]);
    expect(alarmArgs("set an alarm at 7am on sunday").weekdays).toEqual(["Sun"]);
    // Matching is on the lowercased text.
    expect(alarmArgs("set an alarm at 7am on MONDAY").weekdays).toEqual(["Mon"]);
  });

  it("unions multiple days in Monday-first order", () => {
    expect(alarmArgs("set an alarm at 7am on mondays and fridays").weekdays).toEqual([
      "Mon",
      "Fri",
    ]);
    expect(
      alarmArgs("set an alarm at 7am mon tues wed thu fri sat sun").weekdays,
    ).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  });

  it("drops the weekdays key when no day word matches", () => {
    // Only the 3-letter prefix of each word is looked up, so long generic
    // words ("everyday", "daily", "weekday", "weekend") truncate to prefixes
    // that are not in the table and match nothing — the key is removed so
    // the backend applies its own default rather than a never-mask.
    expect(alarmArgs("set an alarm at 7am everyday")).toEqual({
      hour: 7,
      minute: 0,
      message: "set an alarm at 7am everyday",
    });
    expect(alarmArgs("alarm at 7am on the weekend")).not.toHaveProperty("weekdays");
    expect(alarmArgs("alarm at 7am on workdays")).not.toHaveProperty("weekdays");
  });

  it("routes alarm requests before any vision/browser branch", () => {
    // The alarm branch returns before the capture branches, so a mixed
    // request can never be hijacked into a screenshot.
    const capture: McpWireTool = {
      server_id: "vision",
      name: "capture_screen",
      qualified: "vision__capture_screen",
      description: "capture the screen",
      schema: {},
    };
    const call = keywordFallback(
      "screenshot the screen and then set an alarm at 7am",
      [alarm, capture],
      [],
    );
    expect(call?.qualified).toBe("builtin__alarm_create");
    expect(call?.args).toMatchObject({ hour: 7 });
  });
});

describe("alarm/calendar dedupe (canonical keys via the parsers)", () => {
  beforeEach(() => {
    // Dropping a duplicate logs the call; keep test output clean.
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  const alarmCall = (args: unknown) => ({
    qualified: "builtin__alarm_create",
    args,
  });

  it("passes non-alarm tools through untouched (repeats can be legit)", () => {
    const calls = [
      { qualified: "mcp__browser__snapshot", args: {} },
      { qualified: "mcp__browser__snapshot", args: {} },
    ];
    expect(dropDuplicateAlarms(calls, [])).toHaveLength(2);
  });

  it("drops an alarm identical to an earlier step's call", () => {
    const calls = [alarmCall({ in_minutes: 30, message: "again" })];
    expect(dropDuplicateAlarms(calls, [alarmCall({ in_minutes: 30 })])).toEqual([]);
    expect(dropDuplicateAlarms(calls, [alarmCall({ in_minutes: 31 })])).toEqual(calls);
  });

  it("canonicalizes clock spellings: 7:00 == 07:00 == 7am", () => {
    const calls = [alarmCall({ hour: 7, minute: 0 })];
    expect(dropDuplicateAlarms([alarmCall({ time: "07:00" })], calls)).toEqual([]);
    expect(dropDuplicateAlarms([alarmCall({ at: "7:00" })], calls)).toEqual([]);
    expect(dropDuplicateAlarms([alarmCall({ hour: 7, minute: 5 })], calls)).toEqual([
      alarmCall({ hour: 7, minute: 5 }),
    ]);
  });

  it("canonicalizes weekday masks across numbers and day-name arrays", () => {
    // 96 = 0b1100000 = Sat|Sun, whether given as a raw mask or as names;
    // masks are clamped to 7 bits (200 & 0x7f == 72). A call still needs a
    // fire time — day names alone are unparseable and pass through.
    const calls = [alarmCall({ hour: 7, minute: 0, weekdays: 96 })];
    expect(
      dropDuplicateAlarms([alarmCall({ time: "7:00", days: ["sat", "sun"] })], calls),
    ).toEqual([]);
    expect(
      dropDuplicateAlarms([alarmCall({ hour: 7, minute: 0, repeat: 200 })], calls),
    ).toEqual([alarmCall({ hour: 7, minute: 0, repeat: 200 })]);
    expect(
      dropDuplicateAlarms(
        [alarmCall({ hour: 7, minute: 0, weekdays: 200 })],
        [alarmCall({ hour: 7, minute: 0, repeat: 72 })],
      ),
    ).toEqual([]);
  });

  it("lets unparseable alarm args through rather than swallowing them", () => {
    const calls = [alarmCall({})];
    expect(dropDuplicateAlarms(calls, [])).toEqual(calls);
    expect(dropDuplicateAlarms([alarmCall({ hour: 7 })], [])).toEqual([
      alarmCall({ hour: 7 }),
    ]);
  });

  it("dedupes calendar creates by date+time+normalized title", () => {
    const seen = [
      { qualified: "x__calendar_create", args: { title: " Standup ", date: "2026-01-05", hour: 9 } },
    ];
    expect(
      dropDuplicateAlarms(
        [{ qualified: "x__calendar_create", args: { title: "standup", date: "2026-01-05", hour: 9 } }],
        seen,
      ),
    ).toEqual([]);
    expect(
      dropDuplicateAlarms(
        [{ qualified: "x__calendar_create", args: { title: "standup", date: "2026-01-06", hour: 9 } }],
        seen,
      ),
    ).toHaveLength(1);
    // No date → no key → passes through.
    expect(
      dropDuplicateAlarms(
        [{ qualified: "x__calendar_create", args: { title: "standup" } }],
        seen,
      ),
    ).toHaveLength(1);
  });

  it("dedupes within a single batch, keeping the first occurrence", () => {
    const calls = [alarmCall({ in_minutes: 10 }), alarmCall({ in_minutes: 10 })];
    expect(dropDuplicateAlarms(calls, [])).toEqual([calls[0]]);
  });
});
