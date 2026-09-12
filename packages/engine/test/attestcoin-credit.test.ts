// Credit lines, disputes, revocations, the facts pipeline and the passport
// credential: the logic that does NOT need a network.
//
// The fact worker is driven against a FAKE client, same as the payment worker's
// suite, so every transition runs deterministically and offline. The EIP-712 pieces
// are checked against viem's own typed-data hashing, which is what the dashboard
// wallet signs with.

import { describe, expect, test } from "bun:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { hashTypedData, keccak256, concatHex, encodeAbiParameters, type Address, type Hex } from "viem";
import { Store, attestcoin } from "../src/index";
import type { CardRow, ChargeRow } from "../src/store";

const {
  AttestcoinStore,
  CREDIT_LINE_TYPES,
  CreditLineError,
  DisputeError,
  LINE_TYPEHASH,
  MAX_ATTEMPTS,
  assertDrawable,
  assertRepayable,
  attachLineSignature,
  attestcoinConfig,
  attestcoinFeatures,
  availableAtoms,
  cardIdToBytes32,
  creditLineDomain,
  creditLineTypedData,
  disputeIdToBytes32,
  drawableLinesForCard,
  enqueueCardRevocation,
  enqueueLineFactForCharge,
  issuePassportCredential,
  lineDigest,
  lineIdOf,
  openDispute,
  openLineOnChain,
  outstandingAtoms,
  owedAtoms,
  proposeLine,
  recordLineEvent,
  resolveDispute,
  sweepFacts,
  termsOf,
  verifyPassportCredential,
} = attestcoin;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LENDER_PK = generatePrivateKey();
const BORROWER_PK = generatePrivateKey();
const LENDER = privateKeyToAccount(LENDER_PK);
const BORROWER = privateKeyToAccount(BORROWER_PK);
const MERCHANT = "0x00000000000000000000000000000000000000a1" as Address;
const CREDIT_LINE = "0x00000000000000000000000000000000000000c1" as Address;
const CHAIN_ID = 102031;

function card(id: string, userId: string, owner: Address, parent: string | null = null): CardRow {
  return {
    id,
    user_id: userId,
    parent_card_id: parent,
    name: id,
    secret_hash: `h_${id}`,
    secret_enc: null,
    terms: { pay: { period: { amount: "100.00", seconds: 604800 } } },
    kind: "pay",
    compiled: {
      kind: "pay",
      rootCaveats: [],
      orGroups: null,
      carvePolicy: { perTxMaxAtoms: null, merchants: null },
      periodStartDate: 1_750_000_000,
      terms: {},
    },
    delegation: { delegate: MERCHANT, delegator: owner, authority: "0x0" as Hex, caveats: [], salt: "0x1" as Hex, signature: "0x2" as Hex },
    k_agent_enc: new Uint8Array([1]),
    k_agent_address: MERCHANT,
    status: "active",
    created_at: 1_756_000_000,
  };
}

/** Two users: a lender with a funding card, a borrower with a card whose agent draws. */
function seed() {
  const store = new Store(":memory:");
  store.upsertUser({ id: "lender", address: LENDER.address });
  store.upsertUser({ id: "borrower", address: BORROWER.address });
  store.createCard(card("card_fund", "lender", LENDER.address));
  store.createCard(card("card_agent", "borrower", BORROWER.address));
  const ac = new AttestcoinStore(store.db);
  return { store, ac };
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
    tx_hash: `0x${id.padEnd(64, "0").slice(0, 64)}` as Hex,
    status: "confirmed",
    memo: "coffee",
    created_at: 1_756_100_000,
    ...over,
  });
  return id;
}

const NOW = 1_757_000_000;
const config = { creditcoinChainId: CHAIN_ID, creditLineAddress: CREDIT_LINE, paymentChainId: 8453 };

async function sign(pk: Hex, row: attestcoin.CreditLineRow): Promise<Hex> {
  const account = privateKeyToAccount(pk);
  return account.signTypedData(creditLineTypedData(CHAIN_ID, CREDIT_LINE, termsOf(row)));
}

type FakeScript = {
  anchorFails?: { message: string; retryable: boolean };
  attestedAt?: number;
  submitFails?: { message: string; retryable: boolean };
  openFails?: { message: string; retryable: boolean };
  line?: Partial<attestcoin.CreditLineOnChain>;
};

