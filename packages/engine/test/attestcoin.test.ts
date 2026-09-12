// Attestcoin integration: the logic that does NOT need a network.
//
// Covers the proof state machine, the store's idempotency guarantees, terms hashing,
// credit grading, and config resolution. The worker is driven against a FAKE client so
// every transition — including the failure and retry paths that are hard to provoke
// live — runs deterministically and offline.

import { beforeEach, describe, expect, test } from "bun:test";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import type { Address, Hex } from "viem";
import { KeyedMutex, Store, attestcoin } from "../src/index";
import type { CardRow, ChargeRow } from "../src/store";

const {
  ATTESTCOIN_CHAIN_KEYS,
  AttestcoinStore,
  CHAIN_KEY_TO_EVM_CHAIN_ID,
  MAX_ATTEMPTS,
  anchorRequestFor,
  attestcoinConfig,
  attestcoinDisabledHealth,
  attestcoinDisabledReason,
  baseTxUrl,
  cardIdToBytes32,
  creditGrade,
  isTerminalProofStatus,
  payerForCard,
  stableStringify,
  sweepProofs,
  termsHashOf,
} = attestcoin;

// ---------------------------------------------------------------------------
// Fixtures: a minimal real card tree in a real in-memory store
// ---------------------------------------------------------------------------

const USER_PK = generatePrivateKey();
const USER = privateKeyToAccount(USER_PK);
const MERCHANT = "0x00000000000000000000000000000000000000a1" as Address;

function seedStore(): { store: Store; cardId: string } {
  const store = new Store(":memory:");
  store.upsertUser({ id: "u1", address: USER.address });

  const card: CardRow = {
    id: "card_root",
    user_id: "u1",
    parent_card_id: null,
    name: "root",
    secret_hash: "h1",
    secret_enc: null,
    terms: { pay: { period: { amount: "10.00", seconds: 604800 } }, perTxMax: "5.00", expiry: 1_800_000_000 },
    kind: "pay",
    compiled: {
      kind: "pay",
      rootCaveats: [],
      orGroups: null,
      carvePolicy: { perTxMaxAtoms: 5_000_000n, merchants: null },
      periodStartDate: 1_750_000_000,
      terms: {},
    },
    delegation: {
      delegate: MERCHANT,
      delegator: USER.address,
      authority: "0x0" as Hex,
      caveats: [],
      salt: "0x1" as Hex,
      signature: "0x2" as Hex,
    },
    k_agent_enc: new Uint8Array([1]),
    k_agent_address: MERCHANT,
    status: "active",
    created_at: 1_756_000_000,
  };
  store.createCard(card);
  return { store, cardId: card.id };
}

function insertCharge(store: Store, cardId: string, over: Partial<ChargeRow> = {}): string {
  const id = over.id ?? `ch_${Math.random().toString(36).slice(2, 10)}`;
  store.insertCharge({
    id,
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
    ...over,
  });
  return id;
}

// ---------------------------------------------------------------------------
// A fake AttestcoinClient: scripted, offline, and able to fail on demand
// ---------------------------------------------------------------------------

type FakeScript = {
  anchorFails?: { message: string; retryable: boolean };
  attestedAt?: number; // heights <= this are attested
  proofFails?: { message: string; retryable: boolean };
  submitFails?: { message: string; retryable: boolean };
};

