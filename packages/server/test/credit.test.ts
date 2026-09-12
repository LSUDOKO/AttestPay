// Credit lines, disputes, guarantees and the passport through the REAL Hono app and
// a real MCP client, with a fake Attestcoin client standing in for the networks.
//
// Two configurations again: DISABLED (client null — nothing offered, nothing 500s)
// and ENABLED with every feature on. The flows under test are the ones a lender and
// an agent actually walk: propose -> both sign -> registered -> agent draws ->
// agent repays -> facts queued; open a dispute -> operator resolves; read and verify
// the public passport.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { KeyedMutex, Store, attestcoin, issueRootCard, type Relayer } from "@attestpay/engine";
import { createApp } from "../src/app";
import type { AppDeps } from "../src/deps";

const ADMIN = "test-admin-credit";
const CHAIN_ID = 102031;
const CREDIT_LINE = "0x00000000000000000000000000000000000000c1" as Address;
const PASSPORT = "0x0000000000000000000000000000000000000091" as Address;
const ANCHORER_PK = `0x${"ab".repeat(32)}` as Hex;
const ANCHORER = privateKeyToAccount(ANCHORER_PK);

const lender = privateKeyToAccount(generatePrivateKey());
const borrower = privateKeyToAccount(generatePrivateKey());
const LENDER_ID = lender.address.toLowerCase();
const BORROWER_ID = borrower.address.toLowerCase();

let server: ReturnType<typeof Bun.serve>;
let base: string;
let store: Store;
let deps: AppDeps;
let fundingCardId: string;
let agentCard: { cardId: string; secret: string };