function fakeClient(script: FakeScript = {}) {
  const calls = { anchorFact: 0, submitFacts: 0, open: 0, getLine: 0, anchored: [] as attestcoin.FactRow[] };
  const client = {
    config: { chainKey: 1, sourceChainId: 11155111, paymentChainId: 8453, creditcoinChainId: CHAIN_ID, creditLineAddress: CREDIT_LINE },
    async anchorFact(fact: attestcoin.FactRow) {
      calls.anchorFact += 1;
      calls.anchored.push(fact);
      if (script.anchorFails) throw new attestcoin.AttestcoinError("anchor", script.anchorFails.message, script.anchorFails.retryable);
      return { txHash: "0xfactanchor", height: 100 };
    },
    async isAttested(height: number) {
      return height <= (script.attestedAt ?? 0);
    },
    recordAttestationWait() {},
    async generateProof() {
      return {
        chainKey: 1,
        headerNumber: 100,
        txIndex: 3,
        txHash: "0xfactanchor",
        txBytes: "0xdead",
        merkleProof: { root: "0xr", siblings: [] },
        continuityProof: { lowerEndpointDigest: "0xl", roots: [] },
      };
    },
    async submitFacts() {
      calls.submitFacts += 1;
      if (script.submitFails) throw new attestcoin.AttestcoinError("submit", script.submitFails.message, script.submitFails.retryable);
      return { txHash: "0xccfacts", recorded: 1 };
    },
    async openCreditLine(terms: { lender: string }) {
      calls.open += 1;
      if (script.openFails) throw new attestcoin.AttestcoinError("submit", script.openFails.message, script.openFails.retryable);
      return { txHash: "0xopen", lineId: "0xline" };
    },
    async getLine() {
      calls.getLine += 1;
      if (!script.line) return null;
      return {
        lender: LENDER.address,
        borrower: BORROWER.address,
        limit: 10_000_000n,
        interestBps: 500n,
        expiresAt: BigInt(NOW + 86_400),
        nonce: 1n,
        status: 2,
        drawn: 0n,
        repaid: 0n,
        openedAt: 0n,
        lastEventAt: 0n,
        defaultedAt: 0n,
        repaidAt: 0n,
        owed: 0n,
        outstanding: 0n,
        available: 0n,
        ...script.line,
      };
    },
    async getAgentCredit() {
      return { totalPayments: 0n, totalVolume: 0n, firstPaymentAt: 0n, lastPaymentAt: 0n, withinTermsPayments: 0n, termsCheckedPayments: 0n };
    },
  };
  return { client: client as unknown as attestcoin.AttestcoinClient, calls };
}

function propose(ac: attestcoin.AttestcoinStore, over: Partial<attestcoin.ProposeLineInput> = {}) {
  return proposeLine(
    ac,
    {
      lenderUserId: "lender",
      lenderAddress: LENDER.address,
      borrowerAddress: BORROWER.address,
      borrowerCardId: "card_agent",
      fundingCardId: "card_fund",
      limitAtoms: 10_000_000n,
      interestBps: 500,
      expiresAt: NOW + 30 * 86_400,
      nonce: 1n,
      ...over,
    },
    NOW,
  );
}

// ---------------------------------------------------------------------------
// EIP-712: what the dashboard signs must be what the contract checks
// ---------------------------------------------------------------------------

describe("credit line typed data", () => {
  test("LINE_TYPEHASH matches the contract's type string", () => {
    expect(LINE_TYPEHASH).toBe(
      keccak256(
        new TextEncoder().encode(
          "CreditLine(address lender,address borrower,uint256 limit,uint256 interestBps,uint256 expiresAt,uint256 nonce)",
        ),
      ),
    );
    expect(CREDIT_LINE_TYPES.CreditLine.map((f) => `${f.type} ${f.name}`)).toEqual([
      "address lender",
      "address borrower",
      "uint256 limit",
      "uint256 interestBps",
      "uint256 expiresAt",
      "uint256 nonce",
    ]);
  });

  test("lineIdOf is the EIP-712 struct hash, and the digest is 0x1901 || domain || structHash", () => {
    const terms = {
      lender: LENDER.address,
      borrower: BORROWER.address,
      limit: 10_000_000n,
      interestBps: 500n,
      expiresAt: 1_760_000_000n,
      nonce: 7n,
    };
    const domain = creditLineDomain(CHAIN_ID, CREDIT_LINE);
    const domainSeparator = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
        [
          keccak256(new TextEncoder().encode("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
          keccak256(new TextEncoder().encode(domain.name)),
          keccak256(new TextEncoder().encode(domain.version)),
          BigInt(domain.chainId),
          domain.verifyingContract,
        ],
      ),
    );
    const expected = keccak256(concatHex(["0x1901", domainSeparator, lineIdOf(terms)]));
    expect(lineDigest(CHAIN_ID, CREDIT_LINE, terms)).toBe(expected);
    // And viem's own typed-data hash agrees, which is what the wallet actually signs.
    expect(hashTypedData(creditLineTypedData(CHAIN_ID, CREDIT_LINE, terms))).toBe(expected);
  });

  test("the line id changes with every term and with the nonce", () => {
    const base = { lender: LENDER.address, borrower: BORROWER.address, limit: 1n, interestBps: 0n, expiresAt: 10n, nonce: 1n };
    const id = lineIdOf(base);
    expect(lineIdOf({ ...base, nonce: 2n })).not.toBe(id);
    expect(lineIdOf({ ...base, limit: 2n })).not.toBe(id);
    expect(lineIdOf({ ...base, borrower: MERCHANT })).not.toBe(id);
    // But not with the verifying contract: the id is the struct hash, the DIGEST is domain-bound.
    expect(lineDigest(CHAIN_ID, CREDIT_LINE, base)).not.toBe(lineDigest(CHAIN_ID, MERCHANT, base));
  });
});