function fakeClient(script: FakeScript = {}) {
  const calls = { anchor: 0, isAttested: 0, proof: 0, submit: 0, credit: 0 };
  const client = {
    config: {
      chainKey: ATTESTCOIN_CHAIN_KEYS.ethereumSepolia,
      sourceChainId: 11155111,
      creditcoinChainId: 102031,
      ascAddress: "0x00000000000000000000000000000000000000cc" as Address,
      anchorAddress: "0x00000000000000000000000000000000000000aa" as Address,
      sourceExplorer: "https://sepolia.etherscan.io",
      creditcoinExplorer: "https://creditcoin-testnet.blockscout.com",
    },
    async anchorPayment() {
      calls.anchor += 1;
      if (script.anchorFails) {
        throw new attestcoin.AttestcoinError("anchor", script.anchorFails.message, script.anchorFails.retryable);
      }
      return { txHash: "0xanchortx", height: 100 };
    },
    async isAttested(height: number) {
      calls.isAttested += 1;
      return height <= (script.attestedAt ?? 0);
    },
    recordAttestationWait() {},
    async generateProof() {
      calls.proof += 1;
      if (script.proofFails) {
        throw new attestcoin.AttestcoinError("proof", script.proofFails.message, script.proofFails.retryable);
      }
      return {
        chainKey: 1,
        headerNumber: 100,
        txIndex: 3,
        txHash: "0xanchortx",
        txBytes: "0xdead",
        merkleProof: { root: "0xr", siblings: [] },
        continuityProof: { lowerEndpointDigest: "0xl", roots: [] },
      };
    },
    async submitProof() {
      calls.submit += 1;
      if (script.submitFails) {
        throw new attestcoin.AttestcoinError("submit", script.submitFails.message, script.submitFails.retryable);
      }
      return { txHash: "0xccverify", recorded: 1 };
    },
    async getAgentCredit() {
      calls.credit += 1;
      return {
        totalPayments: 1n,
        totalVolume: 2_000_000n,
        firstPaymentAt: 1_756_100_000n,
        lastPaymentAt: 1_756_100_000n,
        withinTermsPayments: 1n,
        termsCheckedPayments: 1n,
      };
    },
  };
  return { client: client as unknown as attestcoin.AttestcoinClient, calls };
}

function harness(script: FakeScript = {}) {
  const { store, cardId } = seedStore();
  const ac = new AttestcoinStore(store.db);
  const { client, calls } = fakeClient(script);
  let clock = 1_756_200_000;
  const deps = { store, attestcoin: ac, client, now: () => clock };
  return {
    store,
    ac,
    cardId,
    calls,
    deps,
    tick: (by = 60) => {
      clock += by;
    },
    get clock() {
      return clock;
    },
  };
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

describe("attestcoin config", () => {
  const KEYS = [
    "ATTESTPAY_PAYMENT_ANCHOR_ADDRESS",
    "ATTESTPAY_ASC_ADDRESS",
    "ATTESTPAY_ATTESTCOIN_PRIVATE_KEY",
    "ATTESTPAY_ATTESTCOIN_ENABLED",
    "ATTESTPAY_ATTESTCOIN_CHAIN_KEY",
  ];
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  const restore = () => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };

  test("is null when nothing is configured, and says what is missing", () => {
    expect(attestcoinConfig()).toBeNull();
    const why = attestcoinDisabledReason() ?? "";
    expect(why).toContain("ATTESTPAY_PAYMENT_ANCHOR_ADDRESS");
    expect(why).toContain("ATTESTPAY_ASC_ADDRESS");
    expect(why).toContain("ATTESTPAY_ATTESTCOIN_PRIVATE_KEY");
    restore();
  });

  test("names only the vars that are actually missing", () => {
    process.env.ATTESTPAY_PAYMENT_ANCHOR_ADDRESS = "0xaa";
    process.env.ATTESTPAY_ASC_ADDRESS = "0xcc";
    const why = attestcoinDisabledReason() ?? "";
    expect(why).toContain("ATTESTPAY_ATTESTCOIN_PRIVATE_KEY");
    expect(why).not.toContain("ATTESTPAY_ASC_ADDRESS");
    restore();
  });

  test("resolves with defaults once the three required vars are set", () => {
    process.env.ATTESTPAY_PAYMENT_ANCHOR_ADDRESS = "0xaa";
    process.env.ATTESTPAY_ASC_ADDRESS = "0xcc";
    process.env.ATTESTPAY_ATTESTCOIN_PRIVATE_KEY = "ab".repeat(32);
    const cfg = attestcoinConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.chainKey).toBe(ATTESTCOIN_CHAIN_KEYS.ethereumSepolia);
    expect(cfg!.sourceChainId).toBe(11155111);
    expect(cfg!.creditcoinChainId).toBe(102031);
    // A key without 0x must be normalised, or ethers rejects it.
    expect(cfg!.privateKey.startsWith("0x")).toBe(true);
    expect(attestcoinDisabledReason()).toBeNull();
    restore();
  });

  test("treats the empty string as absent, not as a value", () => {
    // .env.example ships optional vars as `KEY=`, which Bun loads as "".
    process.env.ATTESTPAY_PAYMENT_ANCHOR_ADDRESS = "";
    process.env.ATTESTPAY_ASC_ADDRESS = "0xcc";
    process.env.ATTESTPAY_ATTESTCOIN_PRIVATE_KEY = "ab".repeat(32);
    expect(attestcoinConfig()).toBeNull();
    restore();
  });

  test("can be switched off explicitly even when fully configured", () => {
    process.env.ATTESTPAY_PAYMENT_ANCHOR_ADDRESS = "0xaa";
    process.env.ATTESTPAY_ASC_ADDRESS = "0xcc";
    process.env.ATTESTPAY_ATTESTCOIN_PRIVATE_KEY = "ab".repeat(32);
    process.env.ATTESTPAY_ATTESTCOIN_ENABLED = "0";
    expect(attestcoinConfig()).toBeNull();
    expect(attestcoinDisabledReason()).toContain("disabled explicitly");
    restore();
  });

  test("chain key maps to the right EVM chain id", () => {
    expect(CHAIN_KEY_TO_EVM_CHAIN_ID[1]).toBe(11155111);
    expect(CHAIN_KEY_TO_EVM_CHAIN_ID[3]).toBe(1);
    // Base is deliberately absent: it is not an attested source chain.
    expect(Object.values(CHAIN_KEY_TO_EVM_CHAIN_ID)).not.toContain(8453);
    expect(Object.values(CHAIN_KEY_TO_EVM_CHAIN_ID)).not.toContain(84532);
  });
});

