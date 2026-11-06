// Wake-word helpers — vendored from the host's app/src/audio/wakeword.ts.
// The chat panel gates transcripts on the wake phrase (read from the voice
// plugin's localStorage "companion:tts" store, which still owns that setting).

export function normalizeWakeWord(raw: string | undefined | null): string {
  return (raw ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function extractWakeCommand(transcript: string, wake: string): { matched: boolean; command: string } {
  const norm = normalizeWakeWord(wake);
  if (!norm) return { matched: false, command: "" };
  const lower = transcript.toLowerCase();
  const idx = lower.indexOf(norm);
  if (idx === -1) return { matched: false, command: "" };
  const command = (transcript.slice(0, idx) + " " + transcript.slice(idx + norm.length))
    .replace(/[,\.:;!?\-–—]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { matched: true, command };
}