// ---------------------------------------------------------------------------
// Proposing and signing
// ---------------------------------------------------------------------------

describe("credit line proposal and signatures", () => {
  test("proposes a line whose id is the struct hash", () => {
    const { ac } = seed();
    const row = propose(ac);
    expect(row.id).toBe(lineIdOf(termsOf(row)));
    expect(row.status).toBe("proposed");
    expect(ac.getLine(row.id)!.limit_atoms).toBe(10_000_000n);
    expect(ac.listLinesByLender("lender")).toHaveLength(1);
    expect(ac.listLinesByBorrower(BORROWER.address.toUpperCase())).toHaveLength(1);
  });

  test("refuses terms the contract would refuse", () => {
    const { ac } = seed();
    expect(() => propose(ac, { limitAtoms: 0n })).toThrow(CreditLineError);
    expect(() => propose(ac, { interestBps: 10_001 })).toThrow(CreditLineError);
    expect(() => propose(ac, { expiresAt: NOW })).toThrow(CreditLineError);
    expect(() => propose(ac, { borrowerAddress: LENDER.address })).toThrow(CreditLineError);
  });

  test("accepts each party's signature and flips to signed when both are present", async () => {
    const { ac } = seed();
    const row = propose(ac);

    const lenderSig = await sign(LENDER_PK, row);
    let after = await attachLineSignature(ac, config, row.id, "lender", lenderSig, NOW);
    expect(after.lender_sig).toBe(lenderSig);
    expect(after.status).toBe("proposed");

    const borrowerSig = await sign(BORROWER_PK, row);
    after = await attachLineSignature(ac, config, row.id, "borrower", borrowerSig, NOW);
    expect(after.borrower_sig).toBe(borrowerSig);
    expect(after.status).toBe("signed");
  });

  test("rejects a signature from the wrong party", async () => {
    const { ac } = seed();
    const row = propose(ac);
    const borrowerSig = await sign(BORROWER_PK, row);
    await expect(attachLineSignature(ac, config, row.id, "lender", borrowerSig, NOW)).rejects.toThrow(/recovers to/);
    expect(ac.getLine(row.id)!.lender_sig).toBeNull();
  });

  test("rejects a signature over a different contract's domain", async () => {
    const { ac } = seed();
    const row = propose(ac);
    const wrongDomain = await LENDER.signTypedData(creditLineTypedData(CHAIN_ID, MERCHANT, termsOf(row)));
    await expect(attachLineSignature(ac, config, row.id, "lender", wrongDomain, NOW)).rejects.toThrow(CreditLineError);
  });

  test("rejects a malformed signature", async () => {
    const { ac } = seed();
    const row = propose(ac);
    await expect(attachLineSignature(ac, config, row.id, "lender", "0x1234" as Hex, NOW)).rejects.toThrow(/malformed/);
  });
});

// ---------------------------------------------------------------------------
// Opening on-chain
// ---------------------------------------------------------------------------

