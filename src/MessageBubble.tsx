// Port of the host's app/src/ui/molecules/MessageBubble.tsx (unchanged).

import { useCallback, useEffect, useRef, useState } from "react";

type Props = {
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
};

export function MessageBubble({ role, text, streaming }: Props) {
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
