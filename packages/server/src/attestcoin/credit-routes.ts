// Dashboard REST surface for credit lines, disputes, guarantees and the passport.
//
// Mounted under /api like attestcoin/routes.ts, so it inherits that router's auth and
// receives the parent's scoping helpers rather than re-implementing ownership. The
// one public surface — the passport — lives in `publicPassportRoutes`, mounted at the
// root without auth: a passport that only its owner can read is not a passport.

import { Hono } from "hono";
import type { Context } from "hono";
import { isAddress, type Address, type Hex } from "viem";
import { RefusalError, attestcoin as ac, usdcToAtoms, type CardRow, type UserRow } from "@attestpay/engine";
import type { ApiEnv } from "../api/routes";
import type { AppDeps } from "../deps";
import { openLineInBackground } from "../deps";
import { RateLimiter, clientIp } from "../ratelimit";
import { envInt } from "../deps";
import { creditDeps, executeDraw, executeRepayment, isoTime as iso, lineView, usdcString as usdc } from "./credit-exec";

export type OwnedCardResolver = (c: Context<ApiEnv>, id: string, level?: "read" | "control" | "manage") => CardRow;
export type Handle = (c: Context<ApiEnv>, fn: () => Promise<unknown>) => Promise<Response>;

/** Who is acting: the ops token, or a Privy-bound user. */
export type Actor = { kind: "admin"; userId: string } | { kind: "privy"; user: UserRow };
export type ActorResolver = (c: Context<ApiEnv>, requestedUserId?: string) => Actor;

const actorId = (a: Actor): string => (a.kind === "admin" ? a.userId : a.user.id);
const auditActor = (a: Actor): { kind: "admin" | "user"; id: string } =>
  a.kind === "admin" ? { kind: "admin", id: `admin:${a.userId}` } : { kind: "user", id: a.user.id };

