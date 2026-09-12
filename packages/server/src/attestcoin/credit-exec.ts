// Draw and repayment execution: the one place a credit line moves USDC.
//
// A draw pays from the LENDER's funding card to the borrower's funding account; a
// repayment pays from the BORROWER's card to the lender's address. Both go through
// the ordinary `spend()` pipeline, so every card term, every on-chain caveat and
// every receipt shape is exactly what a normal payment gets. What this module adds is
// the bookkeeping that ties the resulting charge to its line, so the confirmed-charge
// hook can enqueue the fact that proves the transfer into Creditcoin.
//
// Shared by the REST routes and the MCP tools so the two surfaces cannot drift.

import { EngineError, RefusalError, attestcoin as ac, spend, type Receipt } from "@attestpay/engine";
import type { AppDeps } from "../deps";
import { spendDeps, spendKey } from "../deps";

export type CreditExecResult = {
  receipt: Receipt;
  charge_id: string;
  line: ac.CreditLineRow;
  /** Set when the transfer confirmed inline and its fact was queued. */
  fact_id: string | null;
};

/** The credit stores, or a typed refusal when the feature is off. */
export function creditDeps(deps: AppDeps): { store: ac.AttestcoinStore; client: ac.AttestcoinClient } {
  const a = deps.attestcoin;
  if (!a?.client || !ac.attestcoinFeatures(a.client.config).credit) {
    throw new RefusalError("invalid_terms", "credit lines are not enabled on this deployment");
  }
  return { store: a.store, client: a.client };
}

/** Maps engine credit errors onto the agent-facing refusal vocabulary. */
export function refuseCredit(e: unknown): never {
  if (e instanceof ac.CreditLineError) {
    const code =
      e.code === "over_limit"
        ? "over_lifetime_limit"
        : e.code === "line_expired"
          ? "card_expired"
          : e.code === "line_not_found"
            ? "card_not_found"
            : "invalid_terms";
    throw new RefusalError(code, e.message, { credit_error: e.code });
  }
  throw e;
}

/** Executes a draw on behalf of the borrower. `actorCardId` is the borrower's card
 * that asked (for the memo and for scoping); the money leaves the lender's funding
 * card. */
export async function executeDraw(
  deps: AppDeps,
  lineId: string,
  args: { amountAtoms: bigint; memo?: string; idempotencyKey?: string; actorCardId?: string },
): Promise<CreditExecResult> {
  const { store: acStore, client } = creditDeps(deps);
  const now = Math.floor(Date.now() / 1000);
  const line = acStore.getLine(lineId);
  if (!line) throw new RefusalError("card_not_found", "no such credit line");
  try {
    ac.assertDrawable(line, args.amountAtoms, now);
  } catch (e) {
    refuseCredit(e);
  }

  const funding = deps.store.getCard(line.funding_card_id);
  if (!funding || funding.status !== "active") {
    throw new RefusalError("card_frozen", "the lender's funding card is not active; the line cannot be drawn");
  }

  // A server-minted key when the caller gave none: the charge must be findable after
  // spend() returns, because the receipt does not carry the charge id.
  const key = args.idempotencyKey ?? `draw:${lineId}:${crypto.randomUUID()}`;
  const receipt = await deps.spendMutex.run(spendKey(deps.store, line.funding_card_id), () =>
    spend(spendDeps(deps), line.funding_card_id, {
      kind: "pay",
      mode: "pay",
      to: line.borrower_address,
      amountAtoms: args.amountAtoms,
      memo: args.memo ?? `credit draw ${lineId.slice(0, 10)}`,
      idempotencyKey: key,
    }),
  );

  const charge = deps.store.chargeByIdempotency(line.funding_card_id, key);
  if (!charge) throw new EngineError("credit", "draw charge could not be located after spend");

  let factId: string | null = null;
  if (charge.status !== "failed") {
    if (!acStore.getLineEventByCharge(charge.id)) {
      ac.recordLineEvent(acStore, line, "draw", charge.id, args.amountAtoms, now);
    }
    // The inline confirm hook ran before the event existed; enqueue now if confirmed.
    // A still-pending charge is picked up by the reconcile sweep's hook later.
    factId = ac.enqueueLineFactForCharge({ store: deps.store, attestcoin: acStore, config: client.config }, charge.id, now);
  }
  return { receipt, charge_id: charge.id, line: acStore.getLine(lineId)!, fact_id: factId };
}

