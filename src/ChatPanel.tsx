// Port of the host's app/src/ui/organisms/ChatPanel.tsx — the avatar's AI
// conversation, now plugin-owned.
//
// Differences from the host (all host props are gone; the component reads
// everything from plugin surfaces so the main-window override needs no
// props beyond the plugin context):
// - api/provider + persona settings come from the plugin settings store
//   (./settings.ts) instead of App.tsx props.
// - Emotion/motion callbacks (host props onEmotion/onMotion) are internal
//   ctx.avatar.setEmotion/triggerMotion calls.
// - Speech goes through ctx.services: streamed reply TTS via
//   ctx.services.tts().createStream (the host App.tsx used to own the stream;
//   speaking state is now panel-local), STT via ctx.services.stt() — with the
//   voice plugin absent, recognition is disabled with an explicit error.
// - Wake word + STT engine kind are read transitionally from the voice
//   the STT plugin's localStorage "companion:stt" (the stt plugin owns that
//   store since the voice split); live updates arrive through the
//   cross-window DOM storage event.
// - Barge-in toggle is read from the host ui-prefs localStorage
//   "companion:ui" and updated via the host-global "ui-prefs-changed" event.
// - Global "mic-toggle" (host shortcut), "mic-active-changed" (voice plugin
//   reaction), and the alarms/calendar "plugin:*:alarm-fired" announcements
//   use the vendored tauri bridge (plugin ctx.events is namespaced).
// - STT idle-unload reads the host perf config via the vendored bridge.
// - History lives in the plugin chat-history store (ctx.storage-backed).
// - ConfirmModal comes from the host UI kit (ctx.ui).

import { useEffect, useRef, useState, useCallback, useSyncExternalStore } from "react";
import type { PluginContext, TtsStream } from "@companion-lab/plugin";
import type { ChatMessage } from "./net/protocol";
import { RouterClient } from "./net/ws";
import { setAvatarCapabilities } from "./net/capabilities";
import {
  setAskUserHandler,
  clearAskUserHandler,
  type AskUserRequest,
} from "./net/ask-user";
import { tauriListen, tauriEmit, tauriInvoke } from "./tauri";
import { normalizeWakeWord, extractWakeCommand } from "./wakeword";
import { MessageBubble } from "./MessageBubble";
import { ChatInput } from "./ChatInput";
import { injectStyles } from "./styles";
import {
  getChatHistory,
  saveChatHistory,
  setHistorySnapshot,
  clearChatHistory,
  subscribeChatHistory,
  type Msg,
} from "./chat-history";
import { buildWire } from "./context";
import {
  getApiSettings,
  getPersonaSettings,
  subscribeChatSettings,
} from "./settings";

// How long the question card waits for an answer before dismissing itself;
// the tool loop then receives a "no answer" result. Must stay shorter than
// the handler backstop in net/ask-user.ts.
const ASK_TIMEOUT_MS = 120_000;

type PendingAsk = AskUserRequest & { resolve: (answer: string) => void };

// ─── Transitional voice/ui-prefs reads (the voice plugin owns that store) ──

type SttSettingsLike = {
  wakeWord?: string;
  sttProvider?: "local" | "cloud";
};

function readSttSettings(): SttSettingsLike {
  try {
    const raw = localStorage.getItem("companion:stt");
    if (raw) return JSON.parse(raw) as SttSettingsLike;
  } catch {
    /* ignore */
  }
  return {};
}

function readBargeIn(): boolean {
  try {
    const raw = localStorage.getItem("companion:ui");
    if (raw) {
      const prefs = JSON.parse(raw) as { bargeIn?: boolean };
      return prefs.bargeIn !== false;
    }
  } catch {
    /* ignore */
  }
  return true;
}

function refreshAvatarCapabilities(ctx: PluginContext): void {
  try {
    const caps = ctx.avatar.describeCapabilities();
    // No-op bus (settings window / no model yet) reports empty lists — keep
    // the defaults instead of wiping them.
    if (caps.emotions.length || caps.motions.length) {
      setAvatarCapabilities(caps);
    }
  } catch {
    /* keep the current snapshot */
  }
}

