// OpenAI-compatible chat client (Groq, Venice, etc.). Speaks the OpenAI wire format.
// Model comes from VENICE_MODEL env var; key from VENICE_API_KEY; base URL from
// VENICE_BASE_URL. Set VENICE_BASE_URL=https://api.groq.com/openai/v1 for Groq.

import { trace } from "@opentelemetry/api";

const tracer = trace.getTracer("attestpay-server");

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/** The injectable brain: NL messages in, raw assistant text out. Tests pass a fake. */
export type ChatFn = (messages: ChatMessage[]) => Promise<string>;

const DEFAULT_BASE = "https://api.groq.com/openai/v1";

const CHAT_TIMEOUT_MS = 20_000;
const CHAT_TIMEOUT_TRIES = 3; // 3 × 20s worst case

export function veniceChat(opts?: { apiKey?: string; model?: string; baseUrl?: string }): ChatFn {
  const apiKey = opts?.apiKey ?? process.env.VENICE_API_KEY;
  const model = opts?.model ?? process.env.VENICE_MODEL ?? "llama-3.3-70b-versatile";
  const base = opts?.baseUrl ?? process.env.VENICE_BASE_URL ?? DEFAULT_BASE;
  return async (messages: ChatMessage[]) => {
    return tracer.startActiveSpan("nl_compile", async (span) => {
      span.setAttribute("model_id", model);
      if (!apiKey) throw new Error("VENICE_API_KEY not configured");
      let lastTimeout: Error | null = null;
      for (let attempt = 0; attempt < CHAT_TIMEOUT_TRIES; attempt++) {
        let res: Response;
        try {
          res = await fetch(`${base}/chat/completions`, {
            method: "POST",
            headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
            body: JSON.stringify({
              model,
              messages,
              temperature: 0,
            }),
            signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
          });
        } catch (e) {
          if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) {
            lastTimeout = new Error(`chat: no response within ${CHAT_TIMEOUT_MS / 1000}s`);
            continue;
          }
          throw e;
        }
        const text = await res.text();
        if (!res.ok) throw new Error(`chat ${res.status}: ${text.slice(0, 300)}`);
        let json: { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
        try {
          json = JSON.parse(text);
        } catch {
          throw new Error(`chat: non-JSON response: ${text.slice(0, 200)}`);
        }
        if (json.usage) {
          span.setAttribute("prompt_tokens", json.usage.prompt_tokens ?? 0);
          span.setAttribute("completion_tokens", json.usage.completion_tokens ?? 0);
        }
        const content = json.choices?.[0]?.message?.content;
        if (typeof content !== "string") throw new Error("chat: no message content");
        span.end();
        return content;
      }
      const err = lastTimeout ?? new Error("chat: no response");
      span.recordException(err);
      span.setStatus({ code: 2, message: err.message });
      span.end();
      throw err;
    });
  };
}

/** Pull the first JSON object out of a model reply (handles ```json fences + prose).
 * Fenced block wins when it parses; otherwise every `{` is tried as the start of a
 * balanced object, so stray braces in surrounding prose can't poison the slice. */
export function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]!.trim());
    } catch {
      // fall through: fence held prose or a fragment; scan the full reply
    }
  }
  for (let start = raw.indexOf("{"); start !== -1; start = raw.indexOf("{", start + 1)) {
    const end = matchBalancedBrace(raw, start);
    if (end === -1) continue;
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      // not JSON from this brace (e.g. "{placeholder}" in prose); try the next one
    }
  }
  throw new Error("no JSON object in model reply");
}

/** Index of the `}` closing the `{` at `start`, string-aware; -1 if unbalanced. */
function matchBalancedBrace(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escaped) {
      escaped = false;
    } else if (ch === "\\") {
      if (inString) escaped = true;
    } else if (ch === '"') {
      inString = !inString;
    } else if (!inString) {
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return i;
      }
    }
  }
  return -1;
}