describe("opening a line on Creditcoin", () => {
  async function signedLine(ac: attestcoin.AttestcoinStore) {
    const row = propose(ac);
    await attachLineSignature(ac, config, row.id, "lender", await sign(LENDER_PK, row), NOW);
    await attachLineSignature(ac, config, row.id, "borrower", await sign(BORROWER_PK, row), NOW);
    return ac.getLine(row.id)!;
  }

  test("opens a signed line and records the transaction", async () => {
    const { ac } = seed();
    const row = await signedLine(ac);
    const { client, calls } = fakeClient();
    const r = await openLineOnChain({ attestcoin: ac, client }, row.id, NOW);
    expect(r.ok).toBe(true);
    expect(calls.open).toBe(1);
    const after = ac.getLine(row.id)!;
    expect(after.status).toBe("open");
    expect(after.creditcoin_tx_hash).toBe("0xopen");
  });

  test("refuses to open an unsigned line", async () => {
    const { ac } = seed();
    const row = propose(ac);
    const { client, calls } = fakeClient();
    const r = await openLineOnChain({ attestcoin: ac, client }, row.id, NOW);
    expect(r.ok).toBe(false);
    expect(calls.open).toBe(0);
  });

  test("a permanent rejection parks the line as failed; a transient one leaves it signed", async () => {
    const { ac } = seed();
    const row = await signedLine(ac);

    let f = fakeClient({ openFails: { message: "openLine rejected on simulation: NonceUsed", retryable: false } });
    let r = await openLineOnChain({ attestcoin: ac, client: f.client }, row.id, NOW);
    expect(r.ok).toBe(false);
    expect(ac.getLine(row.id)!.status).toBe("failed");
    expect(ac.getLine(row.id)!.error).toContain("NonceUsed");

    // Reset to signed to try the transient path.
    ac.updateLine(row.id, { status: "signed", error: null }, NOW);
    f = fakeClient({ openFails: { message: "rpc down", retryable: true } });
    r = await openLineOnChain({ attestcoin: ac, client: f.client }, row.id, NOW);
    expect(r.ok).toBe(false);
    expect(ac.getLine(row.id)!.status).toBe("signed");
    expect(ac.linesAwaitingOpen()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Draws, repayments and their facts
// ---------------------------------------------------------------------------

describe("draws and repayments", () => {
  function openLine(ac: attestcoin.AttestcoinStore) {
    const row = propose(ac);
    ac.updateLine(row.id, { status: "open" }, NOW);
    return ac.getLine(row.id)!;
  }

  test("available / owed / outstanding follow the contract's arithmetic", () => {
    const { ac } = seed();
    const row = openLine(ac);
    expect(availableAtoms(row, NOW)).toBe(10_000_000n);
    expect(availableAtoms(row, row.expires_at + 1)).toBe(0n);

    const drawn = { ...row, drawn_atoms: 4_000_000n, repaid_atoms: 0n };
    expect(owedAtoms(drawn)).toBe(4_200_000n);
    expect(outstandingAtoms(drawn)).toBe(4_200_000n);
    expect(outstandingAtoms({ ...drawn, repaid_atoms: 5_000_000n })).toBe(0n);
  });

  test("assertDrawable refuses over-limit, expired and closed lines", () => {
    const { ac } = seed();
    const row = openLine(ac);
    expect(() => assertDrawable(row, 10_000_001n, NOW)).toThrow(/exceeds available/);
    expect(() => assertDrawable(row, 1n, row.expires_at + 1)).toThrow(/expired/);
    expect(() => assertDrawable({ ...row, status: "repaid" }, 1n, NOW)).toThrow(/line is repaid/);
    expect(() => assertDrawable(row, 0n, NOW)).toThrow(/positive/);
    expect(() => assertDrawable(row, 10_000_000n, NOW)).not.toThrow();
  });

  test("assertRepayable needs an active or defaulted line with a balance", () => {
    const { ac } = seed();
    const row = openLine(ac);
    expect(() => assertRepayable(row, 1n)).toThrow(/nothing to repay/);
    const active = { ...row, status: "active" as const, drawn_atoms: 1_000_000n };
    expect(() => assertRepayable(active, 1n)).not.toThrow();
    expect(() => assertRepayable({ ...active, repaid_atoms: 2_000_000n }, 1n)).toThrow(/fully repaid/);
    expect(() => assertRepayable({ ...active, status: "defaulted" }, 1n)).not.toThrow();
  });

  test("recordLineEvent mirrors the draw locally and the confirmed charge enqueues the fact", () => {
    const { store, ac } = seed();
    const row = openLine(ac);
    const ch = insertCharge(store, "card_fund", { to_addr: BORROWER.address, amount_atoms: 3_000_000n });

    recordLineEvent(ac, row, "draw", ch, 3_000_000n, NOW);
    const after = ac.getLine(row.id)!;
    expect(after.drawn_atoms).toBe(3_000_000n);
    expect(after.status).toBe("active");
    expect(ac.getLineEventByCharge(ch)!.kind).toBe("draw");

    const factId = enqueueLineFactForCharge({ store, attestcoin: ac, config }, ch, NOW);
    expect(factId).toBe(`fact:draw:${ch}`);
    const fact = ac.getFact(factId!)!;
    expect(fact.kind).toBe("draw");
    expect(fact.target).toBe("credit_line");
    expect(fact.ref_id).toBe(row.id);
    expect(fact.card_id).toBe("card_fund");
    expect(fact.payload).toMatchObject({
      kind: "draw",
      lineId: row.id,
      borrower: BORROWER.address,
      lender: LENDER.address,
      amountAtoms: "3000000",
      sourceChainId: 8453,
      at: 1_756_100_000,
    });
  });

  test("an unrelated confirmed charge enqueues nothing", () => {
    const { store, ac } = seed();
    const ch = insertCharge(store, "card_fund");
    expect(enqueueLineFactForCharge({ store, attestcoin: ac, config }, ch, NOW)).toBeNull();
    expect(ac.factStatusCounts().pending).toBe(0);
  });

  test("a pending (unconfirmed) draw charge is not enqueued yet", () => {
    const { store, ac } = seed();
    const row = openLine(ac);
    const ch = insertCharge(store, "card_fund", { status: "pending", tx_hash: null });
    recordLineEvent(ac, row, "draw", ch, 1_000_000n, NOW);
    expect(enqueueLineFactForCharge({ store, attestcoin: ac, config }, ch, NOW)).toBeNull();
  });

  test("repayment facts are scoped to the borrower's card", () => {
    const { store, ac } = seed();
    const row = openLine(ac);
    ac.updateLine(row.id, { status: "active", drawn_atoms: 2_000_000n }, NOW);
    const ch = insertCharge(store, "card_agent", { to_addr: LENDER.address, amount_atoms: 1_000_000n });
    recordLineEvent(ac, ac.getLine(row.id)!, "repayment", ch, 1_000_000n, NOW);
    const factId = enqueueLineFactForCharge({ store, attestcoin: ac, config }, ch, NOW)!;
    const fact = ac.getFact(factId)!;
    expect(fact.kind).toBe("repayment");
    expect(fact.card_id).toBe("card_agent");
    expect(ac.getLine(row.id)!.repaid_atoms).toBe(1_000_000n);
  });

  test("drawableLinesForCard resolves through the card's funding account", () => {
    const { store, ac } = seed();
    const row = openLine(ac);
    expect(drawableLinesForCard(store, ac, "card_agent", NOW).map((l) => l.id)).toEqual([row.id]);
    expect(drawableLinesForCard(store, ac, "card_fund", NOW)).toEqual([]);
    // A sub-card of the borrower's card sees the same lines: credit belongs to the root.
    store.createCard(card("card_sub", "borrower", BORROWER.address, "card_agent"));
    expect(drawableLinesForCard(store, ac, "card_sub", NOW)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The facts pipeline
// ---------------------------------------------------------------------------

describe("facts worker", () => {
  function harness(script: FakeScript = {}) {
    const { store, ac } = seed();
    const { client, calls } = fakeClient(script);
    let clock = NOW;
    const events: attestcoin.PipelineEvent[] = [];
    const deps = { store, attestcoin: ac, client, now: () => clock, onTerminal: (e: attestcoin.PipelineEvent) => events.push(e) };
    const row = propose(ac);
    ac.updateLine(row.id, { status: "open" }, NOW);
    const ch = insertCharge(store, "card_fund", { to_addr: BORROWER.address, amount_atoms: 3_000_000n });
    recordLineEvent(ac, ac.getLine(row.id)!, "draw", ch, 3_000_000n, NOW);
    const factId = enqueueLineFactForCharge({ store, attestcoin: ac, config }, ch, NOW)!;
    return { store, ac, client, calls, deps, events, factId, lineId: row.id, tick: (by = 60) => (clock += by) };
  }

  test("drives a fact pending -> anchored -> attested -> verified, one state per tick", async () => {
    const h = harness({ attestedAt: 100, line: { status: 2, drawn: 3_000_000n, repaid: 0n } });

    let r = await sweepFacts(h.deps);
    expect(r.advanced).toBe(1);
    expect(h.ac.getFact(h.factId)!.status).toBe("anchored");
    expect(h.ac.getFact(h.factId)!.anchor_tx_hash).toBe("0xfactanchor");
    expect(h.calls.anchored[0]!.payload.kind).toBe("draw");

    h.tick();
    r = await sweepFacts(h.deps);
    expect(h.ac.getFact(h.factId)!.status).toBe("attested");

    h.tick();
    r = await sweepFacts(h.deps);
    expect(r.verified).toBe(1);
    const fact = h.ac.getFact(h.factId)!;
    expect(fact.status).toBe("verified");
    expect(fact.creditcoin_tx_hash).toBe("0xccfacts");
    expect(h.calls.submitFacts).toBe(1);
    // The verified draw re-synced the line from the chain.
    expect(h.calls.getLine).toBe(1);
    expect(h.ac.getLine(h.lineId)!.status).toBe("active");
    expect(h.events).toEqual([{ pipeline: "fact", status: "verified", row: expect.objectContaining({ id: h.factId }) }]);
  });

  test("waits without consuming attempts while the anchor is unattested", async () => {
    const h = harness({ attestedAt: 50 });
    await sweepFacts(h.deps);
    const before = h.ac.getFact(h.factId)!.attempts;
    for (let i = 0; i < 5; i++) {
      h.tick();
      const r = await sweepFacts(h.deps);
      expect(r.waiting).toBe(1);
    }
    expect(h.ac.getFact(h.factId)!.attempts).toBe(before);
    expect(h.ac.getFact(h.factId)!.status).toBe("anchored");
  });

  test("a permanent anchor failure parks the fact and notifies", async () => {
    const h = harness({ anchorFails: { message: "already anchored but not found", retryable: false } });
    const r = await sweepFacts(h.deps);
    expect(r.failed).toBe(1);
    expect(h.ac.getFact(h.factId)!.status).toBe("failed");
    expect(h.events[0]).toMatchObject({ pipeline: "fact", status: "failed" });
  });

  test("a retryable submit failure keeps the row proving and eventually exhausts", async () => {
    const h = harness({ attestedAt: 100, submitFails: { message: "rpc hiccup", retryable: true } });
    await sweepFacts(h.deps); // anchored
    h.tick();
    await sweepFacts(h.deps); // attested
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      h.tick();
      await sweepFacts(h.deps);
    }
    const fact = h.ac.getFact(h.factId)!;
    expect(fact.status).toBe("failed");
    expect(fact.error).toContain("rpc hiccup");
    // Re-arming resets the budget, same as payments.
    expect(h.ac.retryFailedFact(h.factId, NOW)).toBe(true);
    expect(h.ac.getFact(h.factId)!.attempts).toBe(0);
  });

  test("fact and payment queues are separate", () => {
    const h = harness();
    expect(h.ac.factStatusCounts().pending).toBe(1);
    expect(h.ac.statusCounts().pending).toBe(0);
    expect(h.ac.listFactsByRef(h.lineId)).toHaveLength(1);
    expect(h.ac.listFactsByCard("card_fund")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Disputes
// ---------------------------------------------------------------------------

describe("disputes", () => {
  test("opens a dispute on a confirmed payment and enqueues the fact", () => {
    const { store, ac } = seed();
    const ch = insertCharge(store, "card_agent");
    const d = openDispute({ store, attestcoin: ac, config }, { chargeId: ch, cardId: "card_agent", openedByUserId: "borrower", reason: "never delivered" }, NOW);
    expect(d.status).toBe("open");
    expect(ac.openDisputeForCharge(ch)!.id).toBe(d.id);

    const fact = ac.getFact(`fact:dispute_opened:${d.id}`)!;
    expect(fact.kind).toBe("dispute_opened");
    expect(fact.target).toBe("ledger");
    expect(fact.payload).toMatchObject({
      kind: "dispute_opened",
      disputeId: disputeIdToBytes32(d.id),
      cardIdHash: cardIdToBytes32("card_agent"),
      payer: BORROWER.address,
      merchant: MERCHANT,
      amountAtoms: "2000000",
      reason: "never delivered",
    });
  });

  test("refuses a second open dispute on the same payment", () => {
    const { store, ac } = seed();
    const ch = insertCharge(store, "card_agent");
    const deps = { store, attestcoin: ac, config };
    openDispute(deps, { chargeId: ch, cardId: "card_agent", openedByUserId: "borrower", reason: "a" }, NOW);
    expect(() => openDispute(deps, { chargeId: ch, cardId: "card_agent", openedByUserId: "borrower", reason: "b" }, NOW)).toThrow(DisputeError);
  });

  test("refuses to dispute a pending or x402 charge, or a charge on another card", () => {
    const { store, ac } = seed();
    const deps = { store, attestcoin: ac, config };
    const pending = insertCharge(store, "card_agent", { status: "pending", tx_hash: null });
    expect(() => openDispute(deps, { chargeId: pending, cardId: "card_agent", openedByUserId: "borrower", reason: "x" }, NOW)).toThrow(/confirmed/);
    const other = insertCharge(store, "card_fund");
    expect(() => openDispute(deps, { chargeId: other, cardId: "card_agent", openedByUserId: "borrower", reason: "x" }, NOW)).toThrow(/no such charge/);
  });

  test("resolves with each outcome and enqueues the outcome code", () => {
    const { store, ac } = seed();
    const deps = { store, attestcoin: ac, config };
    const outcomes = [
      ["upheld", 1],
      ["rejected", 2],
      ["withdrawn", 3],
    ] as const;
    for (const [outcome, code] of outcomes) {
      const ch = insertCharge(store, "card_agent");
      const d = openDispute(deps, { chargeId: ch, cardId: "card_agent", openedByUserId: "borrower", reason: "r" }, NOW);
      const r = resolveDispute(deps, d.id, outcome, "note", "admin", NOW + 10);
      expect(r.status).toBe(outcome);
      expect(r.resolved_at).toBe(NOW + 10);
      expect(r.resolved_by).toBe("admin");
      expect(ac.getFact(`fact:dispute_resolved:${d.id}`)!.payload).toMatchObject({ kind: "dispute_resolved", outcome: code });
    }
    expect(ac.listDisputes(null)).toHaveLength(3);
    expect(ac.listDisputes("open")).toHaveLength(0);
  });

  test("cannot resolve twice", () => {
    const { store, ac } = seed();
    const deps = { store, attestcoin: ac, config };
    const ch = insertCharge(store, "card_agent");
    const d = openDispute(deps, { chargeId: ch, cardId: "card_agent", openedByUserId: "borrower", reason: "r" }, NOW);
    resolveDispute(deps, d.id, "rejected", null, "admin", NOW);
    expect(() => resolveDispute(deps, d.id, "upheld", null, "admin", NOW)).toThrow(/already rejected/);
  });

  test("without a ledger configured, disputes stay local and no fact is queued", () => {
    const { store, ac } = seed();
    const ch = insertCharge(store, "card_agent");
    const d = openDispute({ store, attestcoin: ac, config: null }, { chargeId: ch, cardId: "card_agent", openedByUserId: "borrower", reason: "r" }, NOW);
    expect(ac.getDispute(d.id)).not.toBeNull();
    expect(ac.factStatusCounts().pending).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Revocations
// ---------------------------------------------------------------------------

describe("proven revocations", () => {
  test("enqueues one revocation fact per card, idempotently", () => {
    const { store, ac } = seed();
    const id = enqueueCardRevocation({ store, attestcoin: ac }, "card_agent", NOW);
    expect(id).toBe("fact:card_revoked:card_agent");
    // revoke + nuke + cascade all collapse to the first.
    enqueueCardRevocation({ store, attestcoin: ac }, "card_agent", NOW + 100);
    expect(ac.factStatusCounts().pending).toBe(1);
    expect(ac.getFact(id!)!.payload).toMatchObject({
      kind: "card_revoked",
      cardIdHash: cardIdToBytes32("card_agent"),
      payer: BORROWER.address,
      revokedAt: NOW,
    });
  });

  test("an unknown card enqueues nothing", () => {
    const { store, ac } = seed();
    expect(enqueueCardRevocation({ store, attestcoin: ac }, "ghost", NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The passport credential
// ---------------------------------------------------------------------------

describe("passport credential", () => {
  const passport: attestcoin.Passport = {
    account: BORROWER.address,
    verifiedPayments: 12n,
    verifiedVolume: 34_500_000n,
    firstPaymentAt: 1_756_000_000n,
    lastPaymentAt: 1_756_900_000n,
    withinTermsPayments: 12n,
    termsCheckedPayments: 12n,
    linesOpened: 1n,
    linesRepaid: 1n,
    linesDefaulted: 0n,
    totalDrawn: 5_000_000n,
    totalRepaid: 5_250_000n,
    disputesOpened: 0n,
    disputesUpheld: 0n,
    disputesRejected: 0n,
    disputedVolume: 0n,
    guaranteeBonded: 3_000_000_000_000_000_000n,
    score: 96n,
    grade: "A",
    asOf: BigInt(NOW),
  };
  const SIGNER_PK = generatePrivateKey();
  const SIGNER = privateKeyToAccount(SIGNER_PK);

  test("issues a credential that verifies against the signer and carries the units", async () => {
    const cred = await issuePassportCredential(passport, {
      signerPrivateKey: SIGNER_PK,
      issuer: "https://api.example",
      chainId: CHAIN_ID,
      passportContract: MERCHANT,
      now: NOW,
    });
    expect(cred.signer).toBe(SIGNER.address);
    expect(cred.payload.passport.verified_volume_usdc).toBe("34.500000");
    expect(cred.payload.passport.guarantee_bonded_ctc).toBe("3.000000");
    expect(cred.payload.passport.grade).toBe("A");
    expect(cred.payload.passport.first_payment_at).toBe("2025-08-24T01:46:40.000Z");

    const ok = await verifyPassportCredential(cred, { expectedSigner: SIGNER.address, now: NOW + 60 });
    expect(ok).toEqual({ valid: true, signer: SIGNER.address, expired: false });
  });

  test("rejects a tampered payload, a wrong signer and an expired document", async () => {
    const cred = await issuePassportCredential(passport, {
      signerPrivateKey: SIGNER_PK,
      issuer: "i",
      chainId: CHAIN_ID,
      passportContract: MERCHANT,
      now: NOW,
      ttlSeconds: 100,
    });

    const tampered = { ...cred, payload: { ...cred.payload, passport: { ...cred.payload.passport, score: 100 } } };
    const t = await verifyPassportCredential(tampered, { expectedSigner: SIGNER.address, now: NOW });
    expect(t.valid).toBe(false);
    expect(t.signer).not.toBe(SIGNER.address);

    const wrong = await verifyPassportCredential(cred, { expectedSigner: LENDER.address, now: NOW });
    expect(wrong.valid).toBe(false);
    expect(wrong.reason).toMatch(/expected/);

    const late = await verifyPassportCredential(cred, { expectedSigner: SIGNER.address, now: NOW + 101 });
    expect(late).toMatchObject({ valid: false, expired: true });
  });
});

// ---------------------------------------------------------------------------
// Configuration of the optional features and the auto chain key
// ---------------------------------------------------------------------------

describe("feature configuration", () => {
  const KEYS = [
    "ATTESTPAY_PAYMENT_ANCHOR_ADDRESS",
    "ATTESTPAY_ASC_ADDRESS",
    "ATTESTPAY_ATTESTCOIN_PRIVATE_KEY",
    "ATTESTPAY_ATTESTCOIN_CHAIN_KEY",
    "ATTESTPAY_FACT_ANCHOR_ADDRESS",
    "ATTESTPAY_CREDIT_LINE_ADDRESS",
    "ATTESTPAY_LEDGER_ADDRESS",
    "ATTESTPAY_GUARANTEE_ADDRESS",
    "ATTESTPAY_PASSPORT_ADDRESS",
    "ATTESTPAY_PAYMENT_CHAIN_ID",
  ];
  function withEnv(vars: Record<string, string>, fn: () => void) {
    const saved: Record<string, string | undefined> = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    Object.assign(process.env, vars);
    try {
      fn();
    } finally {
      for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  }
  const base = {
    ATTESTPAY_PAYMENT_ANCHOR_ADDRESS: "0xaa",
    ATTESTPAY_ASC_ADDRESS: "0xcc",
    ATTESTPAY_ATTESTCOIN_PRIVATE_KEY: "ab".repeat(32),
  };

  test("features are off until each contract is configured, and need the fact anchor", () => {
    withEnv(base, () => {
      const cfg = attestcoinConfig()!;
      expect(attestcoinFeatures(cfg)).toEqual({ credit: false, disputes: false, guarantee: false, passport: false });
      expect(cfg.paymentChainId).toBe(8453);
    });
    withEnv({ ...base, ATTESTPAY_CREDIT_LINE_ADDRESS: "0xc1", ATTESTPAY_LEDGER_ADDRESS: "0xd1" }, () => {
      // Consumers without the anchor cannot receive facts.
      expect(attestcoinFeatures(attestcoinConfig()!).credit).toBe(false);
    });
    withEnv(
      {
        ...base,
        ATTESTPAY_FACT_ANCHOR_ADDRESS: "0xfa",
        ATTESTPAY_CREDIT_LINE_ADDRESS: "0xc1",
        ATTESTPAY_LEDGER_ADDRESS: "0xd1",
        ATTESTPAY_GUARANTEE_ADDRESS: "0x61",
        ATTESTPAY_PASSPORT_ADDRESS: "0x91",
      },
      () => {
        expect(attestcoinFeatures(attestcoinConfig()!)).toEqual({ credit: true, disputes: true, guarantee: true, passport: true });
      },
    );
  });

  test("chain key 'auto' is recognised and keeps a Sepolia default until resolved", () => {
    withEnv({ ...base, ATTESTPAY_ATTESTCOIN_CHAIN_KEY: "auto" }, () => {
      const cfg = attestcoinConfig()!;
      expect(cfg.chainKeyMode).toBe("auto");
      expect(cfg.chainKey).toBe(1);
    });
    withEnv({ ...base, ATTESTPAY_ATTESTCOIN_CHAIN_KEY: "3" }, () => {
      const cfg = attestcoinConfig()!;
      expect(cfg.chainKeyMode).toBe("env");
      expect(cfg.chainKey).toBe(3);
      expect(cfg.sourceChainId).toBe(1);
    });
  });

  test("payment chain id is configurable and guarded", () => {
    withEnv({ ...base, ATTESTPAY_PAYMENT_CHAIN_ID: "84532" }, () => {
      expect(attestcoinConfig()!.paymentChainId).toBe(84532);
    });
    withEnv({ ...base, ATTESTPAY_PAYMENT_CHAIN_ID: "nope" }, () => {
      expect(attestcoinConfig()!.paymentChainId).toBe(8453);
    });
  });
});
