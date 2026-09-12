// Attestcoin server surface: REST routes + MCP tool registration, through the REAL
// Hono app and a real store.
//
// Two configurations are exercised, and the second matters as much as the first:
//   DISABLED — no Attestcoin env vars. Every route must still answer, labelled
//              `configured: false`, and the four MCP tools must NOT be offered.
//   ENABLED  — a fake client stands in for the network. Routes return real shapes
//              and the tools appear.
//
// The disabled case is the one that protects existing deployments: adding this
// integration must not change the behaviour of a server that never configures it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { KeyedMutex, Store, attestcoin, issueRootCard, type Relayer } from "@attestpay/engine";
import { createApp } from "../src/app";
import type { AppDeps } from "../src/deps";
import { buildMcpServer } from "../src/mcp/server";

const ADMIN = "test-admin-attestcoin";
const MERCHANT = "0x00000000000000000000000000000000000000a1" as Address;

const user = privateKeyToAccount(generatePrivateKey());

let server: ReturnType<typeof Bun.serve>;
let base: string;
let store: Store;
let deps: AppDeps;
let cardId: string;
let chargeId: string;

/** A fake Attestcoin client: no network, scripted answers. */
function fakeClient(over: Partial<Record<string, unknown>> = {}) {
  return {
    config: {
      chainKey: 1,
      sourceChainId: 11155111,
      creditcoinChainId: 102031,
      ascAddress: "0x00000000000000000000000000000000000000cc" as Address,
      anchorAddress: "0x00000000000000000000000000000000000000aa" as Address,
      sourceExplorer: "https://sepolia.etherscan.io",
      creditcoinExplorer: "https://creditcoin-testnet.blockscout.com",
      sourceRpcUrl: "http://127.0.0.1:1",
      creditcoinRpcUrl: "http://127.0.0.1:1",
      proverApiUrl: "http://127.0.0.1:1",
      privateKey: `0x${"ab".repeat(32)}`,
    },
    anchorerAddress: "0x00000000000000000000000000000000000000ab",
    async latestAttestedHeight() {
      return 11_687_990;
    },
    async sourceHead() {
      return 11_688_030;
    },
    async isAttested() {
      return true;
    },
    recordAttestationWait() {},
    async getAgentCredit() {
      return {
        totalPayments: 3n,
        totalVolume: 6_000_000n,
        firstPaymentAt: 1_756_000_000n,
        lastPaymentAt: 1_756_500_000n,
        withinTermsPayments: 3n,
        termsCheckedPayments: 3n,
      };
    },
    async getCardPayments() {
      return [
        {
          cardId: "0x01" as Hex,
          payer: user.address,
          merchant: MERCHANT,
          amount: 2_000_000n,
          sourceChainId: 8453n,
          sourceTxHash: "0xbasetx" as Hex,
          paidAt: 1_756_100_000n,
          anchorHeight: 11_687_948n,
          verifiedAt: 1_756_100_300n,
          memo: "coffee",
        },
      ];
    },
    async registerCardTerms() {
      return "0xtermstx";
    },
    async revokeCardTerms() {
      return "0xrevoketx";
    },
    async checkDeployment() {
      return { ok: true, problems: [] };
    },
    ...over,
  } as unknown as attestcoin.AttestcoinClient;
}

