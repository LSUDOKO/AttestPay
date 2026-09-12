// Events, webhooks, audit log and budget alerts through the REAL app.
//
// Delivery is exercised against a captured `fetch`, so the signature, headers,
// retry schedule and dead-lettering are all checked without a network. Events come
// from the real hook points: a freeze via the API, a payment via a real MCP call.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { KeyedMutex, Store, issueRootCard, type Relayer } from "@attestpay/engine";
import { createApp } from "../src/app";
import type { AppDeps } from "../src/deps";
import { EventBus } from "../src/events/bus";
import { EventStore } from "../src/events/store";
import { WEBHOOK_BACKOFF_S, WEBHOOK_MAX_ATTEMPTS, checkWebhookUrl, deliverWebhooks, signWebhook, verifyWebhookSignature } from "../src/events/deliver";

const ADMIN = "test-admin-events";
const MERCHANT = "0xAc36D18d2315c8c1F6e93B9074D3C25e2DC14127";
const user = privateKeyToAccount(generatePrivateKey());
const USER_ID = user.address.toLowerCase();

let server: ReturnType<typeof Bun.serve>;
let base: string;
let store: Store;
let events: EventStore;
let deps: AppDeps;
let card: { cardId: string; secret: string };

const fakeRelayer = {
  getFeeData: async () => ({ minFee: "0.01", rate: 1, gasPrice: "1", expiry: 0, feeCollector: "0xE936e8FAf4A5655469182A49a505055B71C17604", targetAddress: "0x26a529124f0bbf9af9d8f9f84a43efe47cf1199a", context: "ctx" }),
  estimate: async () => ({ success: true, requiredPaymentAmount: "10000", context: "ctx", error: null, raw: null }),
  send: async () => "0xreq",
  getStatus: async () => ({ status: 200, txHash: "0xfaketx", raw: null }),
  waitForStatus: async () => ({ status: 200, txHash: "0xfaketx", raw: null, timedOut: false }),
};

beforeAll(async () => {
  process.env.ATTESTPAY_MASTER_KEY = "f".repeat(64);
  process.env.ATTESTPAY_RPC_URL = "http://127.0.0.1:1";
  process.env.ATTESTPAY_WEBHOOK_ALLOW_LOCAL = "1";
  store = new Store(":memory:");
  events = new EventStore(store.db);
  deps = {
    store,
    relayer: fakeRelayer as unknown as Relayer,
    userSigner: user,
    adminToken: ADMIN,
    verifyPrivyToken: null,
    spendMutex: new KeyedMutex(),
    spendOverrides: { codeCheck: async () => true, confirmViaChain: false, feeJitter: (b) => b },
    events: new EventBus(events, store),
  };
  store.upsertUser({ id: USER_ID, address: user.address });
  // A 10 USDC/week card: after one 8.50 payment it is under the 20% default threshold.
  const issued = await issueRootCard(
    { store, userSigner: user, revocationNonceOverride: 0n },
    { userId: USER_ID, name: "events card", terms: { pay: { period: { amount: "10.00", seconds: 604800 } } } },
  );
  card = { cardId: issued.cardId, secret: issued.secret };
  const app = createApp(deps);
  server = Bun.serve({ port: 0, fetch: app.fetch });
  base = `http://localhost:${server.port}`;
  process.env.ATTESTPAY_PUBLIC_MCP_BASE = base;
});

afterAll(() => {
  server?.stop(true);
  store?.close();
  delete process.env.ATTESTPAY_WEBHOOK_ALLOW_LOCAL;
});

const admin = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json", ...(init.headers ?? {}) } });
const post = (path: string, body: unknown) => admin(path, { method: "POST", body: JSON.stringify(body) });

// ---------------------------------------------------------------------------

describe("signing", () => {
  test("sign and verify round-trip; tampering and staleness fail", () => {
    const header = signWebhook("whsec_x", 1_757_000_000, '{"a":1}');
    expect(header).toMatch(/^t=1757000000,v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature("whsec_x", header, '{"a":1}', { now: 1_757_000_010 })).toBe(true);
    expect(verifyWebhookSignature("whsec_x", header, '{"a":2}', { now: 1_757_000_010 })).toBe(false);
    expect(verifyWebhookSignature("whsec_y", header, '{"a":1}', { now: 1_757_000_010 })).toBe(false);
    expect(verifyWebhookSignature("whsec_x", header, '{"a":1}', { now: 1_757_001_000 })).toBe(false);
    expect(verifyWebhookSignature("whsec_x", "garbage", '{"a":1}')).toBe(false);
  });

  test("webhook URL policy", () => {
    delete process.env.ATTESTPAY_WEBHOOK_ALLOW_LOCAL;
    expect(checkWebhookUrl("https://hooks.example.com/x")).toBeNull();
    expect(checkWebhookUrl("http://hooks.example.com/x")).toMatch(/https/);
    expect(checkWebhookUrl("https://10.0.0.5/x")).toMatch(/private/);
    expect(checkWebhookUrl("https://localhost/x")).toMatch(/private/);
    expect(checkWebhookUrl("https://user:pw@hooks.example.com/x")).toMatch(/credentials/);
    expect(checkWebhookUrl("not a url")).toMatch(/malformed/);
    process.env.ATTESTPAY_WEBHOOK_ALLOW_LOCAL = "1";
    expect(checkWebhookUrl("http://localhost:9/x")).toBeNull();
  });
});