// ---------------------------------------------------------------------------
// Card id hashing + terms hashing
// ---------------------------------------------------------------------------

describe("card id and terms hashing", () => {
  test("card id hashes to a 32-byte value, stably", () => {
    const a = cardIdToBytes32("card_root");
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(cardIdToBytes32("card_root")).toBe(a);
    expect(cardIdToBytes32("card_other")).not.toBe(a);
  });

  test("terms hash differs per card even for identical terms", () => {
    const terms = { pay: { period: { amount: "10.00", seconds: 604800 } } };
    expect(termsHashOf("card_a", terms)).not.toBe(termsHashOf("card_b", terms));
  });

  test("terms hash is independent of key order", () => {
    const a = termsHashOf("card_a", { perTxMax: "5.00", expiry: 123 });
    const b = termsHashOf("card_a", { expiry: 123, perTxMax: "5.00" });
    expect(a).toBe(b);
  });

  test("terms hash changes when terms change", () => {
    const a = termsHashOf("card_a", { perTxMax: "5.00" });
    const b = termsHashOf("card_a", { perTxMax: "6.00" });
    expect(a).not.toBe(b);
  });

  test("stableStringify sorts keys recursively", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(stableStringify([3, { b: 1, a: 2 }])).toBe('[3,{"a":2,"b":1}]');
    expect(stableStringify(null)).toBe("null");
  });
});

// ---------------------------------------------------------------------------
// Store behaviour
// ---------------------------------------------------------------------------

