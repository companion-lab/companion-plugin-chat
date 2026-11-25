// User file attachments: picking, classification, and limits.
//
// A picked File crosses into the chat pipeline as base64 (the established
// in-webview pattern — vrm/l2d/sakura read files with FileReader and hand
// base64 over IPC). Caps exist because multi-MB payloads hurt twice:
// request bodies cross Tauri IPC as JSON number arrays (plugin:http|fetch)
// and are re-sent on every step of the tool loop, and history rides back
// through plugin_storage_set (the same wedging lesson l2d's upload.ts
// documents). Images therefore get canvas-downscaled before anything else.

import type { VideoFrame } from "./protocol";

/** Raw-byte cap per file, after image downscaling. 1.5 MB → ~2 MB base64. */
export const MAX_FILE_BYTES = 1.5 * 1024 * 1024;
/** Max picked files per message. */
export const MAX_FILES = 6;
/** Raw-byte cap per message (all files together). */
export const MAX_MSG_BYTES = 3 * 1024 * 1024;
/** Cumulative base64 budget that persistence keeps for recent attachment-
 *  bearing messages; older ones keep their metadata but lose the bytes
 *  (chat-history.ts stripAttachmentsForPersist). */
export const PERSIST_KEEP_BUDGET_BASE64 = 2 * 1024 * 1024;

/** Videos are decoded client-side (keyframes), so the raw-size caps don't
 *  fit them — a 60 MB clip costs the same ~600 KB of frames. The raw cap is
 *  only a decode sanity bound; what counts against the message budget is
 *  the KEPT bytes (frames, and the base64 when ≤ MAX_FILE_BYTES). */
export const MAX_VIDEO_RAW_BYTES = 64 * 1024 * 1024;

/** Images above this size (or a longer edge below) get re-encoded to JPEG. */
const DOWNSCALE_TRIGGER_BYTES = 512 * 1024;
const DOWNSCALE_MAX_EDGE = 1600;
const JPEG_QUALITY = 0.85;

/** Text-like files ride to every provider as a plain text part (decoded),
 *  so code/config/markdown files reach models that have no file upload. */
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "yaml", "yml", "toml", "ini",
  "js", "jsx", "ts", "tsx", "py", "rb", "go", "rs", "java", "kt", "c", "h",
  "cpp", "hpp", "cs", "swift", "sh", "bash", "zsh", "fish", "sql", "html",
  "htm", "css", "scss", "xml", "svg", "log", "env", "gitignore", "lock",
]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic", "heif", "avif"]);
const AUDIO_EXTENSIONS = new Set(["wav", "mp3", "m4a", "aac", "ogg", "oga", "flac", "opus", "weba", "webm-audio"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm", "m4v", "avi", "mkv"]);

/** Wire-agnostic attachment classification. "text" files are decoded and
 *  sent as text parts; "image"/"audio"/"pdf" get provider-native parts where
 *  available; "video" rides as extracted keyframes (Gemini can also take the
 *  raw file); "binary" only gets a filename note. */
export type AttachmentKind = "image" | "audio" | "pdf" | "text" | "video" | "binary";

export function classifyMime(name: string, mime: string): string {
  if (mime && mime !== "application/octet-stream") return mime;
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  if (IMAGE_EXTENSIONS.has(ext)) return ext === "jpg" ? "image/jpeg" : ext === "svg" ? "image/svg+xml" : `image/${ext}`;
  if (ext === "pdf") return "application/pdf";
  if (AUDIO_EXTENSIONS.has(ext)) return ext === "webm-audio" ? "audio/webm" : `audio/${ext}`;
  if (VIDEO_EXTENSIONS.has(ext)) return ext === "mov" || ext === "m4v" ? "video/mp4" : `video/${ext}`;
  if (TEXT_EXTENSIONS.has(ext)) return ext === "md" || ext === "markdown" ? "text/markdown" : `text/${ext}`;
  return mime || "application/octet-stream";
}

export function attachmentKind(mime: string): AttachmentKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("text/") || mime === "application/json" || mime === "application/xml" || mime === "application/yaml") return "text";
  return "binary";
}

/** Compact per-attachment token estimate for the context-fill indicator
 *  (context.ts). Images/pdfs are flat mid-range values — real providers
 *  range from a few hundred to a couple thousand — and text-like files
 *  estimate from their decoded length (base64 is 4/3 of decoded bytes). */
export function attachmentTokenEstimate(
  mime: string,
  base64: string,
  frames?: VideoFrame[],
): number {
  switch (attachmentKind(mime)) {
    case "image": return 1100;
    case "audio": return 600;
    case "pdf": return 1500;
    case "video":
      // Raw file inlined (Gemini): a coarse flat figure; keyframe transport:
      // per-image figures plus a note.
      return base64 ? 4500 : (frames?.length ?? 0) * 1100 + 50;
    case "text": return Math.ceil((base64.length * 3) / 4 / 4);
    case "binary": return 50;
  }
}

