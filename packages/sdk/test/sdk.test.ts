// The SDK against the REAL server app: every namespace makes at least one call,
// errors map to AttestPayError with the typed refusal code, and the two pure
// verifiers agree with the server's own implementations.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { KeyedMutex, Store, attestcoin, issueRootCard, type Relayer } from "@attestpay/engine";
import { createApp } from "@attestpay/server/src/app";
import type { AppDeps } from "@attestpay/server/src/deps";
import { EventBus } from "@attestpay/server/src/events/bus";
import { EventStore } from "@attestpay/server/src/events/store";
import { signWebhook } from "@attestpay/server/src/events/deliver";
import { TeamStore } from "@attestpay/server/src/teams/store";
import { AttestPay, AttestPayError, canonicalJson, verifyPassportCredential, verifyWebhookSignature } from "../src/index";

const ADMIN = "sdk-admin";
const user = privateKeyToAccount(generatePrivateKey());
const USER_ID = user.address.toLowerCase();
const MERCHANT = "0xAc36D18d2315c8c1F6e93B9074D3C25e2DC14127" as Address;

let server: ReturnType<typeof Bun.serve>;
let store: Store;
let ap: AttestPay;
let cardId: string;

const fakeRelayer = {
  getFeeData: async () => ({ minFee: "0.01", rate: 1, gasPrice: "1", expiry: 0, feeCollector: "0xE936e8FAf4A5655469182A49a505055B71C17604", targetAddress: "0x26a529124f0bbf9af9d8f9f84a43efe47cf1199a", context: "ctx" }),
  estimate: async () => ({ success: true, requiredPaymentAmount: "10000", context: "ctx", error: null, raw: null }),
  send: async () => "0xreq",
  getStatus: async () => ({ status: 200, txHash: "0xfaketx", raw: null }),
  waitForStatus: async () => ({ status: 200, txHash: "0xfaketx", raw: null, timedOut: false }),
};

beforeAll(async () => {
  process.env.ATTESTPAY_MASTER_KEY = "b".repeat(64);
  process.env.ATTESTPAY_RPC_URL = "http://127.0.0.1:1";
  process.env.ATTESTPAY_WEBHOOK_ALLOW_LOCAL = "1";
  store = new Store(":memory:");
  const deps: AppDeps = {
    store,
    relayer: fakeRelayer as unknown as Relayer,
    userSigner: user,
    adminToken: ADMIN,
    verifyPrivyToken: null,
    spendMutex: new KeyedMutex(),
    spendOverrides: { codeCheck: async () => true, confirmViaChain: false, feeJitter: (b) => b },
    attestcoin: { store: new attestcoin.AttestcoinStore(store.db), client: null },
    events: new EventBus(new EventStore(store.db), store),
    teams: new TeamStore(store.db),
  };
  store.upsertUser({ id: USER_ID, address: user.address });
  const issued = await issueRootCard({ store, userSigner: user, revocationNonceOverride: 0n }, { userId: USER_ID, name: "sdk card", terms: { pay: { period: { amount: "10.00", seconds: 604800 } } } });
  cardId = issued.cardId;
  server = Bun.serve({ port: 0, fetch: createApp(deps).fetch });
  ap = new AttestPay({ baseUrl: `http://localhost:${server.port}`, token: ADMIN, userId: USER_ID });
});

afterAll(() => {
  server?.stop(true);
  store?.close();
  delete process.env.ATTESTPAY_WEBHOOK_ALLOW_LOCAL;
});