describe("webhooks over the API", () => {
  let webhookId: string;
  let secret: string;

  test("create returns the secret exactly once", async () => {
    const r = await post("/api/webhooks", { userId: USER_ID, url: "http://localhost:9/hook", events: ["card.frozen", "charge.confirmed", "budget.low"], description: "test" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { webhook_id: string; secret: string; events: string[]; active: boolean };
    webhookId = body.webhook_id;
    secret = body.secret;
    expect(secret).toMatch(/^whsec_/);
    expect(body.active).toBe(true);

    const list = (await (await admin(`/api/webhooks?userId=${USER_ID}`)).json()) as { items: Array<Record<string, unknown>>; event_types: string[] };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.secret).toBeUndefined();
    expect(list.event_types).toContain("credit_line.drawn");
  });

  test("rejects bad URLs and unknown event types", async () => {
    expect((await post("/api/webhooks", { userId: USER_ID, url: "ftp://x" })).status).toBe(422);
    expect((await post("/api/webhooks", { userId: USER_ID, url: "https://hooks.example.com", events: ["nope"] })).status).toBe(422);
  });

  test("a freeze via the API becomes an event, a delivery, and an audit entry", async () => {
    expect((await post(`/api/cards/${card.cardId}/freeze`, {})).status).toBe(200);
    const evs = events.listEvents(USER_ID);
    expect(evs.map((e) => e.type)).toContain("card.frozen");
    const due = events.dueDeliveries(Math.floor(Date.now() / 1000) + 1);
    expect(due).toHaveLength(1);
    expect(due[0]!.event_type).toBe("card.frozen");

    const audit = events.listAudit({ scope: { userId: USER_ID, cardIds: [card.cardId] } });
    expect(audit.some((a) => a.action === "card.frozen" && a.target_id === card.cardId && a.actor_kind === "admin")).toBe(true);
    expect((await post(`/api/cards/${card.cardId}/unfreeze`, {})).status).toBe(200);
  });

  test("delivery POSTs a signed body; a 2xx marks it delivered", async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: String(init?.body) });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const r = await deliverWebhooks(events, { fetch: fakeFetch });
    expect(r.delivered).toBeGreaterThanOrEqual(1);
    const hit = seen.find((s) => s.headers["x-attestpay-event"] === "card.frozen")!;
    expect(hit.url).toBe("http://localhost:9/hook");
    expect(hit.headers["content-type"]).toBe("application/json");
    expect(verifyWebhookSignature(secret, hit.headers["x-attestpay-signature"]!, hit.body)).toBe(true);
    const payload = JSON.parse(hit.body) as { type: string; card_id: string; data: { card_id: string } };
    expect(payload.type).toBe("card.frozen");
    expect(payload.card_id).toBe(card.cardId);

    const dl = (await (await admin(`/api/webhooks/${webhookId}/deliveries?userId=${USER_ID}`)).json()) as { items: Array<{ status: string; event_type: string }> };
    expect(dl.items.every((d) => d.status === "delivered")).toBe(true);
  });

  test("a failing endpoint backs off and dies after the schedule", async () => {
    const ev = deps.events!.emit("card.frozen", { cardId: card.cardId }, { card_id: card.cardId, synthetic: true });
    const d = events.dueDeliveries(Math.floor(Date.now() / 1000) + 1).find((x) => x.event_id === ev.id)!;
    expect(d).toBeDefined();

    let clock = Math.floor(Date.now() / 1000);
    const failing = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    for (let i = 0; i < WEBHOOK_MAX_ATTEMPTS; i++) {
      const r = await deliverWebhooks(events, { fetch: failing, now: () => clock, only: d.id });
      expect(r.attempted).toBe(1);
      const row = events.getDelivery(d.id)!;
      expect(row.attempts).toBe(i + 1);
      expect(row.last_status_code).toBe(500);
      if (i + 1 < WEBHOOK_MAX_ATTEMPTS) {
        expect(row.status).toBe("failed");
        expect(row.next_attempt_at).toBe(clock + WEBHOOK_BACKOFF_S[i]!);
        // Not due yet: a sweep now must skip it.
        expect(events.dueDeliveries(clock).some((x) => x.id === d.id)).toBe(false);
        clock = row.next_attempt_at;
      } else {
        expect(row.status).toBe("dead");
      }
    }

    // Manual retry re-arms it; a healthy endpoint then delivers.
    const ok = (async () => new Response("", { status: 204 })) as unknown as typeof fetch;
    expect(events.retryDelivery(d.id, clock)).toBe(true);
    await deliverWebhooks(events, { fetch: ok, now: () => clock, only: d.id });
    expect(events.getDelivery(d.id)!.status).toBe("delivered");
  });

  test("a paused webhook receives nothing; delete removes deliveries", async () => {
    await post(`/api/webhooks/${webhookId}/pause`, { userId: USER_ID, active: false });
    const before = events.listDeliveries(webhookId).length;
    deps.events!.emit("card.frozen", { cardId: card.cardId }, { card_id: card.cardId });
    expect(events.listDeliveries(webhookId).length).toBe(before);
    await post(`/api/webhooks/${webhookId}/pause`, { userId: USER_ID, active: true });

    const r = await admin(`/api/webhooks/${webhookId}?userId=${USER_ID}`, { method: "DELETE" });
    expect(r.status).toBe(200);
    expect(events.getWebhook(webhookId)).toBeNull();
    expect(events.listDeliveries(webhookId)).toHaveLength(0);
  });

  test("a webhook is scoped to its owner", async () => {
    const r = await post("/api/webhooks", { userId: USER_ID, url: "http://localhost:9/other" });
    const { webhook_id } = (await r.json()) as { webhook_id: string };
    // Another user (via the admin lane picking a different userId) cannot see it.
    const list = (await (await admin(`/api/webhooks?userId=someone-else`)).json()) as { items: unknown[] };
    expect(list.items).toHaveLength(0);
    expect((await admin(`/api/webhooks/${webhook_id}/deliveries?userId=someone-else`)).status).toBe(422);
  });
});