describe("attestcoin store", () => {
  test("enqueue is idempotent and never resets an in-flight row", () => {
    const { store, ac, cardId } = harness();
    const ch = insertCharge(store, cardId);

    ac.enqueue(ch, cardId, 1000);
    ac.update(ch, { status: "anchored", anchor_tx_hash: "0xa", anchor_height: 50 }, 1001);

    // A reconcile sweep re-confirming the charge must not rewind the pipeline.
    ac.enqueue(ch, cardId, 1002);

    const row = ac.get(ch)!;
    expect(row.status).toBe("anchored");
    expect(row.anchor_tx_hash).toBe("0xa");
    expect(row.anchor_height).toBe(50);
  });

  test("claimable returns only working states, oldest first", () => {
    const { store, ac, cardId } = harness();
    const a = insertCharge(store, cardId, { id: "ch_a" });
    const b = insertCharge(store, cardId, { id: "ch_b" });
    const c = insertCharge(store, cardId, { id: "ch_c" });

    ac.enqueue(a, cardId, 100);
    ac.enqueue(b, cardId, 100);
    ac.enqueue(c, cardId, 100);
    ac.update(a, { status: "verified" }, 300); // terminal
    ac.update(b, { status: "failed" }, 301); // terminal
    ac.update(c, { status: "anchored" }, 200);

    const claim = ac.claimable(10).map((r) => r.charge_id);
    expect(claim).toEqual(["ch_c"]);
  });

  test("statusCounts reports every status, zero-filled", () => {
    const { store, ac, cardId } = harness();
    ac.enqueue(insertCharge(store, cardId, { id: "ch_1" }), cardId, 100);
    const counts = ac.statusCounts();
    expect(counts.pending).toBe(1);
    expect(counts.verified).toBe(0);
    // Zero-filled, so a dashboard can render every row without undefined checks.
    expect(Object.keys(counts).sort()).toEqual(
      ["anchored", "anchoring", "attested", "failed", "pending", "proving", "verified"].sort(),
    );
  });

  test("cardStats separates verified, failed and in-flight", () => {
    const { store, ac, cardId } = harness();
    const ids = ["s1", "s2", "s3", "s4"].map((i) => insertCharge(store, cardId, { id: i }));
    for (const id of ids) ac.enqueue(id, cardId, 100);
    ac.update(ids[0]!, { status: "verified" }, 200);
    ac.update(ids[1]!, { status: "verified" }, 200);
    ac.update(ids[2]!, { status: "failed" }, 200);

    expect(ac.cardStats(cardId)).toEqual({ total: 4, verified: 2, failed: 1, inFlight: 1 });
  });

  test("retryFailed re-arms a failed row, budget and all", () => {
    const { store, ac, cardId } = harness();
    const ch = insertCharge(store, cardId);
    ac.enqueue(ch, cardId, 100);
    ac.update(ch, { status: "failed", error: "rpc down" }, 200);
    // Park it at the attempt ceiling, as a genuinely exhausted row would be.
    for (let i = 0; i < MAX_ATTEMPTS; i++) ac.update(ch, { bumpAttempts: true }, 200);
    expect(ac.get(ch)!.attempts).toBe(MAX_ATTEMPTS);

    expect(ac.retryFailed(ch, 300)).toBe(true);
    const row = ac.get(ch)!;
    expect(row.status).toBe("pending");
    // Resetting status alone would not help: the worker checks attempts FIRST and
    // would re-park the row on its very next look.
    expect(row.attempts).toBe(0);
    expect(row.error).toBeNull();
  });

  test("retryFailed refuses a row that is not failed", () => {
    const { store, ac, cardId } = harness();
    const ch = insertCharge(store, cardId);
    ac.enqueue(ch, cardId, 100);
    ac.update(ch, { status: "anchored", anchor_tx_hash: "0xa", anchor_height: 5 }, 200);

    // Re-arming a healthy in-flight row would restart its anchoring.
    expect(ac.retryFailed(ch, 300)).toBe(false);
    expect(ac.get(ch)!.status).toBe("anchored");
    expect(ac.get(ch)!.anchor_tx_hash).toBe("0xa");

    expect(ac.retryFailed("nope", 300)).toBe(false);
  });

  test("a re-armed row actually runs again instead of re-failing", async () => {
    // The point of resetting attempts: the worker must pick the row up for real.
    const h = harness({ attestedAt: 100 });
    const ch = insertCharge(h.store, h.cardId);
    h.ac.enqueue(ch, h.cardId, h.clock);
    h.ac.update(ch, { status: "failed", error: "transient" }, h.clock);
    for (let i = 0; i < MAX_ATTEMPTS; i++) h.ac.update(ch, { bumpAttempts: true }, h.clock);

    h.ac.retryFailed(ch, h.clock);
    h.tick();
    const r = await sweepProofs(h.deps);
    expect(r.advanced).toBe(1);
    expect(h.ac.get(ch)!.status).toBe("anchored");
  });

  test("averageVerifySeconds is null with no verified rows, not zero", () => {
    const { store, ac, cardId } = harness();
    const ch = insertCharge(store, cardId);
    ac.enqueue(ch, cardId, 1000);
    // "no data" must not render as "instant".
    expect(ac.averageVerifySeconds(cardId)).toBeNull();

    ac.update(ch, { status: "verified", verified_at: 1120 }, 1120);
    expect(ac.averageVerifySeconds(cardId)).toBe(120);
  });

  test("credit cache round-trips bigints without loss", () => {
    const { ac } = harness();
    ac.cacheCredit(
      USER.address,
      {
        totalPayments: 7n,
        totalVolume: 123_456_789n,
        firstPaymentAt: 1_756_000_000n,
        lastPaymentAt: 1_757_000_000n,
        withinTermsPayments: 6n,
        termsCheckedPayments: 7n,
      },
      1_757_000_100,
    );
    const got = ac.getCachedCredit(USER.address)!;
    expect(got.totalPayments).toBe(7n);
    expect(got.totalVolume).toBe(123_456_789n);
    expect(got.lastSyncedAt).toBe(1_757_000_100);
    // Address lookup must be case-insensitive: checksummed in, lowercase stored.
    expect(ac.getCachedCredit(USER.address.toUpperCase())).not.toBeNull();
  });

  test("terms registration records upgrade pending -> confirmed", () => {
    const { store, ac, cardId } = harness();
    void store;
    ac.recordTermsRegistration(cardId, "0xhash", "pending", 100);
    expect(ac.getTermsRegistration(cardId)!.status).toBe("pending");
    expect(ac.getTermsRegistration(cardId)!.registered_at).toBeNull();

    ac.recordTermsRegistration(cardId, "0xhash", "confirmed", 200, "0xtx");
    const r = ac.getTermsRegistration(cardId)!;
    expect(r.status).toBe("confirmed");
    expect(r.creditcoin_tx_hash).toBe("0xtx");
    expect(r.registered_at).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Anchor request construction
// ---------------------------------------------------------------------------

describe("anchor request", () => {
  test("resolves the payer as the card tree's ROOT funding account", () => {
    const { store, cardId } = seedStore();
    // A sub-card spends from its root's account, so credit must accrue to the root.
    store.createCard({
      ...store.getCard(cardId)!,
      id: "card_child",
      parent_card_id: cardId,
      secret_hash: "h2",
      name: "child",
    });
    expect(payerForCard(store, "card_child")).toBe(USER.address);
  });

  test("builds a request from a confirmed charge", () => {
    const { store, cardId } = seedStore();
    const ch = insertCharge(store, cardId);
    const req = anchorRequestFor(store, ch, 8453)!;
    expect(req.cardId).toBe(cardId);
    expect(req.payer).toBe(USER.address);
    expect(req.merchant).toBe(MERCHANT);
    expect(req.amountAtoms).toBe(2_000_000n);
    expect(req.sourceChainId).toBe(8453);
    expect(req.sourceTxHash).toBe("0xbasetx");
    expect(req.memo).toBe("coffee");
  });

  test("refuses a charge with no on-chain transaction", () => {
    const { store, cardId } = seedStore();
    // Nothing for a third party to check against: not anchorable.
    const ch = insertCharge(store, cardId, { tx_hash: null });
    expect(anchorRequestFor(store, ch, 8453)).toBeNull();
  });

  test("refuses a charge with no recipient", () => {
    const { store, cardId } = seedStore();
    const ch = insertCharge(store, cardId, { to_addr: null });
    expect(anchorRequestFor(store, ch, 8453)).toBeNull();
  });

  test("refuses an unknown charge", () => {
    const { store } = seedStore();
    expect(anchorRequestFor(store, "nope", 8453)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The worker state machine
// ---------------------------------------------------------------------------

describe("proof worker", () => {
  test("walks pending -> anchored -> attested -> verified across ticks", async () => {
    const h = harness({ attestedAt: 100 });
    const ch = insertCharge(h.store, h.cardId);
    h.ac.enqueue(ch, h.cardId, h.clock);

    // tick 1: anchor
    let r = await sweepProofs(h.deps);
    expect(r.advanced).toBe(1);
    expect(h.ac.get(ch)!.status).toBe("anchored");
    expect(h.ac.get(ch)!.anchor_tx_hash).toBe("0xanchortx");

    // tick 2: attestation check passes
    h.tick();
    r = await sweepProofs(h.deps);
    expect(h.ac.get(ch)!.status).toBe("attested");

    // tick 3: prove + submit
    h.tick();
    r = await sweepProofs(h.deps);
    expect(r.verified).toBe(1);

    const row = h.ac.get(ch)!;
    expect(row.status).toBe("verified");
    expect(row.creditcoin_tx_hash).toBe("0xccverify");
    expect(row.verified_at).not.toBeNull();
    expect(row.error).toBeNull();
  });

  test("waits on attestation without burning attempts", async () => {
    // The prover reports "not attested" like any other failure, so an attestation
    // wait that consumed attempts would expire perfectly healthy rows.
    const h = harness({ attestedAt: 0 }); // height 100 is never attested
    const ch = insertCharge(h.store, h.cardId);
    h.ac.enqueue(ch, h.cardId, h.clock);

    await sweepProofs(h.deps); // anchor
    const afterAnchor = h.ac.get(ch)!.attempts;

    for (let i = 0; i < 5; i++) {
      h.tick();
      const r = await sweepProofs(h.deps);
      expect(r.waiting).toBe(1);
    }

    const row = h.ac.get(ch)!;
    expect(row.status).toBe("anchored");
    expect(row.attempts).toBe(afterAnchor);
  });

  test("retryable failures keep the row alive and record the reason", async () => {
    const h = harness({ attestedAt: 100, proofFails: { message: "proof not available yet", retryable: true } });
    const ch = insertCharge(h.store, h.cardId);
    h.ac.enqueue(ch, h.cardId, h.clock);

    await sweepProofs(h.deps); // anchor
    h.tick();
    await sweepProofs(h.deps); // attested
    h.tick();
    const r = await sweepProofs(h.deps); // proof fails

    expect(r.waiting).toBe(1);
    const row = h.ac.get(ch)!;
    expect(row.status).toBe("proving");
    expect(row.error).toContain("proof not available yet");
    expect(row.attempts).toBeGreaterThan(0);
  });

  test("non-retryable failures park the row as failed immediately", async () => {
    const h = harness({
      attestedAt: 100,
      submitFails: { message: "UntrustedAnchorer", retryable: false },
    });
    const ch = insertCharge(h.store, h.cardId);
    h.ac.enqueue(ch, h.cardId, h.clock);

    await sweepProofs(h.deps);
    h.tick();
    await sweepProofs(h.deps);
    h.tick();
    const r = await sweepProofs(h.deps);

    expect(r.failed).toBe(1);
    const row = h.ac.get(ch)!;
    expect(row.status).toBe("failed");
    expect(row.error).toContain("UntrustedAnchorer");
  });

  test("gives up after MAX_ATTEMPTS instead of retrying forever", async () => {
    const h = harness({ anchorFails: { message: "rpc down", retryable: true } });
    const ch = insertCharge(h.store, h.cardId);
    h.ac.enqueue(ch, h.cardId, h.clock);

    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
      h.tick();
      await sweepProofs(h.deps);
      if (h.ac.get(ch)!.status === "failed") break;
    }

    const row = h.ac.get(ch)!;
    expect(row.status).toBe("failed");
    expect(row.attempts).toBeGreaterThanOrEqual(MAX_ATTEMPTS);
  });

  test("parks an unanchorable charge without consuming retries", async () => {
    const h = harness({ attestedAt: 100 });
    const ch = insertCharge(h.store, h.cardId, { tx_hash: null });
    h.ac.enqueue(ch, h.cardId, h.clock);

    const r = await sweepProofs(h.deps);
    expect(r.failed).toBe(1);
    const row = h.ac.get(ch)!;
    expect(row.status).toBe("failed");
    expect(row.error).toContain("not anchorable");
    // Failed on the first look: no point retrying something structurally impossible.
    expect(row.attempts).toBe(0);
  });

  test("refreshes the credit cache on verification", async () => {
    const h = harness({ attestedAt: 100 });
    const ch = insertCharge(h.store, h.cardId);
    h.ac.enqueue(ch, h.cardId, h.clock);

    await sweepProofs(h.deps);
    h.tick();
    await sweepProofs(h.deps);
    h.tick();
    await sweepProofs(h.deps);

    expect(h.calls.credit).toBeGreaterThan(0);
    const cached = h.ac.getCachedCredit(USER.address)!;
    expect(cached.totalPayments).toBe(1n);
    expect(cached.totalVolume).toBe(2_000_000n);
  });

  test("one bad row does not stall the rest of the queue", async () => {
    const h = harness({ attestedAt: 100 });
    const bad = insertCharge(h.store, h.cardId, { id: "ch_bad", tx_hash: null });
    const good = insertCharge(h.store, h.cardId, { id: "ch_good" });
    h.ac.enqueue(bad, h.cardId, h.clock);
    h.ac.enqueue(good, h.cardId, h.clock);

    const r = await sweepProofs(h.deps);
    expect(r.examined).toBe(2);
    expect(h.ac.get(bad)!.status).toBe("failed");
    expect(h.ac.get(good)!.status).toBe("anchored");
  });

  test("respects the batch size", async () => {
    const h = harness({ attestedAt: 100 });
    for (let i = 0; i < 5; i++) {
      h.ac.enqueue(insertCharge(h.store, h.cardId, { id: `b${i}` }), h.cardId, h.clock);
    }
    const r = await sweepProofs({ ...h.deps, batchSize: 2 });
    expect(r.examined).toBe(2);
  });

  test("an empty queue is a clean no-op", async () => {
    const h = harness();
    expect(await sweepProofs(h.deps)).toEqual({
      examined: 0,
      advanced: 0,
      verified: 0,
      failed: 0,
      waiting: 0,
    });
  });

  test("terminal statuses are recognised", () => {
    expect(isTerminalProofStatus("verified")).toBe(true);
    expect(isTerminalProofStatus("failed")).toBe(true);
    expect(isTerminalProofStatus("pending")).toBe(false);
    expect(isTerminalProofStatus("anchored")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Credit grading
// ---------------------------------------------------------------------------

describe("credit grading", () => {
  const base = {
    totalPayments: 0n,
    totalVolume: 0n,
    firstPaymentAt: 0n,
    lastPaymentAt: 0n,
    withinTermsPayments: 0n,
    termsCheckedPayments: 0n,
  };

  test("no history grades F and says so", () => {
    const g = creditGrade(base);
    expect(g.grade).toBe("F");
    expect(g.score).toBe(0);
    expect(g.basis).toContain("no verified payments");
  });

  test("a long, consistent, compliant history grades A", () => {
    const g = creditGrade({
      totalPayments: 20n,
      totalVolume: 50_000_000n, // 50 USDC
      firstPaymentAt: 1_700_000_000n,
      lastPaymentAt: 1_700_000_000n + 60n * 86_400n,
      withinTermsPayments: 20n,
      termsCheckedPayments: 20n,
    });
    expect(g.grade).toBe("A");
    expect(g.score).toBe(100);
    expect(g.basis).toContain("100% within registered terms");
  });

  test("a single small payment scores above zero but still grades F", () => {
    // Deliberate: one 1 USDC payment with no history length is thin credit, and the
    // grade should say so. What it must NOT do is score 0 — that is reserved for
    // "no verified payments at all", a materially different statement.
    const g = creditGrade({
      ...base,
      totalPayments: 1n,
      totalVolume: 1_000_000n,
      firstPaymentAt: 1_756_000_000n,
      lastPaymentAt: 1_756_000_000n,
    });
    expect(g.score).toBe(7); // 4 (count) + 3 (volume) + 0 (age)
    expect(g.grade).toBe("F");
    expect(g.basis).toContain("1 verified payment(s)");
  });

  test("a handful of payments over a few weeks reaches a mid grade", () => {
    const g = creditGrade({
      ...base,
      totalPayments: 6n,
      totalVolume: 8_000_000n,
      firstPaymentAt: 1_756_000_000n,
      lastPaymentAt: 1_756_000_000n + 21n * 86_400n,
    });
    // 24 (count) + 24 (volume) + 21 (age) = 69
    expect(g.grade).toBe("B");
  });

  test("terms violations scale the score down", () => {
    const shared = {
      totalPayments: 20n,
      totalVolume: 50_000_000n,
      firstPaymentAt: 1_700_000_000n,
      lastPaymentAt: 1_700_000_000n + 60n * 86_400n,
    };
    const clean = creditGrade({ ...shared, withinTermsPayments: 20n, termsCheckedPayments: 20n });
    const half = creditGrade({ ...shared, withinTermsPayments: 10n, termsCheckedPayments: 20n });
    expect(half.score).toBeLessThan(clean.score);
    expect(half.basis).toContain("50% within registered terms");
  });

  test("an unregistered card is graded on facts and says terms were not checked", () => {
    const g = creditGrade({
      ...base,
      totalPayments: 20n,
      totalVolume: 50_000_000n,
      firstPaymentAt: 1_700_000_000n,
      lastPaymentAt: 1_700_000_000n + 60n * 86_400n,
    });
    // No free compliance bonus, but no penalty either — the facts still count.
    expect(g.score).toBe(100);
    expect(g.basis).toContain("no registered terms");
  });

  test("score never escapes 0..100", () => {
    const g = creditGrade({
      totalPayments: 10_000n,
      totalVolume: 10_000_000_000_000n,
      firstPaymentAt: 1n,
      lastPaymentAt: 2_000_000_000n,
      withinTermsPayments: 10_000n,
      termsCheckedPayments: 10_000n,
    });
    expect(g.score).toBeLessThanOrEqual(100);
    expect(g.score).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Health + explorer links
// ---------------------------------------------------------------------------

describe("health and links", () => {
  test("disabled health reports why and still shows the local queue", () => {
    const h = harness();
    const ch = insertCharge(h.store, h.cardId);
    h.ac.enqueue(ch, h.cardId, 100);

    const health = attestcoinDisabledHealth(h.ac);
    expect(health.configured).toBe(false);
    expect(health.error).toBeTruthy();
    expect(health.queue.pending).toBe(1);
    // Numeric fields stay null so "unknown" is distinguishable from zero.
    expect(health.attestationLagBlocks).toBeNull();
    expect(health.latestAttestedHeight).toBeNull();
  });

  test("base explorer link follows the payment's chain, not the anchor's", () => {
    expect(baseTxUrl(8453, "0xabc")).toBe("https://basescan.org/tx/0xabc");
    expect(baseTxUrl(84532, "0xabc")).toBe("https://sepolia.basescan.org/tx/0xabc");
  });
});

// Keep the mutex import meaningful: the worker shares the engine's store, and this
// asserts the package export surface stays intact for server-side wiring.
test("engine exports the attestcoin namespace alongside the rest", () => {
  expect(typeof KeyedMutex).toBe("function");
  expect(typeof attestcoin.AttestcoinClient).toBe("function");
  expect(typeof attestcoin.sweepProofs).toBe("function");
  expect(typeof attestcoin.AttestcoinStore).toBe("function");
});