export function ChatPanel({ ctx }: { ctx: PluginContext }) {
  injectStyles();

  const api = useSyncExternalStore(subscribeChatSettings, getApiSettings);
  const persona = useSyncExternalStore(subscribeChatSettings, getPersonaSettings);
  const history = useSyncExternalStore(subscribeChatHistory, getChatHistory);

  const [confirmClear, setConfirmClear] = useState(false);
  const saveTimerRef = useRef<number | null>(null);

  const persist = useCallback((next: Msg[]) => {
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      saveChatHistory(next);
    }, 500);
  }, []);

  // Forward-declared so clearHistory can stop an in-flight turn.
  const stopRef = useRef<() => void>(() => {});

  const clearHistory = useCallback(() => {
    setConfirmClear(false);
    stopRef.current();
    clearChatHistory();
    setStreaming("");
    setThinking("");
  }, []);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState("");
  // Live reasoning text from thinking models. Transient: never persisted to
  // history, never spoken.
  const [thinking, setThinking] = useState("");
  const thinkingRafRef = useRef(0);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const clientRef = useRef<RouterClient | null>(null);
  const isSendingRef = useRef(false);
  const pendingQueueRef = useRef<string[]>([]);
  // Batch token renders: the LLM fires many tokens/sec; coalesce them into
  // one React update per animation frame.
  const streamRafRef = useRef(0);

  // Active clarifying question from the ask_user tool: shown as a card, the
  // user's reply resolves the pending tool call inside the running LLM turn.
  const [pendingAsk, setPendingAsk] = useState<PendingAsk | null>(null);
  const pendingAskRef = useRef<PendingAsk | null>(null);
  pendingAskRef.current = pendingAsk;
  const askTimerRef = useRef<number | null>(null);

  // ─── Speech (panel-owned, via ctx.services) ───
  // The stream is created lazily on the first token, exactly like the host's
  // App.tsx did. Settings are empty: the voice provider resolves its own
  // stored TTS settings.
  const streamTtsRef = useRef<TtsStream | null>(null);
  const [speaking, setSpeaking] = useState(false);

  const onViseme = useCallback(
    (name: string, weight?: number) => ctx.avatar.setViseme(name, weight),
    [ctx],
  );

  const stopStream = useCallback(() => {
    streamTtsRef.current?.stop();
    streamTtsRef.current = null;
    ctx.avatar.setViseme("neutral");
  }, [ctx]);

  const handleSpeakingChange = useCallback((v: boolean) => {
    setSpeaking(v);
  }, []);

  const onStreamToken = useCallback(
    (token: string) => {
      if (!token) return;
      if (!streamTtsRef.current) {
        const tts = ctx.services.tts();
        streamTtsRef.current = tts.createStream(
          {},
          onViseme,
          () => {
            ctx.avatar.setViseme("neutral");
            streamTtsRef.current = null;
          },
          handleSpeakingChange,
        );
      }
      streamTtsRef.current.push(token);
    },
    [ctx, onViseme, handleSpeakingChange],
  );

  const onStreamStart = useCallback(() => {
    if (streamTtsRef.current) {
      streamTtsRef.current.stop();
      streamTtsRef.current = null;
    }
  }, []);

  const onStreamDone = useCallback((_fullText: string) => {
    streamTtsRef.current?.flush();
  }, []);

  // Barge-in guards: ignore TTS-onset clicks, cooldown between triggers.
  const speechStartRef = useRef(0);
  const lastBargeRef = useRef(0);
  // Latest onToken, for speaking ask_user questions through the TTS pipeline.
  const onTokenRef = useRef(onStreamToken);
  onTokenRef.current = onStreamToken;

  useEffect(() => {
    if (speaking || streaming) speechStartRef.current = Date.now();
  }, [speaking, streaming]);

  // STT
  const [micActive, setMicActive] = useState(false);
  const [liveText, setLiveText] = useState("");
  const [armed, setArmed] = useState(false);
  const armedRef = useRef(false);
  // Both engines share this interface; ChatPanel only talks to it.
  type SttEngine = {
    start(): Promise<void>;
    stop(): Promise<unknown>;
    setBargeInListener(fn: ((energy: number) => void) | null): void;
    discardPending(): void;
    shouldSend(text: string): boolean;
  };
  const sttRef = useRef<SttEngine | null>(null);
  // Set when the user explicitly stops the mic, so the wake-word auto-start
  // effect doesn't restart dormant listening against their intent.
  const micUserOffRef = useRef(false);
  // Engine kind is transitional: read from the voice plugin's store.
  const sttProviderRef = useRef<"local" | "cloud">(
    readSttSettings().sttProvider ?? "local",
  );

  // Wake word: transitional read from the voice plugin's localStorage store.
  const [wakeWord, setWakeWord] = useState(
    () => readSttSettings().wakeWord ?? "",
  );
  const wakeRef = useRef("");
  wakeRef.current = normalizeWakeWord(wakeWord);
  const pendingWakeTimeout = useRef<number | null>(null);

  const speakingRef = useRef(speaking);
  speakingRef.current = speaking;
  const suppressUntilRef = useRef(0);
  const prevSpeakingRef = useRef(false);

  const suppressed = useCallback(
    () => speakingRef.current || Date.now() < suppressUntilRef.current,
    [],
  );

  // Barge-in toggle: host ui-prefs (localStorage "companion:ui").
  const [bargeInEnabled, setBargeInEnabled] = useState(readBargeIn);
  const bargeInRef = useRef(bargeInEnabled);
  bargeInRef.current = bargeInEnabled;

  useEffect(() => {
    if (speaking) {
      prevSpeakingRef.current = true;
      sttRef.current?.discardPending();
      return;
    }
    if (!prevSpeakingRef.current) return;
    prevSpeakingRef.current = false;
    suppressUntilRef.current = Date.now() + 1000;
    const t = window.setTimeout(() => {
      sttRef.current?.discardPending();
    }, 1050);
    return () => window.clearTimeout(t);
  }, [speaking]);

  const disarm = useCallback(() => {
    armedRef.current = false;
    setArmed(false);
    if (pendingWakeTimeout.current !== null) {
      window.clearTimeout(pendingWakeTimeout.current);
      pendingWakeTimeout.current = null;
    }
  }, []);

  const arm = useCallback(() => {
    armedRef.current = true;
    setArmed(true);
    if (pendingWakeTimeout.current !== null) window.clearTimeout(pendingWakeTimeout.current);
    pendingWakeTimeout.current = window.setTimeout(() => {
      disarm();
    }, 8000);
  }, [disarm]);

  useEffect(() => {
    clientRef.current = new RouterClient(
      api.provider,
      api.url,
      api.key,
      api.model,
      persona,
    );
  }, [api.provider, api.url, api.key, api.model, persona]);

  useEffect(() => () => { sttRef.current?.stop(); }, []);

  // Flush any pending debounced save on unmount.
  useEffect(() => () => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveChatHistory(historyRef.current);
    }
  }, []);

  const historyRef = useRef(history);
  historyRef.current = history;

  const commitHistory = useCallback((next: Msg[]) => {
    // The store snapshot is the single source of truth; the panel re-renders
    // through its subscription. Storage writes stay debounced (as in the
    // host); the unmount flush below forces any pending save.
    setHistorySnapshot(next);
    historyRef.current = next;
    persist(next);
  }, [persist]);

  // Resolve the pending ask_user tool call with `answer` ("" = skipped,
  // timed out or cancelled) and keep the Q&A in the transcript so it stays
  // in context for the next turn.
  const answerAsk = useCallback((answer: string) => {
    const ask = pendingAskRef.current;
    if (!ask) return false;
    pendingAskRef.current = null;
    setPendingAsk(null);
    if (askTimerRef.current !== null) {
      window.clearTimeout(askTimerRef.current);
      askTimerRef.current = null;
    }
    const text = answer.trim();
    if (text) {
      commitHistory([
        ...historyRef.current,
        { role: "assistant", text: `❓ ${ask.question}` },
        { role: "user", text },
      ]);
    }
    ask.resolve(text);
    return true;
  }, [commitHistory]);

  const answerAskRef = useRef(answerAsk);
  answerAskRef.current = answerAsk;

  // Turn ended without the question being answered (stop, error): release
  // the card so a stale prompt can't swallow the next message.
  const dismissAsk = useCallback(() => {
    answerAskRef.current("");
  }, []);

  // ask_user tool calls land here from the provider loop (net/ask-user
  // registry). The question is spoken through the normal token pipeline so
  // TTS says it; typing, voice, or an option button resolves the turn.
  useEffect(() => {
    const handler = (req: AskUserRequest) =>
      new Promise<string>((resolve) => {
        onTokenRef.current?.(` ${req.question}`);
        setPendingAsk({ ...req, resolve });
        if (askTimerRef.current !== null) window.clearTimeout(askTimerRef.current);
        askTimerRef.current = window.setTimeout(() => {
          askTimerRef.current = null;
          answerAskRef.current("");
        }, ASK_TIMEOUT_MS);
      });
    setAskUserHandler(handler);
    return () => {
      clearAskUserHandler(handler);
      if (askTimerRef.current !== null) {
        window.clearTimeout(askTimerRef.current);
        askTimerRef.current = null;
      }
    };
  }, []);

  // Alarm announcements land in the transcript so they stay in context for
  // the next LLM turn. Both reminder plugins fire host-global namespaced
  // events (plugin:<id>:alarm-fired); the host events.ts used to fan both
  // out to core listeners.
  useEffect(() => {
    const offs: Array<() => void> = [];
    const onFired = (payload: unknown) => {
      const p = (payload ?? {}) as { label?: string; message?: string };
      const text =
        [p.label, p.message].filter(Boolean).join(" — ") ||
        "Your alarm is going off.";
      const entry: Msg = { role: "assistant", text: `⏰ ${text}` };
      commitHistory([...historyRef.current, entry]);
    };
    for (const channel of [
      "plugin:alarms:alarm-fired",
      "plugin:calendar:alarm-fired",
    ]) {
      tauriListen<unknown>(channel, onFired)
        .then((off) => offs.push(off))
        .catch(() => {});
    }
    return () => { for (const off of offs) off(); };
  }, [commitHistory]);

  // Release the STT model memory once the mic stops for good (not on
  // restart). The pre-split voice plugin exposed no unload on the provider
  // surface, and the host command it invoked is gone since the plugin split;
  // the provider's own `stt.unload` route is not on the SDK service contract,
  // so this is a no-op until the SDK grows an unload method.
  const unloadSttIfIdle = useCallback(async () => {
    /* intentionally empty — see comment */
  }, []);

  // Shared provider turn: streams `wire` into TTS/chat and appends the final
  // assistant message to the live history when the turn completes.
  const runTurn = useCallback(async (wire: ChatMessage[]) => {
    isSendingRef.current = true;
    setSending(true);
    setErr(null);
    setStreaming("");
    setThinking("");
    // Custom emotions/motions from the library plugin can come and go
    // between turns; re-read the avatar's live capabilities.
    refreshAvatarCapabilities(ctx);
    onStreamStart();
    let acc = "";
    let thought = "";
    const flushStreaming = () => {
      streamRafRef.current = 0;
      setStreaming(acc);
    };
    const flushThinking = () => {
      thinkingRafRef.current = 0;
      setThinking(thought);
    };
    await clientRef.current!.chat(wire, {
      onToken: (t) => {
        acc += t;
        if (!streamRafRef.current) {
          streamRafRef.current = requestAnimationFrame(flushStreaming);
        }
        onStreamToken(t);
      },
      onThinking: (t) => {
        thought += t;
        if (!thinkingRafRef.current) {
          thinkingRafRef.current = requestAnimationFrame(flushThinking);
        }
      },
      onEmotion: (e) => {
        if (e) ctx.avatar.setEmotion(e);
      },
      onMotion: (m) => {
        if (m && m !== "none") ctx.avatar.triggerMotion(m);
      },
      onDone: (full) => {
        if (streamRafRef.current) {
          cancelAnimationFrame(streamRafRef.current);
          streamRafRef.current = 0;
        }
        if (thinkingRafRef.current) {
          cancelAnimationFrame(thinkingRafRef.current);
          thinkingRafRef.current = 0;
        }
        // Build from live history: an ask_user answer committed mid-turn
        // must survive into the final transcript (base is stale by then).
        const updated: Msg[] = [...historyRef.current, { role: "assistant", text: full }];
        commitHistory(updated);
        setStreaming("");
        setThinking("");
        isSendingRef.current = false;
        setSending(false);
        onStreamDone(full);
        const queued = pendingQueueRef.current.splice(0);
        if (queued.length > 0) sendTextRef.current(queued.join(" "));
      },
      onError: (e) => {
        if (streamRafRef.current) {
          cancelAnimationFrame(streamRafRef.current);
          streamRafRef.current = 0;
        }
        if (thinkingRafRef.current) {
          cancelAnimationFrame(thinkingRafRef.current);
          thinkingRafRef.current = 0;
        }
        setErr(e.message);
        setStreaming("");
        setThinking("");
        isSendingRef.current = false;
        setSending(false);
        dismissAsk();
      },
      onAbort: () => {
        // User-cancelled: silent reset, no error banner, queue dropped.
        if (streamRafRef.current) {
          cancelAnimationFrame(streamRafRef.current);
          streamRafRef.current = 0;
        }
        if (thinkingRafRef.current) {
          cancelAnimationFrame(thinkingRafRef.current);
          thinkingRafRef.current = 0;
        }
        setStreaming("");
        setThinking("");
        isSendingRef.current = false;
        setSending(false);
        dismissAsk();
      },
    });
  }, [ctx, onStreamStart, onStreamToken, onStreamDone, commitHistory, dismissAsk]);

  const sendText = useCallback(async (text: string) => {
    if (!text) return;
    // While a clarifying question is open, any typed message answers it
    // instead of starting a new turn.
    if (pendingAskRef.current) {
      setInput("");
      answerAskRef.current(text);
      return;
    }
    if (isSendingRef.current) {
      pendingQueueRef.current.push(text);
      return;
    }
    setInput("");
    const next: Msg[] = [...historyRef.current, { role: "user", text }];
    commitHistory(next);
    await runTurn(buildWire(next));
  }, [runTurn, commitHistory]);

  const stop = useCallback(() => {
    if (!isSendingRef.current) return;
    pendingQueueRef.current.splice(0);
    // Halt in-flight chat speech (host App.tsx stopChatSpeech).
    stopStream();
    ctx.services.tts().stop();
    clientRef.current?.cancel();
  }, [ctx, stopStream]);

  stopRef.current = stop;

  const sendTextRef = useRef(sendText);
  sendTextRef.current = sendText;

  const startStt = useCallback(async (mode: "manual" | "dormant") => {
    await sttRef.current?.stop();
    sttRef.current = null;
    setLiveText("");
    const gate = mode === "dormant" ? wakeRef.current : "";
    const callbacks = {
      onLive: (text: string) => {
        if (suppressed()) return;
        if (gate && !armedRef.current) return;
        setLiveText(text);
      },
      onEnd: async (text: string) => {
        setLiveText("");
        if (suppressed()) {
          sttRef.current?.discardPending();
          return;
        }
        if (!sttRef.current?.shouldSend(text)) return;
        // A pending clarifying question takes any spoken input as its
        // answer, bypassing the wake-word gate: the avatar just asked, no
        // wake word needed.
        if (pendingAskRef.current) {
          answerAskRef.current(text);
          return;
        }
        if (!gate) {
          sendTextRef.current(text);
          return;
        }
        if (armedRef.current) {
          disarm();
          sendTextRef.current(text);
          await startStt("dormant");
          return;
        }
        const { matched, command } = extractWakeCommand(text, gate);
        if (!matched) return;
        if (command) {
          sendTextRef.current(command);
          await startStt("dormant");
        } else {
          arm();
        }
      },
      onError: (e: string) => setErr(e),
    };
    // Engine chosen at start time via the STT service so a Voice-tab switch
    // applies on the next mic session without a restart. No voice plugin =
    // no recognition; surface it instead of failing silently.
    const sttServiceInstance = ctx.services.stt();
    if (!sttServiceInstance) {
      setErr("STT plugin not installed — speech recognition unavailable");
      return;
    }
    const stt: SttEngine = sttServiceInstance.createEngine(
      sttProviderRef.current === "cloud" ? "cloud" : "local",
      callbacks.onLive,
      callbacks.onEnd,
      callbacks.onError,
    );
    stt.setBargeInListener((energy) => {
      void energy;
      if (!bargeInRef.current || !isSendingRef.current) return;
      const now = Date.now();
      if (now - speechStartRef.current < 800) return;
      if (now - lastBargeRef.current < 1200) return;
      lastBargeRef.current = now;
      stopRef.current();
    });
    sttRef.current = stt;
    try {
      setMicActive(true);
      await stt.start();
    } catch (e) {
      setErr(String(e));
      setMicActive(false);
      sttRef.current = null;
    }
  }, [ctx, arm, disarm, suppressed]);

  useEffect(() => {
    disarm();
    if (!wakeRef.current) {
      (async () => {
        await sttRef.current?.stop();
        sttRef.current = null;
        setMicActive(false);
        setLiveText("");
        await unloadSttIfIdle();
      })();
      return;
    }
    // Respect an explicit user stop; the mic toggle re-enables dormant mode.
    if (micUserOffRef.current) return;
    startStt("dormant");
    return () => { sttRef.current?.stop(); sttRef.current = null; };
  }, [wakeWord, startStt, disarm, unloadSttIfIdle]);

  const toggleMic = useCallback(async () => {
    disarm();
    if (micActive) {
      // A click on the active mic must stop it in every mode. With a wake
      // word set, dormant listening must not auto-restart over the user.
      micUserOffRef.current = true;
      setMicActive(false);
      await sttRef.current?.stop();
      sttRef.current = null;
      setLiveText("");
      tauriEmit("mic-active-changed", false).catch(() => {});
      await unloadSttIfIdle();
    } else {
      micUserOffRef.current = false;
      await startStt(wakeRef.current ? "dormant" : "manual");
      if (!wakeRef.current) {
        tauriEmit("mic-active-changed", true).catch(() => {});
      }
    }
  }, [micActive, startStt, disarm, unloadSttIfIdle]);

  // Speech availability follows the live service registry: disabling (or
  // removing) the stt plugin unregisters its provider, so stop an active
  // session cleanly instead of leaving the mic running with its button gone.
  const sttAvailable = !!ctx.services.stt();
  useEffect(() => {
    if (sttAvailable || !micActive) return;
    micUserOffRef.current = true;
    setMicActive(false);
    void sttRef.current?.stop();
    sttRef.current = null;
    setLiveText("");
    tauriEmit("mic-active-changed", false).catch(() => {});
  }, [sttAvailable, micActive]);

  const toggleMicRef = useRef(toggleMic);
  toggleMicRef.current = toggleMic;
  // Host-global mic shortcut: App.tsx emits "mic-toggle"; the host events.ts
  // used to fan it out to the panel.
  useEffect(() => {
    let off: (() => void) | null = null;
    tauriListen("mic-toggle", () => {
      toggleMicRef.current();
    })
      .then((f) => {
        off = f;
      })
      .catch(() => {});
    return () => {
      off?.();
    };
  }, []);

  // Wake word + STT engine kind live updates: the settings window writes the
  // localStorage key; the DOM storage event fires here (different window,
  // same origin).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== null && e.key !== "companion:stt") return;
      const stt = readSttSettings();
      setWakeWord(stt.wakeWord ?? "");
      sttProviderRef.current = stt.sttProvider ?? "local";
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Barge-in toggle live updates via the host-global "ui-prefs-changed"
  // event (the host Interface section emits it on save).
  useEffect(() => {
    let off: (() => void) | null = null;
    tauriListen<{ bargeIn?: boolean }>("ui-prefs-changed", (p) => {
      setBargeInEnabled(p?.bargeIn !== false);
    })
      .then((f) => {
        off = f;
      })
      .catch(() => {});
    return () => {
      off?.();
    };
  }, []);

  // Keep the newest message in view: history, stream tokens, live transcript,
  // and errors all grow the tail of the list.
  const msgsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = msgsRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history, streaming, thinking, liveText, err]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    sendText(text);
  }, [input, sendText]);

  const { ConfirmModal } = ctx.ui as Record<string, any>;

  return (
    <div className="cp-root">
      <div className="cp-head">
        <span className="cp-head-title">Chat</span>
        {history.length > 0 && (
          <span className="cp-head-count">{history.length}</span>
        )}
        <span className="cp-head-spacer" />
        <button
          className="cp-clear"
          onClick={() => setConfirmClear(true)}
          disabled={sending || !history.length}
          title="Clear chat history"
          aria-label="Clear chat history"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 6h18" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
      </div>
      {confirmClear && (
        <ConfirmModal
          title="Clear chat?"
          message="Delete the whole conversation? This cannot be undone."
          confirmLabel="Clear"
          onClose={() => setConfirmClear(false)}
          onConfirm={clearHistory}
        />
      )}
      <div className="cp-msgs" ref={msgsRef}>
        {history.map((m, i) => (
          <MessageBubble key={i} role={m.role} text={m.text} />
        ))}
        {sending && !streaming && !thinking && (
          <div className="cp-waiting">
            <span className="cp-live-dot" />
            <span>thinking…</span>
          </div>
        )}
        {thinking && (
          <div className="cp-msg cp-msg-assistant">
            <div className="cp-think">
              <div className="cp-think-label">
                {/* Keyed: element + expression children compile to a dynamic
                    array, and React warns for keyless elements in it. */}
                <span className="cp-think-dot" key="dot" />
                {streaming ? "reasoned" : "thinking"}
              </div>
              <div className={`cp-think-text${streaming ? "" : " cp-bubble-streaming"}`}>
                {thinking.length > 600 ? `…${thinking.slice(-600)}` : thinking}
              </div>
            </div>
          </div>
        )}
        {streaming && (
          <MessageBubble role="assistant" text={streaming} streaming />
        )}
        {liveText && (
          <div className="cp-live">
            <span className="cp-live-dot" />
            <span>{liveText}</span>
          </div>
        )}
        {micActive && wakeRef.current && !liveText && (
          <div className="cp-wake">
            {armed ? "listening… go ahead" : `say “${wakeRef.current}”…`}
          </div>
        )}
        {err && <div className="cp-err">{err}</div>}
      </div>
      {pendingAsk && (
        <div className="cp-ask">
          <div className="cp-ask-q">{pendingAsk.question}</div>
          {pendingAsk.options && pendingAsk.options.length > 0 && (
            <div className="cp-ask-opts">
              {pendingAsk.options.map((o, i) => (
                <button
                  key={`${i}-${o}`}
                  className="cp-ask-opt"
                  onClick={() => answerAsk(o)}
                >
                  {o}
                </button>
              ))}
            </div>
          )}
          <div className="cp-ask-hint">
            type or say your answer
            {pendingAsk.options?.length ? " — or tap a choice" : ""} ·{" "}
            <button key="skip" className="cp-ask-skip" onClick={() => answerAsk("")}>
              skip
            </button>
          </div>
        </div>
      )}
      <ChatInput
        value={input}
        onChange={setInput}
        onSend={send}
        onToggleMic={toggleMic}
        micActive={micActive}
        micAvailable={!!ctx.services.stt()}
        sending={sending}
        onStop={stop}
      />
    </div>
  );
}
