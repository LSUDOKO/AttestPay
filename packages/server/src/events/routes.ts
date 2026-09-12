// Dashboard REST surface for webhooks, the event outbox, the audit log and alert
// settings. Mounted under /api; scoping comes from the parent router like the other
// sub-routers, so a Privy user sees only their own webhooks, events and audit trail.

import { Hono } from "hono";
import type { Context } from "hono";
import { RefusalError, encryptSecret, type CardRow } from "@attestpay/engine";
import type { ApiEnv } from "../api/routes";
import type { AppDeps } from "../deps";
import { EVENT_TYPES, type AuditRow, type DeliveryRow, type EventType, type WebhookRow } from "./store";
import { checkWebhookUrl, deliverWebhooks } from "./deliver";
import type { Actor } from "../attestcoin/credit-routes";

export type OwnedCardResolver = (c: Context<ApiEnv>, id: string, level?: "read" | "control" | "manage") => CardRow;
export type Handle = (c: Context<ApiEnv>, fn: () => Promise<unknown>) => Promise<Response>;
export type ActorResolver = (c: Context<ApiEnv>, requestedUserId?: string) => Actor;

const iso = (sec: number | null): string | null => (sec === null ? null : new Date(sec * 1000).toISOString());
const actorId = (a: Actor): string => (a.kind === "admin" ? a.userId : a.user.id);