describe("payments, budget alerts and the audit export", () => {
  test("a real MCP payment emits charge.confirmed and a low-budget alert once per window", async () => {
    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/c/${card.secret}/mcp`)));
    const first = await client.callTool({ name: "pay", arguments: { to: MERCHANT, amount: "8.50", memo: "big" } });
    expect(first.isError).not.toBe(true);

    const types = events.listEvents(USER_ID).map((e) => e.type);
    expect(types).toContain("charge.confirmed");
    expect(types.filter((t) => t === "budget.low")).toHaveLength(1);
    const alert = events.listEvents(USER_ID).find((e) => e.type === "budget.low")!;
    expect(alert.data.threshold_pct).toBe(20);
    expect(Number(alert.data.remaining_pct)).toBeLessThanOrEqual(20);

    // A second small payment in the same window does not alert again.
    const second = await client.callTool({ name: "pay", arguments: { to: MERCHANT, amount: "0.10" } });
    expect(second.isError).not.toBe(true);
    expect(events.listEvents(USER_ID).filter((e) => e.type === "budget.low")).toHaveLength(1);
    await client.close();
  });

  test("the threshold is per card and editable", async () => {
    const g = (await (await admin(`/api/cards/${card.cardId}/alerts`)).json()) as { threshold_pct: number };
    expect(g.threshold_pct).toBe(20);
    const r = await admin(`/api/cards/${card.cardId}/alerts`, { method: "PUT", body: JSON.stringify({ threshold_pct: 50 }) });
    expect(r.status).toBe(200);
    expect(events.getAlertThreshold(card.cardId)).toBe(50);
    expect((await admin(`/api/cards/${card.cardId}/alerts`, { method: "PUT", body: JSON.stringify({ threshold_pct: 500 }) })).status).toBe(422);
  });

  test("audit export as JSON and CSV, scoped and filterable", async () => {
    const j = (await (await admin(`/api/audit?userId=${USER_ID}&card_id=${card.cardId}`)).json()) as { items: Array<{ action: string; actor: string; target: string }> };
    const actions = j.items.map((i) => i.action);
    expect(actions).toContain("card.frozen");
    expect(actions).toContain("card.unfrozen");
    expect(actions).toContain("card.alerts_updated");
    expect(j.items[0]!.target).toBe(`card:${card.cardId}`);

    const only = (await (await admin(`/api/audit?userId=${USER_ID}&action=card.frozen`)).json()) as { items: Array<{ action: string }> };
    expect(only.items.every((i) => i.action === "card.frozen")).toBe(true);

    const csv = await admin(`/api/audit?userId=${USER_ID}&format=csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const text = await csv.text();
    expect(text.split("\n")[0]).toBe("id,at,actor_kind,actor_id,action,target_type,target_id,detail,ip");
    expect(text).toContain("card.frozen");

    // Another user's scope sees none of it.
    const other = (await (await admin(`/api/audit?userId=someone-else`)).json()) as { items: unknown[] };
    expect(other.items).toHaveLength(0);
    // The operator's global view sees everything.
    const all = (await (await admin(`/api/audit?all=1`)).json()) as { items: unknown[] };
    expect(all.items.length).toBeGreaterThanOrEqual(j.items.length);
  });

  test("the event outbox is readable per user and per card", async () => {
    const r = (await (await admin(`/api/events?userId=${USER_ID}&card_id=${card.cardId}&limit=5`)).json()) as { items: Array<{ type: string; created_at: string }> };
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.length).toBeLessThanOrEqual(5);
    expect(r.items[0]!.created_at).toMatch(/^\d{4}-/);
  });
});