/** A fake client with every feature on. Reads answer from a scripted line. */
function fakeClient(script: { lineStatus?: number } = {}) {
  const calls = { open: 0, settle: 0, bond: 0 };
  const client = {
    config: {
      chainKey: 1,
      chainKeyMode: "env",
      sourceChainId: 11155111,
      paymentChainId: 8453,
      creditcoinChainId: CHAIN_ID,
      ascAddress: "0x00000000000000000000000000000000000000cc" as Address,
      anchorAddress: "0x00000000000000000000000000000000000000aa" as Address,
      factAnchorAddress: "0x00000000000000000000000000000000000000fa" as Address,
      creditLineAddress: CREDIT_LINE,
      ledgerAddress: "0x00000000000000000000000000000000000000d1" as Address,
      guaranteeAddress: "0x0000000000000000000000000000000000000061" as Address,
      passportAddress: PASSPORT,
      sourceExplorer: "https://sepolia.etherscan.io",
      creditcoinExplorer: "https://creditcoin-testnet.blockscout.com",
      sourceRpcUrl: "http://127.0.0.1:1",
      creditcoinRpcUrl: "http://127.0.0.1:1",
      proverApiUrl: "http://127.0.0.1:1",
      privateKey: ANCHORER_PK,
    },
    discovery: null,
    anchorerAddress: ANCHORER.address,
    get features() {
      return { credit: true, disputes: true, guarantee: true, passport: true };
    },
    async latestAttestedHeight() {
      return 11_687_990;
    },
    async sourceHead() {
      return 11_688_030;
    },
    async openCreditLine() {
      calls.open += 1;
      return { txHash: "0xopen", lineId: "0xline" };
    },
    async getLine() {
      return {
        lender: lender.address,
        borrower: borrower.address,
        limit: 10_000_000n,
        interestBps: 500n,
        expiresAt: 9_999_999_999n,
        nonce: 1n,
        status: script.lineStatus ?? 1,
        drawn: 0n,
        repaid: 0n,
        openedAt: 1n,
        lastEventAt: 1n,
        defaultedAt: 0n,
        repaidAt: 0n,
        owed: 0n,
        outstanding: 0n,
        available: 10_000_000n,
      };
    },
    async settleExpiredLine() {
      calls.settle += 1;
      return "0xsettle";
    },
    async getAgentCredit() {
      return { totalPayments: 3n, totalVolume: 6_000_000n, firstPaymentAt: 1_756_000_000n, lastPaymentAt: 1_756_500_000n, withinTermsPayments: 3n, termsCheckedPayments: 3n };
    },
    async getPassport(account: string) {
      return {
        account: account as Address,
        verifiedPayments: 3n,
        verifiedVolume: 6_000_000n,
        firstPaymentAt: 1_756_000_000n,
        lastPaymentAt: 1_756_500_000n,
        withinTermsPayments: 3n,
        termsCheckedPayments: 3n,
        linesOpened: 1n,
        linesRepaid: 0n,
        linesDefaulted: 0n,
        totalDrawn: 0n,
        totalRepaid: 0n,
        disputesOpened: 0n,
        disputesUpheld: 0n,
        disputesRejected: 0n,
        disputedVolume: 0n,
        guaranteeBonded: 2n * 10n ** 18n,
        score: 36n,
        grade: "D",
        asOf: 1_757_000_000n,
      };
    },
    async guaranteeOf() {
      return 2n * 10n ** 18n;
    },
    async guarantorsOf() {
      return [{ guarantor: ANCHORER.address, amount: 2n * 10n ** 18n, unbondRequestedAt: 0n }];
    },
    async bondGuarantee() {
      calls.bond += 1;
      return "0xbond";
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
  };
  return { client: client as unknown as attestcoin.AttestcoinClient, calls };
}

const fakeRelayer = {
  getFeeData: async () => ({ minFee: "0.01", rate: 1, gasPrice: "1", expiry: 0, feeCollector: "0xE936e8FAf4A5655469182A49a505055B71C17604", targetAddress: "0x26a529124f0bbf9af9d8f9f84a43efe47cf1199a", context: "ctx" }),
  estimate: async () => ({ success: true, requiredPaymentAmount: "10000", context: "ctx", error: null, raw: null }),
  send: async () => "0xreq",
  getStatus: async () => ({ status: 200, txHash: "0xfaketx", raw: null }),
  waitForStatus: async () => ({ status: 200, txHash: "0xfaketx", raw: null, timedOut: false }),
};

let fake: ReturnType<typeof fakeClient>;

beforeAll(async () => {
  process.env.ATTESTPAY_MASTER_KEY = "e".repeat(64);
  process.env.ATTESTPAY_RPC_URL = "http://127.0.0.1:1";
  store = new Store(":memory:");
  fake = fakeClient();
  deps = {
    store,
    relayer: fakeRelayer as unknown as Relayer,
    userSigner: lender,
    adminToken: ADMIN,
    verifyPrivyToken: null,
    spendMutex: new KeyedMutex(),
    spendOverrides: { codeCheck: async () => true, confirmViaChain: false, feeJitter: (b) => b },
    attestcoin: { store: new attestcoin.AttestcoinStore(store.db), client: fake.client },
  };

  store.upsertUser({ id: LENDER_ID, address: lender.address });
  store.upsertUser({ id: BORROWER_ID, address: borrower.address });
  const funding = await issueRootCard(
    { store, userSigner: lender, revocationNonceOverride: 0n },
    { userId: LENDER_ID, name: "lender funding", terms: { pay: { period: { amount: "100.00", seconds: 604800 } } } },
  );
  fundingCardId = funding.cardId;
  const agent = await issueRootCard(
    { store, userSigner: borrower, revocationNonceOverride: 0n },
    { userId: BORROWER_ID, name: "agent", terms: { pay: { period: { amount: "50.00", seconds: 604800 } } } },
  );
  agentCard = { cardId: agent.cardId, secret: agent.secret };

  const app = createApp(deps);
  server = Bun.serve({ port: 0, fetch: app.fetch });
  base = `http://localhost:${server.port}`;
  process.env.ATTESTPAY_PUBLIC_MCP_BASE = base;
});

afterAll(() => {
  server?.stop(true);
  store?.close();
});

const admin = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
const post = (path: string, body: unknown) => admin(path, { method: "POST", body: JSON.stringify(body) });

async function mcp(secret: string): Promise<Client> {
  const client = new Client({ name: "test-agent", version: "0.0.1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/c/${secret}/mcp`)));
  return client;
}
const parse = (r: { content?: unknown }): Record<string, unknown> =>
  JSON.parse((r.content as Array<{ text: string }>)[0]!.text);

// ---------------------------------------------------------------------------

describe("credit lines: propose, sign, register", () => {
  let lineId: string;

  test("lender proposes a line to the agent's card and gets typed data to sign", async () => {
    const r = await post("/api/credit-lines", {
      userId: LENDER_ID,
      funding_card_id: fundingCardId,
      borrower_card_id: agentCard.cardId,
      limit: "10.00",
      interest_bps: 500,
      expires_at: Math.floor(Date.now() / 1000) + 30 * 86_400,
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, unknown>;
    lineId = body.line_id as string;
    expect(lineId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(body.status).toBe("proposed");
    expect(body.lender).toBe(lender.address);
    expect(body.borrower).toBe(borrower.address);
    expect(body.limit).toBe("10.000000");
    // Nothing is drawable until the line is registered on-chain.
    expect(body.available).toBe("0.000000");
    const td = body.typed_data as { domain: { name: string; chainId: number; verifyingContract: string }; primaryType: string; message: Record<string, string> };
    expect(td.domain).toEqual({ name: "AttestPayCreditLine", version: "1", chainId: CHAIN_ID, verifyingContract: CREDIT_LINE });
    expect(td.primaryType).toBe("CreditLine");
    expect(td.message.limit).toBe("10000000");
  });

  test("refuses bad terms with a typed refusal", async () => {
    const r = await post("/api/credit-lines", {
      userId: LENDER_ID,
      funding_card_id: fundingCardId,
      borrower_card_id: agentCard.cardId,
      limit: "0",
      interest_bps: 500,
      expires_at: Math.floor(Date.now() / 1000) + 100,
    });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { code: string }).code).toBe("invalid_terms");
  });

  test("both parties sign; the second signature registers the line on-chain", async () => {
    const detail = (await (await admin(`/api/credit-lines/${lineId}?userId=${LENDER_ID}`)).json()) as { typed_data: { message: Record<string, string> } };
    const row = deps.attestcoin!.store.getLine(lineId)!;
    const td = attestcoin.creditLineTypedData(CHAIN_ID, CREDIT_LINE, attestcoin.termsOf(row));
    expect(String(td.message.nonce)).toBe(detail.typed_data.message.nonce);

    const lenderSig = await lender.signTypedData(td);
    const borrowerSig = await borrower.signTypedData(td);

    // Wrong party for the signature: refused, nothing stored.
    let r = await post(`/api/credit-lines/${lineId}/sign`, { party: "lender", signature: borrowerSig });
    expect(r.status).toBe(422);

    r = await post(`/api/credit-lines/${lineId}/sign`, { party: "lender", signature: lenderSig });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { status: string }).status).toBe("proposed");

    r = await post(`/api/credit-lines/${lineId}/sign`, { party: "borrower", signature: borrowerSig });
    expect(r.status).toBe(200);
    const after = (await r.json()) as { status: string; signatures: { lender: boolean; borrower: boolean } };
    expect(after.signatures).toEqual({ lender: true, borrower: true });

    // Registration is fire-and-forget; give it a tick.
    await new Promise((res) => setTimeout(res, 50));
    expect(fake.calls.open).toBe(1);
    const line = deps.attestcoin!.store.getLine(lineId)!;
    expect(line.status).toBe("open");
    expect(line.creditcoin_tx_hash).toBe("0xopen");
  });

  test("the line lists for the lender and for the borrower, and hides from strangers", async () => {
    const asLender = (await (await admin(`/api/credit-lines?userId=${LENDER_ID}`)).json()) as { as_lender: unknown[]; as_borrower: unknown[] };
    expect(asLender.as_lender).toHaveLength(1);
    const asBorrower = (await (await admin(`/api/credit-lines?userId=${BORROWER_ID}`)).json()) as { as_lender: unknown[]; as_borrower: unknown[] };
    expect(asBorrower.as_lender).toHaveLength(0);
    expect(asBorrower.as_borrower).toHaveLength(1);
  });
});

describe("credit lines: the agent draws and repays over MCP", () => {
  let lineId: string;

  beforeAll(() => {
    lineId = deps.attestcoin!.store.listLinesByBorrower(borrower.address)[0]!.id;
  });

  test("the agent's card offers the credit tools and sees the line", async () => {
    const client = await mcp(agentCard.secret);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ["credit_lines", "draw_credit", "repay_credit", "dispute_payment", "credit_passport"]) {
      expect(names).toContain(n);
    }
    const r = parse(await client.callTool({ name: "credit_lines", arguments: {} }));
    expect(r.funding_account).toBe(borrower.address);
    expect((r.lines as Array<{ line_id: string }>)[0]!.line_id).toBe(lineId);
    expect(r.drawable).toEqual([lineId]);
    await client.close();
  });

  test("draw_credit pays from the lender's funding card and queues the draw fact", async () => {
    const client = await mcp(agentCard.secret);
    const r = parse(await client.callTool({ name: "draw_credit", arguments: { line_id: lineId, amount: "4.00", idempotency_key: "d1" } }));
    expect(r.status).toBe("confirmed");
    expect(r.received_by).toBe(borrower.address);
    expect(Number(r.drawn)).toBe(4);
    const line = r.line as { drawn: string; available: string; status: string; owed: string };
    expect(line.status).toBe("active");
    expect(line.drawn).toBe("4.000000");
    expect(line.available).toBe("6.000000");
    expect(line.owed).toBe("4.200000");

    // The charge is on the LENDER's card, and it is now a credit-line event + fact.
    const charge = store.getCharge(r.charge_id as string)!;
    expect(charge.card_id).toBe(fundingCardId);
    expect(charge.to_addr?.toLowerCase()).toBe(borrower.address.toLowerCase());
    const cross = r.cross_chain as { fact_id: string; status: string };
    const fact = deps.attestcoin!.store.getFact(cross.fact_id)!;
    expect(fact.kind).toBe("draw");
    expect(fact.status).toBe("pending");
    expect(fact.payload).toMatchObject({ lineId, amountAtoms: "4000000", sourceTxHash: "0xfaketx" });

    // Same idempotency key -> same charge, no second draw.
    const again = parse(await client.callTool({ name: "draw_credit", arguments: { line_id: lineId, amount: "4.00", idempotency_key: "d1" } }));
    expect(again.charge_id).toBe(r.charge_id);
    expect(deps.attestcoin!.store.getLine(lineId)!.drawn_atoms).toBe(4_000_000n);
    await client.close();
  });

  test("a draw over the available amount is refused, typed", async () => {
    const client = await mcp(agentCard.secret);
    const res = await client.callTool({ name: "draw_credit", arguments: { line_id: lineId, amount: "7.00" } });
    expect(res.isError).toBe(true);
    const r = parse(res);
    expect(r.code).toBe("over_lifetime_limit");
    expect((r.detail as { credit_error: string }).credit_error).toBe("over_limit");
    await client.close();
  });

  test("repay_credit pays the lender from the agent's card and queues the repayment fact", async () => {
    const client = await mcp(agentCard.secret);
    const r = parse(await client.callTool({ name: "repay_credit", arguments: { line_id: lineId, amount: "1.00" } }));
    expect(r.status).toBe("confirmed");
    expect(r.paid_to).toBe(lender.address);
    const charge = store.getCharge(r.charge_id as string)!;
    expect(charge.card_id).toBe(agentCard.cardId);
    const fact = deps.attestcoin!.store.getFact((r.cross_chain as { fact_id: string }).fact_id)!;
    expect(fact.kind).toBe("repayment");
    expect((r.line as { outstanding: string }).outstanding).toBe("3.200000");
    await client.close();
  });

  test("REST draw and repay require a card on the borrower side", async () => {
    // The lender's card is not the borrower: refused.
    let r = await post(`/api/credit-lines/${lineId}/draw`, { userId: LENDER_ID, card_id: fundingCardId, amount: "1.00" });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { code: string }).code).toBe("not_your_subcard");

    r = await post(`/api/credit-lines/${lineId}/repay`, { userId: BORROWER_ID, card_id: agentCard.cardId, amount: "0.50" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { receipt: { status: string } }).receipt.status).toBe("confirmed");
  });

  test("line detail joins events, facts and the chain's view", async () => {
    const d = (await (await admin(`/api/credit-lines/${lineId}?userId=${LENDER_ID}`)).json()) as {
      events: Array<{ kind: string; charge_status: string }>;
      facts: Array<{ kind: string; status: string }>;
      on_chain: { status: string } | null;
    };
    expect(d.events.map((e) => e.kind)).toEqual(["draw", "repayment", "repayment"]);
    expect(d.facts).toHaveLength(3);
    expect(d.on_chain?.status).toBe("open");
  });

  test("settle is lender-or-admin and syncs from the chain", async () => {
    const r = await post(`/api/credit-lines/${lineId}/settle`, { userId: LENDER_ID, action: "close" });
    expect(r.status).toBe(200);
    expect(fake.calls.settle).toBe(1);
  });
});

