import { describe, expect, it } from "vitest";
import { extractWakeCommand, normalizeWakeWord } from "./wakeword";

describe("normalizeWakeWord", () => {
  it("trims, lowercases and collapses whitespace runs", () => {
    expect(normalizeWakeWord("  Hey   JARVIS ")).toBe("hey jarvis");
    // Any whitespace run (tabs, newlines) becomes a single space.
    expect(normalizeWakeWord("hey\tjarvis\nok")).toBe("hey jarvis ok");
  });

  it("treats null/undefined/blank as an empty wake word", () => {
    expect(normalizeWakeWord(null)).toBe("");
    expect(normalizeWakeWord(undefined)).toBe("");
    expect(normalizeWakeWord("   ")).toBe("");
  });
});

describe("extractWakeCommand", () => {
  it("strips the wake phrase and returns the rest", () => {
    expect(extractWakeCommand("hey jarvis what's the weather", "hey jarvis")).toEqual({
      matched: true,
      command: "what's the weather",
    });
  });

  it("matches case-insensitively but keeps the transcript's original casing", () => {
    // The match runs on a lowercased copy; the command is sliced from the
    // original transcript, so user capitalization survives.
    expect(extractWakeCommand("Hey Jarvis, open Chrome", "HEY JARVIS")).toEqual({
      matched: true,
      command: "open Chrome",
    });
  });

  it("removes punctuation around the wake phrase", () => {
    // ,.:;!? and dashes become spaces; apostrophes are not in the class.
    expect(extractWakeCommand("hey jarvis — stop everything", "hey jarvis").command).toBe(
      "stop everything",
    );
    expect(extractWakeCommand("ok hey jarvis: go home", "hey jarvis").command).toBe(
      "ok go home",
    );
  });

  it("only removes the first occurrence", () => {
    expect(extractWakeCommand("hey jarvis hey jarvis again", "hey jarvis").command).toBe(
      "hey jarvis again",
    );
  });

  it("handles a mid-sentence wake phrase", () => {
    expect(extractWakeCommand("please hey jarvis stop the music", "hey jarvis").command).toBe(
      "please stop the music",
    );
  });

  it("does not match when the wake word is empty or absent", () => {
    // An empty normalized wake word can never match — every command would
    // otherwise be swallowed.
    expect(extractWakeCommand("hello there", "")).toEqual({ matched: false, command: "" });
    expect(extractWakeCommand("hello there", "   ")).toEqual({ matched: false, command: "" });
    expect(extractWakeCommand("hello there", "hey jarvis")).toEqual({
      matched: false,
      command: "",
    });
  });
});
