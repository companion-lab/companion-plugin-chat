// Port of the host's app/src/ui/molecules/ChatInput.tsx, extended with file
// attachments: a paperclip opens the webview's native file picker (plain
// <input type="file">, the same pattern the vrm/l2d/skills plugins use),
// picked images can also be pasted, and pending files show as removable
// chips above the row. Attachment state lives in ChatPanel — onSend stays
// argument-less and the panel reads its own pending list.

import { useCallback, useRef, type ClipboardEvent, type KeyboardEvent } from "react";
import { attachmentKind, fmtBytes, type PendingAttachment } from "./net/attachments";

type Props = {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onToggleMic: () => void;
  micActive: boolean;
  /** Speech recognition availability (an STT provider is registered). The
   *  mic button hides without it — e.g. the stt plugin is disabled. */
  micAvailable?: boolean;
  sending?: boolean;
  onStop?: () => void;
  /** Files picked/pasted but not sent yet. */
  pending?: PendingAttachment[];
  /** Fired with files from the picker or an image paste. */
  onFiles?: (files: File[]) => void;
  onRemovePending?: (id: string) => void;
};

const MicIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" y1="19" x2="12" y2="22" />
  </svg>
);

const SendIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m22 2-7 20-4-9-9-4Z" />
    <path d="M22 2 11 13" />
  </svg>
);

const StopIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </svg>
);

const AttachIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </svg>
);

const FileIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
  </svg>
);

export function ChatInput({
  value,
  onChange,
  onSend,
  onToggleMic,
  micActive,
  micAvailable = true,
  sending,
  onStop,
  pending,
  onFiles,
  onRemovePending,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") onSend();
    },
    [onSend],
  );

  const handlePaste = useCallback(
    (e: ClipboardEvent<HTMLInputElement>) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (!files.length || !onFiles) return;
      e.preventDefault();
      onFiles(files);
    },
    [onFiles],
  );

  const canSend = !!value.trim() || !!pending?.length;

  return (
    <div className="cp-attach-zone">
      {pending?.length ? (
        <div className="cp-attach-chips">
          {pending.map((a) => (
            <div key={a.id} className="cp-attach-chip" title={`${a.name} · ${fmtBytes(a.size)}`}>
              {attachmentKind(a.mime) === "image" ? (
                <img className="cp-attach-chip-img" src={`data:${a.mime};base64,${a.base64}`} alt="" />
              ) : (
                <FileIcon />
              )}
              <span className="cp-attach-chip-name">{a.name}</span>
              <button
                className="cp-attach-chip-x"
                onClick={() => onRemovePending?.(a.id)}
                aria-label={`Remove ${a.name}`}
                title="Remove"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <div className={`cp-inputrow${sending ? " cp-busy" : ""}`}>
        <input
          className="cp-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder="Say something…"
          aria-label="Message"
        />
        {onFiles ? (
          <>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = "";
                if (files.length) onFiles(files);
              }}
            />
            <button
              className="cp-btn"
              onClick={() => fileRef.current?.click()}
              disabled={sending}
              aria-label="Attach files"
              title="Attach files"
            >
              <AttachIcon />
            </button>
          </>
        ) : null}
        {micAvailable ? (
          <button
            className={`cp-btn${micActive ? " cp-btn-mic-on" : ""}`}
            onClick={onToggleMic}
            aria-label={micActive ? "Stop microphone" : "Start microphone"}
            aria-pressed={micActive}
            title={micActive ? "Stop mic" : "Mic"}
          >
            <MicIcon />
          </button>
        ) : null}
        {sending ? (
          <button
            className="cp-btn cp-btn-stop cp-btn-stop-busy"
            onClick={onStop}
            aria-label="Stop response"
            title="Stop"
          >
            <StopIcon />
          </button>
        ) : (
          <button
            className="cp-btn cp-btn-send"
            onClick={onSend}
            disabled={!canSend}
            aria-label="Send"
            title="Send"
          >
            <SendIcon />
          </button>
        )}
      </div>
    </div>
  );
}