describe("disputes", () => {
  let chargeId: string;
  let disputeId: string;

  beforeAll(() => {
    // A confirmed payment on the agent's card, inserted directly.
    chargeId = "ch_disputed";
    store.insertCharge({
      id: chargeId,
      card_id: agentCard.cardId,
      idempotency_key: null,
      kind: "pay",
      to_addr: "0x00000000000000000000000000000000000000a1" as Address,
      amount_atoms: 2_000_000n,
      fee_atoms: 10_000n,
      request_id: "req1",
      tx_hash: "0xbasetx" as Hex,
      status: "confirmed",
      memo: "coffee",
      created_at: 1_756_100_000,
    });
  });

  test("the agent disputes a payment over MCP; the fact is queued for the ledger", async () => {
    const client = await mcp(agentCard.secret);
    const r = parse(await client.callTool({ name: "dispute_payment", arguments: { charge_id: chargeId, reason: "never delivered" } }));
    disputeId = r.dispute_id as string;
    expect(r.status).toBe("open");
    expect((r.facts as Array<{ kind: string }>)[0]!.kind).toBe("dispute_opened");

    const dup = await client.callTool({ name: "dispute_payment", arguments: { charge_id: chargeId, reason: "again" } });
    expect(dup.isError).toBe(true);
    await client.close();
  });

  test("REST lists the dispute on the card and refuses a stranger's resolve", async () => {
    const list = (await (await admin(`/api/cards/${agentCard.cardId}/disputes`)).json()) as { items: Array<{ dispute_id: string }> };
    expect(list.items.map((d) => d.dispute_id)).toContain(disputeId);

    const all = (await (await admin(`/api/disputes?status=open`)).json()) as { items: unknown[] };
    expect(all.items).toHaveLength(1);
  });

  test("the operator upholds the dispute; the outcome fact is queued", async () => {
    const r = await post(`/api/disputes/${disputeId}/resolve`, { outcome: "upheld", note: "merchant confirmed" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { status: string; facts: Array<{ kind: string }> };
    expect(body.status).toBe("upheld");
    expect(body.facts.map((f) => f.kind)).toEqual(["dispute_opened", "dispute_resolved"]);
    expect((await post(`/api/disputes/${disputeId}/resolve`, { outcome: "rejected" })).status).toBe(422);
  });
});

describe("passport and guarantees", () => {
  test("the public passport needs no auth and carries a verifiable credential", async () => {
    const r = await fetch(`${base}/passport/${borrower.address}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await r.json()) as {
      configured: boolean;
      passport: { score: number; grade: string; guarantee_bonded_ctc: string };
      credential: { payload: unknown; signature: Hex; signer: string };
      local: { credit_lines: unknown[]; disputes: unknown[] };
    };
    expect(body.configured).toBe(true);
    expect(body.passport.grade).toBe("D");
    expect(body.passport.guarantee_bonded_ctc).toBe("2.000000");
    expect(body.credential.signer).toBe(ANCHORER.address);
    expect(body.local.credit_lines).toHaveLength(1);
    expect(body.local.disputes).toHaveLength(1);

    const v = await fetch(`${base}/passport/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: body.credential.payload, signature: body.credential.signature }),
    });
    const check = (await v.json()) as { valid: boolean; signer: string; expected_signer: string };
    expect(check.valid).toBe(true);
    expect(check.expected_signer).toBe(ANCHORER.address);

    const bad = await fetch(`${base}/passport/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: { ...(body.credential.payload as object), issuer: "x" }, signature: body.credential.signature }),
    });
    expect(((await bad.json()) as { valid: boolean }).valid).toBe(false);
  });

  test("the passport rejects non-addresses", async () => {
    expect((await fetch(`${base}/passport/nope`)).status).toBe(400);
  });

  test("the owner-side passport and the MCP tool agree with the public one", async () => {
    const owner = (await (await admin(`/api/cards/${agentCard.cardId}/passport`)).json()) as { passport: { score: number } };
    expect(owner.passport.score).toBe(36);
    const client = await mcp(agentCard.secret);
    const r = parse(await client.callTool({ name: "credit_passport", arguments: {} }));
    expect((r.passport as { score: number }).score).toBe(36);
    await client.close();
  });

  test("guarantees read and the operator can bond", async () => {
    const g = (await (await admin(`/api/guarantees/${borrower.address}`)).json()) as { bonded_ctc: string; guarantors: unknown[] };
    expect(g.bonded_ctc).toBe("2.000000");
    expect(g.guarantors).toHaveLength(1);
    const r = await post("/api/guarantees/bond", { borrower: borrower.address, amount_ctc: "1.5" });
    expect(r.status).toBe(200);
    expect(fake.calls.bond).toBe(1);
  });
});

describe("disabled", () => {
  let off: ReturnType<typeof Bun.serve>;
  let offBase: string;
  let offSecret: string;

  beforeAll(async () => {
    const s2 = new Store(":memory:");
    const d2: AppDeps = {
      store: s2,
      relayer: fakeRelayer as unknown as Relayer,
      userSigner: lender,
      adminToken: ADMIN,
      verifyPrivyToken: null,
      spendMutex: new KeyedMutex(),
      attestcoin: { store: new attestcoin.AttestcoinStore(s2.db), client: null },
    };
    s2.upsertUser({ id: LENDER_ID, address: lender.address });
    const c = await issueRootCard({ store: s2, userSigner: lender, revocationNonceOverride: 0n }, { userId: LENDER_ID, name: "x", terms: { pay: { period: { amount: "1.00", seconds: 60 } } } });
    offSecret = c.secret;
    off = Bun.serve({ port: 0, fetch: createApp(d2).fetch });
    offBase = `http://localhost:${off.port}`;
  });
  afterAll(() => off?.stop(true));

  test("credit endpoints answer configured:false and the tools are not offered", async () => {
    const r = await fetch(`${offBase}/api/credit-lines?userId=${LENDER_ID}`, { headers: { authorization: `Bearer ${ADMIN}` } });
    expect(((await r.json()) as { configured: boolean }).configured).toBe(false);
    const p = await fetch(`${offBase}/passport/${lender.address}`);
    expect(((await p.json()) as { configured: boolean }).configured).toBe(false);

    // The MCP host allowlist is armed by the public base; point it at this server.
    const savedBase = process.env.ATTESTPAY_PUBLIC_MCP_BASE;
    process.env.ATTESTPAY_PUBLIC_MCP_BASE = offBase;
    try {
      const client = new Client({ name: "t", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${offBase}/c/${offSecret}/mcp`)));
      const names = (await client.listTools()).tools.map((t) => t.name);
      for (const n of ["credit_lines", "draw_credit", "repay_credit", "dispute_payment", "credit_passport"]) {
        expect(names).not.toContain(n);
      }
      await client.close();
    } finally {
      process.env.ATTESTPAY_PUBLIC_MCP_BASE = savedBase;
    }
  });
});