beforeAll(async () => {
  process.env.ATTESTPAY_MASTER_KEY = "c".repeat(64);
  process.env.ATTESTPAY_RPC_URL = "http://127.0.0.1:1";
  store = new Store(":memory:");

  const fakeRelayer = {
    getFeeData: async () => ({
      minFee: "0.01",
      rate: 1,
      gasPrice: "1",
      expiry: 0,
      feeCollector: "0x0",
      targetAddress: "0x0",
      context: "ctx",
    }),
    estimate: async () => ({ success: true, requiredPaymentAmount: "10000", context: "ctx", error: null, raw: null }),
    send: async () => "0xreq",
    getStatus: async () => ({ status: 200, txHash: "0xtx", raw: null }),
    waitForStatus: async () => ({ status: 200, txHash: "0xtx", raw: null, timedOut: false }),
  };

  deps = {
    store,
    relayer: fakeRelayer as unknown as Relayer,
    userSigner: user,
    adminToken: ADMIN,
    verifyPrivyToken: null,
    spendMutex: new KeyedMutex(),
    // Store present, client null: the DISABLED shape.
    attestcoin: { store: new attestcoin.AttestcoinStore(store.db), client: null },
  };

  store.upsertUser({ id: "u1", address: user.address });
  const issued = await issueRootCard(
    { store, userSigner: user, revocationNonceOverride: 0n },
    { userId: "u1", name: "attestcoin card", terms: { pay: { period: { amount: "10.00", seconds: 604800 } }, perTxMax: "5.00" } },
  );
  cardId = issued.cardId;

  // A confirmed charge to verify, inserted directly: this suite is about the
  // Attestcoin surface, not about re-testing the spend path.
  chargeId = "ch_attestcoin_1";
  store.insertCharge({
    id: chargeId,
    card_id: cardId,
    idempotency_key: null,
    kind: "pay",
    to_addr: MERCHANT,
    amount_atoms: 2_000_000n,
    fee_atoms: 10_000n,
    request_id: "req1",
    tx_hash: "0xbasetx" as Hex,
    status: "confirmed",
    memo: "coffee",
    created_at: 1_756_100_000,
  });

  const app = createApp(deps);
  server = Bun.serve({ port: 0, fetch: app.fetch });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
  store?.close();
});

const get = (path: string) =>
  fetch(`${base}${path}`, { headers: { authorization: `Bearer ${ADMIN}` } });

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// ---------------------------------------------------------------------------
// Disabled: existing behaviour must not change
// ---------------------------------------------------------------------------