/** The text note a data-less (stripped or unsupported) attachment degrades
 *  to on the wire. */
export function attachmentNote(name: string, mime: string): string {
  return `[attached file: ${name} (${mime})]`;
}

/** A picked-and-processed attachment ready to attach to a message. */
export type PendingAttachment = {
  id: string;
  name: string;
  mime: string;
  size: number;
  base64: string;
  /** Video attachments only: extracted keyframes. `base64` stays "" when
   *  the raw clip exceeded MAX_FILE_BYTES (frames-only transport). */
  frames?: VideoFrame[];
};

/** Bytes this attachment will actually carry through the pipeline (the
 *  message-budget accounting unit; raw file size is irrelevant once
 *  keyframes exist). */
export function attachmentKeptBytes(a: {
  base64?: string;
  frames?: VideoFrame[];
}): number {
  return (a.base64?.length ?? 0) + (a.frames?.reduce((n, f) => n + f.dataBase64.length, 0) ?? 0);
}

export type ReadResult =
  | { ok: true; attachment: PendingAttachment }
  | { ok: false; name: string; reason: string };

let seq = 0;
const nextId = () => `att-${Date.now().toString(36)}-${(seq++).toString(36)}`;

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const comma = dataUrl.indexOf(",");
      resolve(comma === -1 ? "" : dataUrl.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(blob);
  });
}

function decodeBase64Text(base64: string): string {
  try {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return "";
  }
}

/** Resolve on `event` (once) or reject after `timeoutMs`. */
function once(target: EventTarget, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const ok = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error(`${event} timed out`));
    };
    const timer = window.setTimeout(fail, timeoutMs);
    const cleanup = () => {
      window.clearTimeout(timer);
      target.removeEventListener(event, ok);
    };
    target.addEventListener(event, ok, { once: true });
  });
}

const FRAME_MAX_EDGE = 1280;

/** Client-side keyframe extraction: load the clip in a <video> element, seek
 *  to 0/25/50/75% and re-encode each as a JPEG ≤1280px. Best-effort — null
 *  when the codec can't render or nothing decoded. Providers without video
 *  ingest (OpenAI/Anthropic) send these frames as images; Gemini prefers the
 *  raw file when it fits the byte cap. */
export async function extractVideoFrames(file: File, maxFrames = 4): Promise<VideoFrame[] | null> {
  if (typeof document === "undefined" || typeof window === "undefined") return null;
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  const canvas = document.createElement("canvas");
  const g = canvas.getContext("2d");
  const frames: VideoFrame[] = [];
  try {
    if (!g) return null;
    video.preload = "auto";
    video.muted = true;
    video.src = url;
    await once(video, "loadedmetadata", 10_000);
    if (!Number.isFinite(video.duration) || video.duration <= 0) return null;
    const w0 = video.videoWidth;
    const h0 = video.videoHeight;
    if (!w0 || !h0) return null;
    const scale = Math.min(1, FRAME_MAX_EDGE / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * scale));
    const h = Math.max(1, Math.round(h0 * scale));
    canvas.width = w;
    canvas.height = h;
    const count = Math.max(1, Math.min(maxFrames, Math.floor(video.duration)));
    for (let i = 0; i < count; i++) {
      const t = Math.min((video.duration * i) / count + 0.01, Math.max(0, video.duration - 0.05));
      video.currentTime = t;
      await once(video, "seeked", 8_000);
      g.drawImage(video, 0, 0, w, h);
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.8));
      if (!blob || blob.size === 0) continue;
      frames.push({ dataBase64: await blobToBase64(blob), atMs: Math.round(t * 1000) });
    }
    return frames.length ? frames : null;
  } catch {
    // Partial frame sets are still useful.
    return frames.length ? frames : null;
  } finally {
    video.removeAttribute("src");
    try { video.load(); } catch { /* already released */ }
    URL.revokeObjectURL(url);
  }
}

/** Cap for text-like attachments inlined as text parts — a 1.5 MB text file
 *  would alone eat a chunk of the context window. */
export const MAX_TEXT_PART_CHARS = 20_000;

/** Decoded (UTF-8, lossy) and truncated content of a text-like attachment
 *  for inlining as a text part. */
export function truncatedAttachmentText(base64: string): string {
  if (base64.length <= MAX_TEXT_PART_CHARS) {
    return decodeBase64Text(base64).slice(0, MAX_TEXT_PART_CHARS);
  }
  // Decode only the needed prefix: base64 is 4 chars per 3 bytes.
  const prefix = base64.slice(0, Math.ceil((MAX_TEXT_PART_CHARS * 4) / 3) & ~3);
  return decodeBase64Text(prefix).slice(0, MAX_TEXT_PART_CHARS);
}

/** Re-encode large/raster images to a JPEG within the dimension cap so a
 *  screenshot stays in the IPC-safe size range (and inside what vision
 *  APIs sample down to anyway). Best-effort: any failure keeps the raw file. */
