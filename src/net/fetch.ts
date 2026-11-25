// HTTP plumbing shared by the chat providers — vendored from the host's
// app/src/net/fetch.ts (doFetch/canStream/throwIfHttpError) plus the voice
// plugin's compact port of @tauri-apps/plugin-http's fetch(). The tauri
// branch cannot import @tauri-apps/plugin-http (not resolvable from
// features/), so tauriFetch below only needs invoke(), which comes from the
// vendored tauri bridge. Requests ride the Rust backend instead of the
// webview, so they are not subject to CORS; plain fetch covers non-Tauri runs.

import { isTauri, tauriInvoke } from "../tauri";

export async function doFetch(url: string, init: RequestInit): Promise<Response> {
  // Body size only — media-bearing bodies are multi-MB and logging them
  // whole stalls the webview main thread right before the request.
  const body = init.body;
  const size =
    typeof body === "string"
      ? body.length
      : body instanceof Blob
        ? body.size
        : body == null
          ? 0
          : -1;
  console.log(`${init.method ?? "GET"} ${url} (${size < 0 ? "?" : size} byte body)`);
  // The one-liner above says nothing about WHAT is being sent. The full body
  // goes on its own line — pretty-printed when it's JSON — so the Settings >
  // Logs panel can show the exact request to the LLM. Big bodies (media
  // attachments riding as base64) stay a raw peek: parsing and re-stringify-
  // ing multi-MB JSON would stall the webview right before the request.
  if (typeof body === "string" && body) {
    const peek =
      body.length > PRETTY_BODY_MAX
        ? body.slice(0, 3000) + `… (+${body.length - 3000} chars)`
        : prettyBody(body);
    console.log(`${init.method ?? "GET"} ${url} body:\n${peek}`);
  }
  if (isTauri()) {
    return tauriFetch(url, init);
  }
  return fetch(url, init);
}

// Bodies up to this size are pretty-printed in full; the Logs sink keeps a
// bounded entry per line, so a pretty-printed LLM request (typically well
// under 30 KB) survives the sink's per-message cap intact.
const PRETTY_BODY_MAX = 20_000;

function prettyBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    // Not JSON (form posts etc.) — log it raw.
    return body;
  }
}

export function canStream(res: Response): boolean {
  return !!res.body && typeof res.body.getReader === "function";
}

export async function throwIfHttpError(res: Response): Promise<void> {
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
}

// --- Minimal port of @tauri-apps/plugin-http fetch() ---

const ERROR_REQUEST_CANCELLED = "Request cancelled";

async function tauriFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const signal = init?.signal;
  if (signal?.aborted) throw new Error(ERROR_REQUEST_CANCELLED);

  // Strip the plugin's client-option extensions before building the Request.
  const inner = { ...(init ?? {}) } as RequestInit & {
    maxRedirections?: number;
    connectTimeout?: number;
    proxy?: unknown;
    danger?: unknown;
  };
  const maxRedirections = inner.maxRedirections;
  const connectTimeout = inner.connectTimeout;
  const proxy = inner.proxy;
  const danger = inner.danger;
  delete inner.maxRedirections;
  delete inner.connectTimeout;
  delete inner.proxy;
  delete inner.danger;

  const headers = inner.headers
    ? inner.headers instanceof Headers
      ? inner.headers
      : new Headers(inner.headers)
    : new Headers();
  const req = new Request(input, inner);
  const buffer = await req.arrayBuffer();
  const data = buffer.byteLength !== 0 ? Array.from(new Uint8Array(buffer)) : null;
  // Append browser-created headers (Content-Type etc.) not already declared.
  for (const [key, value] of req.headers) {
    if (!headers.get(key)) headers.set(key, value);
  }
  const mappedHeaders = Array.from(headers.entries()).map(([name, val]) => [
    name,
    typeof val === "string" ? val : String(val),
  ]);

  if (signal?.aborted) throw new Error(ERROR_REQUEST_CANCELLED);

  const rid = await tauriInvoke<number>("plugin:http|fetch", {
    clientConfig: {
      method: req.method,
      url: req.url,
      headers: mappedHeaders,
      data,
      maxRedirections,
      connectTimeout,
      proxy,
      danger,
    },
  });

  const abort = () => void tauriInvoke("plugin:http|fetch_cancel", { rid }).catch(() => {});
  signal?.addEventListener("abort", () => void abort());

  const { status, statusText, url: resUrl, headers: responseHeaders, rid: responseRid } =
    await tauriInvoke<{
      status: number;
      statusText: string;
      url: string;
      headers: [string, string][];
      rid: number;
    }>("plugin:http|fetch_send", { rid });

  let bodyDropped = false;
  const dropBody = () => {
    if (bodyDropped) return Promise.resolve();
    bodyDropped = true;
    return tauriInvoke("plugin:http|fetch_cancel_body", { rid: responseRid }).catch(() => {});
  };
  const readChunk = async (controller: ReadableStreamDefaultController<Uint8Array>) => {
    let data: number[];
    try {
      data = await tauriInvoke<number[]>("plugin:http|fetch_read_body", { rid: responseRid });
    } catch (e) {
      controller.error(e);
      void dropBody();
      return;
    }
    const dataUint8 = new Uint8Array(data);
    // The IPC signals stream end with a trailing 1 byte.
    const lastByte = dataUint8[dataUint8.byteLength - 1];
    const actualData = dataUint8.slice(0, dataUint8.byteLength - 1);
    if (lastByte === 1) {
      controller.close();
      return;
    }
    controller.enqueue(actualData);
  };

  // No body for 101, 103, 204, 205 and 304 (fetch spec null-body statuses).
  const body = [101, 103, 204, 205, 304].includes(status)
    ? null
    : new ReadableStream<Uint8Array>({
        start: (controller) => {
          signal?.addEventListener("abort", () => {
            controller.error(ERROR_REQUEST_CANCELLED);
            void dropBody();
          });
        },
        pull: (controller) => readChunk(controller),
        cancel: () => {
          void dropBody();
        },
      });

  const res = new Response(body, { status, statusText });
  Object.defineProperty(res, "url", { value: resUrl, writable: false });
  Object.defineProperty(res, "headers", {
    value: new Headers(responseHeaders),
    writable: false,
  });
  return res;
}