export function creditRoutes(
  deps: AppDeps,
  ownedCard: OwnedCardResolver,
  handle: Handle,
  actor: ActorResolver,
): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  const now = () => Math.floor(Date.now() / 1000);

  const acStore = () => deps.attestcoin?.store ?? null;
  const client = () => deps.attestcoin?.client ?? null;
  const features = () => ac.attestcoinFeatures(client()?.config ?? null);

  /** The acting user's address: the lender or borrower identity in a line. */
  const actorAddress = (a: Actor): Address | null => {
    if (a.kind === "privy") return a.user.address;
    return deps.store.getUser(a.userId)?.address ?? null;
  };

  /** A line the actor may see: lender, borrower, or admin. Others get not-found. */
  const visibleLine = (a: Actor, id: string): ac.CreditLineRow => {
    const s = acStore();
    const line = s?.getLine(id);
    if (!line) throw new RefusalError("card_not_found", "no such credit line");
    if (a.kind === "admin") return line;
    const addr = a.user.address.toLowerCase();
    if (line.lender_user_id !== a.user.id && line.borrower_address.toLowerCase() !== addr) {
      throw new RefusalError("card_not_found", "no such credit line");
    }
    return line;
  };

  const lineDetail = async (line: ac.CreditLineRow) => {
    const s = acStore()!;
    const cl = client();
    let onChain: unknown = null;
    let onChainError: string | null = null;
    if (cl && features().credit && ["open", "active", "repaid", "defaulted", "closed"].includes(line.status)) {
      try {
        const l = await cl.getLine(line.id);
        onChain = l
          ? {
              status: ac.lineStatusName(l.status),
              drawn: usdc(l.drawn),
              repaid: usdc(l.repaid),
              owed: usdc(l.owed),
              outstanding: usdc(l.outstanding),
              available: usdc(l.available),
              opened_at: iso(l.openedAt),
              defaulted_at: iso(l.defaultedAt),
              repaid_at: iso(l.repaidAt),
            }
          : null;
      } catch (e) {
        onChainError = e instanceof Error ? e.message : String(e);
      }
    }
    const t = now();
    return {
      ...lineView(line, t),
      typed_data:
        cl?.config.creditLineAddress && line.status === "proposed"
          ? serializeTypedData(ac.creditLineTypedData(cl.config.creditcoinChainId, cl.config.creditLineAddress, ac.termsOf(line)))
          : null,
      events: s.listLineEvents(line.id).map((e) => {
        const ch = deps.store.getCharge(e.charge_id);
        return {
          kind: e.kind,
          charge_id: e.charge_id,
          amount: usdc(e.amount_atoms),
          charge_status: ch?.status ?? null,
          tx_hash: ch?.tx_hash ?? null,
          explorer: ch?.tx_hash && cl ? ac.baseTxUrl(cl.config.paymentChainId, ch.tx_hash) : null,
          at: iso(e.created_at),
        };
      }),
      facts: s.listFactsByRef(line.id).map(factView),
      on_chain: onChain,
      on_chain_error: onChainError,
    };
  };

  // -----------------------------------------------------------------------
  // Credit lines
  // -----------------------------------------------------------------------

  app.post("/credit-lines", (c) =>
    handle(c, async () => {
      creditDeps(deps);
      const cl = client()!;
      const body = (await c.req.json().catch(() => ({}))) as {
        funding_card_id?: string;
        borrower_address?: string;
        borrower_card_id?: string;
        limit?: string;
        interest_bps?: number;
        expires_at?: number;
        userId?: string;
      };
      const a = actor(c, body.userId);
      const lenderAddress = actorAddress(a);
      if (!lenderAddress) throw new RefusalError("invalid_terms", "lender has no wallet on file");
      if (!body.funding_card_id) throw new RefusalError("invalid_terms", "funding_card_id is required");
      const funding = ownedCard(c, body.funding_card_id);
      if (funding.user_id !== actorId(a) && a.kind !== "admin") {
        throw new RefusalError("card_not_found", "no such card");
      }
      if (!body.limit || !/^\d+(\.\d{1,6})?$/.test(body.limit)) throw new RefusalError("invalid_terms", "limit must be a USDC decimal string");
      if (typeof body.interest_bps !== "number" || !Number.isInteger(body.interest_bps)) {
        throw new RefusalError("invalid_terms", "interest_bps must be an integer");
      }
      if (typeof body.expires_at !== "number") throw new RefusalError("invalid_terms", "expires_at (unix seconds) is required");

      let borrowerAddress: Address | null = null;
      let borrowerCardId: string | null = null;
      if (body.borrower_card_id) {
        const bc = deps.store.getCard(body.borrower_card_id);
        if (!bc) throw new RefusalError("card_not_found", "no such borrower card");
        borrowerAddress = ac.borrowerAddressForCard(deps.store, bc.id);
        borrowerCardId = bc.id;
      } else if (body.borrower_address && isAddress(body.borrower_address)) {
        borrowerAddress = body.borrower_address as Address;
      }
      if (!borrowerAddress) throw new RefusalError("invalid_terms", "borrower_card_id or a valid borrower_address is required");

      let row: ac.CreditLineRow;
      try {
        row = ac.proposeLine(
          acStore()!,
          {
            lenderUserId: actorId(a),
            lenderAddress,
            borrowerAddress,
            borrowerCardId,
            fundingCardId: funding.id,
            limitAtoms: usdcToAtoms(body.limit),
            interestBps: body.interest_bps,
            expiresAt: body.expires_at,
          },
          now(),
        );
      } catch (e) {
        if (e instanceof ac.CreditLineError) throw new RefusalError("invalid_terms", e.message);
        throw e;
      }
      void cl;
      deps.events?.emit("credit_line.proposed", { userId: actorId(a) }, { line_id: row.id, borrower: row.borrower_address, limit: usdc(row.limit_atoms) });
      deps.events?.audit(auditActor(a), "credit_line.proposed", { type: "credit_line", id: row.id }, { borrower: row.borrower_address, limit: usdc(row.limit_atoms), interest_bps: row.interest_bps });
      return lineDetail(row);
    }),
  );

  app.get("/credit-lines", (c) =>
    handle(c, async () => {
      const s = acStore();
      if (!s) return { configured: false, as_lender: [], as_borrower: [] };
      const a = actor(c, c.req.query("userId"));
      const addr = actorAddress(a);
      const t = now();
      return {
        configured: features().credit,
        as_lender: s.listLinesByLender(actorId(a)).map((l) => lineView(l, t)),
        as_borrower: addr ? s.listLinesByBorrower(addr).map((l) => lineView(l, t)) : [],
      };
    }),
  );

  app.get("/credit-lines/:id", (c) =>
    handle(c, async () => {
      const a = actor(c, c.req.query("userId"));
      return lineDetail(visibleLine(a, c.req.param("id")));
    }),
  );

  app.post("/credit-lines/:id/sign", (c) =>
    handle(c, async () => {
      const { client: cl } = creditDeps(deps);
      const body = (await c.req.json().catch(() => ({}))) as { party?: string; signature?: string; userId?: string };
      const a = actor(c, body.userId);
      const line = visibleLine(a, c.req.param("id"));
      if (body.party !== "lender" && body.party !== "borrower") throw new RefusalError("invalid_terms", "party must be lender or borrower");
      if (!body.signature || !/^0x[0-9a-fA-F]{130}$/.test(body.signature)) {
        throw new RefusalError("invalid_terms", "signature must be a 65-byte hex string");
      }
      // A Privy user may only sign as the party they are.
      if (a.kind === "privy") {
        const mine = body.party === "lender" ? line.lender_user_id === a.user.id : line.borrower_address.toLowerCase() === a.user.address.toLowerCase();
        if (!mine) throw new RefusalError("not_your_subcard", `you are not the ${body.party} on this line`);
      }
      try {
        const after = await ac.attachLineSignature(
          acStore()!,
          { creditcoinChainId: cl.config.creditcoinChainId, creditLineAddress: cl.config.creditLineAddress! },
          line.id,
          body.party,
          body.signature as Hex,
          now(),
        );
        deps.events?.audit(auditActor(a), `credit_line.signed_by_${body.party}`, { type: "credit_line", id: line.id });
        if (after.status === "signed") {
          deps.events?.emit("credit_line.signed", { userId: line.lender_user_id }, { line_id: line.id });
          openLineInBackground(deps, after.id);
        }
        return lineDetail(after);
      } catch (e) {
        if (e instanceof ac.CreditLineError) throw new RefusalError("invalid_terms", e.message, { credit_error: e.code });
        throw e;
      }
    }),
  );

  app.post("/credit-lines/:id/draw", (c) =>
    handle(c, async () => {
      const body = (await c.req.json().catch(() => ({}))) as { amount?: string; card_id?: string; memo?: string; idempotency_key?: string; userId?: string };
      const a = actor(c, body.userId);
      const line = visibleLine(a, c.req.param("id"));
      if (!body.card_id) throw new RefusalError("invalid_terms", "card_id (the borrower's card) is required");
      const card = ownedCard(c, body.card_id, "control");
      const borrower = ac.borrowerAddressForCard(deps.store, card.id);
      if (!borrower || borrower.toLowerCase() !== line.borrower_address.toLowerCase()) {
        throw new RefusalError("not_your_subcard", "that card's funding account is not the borrower on this line");
      }
      if (!body.amount || !/^\d+(\.\d{1,6})?$/.test(body.amount)) throw new RefusalError("invalid_terms", "amount must be a USDC decimal string");
      const r = await executeDraw(deps, line.id, {
        amountAtoms: usdcToAtoms(body.amount),
        memo: body.memo,
        idempotencyKey: body.idempotency_key,
        actorCardId: card.id,
      });
      return { receipt: r.receipt, charge_id: r.charge_id, fact_id: r.fact_id, line: lineView(r.line, now()) };
    }),
  );

  app.post("/credit-lines/:id/repay", (c) =>
    handle(c, async () => {
      const body = (await c.req.json().catch(() => ({}))) as { amount?: string; card_id?: string; memo?: string; idempotency_key?: string; userId?: string };
      const a = actor(c, body.userId);
      const line = visibleLine(a, c.req.param("id"));
      if (!body.card_id) throw new RefusalError("invalid_terms", "card_id (the borrower's card) is required");
      const card = ownedCard(c, body.card_id, "control");
      if (!body.amount || !/^\d+(\.\d{1,6})?$/.test(body.amount)) throw new RefusalError("invalid_terms", "amount must be a USDC decimal string");
      const r = await executeRepayment(deps, line.id, {
        cardId: card.id,
        amountAtoms: usdcToAtoms(body.amount),
        memo: body.memo,
        idempotencyKey: body.idempotency_key,
      });
      return { receipt: r.receipt, charge_id: r.charge_id, fact_id: r.fact_id, line: lineView(r.line, now()) };
    }),
  );

  // Time-based transitions. Permissionless on-chain; here the lender or admin asks.
  app.post("/credit-lines/:id/settle", (c) =>
    handle(c, async () => {
      const { store: s, client: cl } = creditDeps(deps);
      const body = (await c.req.json().catch(() => ({}))) as { action?: string; userId?: string };
      const a = actor(c, body.userId);
      const line = visibleLine(a, c.req.param("id"));
      if (a.kind === "privy" && line.lender_user_id !== a.user.id) throw new RefusalError("not_your_subcard", "only the lender may settle a line");
      if (body.action !== "default" && body.action !== "close") throw new RefusalError("invalid_terms", "action must be default or close");
      const txHash = await cl.settleExpiredLine(line.id, body.action);
      await ac.syncLineFromChain({ attestcoin: s, client: cl }, line.id, now());
      return { tx_hash: txHash, explorer: ac.creditcoinTxUrl(txHash), line: lineView(s.getLine(line.id)!, now()) };
    }),
  );

  // -----------------------------------------------------------------------
  // Guarantees
  // -----------------------------------------------------------------------

  app.get("/guarantees/:address", (c) =>
    handle(c, async () => {
      const cl = client();
      const address = c.req.param("address");
      if (!isAddress(address)) throw new RefusalError("invalid_terms", "not an address");
      if (!cl || !features().guarantee) return { configured: false, address, bonded_ctc: null, guarantors: [] };
      const [bonded, guarantors] = await Promise.all([cl.guaranteeOf(address), cl.guarantorsOf(address)]);
      return {
        configured: true,
        address,
        bonded_ctc: ctc(bonded),
        guarantors: guarantors.map((g) => ({
          guarantor: g.guarantor,
          bonded_ctc: ctc(g.amount),
          unbond_requested_at: iso(g.unbondRequestedAt),
        })),
        contract: cl.config.guaranteeAddress,
        explorer: ac.creditcoinAddressUrl(cl.config.guaranteeAddress!),
      };
    }),
  );

  /** The operator bonds CTC from the anchorer key behind an agent it runs. */
  app.post("/guarantees/bond", (c) =>
    handle(c, async () => {
      const a = actor(c);
      if (a.kind !== "admin") throw new RefusalError("not_your_subcard", "only the operator may bond from the server key");
      const cl = client();
      if (!cl || !features().guarantee) throw new RefusalError("invalid_terms", "guarantees are not enabled on this deployment");
      const body = (await c.req.json().catch(() => ({}))) as { borrower?: string; amount_ctc?: string };
      if (!body.borrower || !isAddress(body.borrower)) throw new RefusalError("invalid_terms", "borrower must be an address");
      if (!body.amount_ctc || !/^\d+(\.\d{1,18})?$/.test(body.amount_ctc)) throw new RefusalError("invalid_terms", "amount_ctc must be a decimal string");
      const txHash = await cl.bondGuarantee(body.borrower, ctcToWei(body.amount_ctc));
      return { tx_hash: txHash, explorer: ac.creditcoinTxUrl(txHash), bonded_ctc: ctc(await cl.guaranteeOf(body.borrower)) };
    }),
  );

  app.post("/credit-lines/:id/slash", (c) =>
    handle(c, async () => {
      const cl = client();
      if (!cl || !features().guarantee) throw new RefusalError("invalid_terms", "guarantees are not enabled on this deployment");
      const body = (await c.req.json().catch(() => ({}))) as { userId?: string };
      const a = actor(c, body.userId);
      const line = visibleLine(a, c.req.param("id"));
      if (a.kind === "privy" && line.lender_user_id !== a.user.id) throw new RefusalError("not_your_subcard", "only the lender may slash");
      const txHash = await cl.slashGuarantee(line.id);
      return { tx_hash: txHash, explorer: ac.creditcoinTxUrl(txHash) };
    }),
  );

  // -----------------------------------------------------------------------
  // Disputes
  // -----------------------------------------------------------------------

  app.post("/cards/:id/disputes", (c) =>
    handle(c, async () => {
      const s = acStore();
      if (!s) throw new RefusalError("invalid_terms", "disputes are not available on this deployment");
      const body = (await c.req.json().catch(() => ({}))) as { charge_id?: string; reason?: string; userId?: string };
      const a = actor(c, body.userId);
      const card = ownedCard(c, c.req.param("id"), "control");
      if (!body.charge_id || !body.reason) throw new RefusalError("invalid_terms", "charge_id and reason are required");
      try {
        const d = ac.openDispute(
          { store: deps.store, attestcoin: s, config: features().disputes ? client()!.config : null },
          { chargeId: body.charge_id, cardId: card.id, openedByUserId: actorId(a), reason: body.reason },
          now(),
        );
        deps.events?.emit("dispute.opened", { cardId: card.id }, { dispute_id: d.id, charge_id: d.charge_id, reason: d.reason });
        deps.events?.audit(auditActor(a), "dispute.opened", { type: "dispute", id: d.id }, { charge_id: d.charge_id }, null);
        return disputeView(d, s);
      } catch (e) {
        if (e instanceof ac.DisputeError) throw new RefusalError("invalid_terms", e.message, { dispute_error: e.code });
        throw e;
      }
    }),
  );

  app.get("/cards/:id/disputes", (c) =>
    handle(c, async () => {
      const s = acStore();
      const card = ownedCard(c, c.req.param("id"), "read");
      if (!s) return { configured: false, items: [] };
      return { configured: features().disputes, items: s.listDisputesByCard(card.id).map((d) => disputeView(d, s)) };
    }),
  );

  app.get("/disputes", (c) =>
    handle(c, async () => {
      const s = acStore();
      if (!s) return { configured: false, items: [] };
      const a = actor(c, c.req.query("userId"));
      const status = c.req.query("status") as ac.DisputeStatus | undefined;
      const all = s.listDisputes(status ?? null);
      const mine =
        a.kind === "admin"
          ? all
          : all.filter((d) => {
              const card = deps.store.getCard(d.card_id);
              return card?.user_id === a.user.id;
            });
      return { configured: features().disputes, items: mine.map((d) => disputeView(d, s)) };
    }),
  );

  app.post("/disputes/:id/resolve", (c) =>
    handle(c, async () => {
      const s = acStore();
      if (!s) throw new RefusalError("invalid_terms", "disputes are not available on this deployment");
      const body = (await c.req.json().catch(() => ({}))) as { outcome?: string; note?: string; userId?: string };
      const a = actor(c, body.userId);
      const d = s.getDispute(c.req.param("id"));
      if (!d) throw new RefusalError("card_not_found", "no such dispute");
      const outcome = body.outcome as ac.DisputeStatus | undefined;
      if (outcome !== "upheld" && outcome !== "rejected" && outcome !== "withdrawn") {
        throw new RefusalError("invalid_terms", "outcome must be upheld, rejected or withdrawn");
      }
      // Adjudication is the operator's; the opener may only withdraw their own.
      if (a.kind === "privy") {
        const card = deps.store.getCard(d.card_id);
        if (card?.user_id !== a.user.id) throw new RefusalError("card_not_found", "no such dispute");
        if (outcome !== "withdrawn") throw new RefusalError("not_your_subcard", "only the operator may uphold or reject a dispute");
      }
      try {
        const r = ac.resolveDispute(
          { store: deps.store, attestcoin: s, config: features().disputes ? client()!.config : null },
          d.id,
          outcome,
          body.note ?? null,
          actorId(a),
          now(),
        );
        deps.events?.emit("dispute.resolved", { cardId: r.card_id }, { dispute_id: r.id, charge_id: r.charge_id, outcome, note: r.resolution_note });
        deps.events?.audit(auditActor(a), "dispute.resolved", { type: "dispute", id: r.id }, { outcome }, null);
        return disputeView(r, s);
      } catch (e) {
        if (e instanceof ac.DisputeError) throw new RefusalError("invalid_terms", e.message, { dispute_error: e.code });
        throw e;
      }
    }),
  );

  // -----------------------------------------------------------------------
  // Passport (owner view; the public view is in publicPassportRoutes)
  // -----------------------------------------------------------------------

  app.get("/cards/:id/passport", (c) =>
    handle(c, async () => {
      const card = ownedCard(c, c.req.param("id"), "read");
      const account = ac.borrowerAddressForCard(deps.store, card.id);
      if (!account) throw new RefusalError("invalid_terms", "card has no resolvable funding account");
      return passportFor(deps, account);
    }),
  );

  // Pipeline rows for facts on a card (draws, repayments, disputes, revocation).
  app.get("/cards/:id/attestcoin-facts", (c) =>
    handle(c, async () => {
      const card = ownedCard(c, c.req.param("id"), "read");
      const s = acStore();
      if (!s) return { configured: false, items: [] };
      return { configured: client() !== null, items: s.listFactsByCard(card.id).map(factView) };
    }),
  );

  app.post("/attestcoin-facts/:id/retry", (c) =>
    handle(c, async () => {
      const s = acStore();
      if (!s) throw new RefusalError("invalid_terms", "not configured");
      const fact = s.getFact(c.req.param("id"));
      if (!fact) throw new RefusalError("card_not_found", "no such fact");
      if (fact.card_id) ownedCard(c, fact.card_id, "control");
      return { retried: s.retryFailedFact(fact.id, now()) };
    }),
  );

  return app;
}