describe("Attestcoin disabled", () => {
  test("health says not configured and explains why", async () => {
    const r = await get("/api/attestcoin/health");
    expect(r.status).toBe(200);
    const body = (await r.json()) as attestcoin.AttestcoinHealth;
    expect(body.configured).toBe(false);
    expect(body.error).toBeTruthy();
    // Numeric fields null, not 0: "unknown" must not read as "zero lag".
    expect(body.attestationLagBlocks).toBeNull();
    expect(body.latestAttestedHeight).toBeNull();
  });

  test("stats still renders the (empty) local queue", async () => {
    const r = await get("/api/attestcoin/stats");
    const body = (await r.json()) as { configured: boolean; queue: Record<string, number>; verification_rate: null };
    expect(body.configured).toBe(false);
    expect(body.queue.pending).toBe(0);
    // A rate over an empty set would be meaningless either way.
    expect(body.verification_rate).toBeNull();
  });

  test("per-card proofs returns an empty, labelled list rather than erroring", async () => {
    const r = await get(`/api/cards/${cardId}/attestcoin-proofs`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { configured: boolean; items: unknown[] };
    expect(body.configured).toBe(false);
    expect(body.items).toEqual([]);
  });

  test("credit score declines with a reason instead of a 500", async () => {
    const r = await get(`/api/cards/${cardId}/credit-score`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { configured: boolean; reason: string };
    expect(body.configured).toBe(false);
    expect(body.reason).toBeTruthy();
  });

  test("manual verify refuses with a reason", async () => {
    const r = await post(`/api/cards/${cardId}/attestcoin-verify`, { charge_id: chargeId });
    const body = (await r.json()) as { queued: boolean; reason: string };
    expect(body.queued).toBe(false);
    expect(body.reason).toBeTruthy();
  });

  test("the four Attestcoin MCP tools are NOT offered", async () => {
    const card = store.getCard(cardId)!;
    const mcp = buildMcpServer(deps, card);
    const names = Object.keys(
      (mcp as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
    );
    // The tool list IS the capability surface: a card must not be shown a tool that
    // can only ever answer "not configured".
    expect(names).not.toContain("verify_payment");
    expect(names).not.toContain("payment_receipt");
    expect(names).not.toContain("credit_score");
    expect(names).not.toContain("cross_chain_status");
    // ...while the normal surface is untouched.
    expect(names).toContain("card");
    expect(names).toContain("pay");
  });

  test("a confirmed charge is NOT enqueued when the integration is off", () => {
    // enqueueForVerification must no-op, or a disabled deployment accumulates rows
    // that nothing will ever process.
    expect(deps.attestcoin!.store.get(chargeId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Enabled: the real shapes, against a fake client
// ---------------------------------------------------------------------------

describe("Attestcoin enabled", () => {
  let enabledDeps: AppDeps;
  let enabledServer: ReturnType<typeof Bun.serve>;
  let enabledBase: string;

  beforeAll(() => {
    enabledDeps = { ...deps, attestcoin: { store: deps.attestcoin!.store, client: fakeClient() } };
    const app = createApp(enabledDeps);
    enabledServer = Bun.serve({ port: 0, fetch: app.fetch });
    enabledBase = `http://localhost:${enabledServer.port}`;
  });

  afterAll(() => {
    enabledServer?.stop(true);
  });

  const eget = (path: string) =>
    fetch(`${enabledBase}${path}`, { headers: { authorization: `Bearer ${ADMIN}` } });
  const epost = (path: string, body: unknown) =>
    fetch(`${enabledBase}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("health reports the attestation lag", async () => {
    const r = await eget("/api/attestcoin/health");
    const body = (await r.json()) as attestcoin.AttestcoinHealth;
    expect(body.configured).toBe(true);
    expect(body.chainKey).toBe(1);
    expect(body.latestAttestedHeight).toBe(11_687_990);
    expect(body.sourceHead).toBe(11_688_030);
    expect(body.attestationLagBlocks).toBe(40);
    expect(body.error).toBeUndefined();
  });

  test("stats exposes the contract wiring", async () => {
    const r = await eget("/api/attestcoin/stats");
    const body = (await r.json()) as Record<string, unknown>;
    expect(body.configured).toBe(true);
    expect(body.chain_key).toBe(1);
    expect(body.creditcoin_chain_id).toBe(102031);
    expect(String(body.asc_explorer)).toContain("creditcoin-testnet.blockscout.com");
  });

  test("manual verify queues a confirmed charge", async () => {
    const r = await epost(`/api/cards/${cardId}/attestcoin-verify`, { charge_id: chargeId });
    const body = (await r.json()) as { queued: boolean; charge_id: string };
    expect(body.queued).toBe(true);
    expect(body.charge_id).toBe(chargeId);
    expect(enabledDeps.attestcoin!.store.get(chargeId)!.status).toBe("pending");
  });

  test("manual verify refuses a charge that is not confirmed", async () => {
    store.insertCharge({
      id: "ch_pending",
      card_id: cardId,
      idempotency_key: null,
      kind: "pay",
      to_addr: MERCHANT,
      amount_atoms: 1_000_000n,
      fee_atoms: 1000n,
      request_id: null,
      tx_hash: null,
      status: "pending",
      memo: null,
      created_at: 1_756_100_100,
    });
    const r = await epost(`/api/cards/${cardId}/attestcoin-verify`, { charge_id: "ch_pending" });
    const body = (await r.json()) as { queued: boolean; reason: string };
    expect(body.queued).toBe(false);
    expect(body.reason).toContain("only a confirmed payment");
  });

  test("manual verify refuses a charge belonging to another card", async () => {
    const other = await issueRootCard(
      { store, userSigner: user, revocationNonceOverride: 0n },
      { userId: "u1", name: "other", terms: { pay: { period: { amount: "1.00", seconds: 3600 } } } },
    );
    const r = await epost(`/api/cards/${other.cardId}/attestcoin-verify`, { charge_id: chargeId });
    const body = (await r.json()) as { queued: boolean; reason: string };
    expect(body.queued).toBe(false);
    expect(body.reason).toContain("no such charge on this card");
  });

  test("proof list joins pipeline state onto its charges with explorer links", async () => {
    enabledDeps.attestcoin!.store.update(
      chargeId,
      {
        status: "verified",
        anchor_tx_hash: "0xanchor",
        anchor_height: 11_687_948,
        creditcoin_tx_hash: "0xccverify",
        verified_at: 1_756_100_300,
      },
      1_756_100_300,
    );

    const r = await eget(`/api/cards/${cardId}/attestcoin-proofs`);
    const body = (await r.json()) as {
      configured: boolean;
      items: Array<Record<string, Record<string, string> | string | null>>;
      stats: { verified: number; avg_verify_seconds: number | null };
    };
    expect(body.configured).toBe(true);
    const item = body.items.find((i) => i.charge_id === chargeId)!;
    expect(item.status).toBe("verified");
    expect(item.amount).toBe("2.000000");
    // All three legs linked, so a reader can check each one.
    expect((item.source as Record<string, string>).explorer).toContain("basescan.org");
    expect((item.anchor as Record<string, string>).explorer).toContain("sepolia.etherscan.io");
    expect((item.creditcoin as Record<string, string>).explorer).toContain("creditcoin-testnet.blockscout.com");
    expect(body.stats.verified).toBeGreaterThanOrEqual(1);
  });

  test("proof detail includes what the ASC itself holds", async () => {
    const r = await eget(`/api/cards/${cardId}/attestcoin-proofs/${chargeId}`);
    const body = (await r.json()) as {
      found: boolean;
      status: string;
      on_chain: Record<string, unknown> | null;
      on_chain_error: string | null;
      proof_type: string;
    };
    expect(body.found).toBe(true);
    expect(body.status).toBe("verified");
    expect(body.proof_type).toContain("Merkle");
    expect(body.on_chain_error).toBeNull();
    expect(body.on_chain!.amount).toBe("2.000000");
    expect(body.on_chain!.source_tx_hash).toBe("0xbasetx");
  });

  test("proof detail hides another card's proof", async () => {
    const other = await issueRootCard(
      { store, userSigner: user, revocationNonceOverride: 0n },
      { userId: "u1", name: "other2", terms: { pay: { period: { amount: "1.00", seconds: 3600 } } } },
    );
    const r = await eget(`/api/cards/${other.cardId}/attestcoin-proofs/${chargeId}`);
    const body = (await r.json()) as { found: boolean };
    expect(body.found).toBe(false);
  });

  test("credit score reads live and grades the history", async () => {
    const r = await eget(`/api/cards/${cardId}/credit-score`);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body.configured).toBe(true);
    expect(body.live).toBe(true);
    expect(body.payer).toBe(user.address);
    expect(body.total_verified_payments).toBe(3);
    expect(body.total_verified_volume).toBe("6.000000");
    expect(body.grade).toBeTruthy();
    expect(body.basis).toContain("within registered terms");
  });

  test("credit score falls back to cache and SAYS it is not live", async () => {
    // Seed the cache, then make the live read fail.
    enabledDeps.attestcoin!.store.cacheCredit(
      user.address,
      {
        totalPayments: 9n,
        totalVolume: 9_000_000n,
        firstPaymentAt: 1_755_000_000n,
        lastPaymentAt: 1_756_000_000n,
        withinTermsPayments: 9n,
        termsCheckedPayments: 9n,
      },
      1_756_600_000,
    );
    const brokenDeps: AppDeps = {
      ...enabledDeps,
      attestcoin: {
        store: enabledDeps.attestcoin!.store,
        client: fakeClient({
          getAgentCredit: async () => {
            throw new Error("creditcoin unreachable");
          },
        }),
      },
    };
    const app = createApp(brokenDeps);
    const srv = Bun.serve({ port: 0, fetch: app.fetch });
    try {
      const r = await fetch(`http://localhost:${srv.port}/api/cards/${cardId}/credit-score`, {
        headers: { authorization: `Bearer ${ADMIN}` },
      });
      const body = (await r.json()) as Record<string, unknown>;
      // The cached value is served, but never presented as live.
      expect(body.live).toBe(false);
      expect(body.total_verified_payments).toBe(9);
      expect(body.synced_at).toBeTruthy();
    } finally {
      srv.stop(true);
    }
  });

  test("health degrades gracefully when the RPC is down", async () => {
    const brokenDeps: AppDeps = {
      ...enabledDeps,
      attestcoin: {
        store: enabledDeps.attestcoin!.store,
        client: fakeClient({
          latestAttestedHeight: async () => {
            throw new Error("rpc down");
          },
        }),
      },
    };
    const app = createApp(brokenDeps);
    const srv = Bun.serve({ port: 0, fetch: app.fetch });
    try {
      const r = await fetch(`http://localhost:${srv.port}/api/attestcoin/health`, {
        headers: { authorization: `Bearer ${ADMIN}` },
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as attestcoin.AttestcoinHealth;
      expect(body.configured).toBe(true);
      expect(body.error).toContain("rpc down");
      // Still null rather than a fabricated 0.
      expect(body.attestationLagBlocks).toBeNull();
      // The local queue is still reported — it needs no network.
      expect(body.queue).toBeTruthy();
    } finally {
      srv.stop(true);
    }
  });

  test("the four Attestcoin MCP tools ARE offered", () => {
    const card = store.getCard(cardId)!;
    const mcp = buildMcpServer(enabledDeps, card);
    const names = Object.keys(
      (mcp as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
    );
    expect(names).toContain("verify_payment");
    expect(names).toContain("payment_receipt");
    expect(names).toContain("credit_score");
    expect(names).toContain("cross_chain_status");
  });
});

// ---------------------------------------------------------------------------
// The enqueue hook
// ---------------------------------------------------------------------------

describe("confirmed-charge enqueue hook", () => {
  test("enqueues when configured and no-ops when not", async () => {
    const { enqueueForVerification } = await import("../src/deps");
    const s = new Store(":memory:");
    s.upsertUser({ id: "u", address: user.address });
    const issued = await issueRootCard(
      { store: s, userSigner: user, revocationNonceOverride: 0n },
      { userId: "u", name: "hook card", terms: { pay: { period: { amount: "1.00", seconds: 3600 } } } },
    );
    const acStore = new attestcoin.AttestcoinStore(s.db);
    s.insertCharge({
      id: "ch_hook",
      card_id: issued.cardId,
      idempotency_key: null,
      kind: "pay",
      to_addr: MERCHANT,
      amount_atoms: 1n,
      fee_atoms: 0n,
      request_id: "r",
      tx_hash: "0xt" as Hex,
      status: "confirmed",
      memo: null,
      created_at: 1,
    });

    const offDeps = { ...deps, store: s, attestcoin: { store: acStore, client: null } } as AppDeps;
    enqueueForVerification(offDeps)("ch_hook", issued.cardId);
    expect(acStore.get("ch_hook")).toBeNull();

    const onDeps = { ...deps, store: s, attestcoin: { store: acStore, client: fakeClient() } } as AppDeps;
    enqueueForVerification(onDeps)("ch_hook", issued.cardId);
    expect(acStore.get("ch_hook")!.status).toBe("pending");

    s.close();
  });

  test("a missing attestcoin dep does not throw (fake AppDeps in other suites)", async () => {
    const { enqueueForVerification } = await import("../src/deps");
    const bare = { store } as unknown as AppDeps;
    expect(() => enqueueForVerification(bare)("ch_x", "card_x")).not.toThrow();
  });
});
