// Styles for the chat plugin, inlined from the host's app/src/ui/chat-modal.css:
// plugin bundles cannot rely on the host loading a separate stylesheet, and
// the main window loads no other CSS, so the whole file (confirm modal +
// chat panel classes, theme tokens repeated) is injected once on first render
// of any plugin component. Identical class definitions also exist in the
// settings window's settings.css, so injecting there too is a no-op visually.

let injected = false;

export function injectStyles(): void {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const style = document.createElement("style");
  style.id = "chat-plugin-styles";
  style.textContent = CHAT_CSS;
  document.head.appendChild(style);
}

const CHAT_CSS = `/* Confirm modal + buttons for the main window. It loads no other stylesheet,
   so theme tokens are repeated here instead of imported from settings.css.
   Covers ConfirmModal (used by the chat clear button) with the same look as
   the settings window. */

/* Modal */
.modal-overlay {
  position: fixed;
  inset: 0;
  /* background: rgba(10, 12, 18, 0.72); */
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
  padding: 16px;
  font-family:
    -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}

.modal-card {
  width: 100%;
  max-width: 360px;
  background: #181c2d;
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 12px;
  padding: 20px;
}

.modal-title {
  font-size: 15px;
  font-weight: 700;
  color: #f0f3f6;
  margin-bottom: 8px;
}

/* Modal header with close button (rendered by ConfirmModal) */
.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: -20px -20px 14px;
  padding: 12px 12px 12px 20px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 12px 12px 0 0;
}

.modal-head .modal-title {
  margin-bottom: 0;
}

.modal-x {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: #565f89;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.modal-x:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.07);
  color: #f0f3f6;
}

.modal-x:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.modal-msg {
  font-size: 13px;
  color: #9aa5ce;
  line-height: 1.45;
  margin-bottom: 20px;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

/* Button variants (subset used by ConfirmModal) */
.btn-secondary,
.btn-danger,
.btn-ghost {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  border-radius: 8px;
  padding: 7px 14px;
  cursor: pointer;
  border: 1px solid transparent;
  transition: all 0.15s ease;
  font-family: inherit;
  white-space: nowrap;
}

.btn-secondary {
  background: rgba(255, 255, 255, 0.05);
  border-color: rgba(255, 255, 255, 0.09);
  color: #f0f3f6;
}

.btn-secondary:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.09);
  border-color: rgba(255, 255, 255, 0.16);
}

.btn-danger {
  background: rgba(247, 118, 142, 0.12);
  color: #f7768e;
  border-color: rgba(247, 118, 142, 0.25);
}

.btn-danger:hover:not(:disabled) {
  background: #f7768e;
  color: #0f111a;
}

.btn-ghost {
  background: transparent;
  color: #9aa5ce;
}

.btn-ghost:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.04);
  color: #f0f3f6;
}

.modal-actions button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.modal-actions .btn-danger.is-busy:disabled {
  opacity: 1;
  cursor: wait;
}

/* ============================== */
/* Chat panel (avatar window)     */
/* ============================== */

.cp-root {
  position: fixed;
  bottom: 10px;
  left: 10px;
  right: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: auto;
  /* No backdrop-filter here: WKWebView composites the blurred backdrop as a
     sharp-edged rectangle behind the rounded panel on the transparent window.
     Opacity carries the contrast instead. */
  background: rgba(11, 14, 23, 0.88);
  border-radius: 14px;
  padding: 10px 12px 12px;
  color: #edf0fb;
  font-size: 12px;
}

.cp-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cp-head-title {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.9px;
  text-transform: uppercase;
  color: rgba(154, 166, 209, 0.8);
}

.cp-head-count {
  font-size: 10px;
  color: #5d6789;
  font-variant-numeric: tabular-nums;
}

.cp-head-spacer {
  flex: 1;
}

.cp-clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 7px;
  border: none;
  background: transparent;
  color: #5d6789;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.cp-clear:hover:not(:disabled) {
  background: rgba(255, 125, 151, 0.14);
  color: #ff7d97;
}

.cp-clear:disabled {
  opacity: 0.35;
  cursor: default;
}

/* Messages */
.cp-msgs {
  overflow-y: auto;
  max-height: 150px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-right: 2px;
}

.cp-msgs::-webkit-scrollbar {
  width: 8px;
}

.cp-msgs::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.12);
  border-radius: 999px;
  border: 2px solid transparent;
  background-clip: content-box;
}

.cp-msg {
  display: flex;
}

.cp-msg-user {
  justify-content: flex-end;
}

.cp-msg-assistant {
  justify-content: flex-start;
}

.cp-bubble {
  position: relative;
  max-width: 86%;
  padding: 7px 11px;
  border-radius: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-wrap: break-word;
  overflow-wrap: break-word;
}

.cp-bubble-user {
  background: linear-gradient(135deg, rgba(143, 157, 255, 0.3), rgba(143, 157, 255, 0.18));
  border: 1px solid rgba(143, 157, 255, 0.32);
  border-bottom-right-radius: 5px;
  color: #e8ecff;
}

.cp-bubble-assistant {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-bottom-left-radius: 5px;
  color: #dde3f7;
}

.cp-bubble-streaming::after {
  content: "▍";
  margin-left: 1px;
  color: #8f9dff;
  animation: cp-caret 1s steps(2) infinite;
}

@keyframes cp-caret {
  50% {
    opacity: 0;
  }
}

.cp-copy {
  position: absolute;
  top: 4px;
  right: 4px;
  font-size: 10px;
  line-height: 1;
  padding: 3px 5px;
  border-radius: 5px;
  opacity: 0;
  transition: opacity 0.15s ease, background 0.15s ease;
  cursor: pointer;
  background: rgba(11, 14, 23, 0.6);
  border: none;
  color: inherit;
}

.cp-bubble:hover .cp-copy {
  opacity: 0.85;
}

.cp-copy:hover {
  opacity: 1 !important;
  background: rgba(143, 157, 255, 0.25);
}

/* Status rows */
.cp-live {
  display: flex;
  align-items: center;
  gap: 7px;
  font-style: italic;
  font-size: 11.5px;
  color: rgba(154, 166, 209, 0.95);
  padding: 1px 4px;
}

.cp-live-dot {
  width: 6px;
  height: 6px;
  flex-shrink: 0;
  border-radius: 50%;
  background: #74e0a2;
  box-shadow: 0 0 8px rgba(116, 224, 162, 0.6);
  animation: cp-pulse 1.6s ease-in-out infinite;
}

@keyframes cp-pulse {
  50% {
    opacity: 0.45;
  }
}

.cp-wake {
  font-style: italic;
  font-size: 11.5px;
  color: #8f9dff;
  padding: 1px 4px;
}

/* Waiting for the first token of a turn */
.cp-waiting {
  display: flex;
  align-items: center;
  gap: 7px;
  font-style: italic;
  font-size: 11.5px;
  color: rgba(154, 166, 209, 0.85);
  padding: 1px 4px;
}

.cp-waiting .cp-live-dot {
  background: #8f9dff;
  box-shadow: 0 0 8px rgba(143, 157, 255, 0.6);
}

/* Live reasoning from thinking models */
.cp-think {
  max-width: 86%;
  border: 1px dashed rgba(143, 157, 255, 0.28);
  border-radius: 12px;
  border-bottom-left-radius: 5px;
  background: rgba(143, 157, 255, 0.06);
  padding: 6px 10px 7px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.cp-think-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.7px;
  text-transform: uppercase;
  color: rgba(143, 157, 255, 0.9);
}

.cp-think-dot {
  width: 6px;
  height: 6px;
  flex-shrink: 0;
  border-radius: 50%;
  background: #8f9dff;
  box-shadow: 0 0 8px rgba(143, 157, 255, 0.6);
  animation: cp-pulse 1.6s ease-in-out infinite;
}

.cp-think-text {
  font-size: 11px;
  font-style: italic;
  line-height: 1.45;
  color: rgba(201, 210, 255, 0.75);
  white-space: pre-wrap;
  word-wrap: break-word;
  overflow-wrap: break-word;
}

.cp-err {
  background: rgba(255, 125, 151, 0.1);
  border: 1px solid rgba(255, 125, 151, 0.25);
  color: #ff7d97;
  border-radius: 9px;
  padding: 6px 10px;
  font-size: 11.5px;
  line-height: 1.4;
}

/* Clarifying-question card */
.cp-ask {
  border: 1px solid rgba(143, 157, 255, 0.3);
  background: rgba(143, 157, 255, 0.08);
  border-radius: 11px;
  padding: 9px 11px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.cp-ask-q {
  font-weight: 600;
  font-size: 12px;
  color: #e8ecff;
}

.cp-ask-opts {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
}

.cp-ask-opt {
  padding: 5px 12px;
  font-size: 11.5px;
  font-weight: 550;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(143, 157, 255, 0.35);
  color: #c9d2ff;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
  font-family: inherit;
}

.cp-ask-opt:hover {
  background: rgba(143, 157, 255, 0.22);
  color: #edf0fb;
}

.cp-ask-hint {
  font-size: 10px;
  color: #5d6789;
}

.cp-ask-skip {
  background: transparent;
  border: none;
  padding: 0;
  font-size: 10px;
  color: #9aa4cb;
  text-decoration: underline;
  cursor: pointer;
  font-family: inherit;
}

.cp-ask-skip:hover {
  color: #edf0fb;
}

/* Input row */
.cp-inputrow {
  display: flex;
  gap: 7px;
  align-items: center;
}

.cp-input {
  flex: 1;
  min-width: 0;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.11);
  border-radius: 11px;
  padding: 8px 12px;
  font-size: 12px;
  font-family: inherit;
  color: #edf0fb;
  outline: none;
  color-scheme: dark;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.cp-input::placeholder {
  color: #5d6789;
}

.cp-input:focus {
  border-color: #8f9dff;
  box-shadow: 0 0 0 3px rgba(143, 157, 255, 0.15);
}

.cp-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.11);
  background: rgba(255, 255, 255, 0.055);
  color: #9aa4cb;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
}

.cp-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.1);
  color: #edf0fb;
}

.cp-btn:disabled {
  opacity: 0.35;
  cursor: default;
}

.cp-btn-mic-on {
  background: rgba(255, 125, 151, 0.16) !important;
  border-color: rgba(255, 125, 151, 0.45) !important;
  color: #ff7d97 !important;
  box-shadow: 0 0 0 4px rgba(255, 125, 151, 0.12);
  animation: cp-pulse 1.6s ease-in-out infinite;
}

.cp-btn-send {
  background: linear-gradient(180deg, #97a5ff, #6a79ec);
  border: 1px solid transparent;
  color: #0a0c14;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.3);
}

.cp-btn-send:hover:not(:disabled) {
  background: linear-gradient(180deg, #a7b2ff, #7585f2);
  color: #0a0c14;
}

.cp-btn-stop {
  background: rgba(255, 125, 151, 0.14);
  border-color: rgba(255, 125, 151, 0.35);
  color: #ff7d97;
}

.cp-btn-stop:hover:not(:disabled) {
  background: rgba(255, 125, 151, 0.24);
  color: #ff7d97;
}
`;