// ---------------------------------------------------------------------------
// Public passport
// ---------------------------------------------------------------------------

/** `GET /passport/:address` and `POST /passport/verify`, unauthenticated. */
export function publicPassportRoutes(deps: AppDeps): Hono {
  const app = new Hono();
  const limit = new RateLimiter(envInt("ATTESTPAY_PASSPORT_RATE_LIMIT", 60), 60_000);

  app.get("/passport/:address", async (c) => {
    if (!limit.allow(clientIp(c), Date.now())) return c.json({ error: "rate limited" }, 429);
    const address = c.req.param("address");
    if (!isAddress(address)) return c.json({ error: "not an address" }, 400);
    try {
      const body = await passportFor(deps, address as Address);
      c.header("Cache-Control", "public, max-age=30");
      return c.json(body);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 503);
    }
  });

  app.post("/passport/verify", async (c) => {
    if (!limit.allow(clientIp(c), Date.now())) return c.json({ error: "rate limited" }, 429);
    const body = (await c.req.json().catch(() => null)) as { payload?: ac.PassportCredentialPayload; signature?: Hex } | null;
    if (!body?.payload || !body.signature) return c.json({ error: "payload and signature required" }, 400);
    const expected = deps.attestcoin?.client?.anchorerAddress as Address | undefined;
    const check = await ac.verifyPassportCredential({ payload: body.payload, signature: body.signature }, { expectedSigner: expected });
    return c.json({ ...check, expected_signer: expected ?? null });
  });

  return app;
}