async function downscaleImage(file: File, mime: string): Promise<Blob | null> {
  if (attachmentKind(mime) !== "image") return null;
  if (mime === "image/svg+xml") return null;
  if (file.size <= DOWNSCALE_TRIGGER_BYTES) return null;
  try {
    const bitmap = await createImageBitmap(file);
    const longest = Math.max(bitmap.width, bitmap.height);
    const scale = longest > DOWNSCALE_MAX_EDGE ? DOWNSCALE_MAX_EDGE / longest : 1;
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext("2d");
    if (!g) return null;
    // JPEG has no alpha; flatten onto dark so transparent PNGs stay legible.
    g.fillStyle = "#101420";
    g.fillRect(0, 0, w, h);
    g.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", JPEG_QUALITY));
    return blob && blob.size < file.size ? blob : null;
  } catch {
    return null;
  }
}

/** Read one picked file into a PendingAttachment, enforcing caps. I/O is
 *  isolated here; the pure helpers above are tested directly. */
export async function readAttachment(file: File): Promise<ReadResult> {
  const name = file.name || "file";
  const mime = classifyMime(name, file.type);
  // Videos take a separate path: they're decoded client-side into keyframes,
  // so the raw-size caps don't apply the same way (see MAX_VIDEO_RAW_BYTES).
  if (attachmentKind(mime) === "video") {
    return readVideoAttachment(file, name, mime);
  }
  if (file.size > MAX_FILE_BYTES) {
    return { ok: false, name, reason: `${name} is ${fmtBytes(file.size)} — the per-file limit is ${fmtBytes(MAX_FILE_BYTES)}` };
  }
  const blob = (await downscaleImage(file, mime)) ?? file;
  let base64: string;
  try {
    base64 = await blobToBase64(blob);
  } catch (e) {
    return { ok: false, name, reason: `could not read ${name}: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (base64.length === 0) {
    return { ok: false, name, reason: `could not read ${name} (empty)` };
  }
  if (blob.size > MAX_FILE_BYTES) {
    return { ok: false, name, reason: `${name} is ${fmtBytes(blob.size)} — the per-file limit is ${fmtBytes(MAX_FILE_BYTES)}` };
  }
  return { ok: true, attachment: { id: nextId(), name, mime, size: blob.size, base64 } };
}

/** Video attachments: extract keyframes always; keep the raw base64 only
 *  when the clip fits MAX_FILE_BYTES (Gemini can inline it). Oversized
 *  clips ride as frames-only, so the message budget counts kept bytes. */
async function readVideoAttachment(file: File, name: string, mime: string): Promise<ReadResult> {
  if (file.size > MAX_VIDEO_RAW_BYTES) {
    return { ok: false, name, reason: `${name} is ${fmtBytes(file.size)} — videos up to ${fmtBytes(MAX_VIDEO_RAW_BYTES)}` };
  }
  if (file.size === 0) {
    return { ok: false, name, reason: `could not read ${name} (empty)` };
  }
  const frames = await extractVideoFrames(file);
  const keepBytes = file.size <= MAX_FILE_BYTES;
  let base64 = "";
  if (keepBytes) {
    try {
      base64 = await blobToBase64(file);
    } catch {
      // Frames still carry the content; the raw file just won't inline.
      base64 = "";
    }
  }
  if (!base64 && !frames?.length) {
    return { ok: false, name, reason: `could not read frames from ${name} (unsupported codec?)` };
  }
  return {
    ok: true,
    attachment: {
      id: nextId(),
      name,
      mime,
      size: keepBytes && base64 ? file.size : frames?.reduce((n, f) => n + f.dataBase64.length, 0) ?? 0,
      base64,
      ...(frames?.length ? { frames } : {}),
    },
  };
}

/** Read a batch, enforcing the file-count and total-size caps. Returns the
 *  accepted attachments plus rejection reasons to show in the chat panel.
 *  The per-message budget counts KEPT bytes (base64 + keyframes), not raw
 *  file size — keyframe transport keeps large videos affordable. */
export async function readAttachments(
  files: ArrayLike<File>,
  alreadyQueuedBytes = 0,
): Promise<{ attachments: PendingAttachment[]; errors: string[] }> {
  const list = Array.from(files).filter((f) => f.size > 0 || f.name);
  const errors: string[] = [];
  const attachments: PendingAttachment[] = [];
  let total = alreadyQueuedBytes;
  for (const file of list) {
    if (attachments.length >= MAX_FILES) {
      errors.push(`up to ${MAX_FILES} files per message — skipped ${file.name || "file"}`);
      continue;
    }
    const res = await readAttachment(file);
    if (!res.ok) {
      errors.push(res.reason);
      continue;
    }
    const kept = attachmentKeptBytes(res.attachment);
    if (kept + total > MAX_MSG_BYTES) {
      errors.push(`${res.attachment.name} would exceed the ${fmtBytes(MAX_MSG_BYTES)} per-message limit`);
      continue;
    }
    attachments.push(res.attachment);
    total += kept;
  }
  return { attachments, errors };
}

export function fmtBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}
