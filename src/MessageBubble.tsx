// Port of the host's app/src/ui/molecules/MessageBubble.tsx (unchanged).

import { useCallback, useEffect, useRef, useState } from "react";
import { attachmentKind, fmtBytes } from "./net/attachments";

/** What a bubble needs to render an attachment — the history shape
 *  (MsgAttachment). `dataBase64` is absent on persistence-stripped entries,
 *  where only the name chip remains. */
type AttachmentView = {
  name: string;
  mime: string;
  size: number;
  dataBase64?: string;
  frames?: Array<{ dataBase64: string; atMs: number }>;
};

/** Thumbnail URL for an attachment: image bytes, a video's first keyframe,
 *  or "" when only the name survives. */
function thumbUrl(a: AttachmentView): string {
  if (attachmentKind(a.mime) === "image" && a.dataBase64) {
    return `data:${a.mime};base64,${a.dataBase64}`;
  }
  if (attachmentKind(a.mime) === "video" && a.frames?.length) {
    return `data:image/jpeg;base64,${a.frames[0].dataBase64}`;
  }
  return "";
}

function AttachmentChip({ a, index }: { a: AttachmentView; index: number }) {
  const thumb = thumbUrl(a);
  if (thumb) {
    return (
      <a
        key={`att-${index}`}
        className="cp-attach-thumb"
        href={thumb}
        target="_blank"
        rel="noreferrer"
        title={`${a.name} · ${fmtBytes(a.size)}`}
      >
        <img src={thumb} alt={a.name} />
      </a>
    );
  }
  return (
    <span
      key={`att-${index}`}
      className="cp-attach-chip"
      title={a.dataBase64 ? `${a.name} · ${fmtBytes(a.size)}` : `${a.name} — attachment data not kept`}
    >
      <span className="cp-attach-chip-name">{a.name}</span>
    </span>
  );
}

type Props = {
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
  attachments?: AttachmentView[];
};

export function MessageBubble({ role, text, streaming, attachments }: Props) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Non-secure contexts (plain http/tauri quirks): legacy fallback.
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      } catch {
        return;
      }
    }
    setCopied(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), 1500);
  }, [text]);

  return (
    <div className={`cp-msg cp-msg-${role}`}>
      <div className={`cp-bubble cp-bubble-${role}${streaming ? " cp-bubble-streaming" : ""}`}>
        {attachments?.length ? (
          <div className="cp-attach-chips">
            {attachments.map((a, i) => (
              <AttachmentChip key={`att-${i}`} a={a} index={i} />
            ))}
          </div>
        ) : null}
        {text}
        {/* Keyed: element + expression children compile to a dynamic array,
            and React warns for keyless elements in it. */}
        {!streaming && text && (
          <button key="copy" onClick={copy} title={copied ? "Copied!" : "Copy message"} className="cp-copy">
            {copied ? "✓" : "⧉"}
          </button>
        )}
      </div>
    </div>
  );
}