/** The passport for a funding account: the on-chain composed record with a signed
 * credential when `CreditPassport` is configured, otherwise the payments-only ASC
 * summary plus whatever the local mirrors hold — labelled as such. */
export async function passportFor(deps: AppDeps, account: Address) {
  const a = deps.attestcoin;
  const cl = a?.client ?? null;
  const s = a?.store ?? null;
  const now = Math.floor(Date.now() / 1000);

  if (!cl) {
    return { configured: false, account, reason: ac.attestcoinDisabledReason() ?? "not configured" };
  }

  if (ac.attestcoinFeatures(cl.config).passport) {
    const passport = await cl.getPassport(account);
    const credential = await ac.issuePassportCredential(passport, {
      signerPrivateKey: cl.config.privateKey as Hex,
      issuer: process.env.ATTESTPAY_PUBLIC_MCP_BASE ?? "attestpay",
      chainId: cl.config.creditcoinChainId,
      passportContract: cl.config.passportAddress!,
      now,
    });
    return {
      configured: true,
      source: "CreditPassport.passportOf (live)",
      account,
      passport: credential.payload.passport,
      credential,
      contracts: {
        passport: cl.config.passportAddress,
        explorer: ac.creditcoinAddressUrl(cl.config.passportAddress!),
      },
      local: localCreditSummary(deps, account),
      note: "Score and grade are computed on-chain by CreditPassport from public facts: verified payments, credit lines, disputes and bonded guarantees. A summary, not a risk model.",
    };
  }

  // Payments-only fallback, clearly labelled.
  let credit: ac.AgentCredit | null = null;
  let live = true;
  try {
    credit = await cl.getAgentCredit(account);
    s?.cacheCredit(account, credit, now);
  } catch {
    const cached = s?.getCachedCredit(account);
    if (cached) {
      credit = cached;
      live = false;
    }
  }
  if (!credit) throw new Error("credit unavailable (Creditcoin unreachable and nothing cached)");
  const grade = ac.creditGrade(credit);
  return {
    configured: true,
    source: live ? "AttestPayASC.getAgentCredit (live)" : "AttestPayASC.getAgentCredit (cached)",
    account,
    passport: {
      account,
      verified_payments: Number(credit.totalPayments),
      verified_volume_usdc: usdc(credit.totalVolume),
      first_payment_at: iso(credit.firstPaymentAt),
      last_payment_at: iso(credit.lastPaymentAt),
      within_terms_payments: Number(credit.withinTermsPayments),
      terms_checked_payments: Number(credit.termsCheckedPayments),
      score: grade.score,
      grade: grade.grade,
    },
    credential: null,
    local: localCreditSummary(deps, account),
    note: "CreditPassport is not deployed on this instance, so this is the payments-only grade from AttestPayASC. Credit lines and disputes below are the server's local records.",
  };
}

