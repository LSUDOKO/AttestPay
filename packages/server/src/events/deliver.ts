// Webhook delivery: signed POSTs with retry and a dead-letter state.
//
// Signature scheme (the one Stripe made everyone's default, so every consumer already
// has code for it): `X-AttestPay-Signature: t=<unix>,v1=<hex hmac-sha256>` where the
// signed string is `${t}.${body}` and the key is the webhook's secret. The timestamp
// in the signature lets a receiver reject replays older than it likes.
//
// Backoff is fixed and short-ish (30s, 2m, 10m, 1h, 6h): five attempts over ~7 hours,
// then the delivery is `dead` and shows up as such in the dashboard, where it can be
// retried by hand once the endpoint is fixed.

import { createHmac } from "node:crypto";
import { decryptSecret } from "@attestpay/engine";
import type { DeliveryRow, EventStore } from "./store";

export const WEBHOOK_BACKOFF_S = [30, 120, 600, 3600, 21600] as const;
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_BACKOFF_S.length;
export const WEBHOOK_TIMEOUT_MS = 10_000;

export function signWebhook(secret: string, timestamp: number, body: string): string {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

/** Verifies a signature header against a body, with a replay window. Exported so
 * the SDK and receivers can use exactly the same logic. */
export function verifyWebhookSignature(
  secret: string,
  header: string,
  body: string,
  opts: { now?: number; toleranceSeconds?: number } = {},
): boolean {
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=") as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) return false;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (opts.toleranceSeconds ?? 300)) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  // Constant-time compare on equal-length hex.
  if (expected.length !== parts.v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ parts.v1.charCodeAt(i);
  return diff === 0;
}

export type DeliverResult = { attempted: number; delivered: number; failed: number; dead: number };

/** Attempts every due delivery once. Never throws. */
export async function deliverWebhooks(
  events: EventStore,
  opts: { fetch?: typeof fetch; now?: () => number; limit?: number; timeoutMs?: number; only?: string } = {},
): Promise<DeliverResult> {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const doFetch = opts.fetch ?? fetch;
  const result: DeliverResult = { attempted: 0, delivered: 0, failed: 0, dead: 0 };

  const due = opts.only ? [events.getDelivery(opts.only)].filter((d): d is DeliveryRow => d !== null) : events.dueDeliveries(now(), opts.limit ?? 50);
  for (const d of due) {
    result.attempted += 1;
    const webhook = events.getWebhook(d.webhook_id);
    if (!webhook || !webhook.active) {
      events.markFailed(d.id, null, "webhook removed or paused", now(), true);
      result.dead += 1;
      continue;
    }

    let secret: string;
    try {
      secret = await decryptSecret(webhook.secret_enc);
    } catch (e) {
      events.markFailed(d.id, null, `secret unreadable: ${e instanceof Error ? e.message : String(e)}`, now(), true);
      result.dead += 1;
      continue;
    }

    const ts = now();
    const body = d.payload_json;
    let code: number | null = null;
    let error: string | null = null;
    try {
      const res = await doFetch(webhook.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "AttestPay-Webhooks/1",
          "x-attestpay-event": d.event_type,
          "x-attestpay-delivery": d.id,
          "x-attestpay-signature": signWebhook(secret, ts, body),
        },
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? WEBHOOK_TIMEOUT_MS),
        redirect: "manual",
      });
      code = res.status;
      if (res.status >= 200 && res.status < 300) {
        events.markDelivered(d.id, res.status, now());
        result.delivered += 1;
        continue;
      }
      error = `endpoint answered ${res.status}`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    const attempts = d.attempts + 1;
    const dead = attempts >= WEBHOOK_MAX_ATTEMPTS;
    const wait = WEBHOOK_BACKOFF_S[Math.min(attempts, WEBHOOK_BACKOFF_S.length) - 1] ?? 21600;
    events.markFailed(d.id, code, error ?? "unknown", now() + wait, dead);
    if (dead) result.dead += 1;
    else result.failed += 1;
  }
  return result;
}

/** Webhook URL policy: https to a public host, unless local delivery is allowed for
 * development. Same reasoning as paid_fetch's SSRF guard: the server must not be
 * turned into a probe of its own network. */
export function checkWebhookUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "malformed URL";
  }
  const allowLocal = process.env.ATTESTPAY_WEBHOOK_ALLOW_LOCAL === "1";
  if (url.protocol !== "https:" && !(allowLocal && url.protocol === "http:")) return "webhook URLs must be https";
  if (!allowLocal && hostIsPrivate(url.hostname)) return "webhook URLs must not point at private networks";
  if (url.username || url.password) return "webhook URLs must not carry credentials";
  return null;
}

function hostIsPrivate(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "::1" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}
