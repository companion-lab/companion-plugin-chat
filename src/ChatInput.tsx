// Port of the host's app/src/ui/molecules/ChatInput.tsx (unchanged).

import { useCallback, type KeyboardEvent } from "react";

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

export function ChatInput({ value, onChange, onSend, onToggleMic, micActive, micAvailable = true, sending, onStop }: Props) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") onSend();
    },
    [onSend],
  );

  return (
    <div className="cp-inputrow">
      <input
        className="cp-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Say something…"
        aria-label="Message"
      />
      {sending ? (
        <button className="cp-btn cp-btn-stop" onClick={onStop} aria-label="Stop response" title="Stop">
          <StopIcon />
        </button>
      ) : micAvailable ? (
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
      <button className="cp-btn cp-btn-send" onClick={onSend} disabled={!value.trim()} aria-label="Send" title="Send">
        <SendIcon />
      </button>
    </div>
  );
}
