// Avatar capabilities for prompt/schema building and tag resolution —
// replaces the host's direct imports of the expression/motion registries
// (app/src/expression/registry.ts + app/src/idle/registry.ts), which a plugin
// cannot reach.
//
// The live snapshot is refreshed from ctx.avatar.describeCapabilities()
// ({emotions: string[], motions: string[]}) once at activation and again
// before every chat turn (custom emotions/motions from the library plugin can
// come and go). Until the first refresh lands — and in non-main windows,
// where the avatar bus is absent — the built-in sets below apply, matching
// the host's built-in registrations exactly (expression/registry.ts
// BUILTIN_EMOTION_META, idle/registry.ts BUILTIN_MOTION_META + "none").

export type AvatarCapabilities = {
  emotions: string[];
  motions: string[];
};

// Host built-ins: expressions neutral/happy/sad/angry/surprised/relaxed;
// motions none/nod/shake/think (listMotionNames puts "none" first).
export const DEFAULT_AVATAR_CAPABILITIES: AvatarCapabilities = {
  emotions: ["neutral", "happy", "sad", "angry", "surprised", "relaxed"],
  motions: ["none", "nod", "shake", "think"],
};

let current: AvatarCapabilities = DEFAULT_AVATAR_CAPABILITIES;

export function setAvatarCapabilities(caps: AvatarCapabilities): void {
  current = {
    emotions: [...caps.emotions],
    motions: [...caps.motions],
  };
}

export function getAvatarCapabilities(): AvatarCapabilities {
  return current;
}

// Name normalization ported from the host registries so model-provided names
// resolve to canonical entries the same way (" Nod " → "nod",
// "vrma-02" → "VRMA_02").

export function normalizeEmotionName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

export function normalizeMotionName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

/** Canonical emotion name, or null when unknown (host resolveEmotionName). */
export function resolveEmotionName(name: string): string | null {
  if (!name) return null;
  if (current.emotions.includes(name)) return name;
  const norm = normalizeEmotionName(name);
  for (const key of current.emotions) {
    if (normalizeEmotionName(key) === norm) return key;
  }
  return null;
}

/** Canonical motion name ("none" always resolves), or null when unknown
 *  (host resolveMotionName). */
export function resolveMotionName(name: string): string | null {
  if (name.trim().toLowerCase() === "none") return "none";
  if (!name) return null;
  if (current.motions.includes(name)) return name;
  const norm = normalizeMotionName(name);
  for (const key of current.motions) {
    if (normalizeMotionName(key) === norm) return key;
  }
  return null;
}

// Built-in motion names + descriptions, ported from the host's
// idle/registry.ts BUILTIN_MOTION_DESCRIPTIONS. The capabilities surface
// carries names only, so the built-in/custom split and the built-in
// descriptions are reconstructed from this fixed table (the host's built-in
// set is exactly nod/shake/think plus "none").
export const BUILTIN_MOTION_NAMES = new Set(["nod", "shake", "think"]);

export const BUILTIN_MOTION_DESCRIPTIONS: Record<string, string> = {
  none: "stay still idle, default when no motion fits",
  nod: "head nod for yes agreement",
  shake: "head shake for no disagreement",
  think: "thoughtful head tilt while thinking",
};

/** Best-effort motion description for the prompt: known built-in table entry,
 *  else the humanized "X custom motion clip" fallback the host used when a
 *  custom motion carried no description. */
export function motionDescription(name: string): string {
  const d = BUILTIN_MOTION_DESCRIPTIONS[name];
  if (d) return d;
  const human = name.replace(/[_-]+/g, " ").trim() || name;
  return `${human} custom motion clip`;
}
