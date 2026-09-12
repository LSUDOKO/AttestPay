// Persistence for events, webhooks, deliveries, the audit log and alert settings.
//
// Rides the engine's sqlite database like the OAuth store. Nothing here is money:
// events are an outbox of things that already happened, deliveries are attempts to
// tell someone, the audit log is who did what. All three are append-mostly, which is
// why they live apart from the card/charge tables the spend path locks.
//
// Webhook secrets are envelope-encrypted with the master key (the same primitive
// that protects agent keys): a delivery must be able to sign with the plaintext, so
// a hash is not enough, and a plaintext column would make the database a secret store.

import type { Database } from "bun:sqlite";

export const EVENT_TYPES = [
  "card.issued",
  "card.frozen",
  "card.unfrozen",
  "card.revoked",
  "card.nuked",
  "card.deleted",
  "card.secret_rotated",
  "charge.confirmed",
  "proof.verified",
  "proof.failed",
  "fact.verified",
  "fact.failed",
  "credit_line.proposed",
  "credit_line.signed",
  "credit_line.opened",
  "credit_line.drawn",
  "credit_line.repaid",
  "dispute.opened",
  "dispute.resolved",
  "budget.low",
  "webhook.test",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type EventRow = {
  id: string;
  type: EventType;
  user_id: string | null;
  card_id: string | null;
  data: Record<string, unknown>;
  created_at: number;
};

export type WebhookRow = {
  id: string;
  user_id: string;
  url: string;
  secret_enc: Uint8Array;
  /** Subscribed types, or ["*"] for everything. */
  events: string[];
  description: string | null;
  active: boolean;
  created_at: number;
  updated_at: number;
};

export type DeliveryStatus = "pending" | "delivered" | "failed" | "dead";

export type DeliveryRow = {
  id: string;
  webhook_id: string;
  event_id: string;
  event_type: EventType;
  payload_json: string;
  status: DeliveryStatus;
  attempts: number;
  next_attempt_at: number;
  last_status_code: number | null;
  last_error: string | null;
  created_at: number;
  delivered_at: number | null;
};

export type AuditRow = {
  id: number;
  at: number;
  actor_kind: "admin" | "user" | "card" | "system";
  actor_id: string;
  action: string;
  target_type: string;
  target_id: string;
  detail: Record<string, unknown> | null;
  ip: string | null;
};

export type AuditQuery = {
  /** Restrict to this actor / these cards (a user's own view). Null = everything (admin). */
  scope: { userId: string; cardIds: string[] } | null;
  from?: number;
  to?: number;
  cardId?: string;
  action?: string;
  limit?: number;
};

const newId = (prefix: string): string => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

export class EventStore {
  constructor(readonly db: Database) {
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        user_id TEXT,
        card_id TEXT,
        data_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_events_card ON events(card_id, created_at);

      CREATE TABLE IF NOT EXISTS webhooks (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        url TEXT NOT NULL,
        secret_enc BLOB NOT NULL,
        events_json TEXT NOT NULL,
        description TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_webhooks_user ON webhooks(user_id, created_at);

      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id TEXT PRIMARY KEY,
        webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
        event_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_status_code INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_deliveries_due ON webhook_deliveries(status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_deliveries_webhook ON webhook_deliveries(webhook_id, created_at);

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        actor_kind TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        detail_json TEXT,
        ip TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
      CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id, at);
      CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target_id, at);

      CREATE TABLE IF NOT EXISTS card_settings (
        card_id TEXT PRIMARY KEY,
        alert_threshold_pct INTEGER NOT NULL DEFAULT 20,
        updated_at INTEGER NOT NULL
      );

      -- One low-budget alert per card per period window.
      CREATE TABLE IF NOT EXISTS budget_alerts (
        card_id TEXT NOT NULL,
        window_start INTEGER NOT NULL,
        sent_at INTEGER NOT NULL,
        PRIMARY KEY (card_id, window_start)
      );
    `);
  }

  // ---- events ----

  insertEvent(ev: Omit<EventRow, "id"> & { id?: string }): EventRow {
    const row: EventRow = { ...ev, id: ev.id ?? newId("evt") };
    this.db
      .query(`INSERT INTO events (id, type, user_id, card_id, data_json, created_at) VALUES ($id, $type, $u, $c, $d, $at)`)
      .run({ $id: row.id, $type: row.type, $u: row.user_id, $c: row.card_id, $d: JSON.stringify(row.data), $at: row.created_at });
    return row;
  }

  private static eventRow(r: Record<string, unknown>): EventRow {
    return {
      id: r.id as string,
      type: r.type as EventType,
      user_id: (r.user_id as string) ?? null,
      card_id: (r.card_id as string) ?? null,
      data: JSON.parse(r.data_json as string),
      created_at: r.created_at as number,
    };
  }

  listEvents(userId: string | null, limit = 100, cardId?: string): EventRow[] {
    const where: string[] = [];
    const params: Record<string, unknown> = { $l: limit };
    if (userId !== null) {
      where.push("user_id = $u");
      params.$u = userId;
    }
    if (cardId) {
      where.push("card_id = $c");
      params.$c = cardId;
    }
    const rows = this.db
      .query(`SELECT * FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT $l`)
      .all(params as never) as Record<string, unknown>[];
    return rows.map(EventStore.eventRow);
  }

  getEvent(id: string): EventRow | null {
    const r = this.db.query(`SELECT * FROM events WHERE id = $id`).get({ $id: id }) as Record<string, unknown> | null;
    return r ? EventStore.eventRow(r) : null;
  }

  // ---- webhooks ----

  createWebhook(w: Omit<WebhookRow, "id" | "created_at" | "updated_at" | "active">, now: number): WebhookRow {
    const row: WebhookRow = { ...w, id: newId("whk"), active: true, created_at: now, updated_at: now };
    this.db
      .query(
        `INSERT INTO webhooks (id, user_id, url, secret_enc, events_json, description, active, created_at, updated_at)
         VALUES ($id, $u, $url, $sec, $ev, $desc, 1, $now, $now)`,
      )
      .run({ $id: row.id, $u: row.user_id, $url: row.url, $sec: row.secret_enc, $ev: JSON.stringify(row.events), $desc: row.description, $now: now });
    return row;
  }

  private static webhookRow(r: Record<string, unknown>): WebhookRow {
    return {
      id: r.id as string,
      user_id: r.user_id as string,
      url: r.url as string,
      secret_enc: new Uint8Array(r.secret_enc as Uint8Array),
      events: JSON.parse(r.events_json as string),
      description: (r.description as string) ?? null,
      active: (r.active as number) === 1,
      created_at: r.created_at as number,
      updated_at: r.updated_at as number,
    };
  }

  getWebhook(id: string): WebhookRow | null {
    const r = this.db.query(`SELECT * FROM webhooks WHERE id = $id`).get({ $id: id }) as Record<string, unknown> | null;
    return r ? EventStore.webhookRow(r) : null;
  }

  listWebhooks(userId: string): WebhookRow[] {
    const rows = this.db.query(`SELECT * FROM webhooks WHERE user_id = $u ORDER BY created_at`).all({ $u: userId }) as Record<string, unknown>[];
    return rows.map(EventStore.webhookRow);
  }

  /** Active webhooks of a user subscribed to `type` (or to everything). */
  subscribers(userId: string, type: EventType): WebhookRow[] {
    return this.listWebhooks(userId).filter((w) => w.active && (w.events.includes("*") || w.events.includes(type)));
  }

  setWebhookActive(id: string, active: boolean, now: number): void {
    this.db.query(`UPDATE webhooks SET active = $a, updated_at = $now WHERE id = $id`).run({ $a: active ? 1 : 0, $now: now, $id: id });
  }

  deleteWebhook(id: string): void {
    this.db.query(`DELETE FROM webhook_deliveries WHERE webhook_id = $id`).run({ $id: id });
    this.db.query(`DELETE FROM webhooks WHERE id = $id`).run({ $id: id });
  }

  // ---- deliveries ----

  enqueueDelivery(d: { webhook_id: string; event_id: string; event_type: EventType; payload_json: string }, now: number): DeliveryRow {
    const row: DeliveryRow = {
      id: newId("dlv"),
      ...d,
      status: "pending",
      attempts: 0,
      next_attempt_at: now,
      last_status_code: null,
      last_error: null,
      created_at: now,
      delivered_at: null,
    };
    this.db
      .query(
        `INSERT INTO webhook_deliveries (id, webhook_id, event_id, event_type, payload_json, status, attempts, next_attempt_at, created_at)
         VALUES ($id, $w, $e, $t, $p, 'pending', 0, $next, $now)`,
      )
      .run({ $id: row.id, $w: row.webhook_id, $e: row.event_id, $t: row.event_type, $p: row.payload_json, $next: now, $now: now });
    return row;
  }

  private static deliveryRow(r: Record<string, unknown>): DeliveryRow {
    return {
      id: r.id as string,
      webhook_id: r.webhook_id as string,
      event_id: r.event_id as string,
      event_type: r.event_type as EventType,
      payload_json: r.payload_json as string,
      status: r.status as DeliveryStatus,
      attempts: r.attempts as number,
      next_attempt_at: r.next_attempt_at as number,
      last_status_code: (r.last_status_code as number) ?? null,
      last_error: (r.last_error as string) ?? null,
      created_at: r.created_at as number,
      delivered_at: (r.delivered_at as number) ?? null,
    };
  }

  getDelivery(id: string): DeliveryRow | null {
    const r = this.db.query(`SELECT * FROM webhook_deliveries WHERE id = $id`).get({ $id: id }) as Record<string, unknown> | null;
    return r ? EventStore.deliveryRow(r) : null;
  }

  /** Deliveries whose retry time has come, oldest first. */
  dueDeliveries(now: number, limit = 50): DeliveryRow[] {
    const rows = this.db
      .query(`SELECT * FROM webhook_deliveries WHERE status IN ('pending','failed') AND next_attempt_at <= $now ORDER BY next_attempt_at ASC LIMIT $l`)
      .all({ $now: now, $l: limit }) as Record<string, unknown>[];
    return rows.map(EventStore.deliveryRow);
  }

  listDeliveries(webhookId: string, limit = 50): DeliveryRow[] {
    const rows = this.db
      .query(`SELECT * FROM webhook_deliveries WHERE webhook_id = $w ORDER BY created_at DESC LIMIT $l`)
      .all({ $w: webhookId, $l: limit }) as Record<string, unknown>[];
    return rows.map(EventStore.deliveryRow);
  }

  markDelivered(id: string, statusCode: number, now: number): void {
    this.db
      .query(`UPDATE webhook_deliveries SET status = 'delivered', attempts = attempts + 1, last_status_code = $c, last_error = NULL, delivered_at = $now WHERE id = $id`)
      .run({ $c: statusCode, $now: now, $id: id });
  }

  markFailed(id: string, statusCode: number | null, error: string, nextAttemptAt: number, dead: boolean): void {
    this.db
      .query(
        `UPDATE webhook_deliveries SET status = $s, attempts = attempts + 1, last_status_code = $c, last_error = $e, next_attempt_at = $next WHERE id = $id`,
      )
      .run({ $s: dead ? "dead" : "failed", $c: statusCode, $e: error.slice(0, 500), $next: nextAttemptAt, $id: id });
  }

  /** Re-arms a dead or failed delivery for an immediate retry. */
  retryDelivery(id: string, now: number): boolean {
    const d = this.getDelivery(id);
    if (!d || d.status === "delivered") return false;
    this.db.query(`UPDATE webhook_deliveries SET status = 'pending', next_attempt_at = $now, attempts = 0 WHERE id = $id`).run({ $now: now, $id: id });
    return true;
  }

  // ---- audit ----

  audit(entry: Omit<AuditRow, "id">): void {
    this.db
      .query(
        `INSERT INTO audit_log (at, actor_kind, actor_id, action, target_type, target_id, detail_json, ip)
         VALUES ($at, $ak, $ai, $action, $tt, $ti, $d, $ip)`,
      )
      .run({
        $at: entry.at,
        $ak: entry.actor_kind,
        $ai: entry.actor_id,
        $action: entry.action,
        $tt: entry.target_type,
        $ti: entry.target_id,
        $d: entry.detail ? JSON.stringify(entry.detail) : null,
        $ip: entry.ip,
      });
  }

  listAudit(q: AuditQuery): AuditRow[] {
    const where: string[] = [];
    const params: Record<string, unknown> = { $l: Math.min(q.limit ?? 200, 5000) };
    if (q.scope) {
      // The user's own actions, plus anything done to their cards (by an agent, the
      // operator, or the system). Sqlite has no array params: one placeholder each.
      const ids = q.scope.cardIds.map((_, i) => `$c${i}`);
      q.scope.cardIds.forEach((id, i) => (params[`$c${i}`] = id));
      where.push(`(actor_id = $me${ids.length ? ` OR target_id IN (${ids.join(",")})` : ""})`);
      params.$me = q.scope.userId;
    }
    if (q.from !== undefined) {
      where.push("at >= $from");
      params.$from = q.from;
    }
    if (q.to !== undefined) {
      where.push("at <= $to");
      params.$to = q.to;
    }
    if (q.cardId) {
      where.push("(target_id = $card OR actor_id = $cardActor)");
      params.$card = q.cardId;
      params.$cardActor = `card:${q.cardId}`;
    }
    if (q.action) {
      where.push("action = $action");
      params.$action = q.action;
    }
    const rows = this.db
      .query(`SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY at DESC, id DESC LIMIT $l`)
      .all(params as never) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      at: r.at as number,
      actor_kind: r.actor_kind as AuditRow["actor_kind"],
      actor_id: r.actor_id as string,
      action: r.action as string,
      target_type: r.target_type as string,
      target_id: r.target_id as string,
      detail: r.detail_json ? JSON.parse(r.detail_json as string) : null,
      ip: (r.ip as string) ?? null,
    }));
  }

  // ---- card settings + budget alerts ----

  getAlertThreshold(cardId: string): number {
    const r = this.db.query(`SELECT alert_threshold_pct FROM card_settings WHERE card_id = $c`).get({ $c: cardId }) as { alert_threshold_pct: number } | null;
    return r?.alert_threshold_pct ?? 20;
  }

  setAlertThreshold(cardId: string, pct: number, now: number): void {
    this.db
      .query(
        `INSERT INTO card_settings (card_id, alert_threshold_pct, updated_at) VALUES ($c, $p, $now)
         ON CONFLICT(card_id) DO UPDATE SET alert_threshold_pct = $p, updated_at = $now`,
      )
      .run({ $c: cardId, $p: pct, $now: now });
  }

  budgetAlertSent(cardId: string, windowStart: number): boolean {
    return (
      this.db.query(`SELECT 1 FROM budget_alerts WHERE card_id = $c AND window_start = $w`).get({ $c: cardId, $w: windowStart }) !==
      null
    );
  }

  markBudgetAlert(cardId: string, windowStart: number, now: number): void {
    this.db
      .query(`INSERT INTO budget_alerts (card_id, window_start, sent_at) VALUES ($c, $w, $now) ON CONFLICT DO NOTHING`)
      .run({ $c: cardId, $w: windowStart, $now: now });
  }
}