const randomSecret = (): string => `whsec_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;

export function eventRoutes(deps: AppDeps, ownedCard: OwnedCardResolver, handle: Handle, actor: ActorResolver): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  const now = () => Math.floor(Date.now() / 1000);
  const bus = () => {
    if (!deps.events) throw new RefusalError("invalid_terms", "events are not enabled on this deployment");
    return deps.events;
  };

  /** A webhook the actor owns, or not-found. */
  const ownedWebhook = (a: Actor, id: string): WebhookRow => {
    const w = bus().events.getWebhook(id);
    // Both lanes act AS a user here: the ops token picks one via userId, and sees
    // only that user's webhooks, same as a Privy session sees its own.
    if (!w || w.user_id !== actorId(a)) throw new RefusalError("card_not_found", "no such webhook");
    return w;
  };

  // -----------------------------------------------------------------------
  // Webhooks
  // -----------------------------------------------------------------------

  app.post("/webhooks", (c) =>
    handle(c, async () => {
      const b = bus();
      const body = (await c.req.json().catch(() => ({}))) as { url?: string; events?: string[]; description?: string; userId?: string };
      const a = actor(c, body.userId);
      if (!body.url) throw new RefusalError("invalid_terms", "url is required");
      const problem = checkWebhookUrl(body.url);
      if (problem) throw new RefusalError("invalid_terms", problem);
      const events = body.events && body.events.length ? body.events : ["*"];
      for (const e of events) {
        if (e !== "*" && !(EVENT_TYPES as readonly string[]).includes(e)) throw new RefusalError("invalid_terms", `unknown event type ${e}`);
      }
      if (b.events.listWebhooks(actorId(a)).length >= 20) throw new RefusalError("invalid_terms", "at most 20 webhooks per account");

      const secret = randomSecret();
      const row = b.events.createWebhook(
        { user_id: actorId(a), url: body.url, secret_enc: await encryptSecret(secret), events, description: body.description?.slice(0, 200) ?? null },
        now(),
      );
      b.audit(auditActor(a), "webhook.created", { type: "webhook", id: row.id }, { url: row.url, events }, ip(c));
      // The secret is shown exactly once.
      return { ...webhookView(row), secret };
    }),
  );

  app.get("/webhooks", (c) =>
    handle(c, async () => {
      if (!deps.events) return { configured: false, items: [], event_types: EVENT_TYPES };
      const a = actor(c, c.req.query("userId"));
      return { configured: true, items: deps.events.events.listWebhooks(actorId(a)).map(webhookView), event_types: EVENT_TYPES };
    }),
  );

  app.delete("/webhooks/:id", (c) =>
    handle(c, async () => {
      const b = bus();
      const a = actor(c, c.req.query("userId"));
      const w = ownedWebhook(a, c.req.param("id"));
      b.events.deleteWebhook(w.id);
      b.audit(auditActor(a), "webhook.deleted", { type: "webhook", id: w.id }, undefined, ip(c));
      return { deleted: true };
    }),
  );

  app.post("/webhooks/:id/pause", (c) =>
    handle(c, async () => {
      const b = bus();
      const body = (await c.req.json().catch(() => ({}))) as { active?: boolean; userId?: string };
      const a = actor(c, body.userId);
      const w = ownedWebhook(a, c.req.param("id"));
      const active = body.active === true;
      b.events.setWebhookActive(w.id, active, now());
      return { ...webhookView(b.events.getWebhook(w.id)!) };
    }),
  );

  /** Sends a `webhook.test` event to this one webhook and attempts delivery now. */
  app.post("/webhooks/:id/test", (c) =>
    handle(c, async () => {
      const b = bus();
      const body = (await c.req.json().catch(() => ({}))) as { userId?: string };
      const a = actor(c, body.userId);
      const w = ownedWebhook(a, c.req.param("id"));
      const ev = b.events.insertEvent({ type: "webhook.test", user_id: w.user_id, card_id: null, data: { webhook_id: w.id, message: "hello from AttestPay" }, created_at: now() });
      const payload = JSON.stringify({ id: ev.id, type: ev.type, created_at: new Date(ev.created_at * 1000).toISOString(), card_id: null, data: ev.data });
      const d = b.events.enqueueDelivery({ webhook_id: w.id, event_id: ev.id, event_type: "webhook.test", payload_json: payload }, now());
      const r = await deliverWebhooks(b.events, { only: d.id });
      return { delivery: deliveryView(b.events.getDelivery(d.id)!), result: r };
    }),
  );

  app.get("/webhooks/:id/deliveries", (c) =>
    handle(c, async () => {
      const b = bus();
      const a = actor(c, c.req.query("userId"));
      const w = ownedWebhook(a, c.req.param("id"));
      return { items: b.events.listDeliveries(w.id).map(deliveryView) };
    }),
  );

  app.post("/webhooks/:id/deliveries/:did/retry", (c) =>
    handle(c, async () => {
      const b = bus();
      const body = (await c.req.json().catch(() => ({}))) as { userId?: string };
      const a = actor(c, body.userId);
      const w = ownedWebhook(a, c.req.param("id"));
      const d = b.events.getDelivery(c.req.param("did"));
      if (!d || d.webhook_id !== w.id) throw new RefusalError("card_not_found", "no such delivery");
      const rearmed = b.events.retryDelivery(d.id, now());
      const r = rearmed ? await deliverWebhooks(b.events, { only: d.id }) : null;
      return { retried: rearmed, delivery: deliveryView(b.events.getDelivery(d.id)!), result: r };
    }),
  );

  // -----------------------------------------------------------------------
  // Events + audit
  // -----------------------------------------------------------------------

  app.get("/events", (c) =>
    handle(c, async () => {
      if (!deps.events) return { configured: false, items: [] };
      const a = actor(c, c.req.query("userId"));
      const limit = Math.min(Number(c.req.query("limit") ?? 100) || 100, 500);
      const cardId = c.req.query("card_id") ?? undefined;
      if (cardId) ownedCard(c, cardId, "read");
      const items = deps.events.events.listEvents(a.kind === "admin" && c.req.query("all") === "1" ? null : actorId(a), limit, cardId);
      return { configured: true, items: items.map((e) => ({ ...e, created_at: iso(e.created_at) })) };
    }),
  );

  app.get("/audit", async (c) => {
    // CSV bypasses `handle` (which JSON-encodes every return); the JSON shape goes
    // through it like every other route. Scoping is identical on both paths.
    const q = c.req.query();
    const compute = () => {
      if (!deps.events) return null;
      const a = actor(c, q.userId);
      const cardId = q.card_id;
      if (cardId) ownedCard(c, cardId, "read");
      const scope =
        a.kind === "admin" && q.all === "1"
          ? null
          : { userId: actorId(a), cardIds: deps.store.listCards(actorId(a)).map((card) => card.id) };
      return deps.events.events.listAudit({
        scope,
        from: q.from ? Number(q.from) : undefined,
        to: q.to ? Number(q.to) : undefined,
        cardId,
        action: q.action,
        limit: q.limit ? Number(q.limit) : undefined,
      });
    };
    if (q.format === "csv") {
      let rows: AuditRow[] | null;
      try {
        rows = compute();
      } catch (e) {
        if (e instanceof RefusalError) return c.json(e.toJSON(), 422);
        return c.json({ status: "error", message: e instanceof Error ? e.message : String(e) }, 500);
      }
      return new Response(auditCsv(rows ?? []), {
        status: 200,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="attestpay-audit-${now()}.csv"`,
        },
      });
    }
    return handle(c, async () => {
      const rows = compute();
      if (rows === null) return { configured: false, items: [] };
      return { configured: true, items: rows.map(auditView) };
    });
  });

  // -----------------------------------------------------------------------
  // Per-card alert settings
  // -----------------------------------------------------------------------

  app.get("/cards/:id/alerts", (c) =>
    handle(c, async () => {
      const card = ownedCard(c, c.req.param("id"), "read");
      return { card_id: card.id, threshold_pct: deps.events?.events.getAlertThreshold(card.id) ?? 20, configured: Boolean(deps.events) };
    }),
  );

  app.put("/cards/:id/alerts", (c) =>
    handle(c, async () => {
      const b = bus();
      const card = ownedCard(c, c.req.param("id"), "control");
      const body = (await c.req.json().catch(() => ({}))) as { threshold_pct?: number; userId?: string };
      const a = actor(c, body.userId);
      const pct = Number(body.threshold_pct);
      if (!Number.isInteger(pct) || pct < 0 || pct > 100) throw new RefusalError("invalid_terms", "threshold_pct must be an integer 0..100");
      b.events.setAlertThreshold(card.id, pct, now());
      b.audit(auditActor(a), "card.alerts_updated", { type: "card", id: card.id }, { threshold_pct: pct }, ip(c));
      return { card_id: card.id, threshold_pct: pct };
    }),
  );

  return app;
}