/** Executes a repayment from `cardId` (a borrower-side card) to the lender. */
export async function executeRepayment(
  deps: AppDeps,
  lineId: string,
  args: { cardId: string; amountAtoms: bigint; memo?: string; idempotencyKey?: string },
): Promise<CreditExecResult> {
  const { store: acStore, client } = creditDeps(deps);
  const now = Math.floor(Date.now() / 1000);
  const line = acStore.getLine(lineId);
  if (!line) throw new RefusalError("card_not_found", "no such credit line");

  const borrower = ac.borrowerAddressForCard(deps.store, args.cardId);
  if (!borrower || borrower.toLowerCase() !== line.borrower_address.toLowerCase()) {
    throw new RefusalError("not_your_subcard", "this card's funding account is not the borrower on that line");
  }
  try {
    ac.assertRepayable(line, args.amountAtoms);
  } catch (e) {
    refuseCredit(e);
  }

  const key = args.idempotencyKey ?? `repay:${lineId}:${crypto.randomUUID()}`;
  const receipt = await deps.spendMutex.run(spendKey(deps.store, args.cardId), () =>
    spend(spendDeps(deps), args.cardId, {
      kind: "pay",
      mode: "pay",
      to: line.lender_address,
      amountAtoms: args.amountAtoms,
      memo: args.memo ?? `credit repayment ${lineId.slice(0, 10)}`,
      idempotencyKey: key,
    }),
  );

  const charge = deps.store.chargeByIdempotency(args.cardId, key);
  if (!charge) throw new EngineError("credit", "repayment charge could not be located after spend");

  let factId: string | null = null;
  if (charge.status !== "failed") {
    if (!acStore.getLineEventByCharge(charge.id)) {
      ac.recordLineEvent(acStore, line, "repayment", charge.id, args.amountAtoms, now);
    }
    factId = ac.enqueueLineFactForCharge({ store: deps.store, attestcoin: acStore, config: client.config }, charge.id, now);
  }
  return { receipt, charge_id: charge.id, line: acStore.getLine(lineId)!, fact_id: factId };
}

const usdc = (atoms: bigint): string => (Number(atoms) / 1e6).toFixed(6);
const iso = (sec: number | bigint | null | undefined): string | null => {
  if (sec === null || sec === undefined) return null;
  const n = Number(sec);
  return n === 0 ? null : new Date(n * 1000).toISOString();
};

/** A line rendered for humans and agents: decimal USDC, ISO dates, derived figures. */
export function lineView(line: ac.CreditLineRow, now: number) {
  return {
    line_id: line.id,
    status: line.status,
    lender: line.lender_address,
    borrower: line.borrower_address,
    borrower_card_id: line.borrower_card_id,
    funding_card_id: line.funding_card_id,
    limit: usdc(line.limit_atoms),
    interest_bps: line.interest_bps,
    expires_at: iso(line.expires_at),
    drawn: usdc(line.drawn_atoms),
    repaid: usdc(line.repaid_atoms),
    owed: usdc(ac.owedAtoms(line)),
    outstanding: usdc(ac.outstandingAtoms(line)),
    available: usdc(ac.availableAtoms(line, now)),
    signatures: { lender: line.lender_sig !== null, borrower: line.borrower_sig !== null },
    creditcoin_tx_hash: line.creditcoin_tx_hash,
    creditcoin_explorer: line.creditcoin_tx_hash ? ac.creditcoinTxUrl(line.creditcoin_tx_hash) : null,
    error: line.error,
    created_at: iso(line.created_at),
    updated_at: iso(line.updated_at),
  };
}

export { usdc as usdcString, iso as isoTime };