/** Local mirrors for the same account: lines and disputes the server knows about. */
function localCreditSummary(deps: AppDeps, account: Address) {
  const s = deps.attestcoin?.store;
  if (!s) return null;
  const now = Math.floor(Date.now() / 1000);
  const lines = s.listLinesByBorrower(account);
  const cards = deps.store.getUserByAddress(account) ? deps.store.listCards(deps.store.getUserByAddress(account)!.id) : [];
  const disputes = cards.flatMap((card) => s.listDisputesByCard(card.id));
  return {
    credit_lines: lines.map((l) => lineView(l, now)),
    disputes: disputes.map((d) => disputeView(d, s)),
  };
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export function disputeView(d: ac.DisputeRow, s: ac.AttestcoinStore) {
  const facts = s.listFactsByRef(d.id);
  return {
    dispute_id: d.id,
    charge_id: d.charge_id,
    card_id: d.card_id,
    status: d.status,
    reason: d.reason,
    resolution_note: d.resolution_note,
    opened_by: d.opened_by_user_id,
    resolved_by: d.resolved_by,
    opened_at: iso(d.opened_at),
    resolved_at: iso(d.resolved_at),
    facts: facts.map(factView),
  };
}

export function factView(f: ac.FactRow) {
  return {
    fact_id: f.id,
    kind: f.kind,
    ref_id: f.ref_id,
    status: f.status,
    target: f.target,
    anchor_tx_hash: f.anchor_tx_hash,
    anchor_height: f.anchor_height,
    creditcoin_tx_hash: f.creditcoin_tx_hash,
    creditcoin_explorer: f.creditcoin_tx_hash ? ac.creditcoinTxUrl(f.creditcoin_tx_hash) : null,
    verified_at: iso(f.verified_at),
    error: f.error,
    attempts: f.attempts,
    created_at: iso(f.created_at),
  };
}

/** EIP-712 typed data with bigints as decimal strings, for the wire. */
export function serializeTypedData(td: ReturnType<typeof ac.creditLineTypedData>) {
  return {
    domain: { ...td.domain },
    types: { EIP712Domain: EIP712_DOMAIN_TYPE, ...td.types },
    primaryType: td.primaryType,
    message: Object.fromEntries(Object.entries(td.message).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])),
  };
}

const EIP712_DOMAIN_TYPE = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];

const ctc = (wei: bigint): string => (Number(wei) / 1e18).toFixed(6);
function ctcToWei(s: string): bigint {
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole || "0") * 10n ** 18n + BigInt((frac + "0".repeat(18)).slice(0, 18));
}