describe("client", () => {
  test("cards: list, get, freeze, unfreeze", async () => {
    const list = await ap.cards.list();
    expect(list.map((c) => c.card_id)).toEqual([cardId]);
    const d = await ap.cards.get(cardId);
    expect(d.name).toBe("sdk card");
    expect((await ap.cards.freeze(cardId)).status).toBe("frozen");
    expect((await ap.cards.unfreeze(cardId)).status).toBe("active");
  });

  test("errors carry the typed refusal", async () => {
    const e = await ap.cards.get("nope").catch((x) => x as AttestPayError);
    expect(e).toBeInstanceOf(AttestPayError);
    expect((e as AttestPayError).status).toBe(422);
    expect((e as AttestPayError).code).toBe("card_not_found");
  });

  test("attestcoin health is readable when disabled", async () => {
    const h = await ap.attestcoin.health();
    expect(h.configured).toBe(false);
    expect(h.features.credit).toBe(false);
    expect((await ap.credit.list()).configured).toBe(false);
    const p = await ap.passport.get(user.address);
    expect(p.configured).toBe(false);
  });

  test("webhooks, events, audit, alerts and teams round-trip", async () => {
    const w = await ap.webhooks.create({ url: "http://localhost:9/x", events: ["card.frozen"] });
    expect(w.secret).toMatch(/^whsec_/);
    expect((await ap.webhooks.list()).items).toHaveLength(1);
    expect((await ap.webhooks.deliveries(w.webhook_id)).items).toHaveLength(0);
    await ap.cards.freeze(cardId);
    expect((await ap.webhooks.deliveries(w.webhook_id)).items).toHaveLength(1);
    await ap.cards.unfreeze(cardId);
    expect((await ap.webhooks.delete(w.webhook_id)).deleted).toBe(true);

    const evs = await ap.events.list({ card_id: cardId });
    expect(evs.items.some((e) => e.type === "card.frozen")).toBe(true);
    const audit = await ap.audit.list({ card_id: cardId });
    expect(audit.items.some((a) => a.action === "card.frozen")).toBe(true);
    const csv = await ap.audit.csv({ card_id: cardId });
    expect(csv.split("\n")[0]).toContain("actor_kind");

    expect((await ap.alerts.set(cardId, 35)).threshold_pct).toBe(35);
    expect((await ap.alerts.get(cardId)).threshold_pct).toBe(35);

    const t = await ap.teams.create("sdk team");
    expect(t.your_role).toBe("owner");
    await ap.teams.addMember(t.team_id, { address: privateKeyToAccount(generatePrivateKey()).address, role: "viewer" });
    expect((await ap.teams.get(t.team_id)).members).toHaveLength(2);
    expect((await ap.cards.assignTeam(cardId, t.team_id)).team?.name).toBe("sdk team");
    expect((await ap.cards.get(cardId)).team?.team_id).toBe(t.team_id);
    await ap.cards.assignTeam(cardId, null);
    expect((await ap.teams.delete(t.team_id)).deleted).toBe(true);
  });

  test("a Privy-style token function is called per request", async () => {
    let calls = 0;
    const client = new AttestPay({ baseUrl: `http://localhost:${server.port}`, token: async () => (calls++, ADMIN), userId: USER_ID });
    await client.cards.list();
    await client.cards.list();
    expect(calls).toBe(2);
  });
});

describe("verifiers", () => {
  test("webhook signature verification matches the server's signer", async () => {
    const body = JSON.stringify({ id: "evt_1", type: "card.frozen" });
    const header = signWebhook("whsec_abc", 1_757_000_000, body);
    expect(await verifyWebhookSignature("whsec_abc", header, body, { now: 1_757_000_005 })).toBe(true);
    expect(await verifyWebhookSignature("whsec_abc", header, body + " ", { now: 1_757_000_005 })).toBe(false);
    expect(await verifyWebhookSignature("whsec_abc", header, body, { now: 1_757_009_000 })).toBe(false);
  });

  test("passport credential verification matches the engine's issuer", async () => {
    const pk = generatePrivateKey();
    const signer = privateKeyToAccount(pk);
    const passport: attestcoin.Passport = {
      account: user.address,
      verifiedPayments: 1n,
      verifiedVolume: 1_000_000n,
      firstPaymentAt: 1n,
      lastPaymentAt: 2n,
      withinTermsPayments: 1n,
      termsCheckedPayments: 1n,
      linesOpened: 0n,
      linesRepaid: 0n,
      linesDefaulted: 0n,
      totalDrawn: 0n,
      totalRepaid: 0n,
      disputesOpened: 0n,
      disputesUpheld: 0n,
      disputesRejected: 0n,
      disputedVolume: 0n,
      guaranteeBonded: 0n,
      score: 7n,
      grade: "F",
      asOf: 1_757_000_000n,
    };
    const cred = await attestcoin.issuePassportCredential(passport, { signerPrivateKey: pk, issuer: "t", chainId: 102031, passportContract: MERCHANT, now: 1_757_000_000 });
    // Same canonical form on both sides.
    expect(canonicalJson(cred.payload)).toBe(attestcoin.canonicalPayload(cred.payload));
    const ok = await verifyPassportCredential(cred as { payload: typeof cred.payload; signature: Hex }, { expectedSigner: signer.address, now: 1_757_000_100 });
    expect(ok.valid).toBe(true);
    const bad = await verifyPassportCredential({ ...cred, payload: { ...cred.payload, issuer: "x" } } as never, { expectedSigner: signer.address, now: 1_757_000_100 });
    expect(bad.valid).toBe(false);
  });
});