function ip(c: Context): string | null {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
}

export function auditActor(a: Actor): { kind: "admin" | "user"; id: string } {
  return a.kind === "admin" ? { kind: "admin", id: `admin:${a.userId}` } : { kind: "user", id: a.user.id };
}

function webhookView(w: WebhookRow) {
  return {
    webhook_id: w.id,
    url: w.url,
    events: w.events,
    description: w.description,
    active: w.active,
    created_at: iso(w.created_at),
    updated_at: iso(w.updated_at),
  };
}

function deliveryView(d: DeliveryRow) {
  return {
    delivery_id: d.id,
    event_id: d.event_id,
    event_type: d.event_type as EventType,
    status: d.status,
    attempts: d.attempts,
    next_attempt_at: iso(d.next_attempt_at),
    last_status_code: d.last_status_code,
    last_error: d.last_error,
    created_at: iso(d.created_at),
    delivered_at: iso(d.delivered_at),
  };
}

function auditView(r: AuditRow) {
  return {
    id: r.id,
    at: iso(r.at),
    actor: `${r.actor_kind}:${r.actor_id}`,
    action: r.action,
    target: `${r.target_type}:${r.target_id}`,
    detail: r.detail,
    ip: r.ip,
  };
}

export function auditCsv(rows: AuditRow[]): string {
  const esc = (v: unknown): string => {
    const s = v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ["id", "at", "actor_kind", "actor_id", "action", "target_type", "target_id", "detail", "ip"];
  const lines = rows.map((r) => [r.id, iso(r.at), r.actor_kind, r.actor_id, r.action, r.target_type, r.target_id, r.detail, r.ip].map(esc).join(","));
  return [head.join(","), ...lines].join("\n") + "\n";
}
