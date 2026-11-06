// Port of the host's app/src/net/structured.ts. The only change: emotion and
// motion names resolve against the avatar capabilities snapshot
// (./capabilities.ts, refreshed from ctx.avatar.describeCapabilities())
// instead of the host's expression/motion registries.

import type { Emotion } from "./types";
import {
  resolveEmotionName,
  resolveMotionName,
} from "./capabilities";

export type Motion = string;

export type ResponsePayload = {
  text: string;
  emotion: Emotion | null;
  motion: Motion;
};

const EMOTION_TAG = /<<emotion:([^>]+)>>/gi;
const MOTION_TAG = /<<motion:([^>]+)>>/gi;

// The tag pattern captures [^>]+, so a match always yields a non-empty name;
// the ?? "" keeps the signature total without an unreachable branch.
function toEmotion(s: string | undefined): Emotion | null {
  return (resolveEmotionName((s ?? "").trim()) as Emotion) ?? null;
}

function toMotion(s: string | undefined): Motion {
  return (resolveMotionName((s ?? "").trim()) as Motion) ?? "none";
}

export function stripStructuredTags(raw: string): string {
  return raw.replace(EMOTION_TAG, "").replace(MOTION_TAG, "");
}

// State machine for streaming tag extraction.
export class StructuredStream {
  private raw = "";
  private emittedText = "";
  private firedEmotion: Emotion | null = null;
  private firedMotion: Motion = "none";

  push(raw: string): { tokens: string; emotion: Emotion | null; motion: Motion } {
    this.raw += raw;

    let emotion: Emotion | null = null;
    let motion: Motion = "none";

    for (const m of this.raw.matchAll(EMOTION_TAG)) {
      const e = toEmotion(m[1]);
      if (e && e !== this.firedEmotion) {
        this.firedEmotion = e;
        emotion = e;
      }
    }
    for (const m of this.raw.matchAll(MOTION_TAG)) {
      const mv = toMotion(m[1]);
      if (mv !== "none" && mv !== this.firedMotion) {
        this.firedMotion = mv;
        motion = mv;
      }
    }

    const clean = stripStructuredTags(this.raw);
    // Hold back a trailing partial tag (a "<<" split across two chunks) so we
    // never speak half of one.
    const partial = clean.search(/<<?[^>]*$/);
    const speakable = partial >= 0 ? clean.slice(0, partial) : clean;

    let tokens = "";
    if (speakable.length > this.emittedText.length) {
      tokens = speakable.slice(this.emittedText.length);
      this.emittedText = speakable;
    }

    return { tokens, emotion, motion };
  }

  getFinal(): { emotion: Emotion | null; motion: Motion } {
    return { emotion: this.firedEmotion, motion: this.firedMotion };
  }
}

export function parseStructured(raw: string): ResponsePayload {
  let emotion: Emotion | null = null;
  let motion: Motion = "none";

  for (const m of raw.matchAll(EMOTION_TAG)) {
    const e = toEmotion(m[1]);
    if (e) emotion = e;
  }
  for (const m of raw.matchAll(MOTION_TAG)) {
    const mv = toMotion(m[1]);
    if (mv !== "none") motion = mv;
  }
  const text = stripStructuredTags(raw).trim();

  return { text, emotion, motion };
}
