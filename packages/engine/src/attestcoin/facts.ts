// Facts that are not payments: disputes and revocations.
//
// Both follow the same discipline as everything else AttestPay proves — a local row
// is the source of truth for the dashboard, a fact is enqueued, the worker anchors it
// on the source chain and proves it into `AttestPayLedger`. Nothing here talks to a
// network; it only writes rows the worker will pick up.

import type { Address, Hex } from "viem";
import type { Store } from "../store";
import type { AttestcoinStore } from "./store";
import type { AttestcoinConfig } from "./config";
import { cardIdToBytes32, disputeIdToBytes32 } from "./config";
import { DISPUTE_OUTCOME_CODES, type DisputeRow, type DisputeStatus } from "./types";
import { payerForCard } from "./worker";

export class DisputeError extends Error {
  constructor(
    readonly code:
      | "charge_not_found"
      | "charge_not_disputable"
      | "already_disputed"
      | "dispute_not_found"
      | "dispute_not_open"
      | "invalid_outcome",
    message: string,
  ) {
    super(message);
    this.name = "DisputeError";
  }
}

const newId = (prefix: string): string => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

export type OpenDisputeInput = {
  chargeId: string;
  cardId: string;
  openedByUserId: string;
  reason: string;
};

/** Opens a dispute on a confirmed payment and enqueues the fact. One open dispute per
 * payment: a second complaint about the same charge joins the first rather than
 * double-counting against the payer. */
export function openDispute(
  deps: { store: Store; attestcoin: AttestcoinStore; config: Pick<AttestcoinConfig, "paymentChainId"> | null },
  input: OpenDisputeInput,
  now: number,
): DisputeRow {
  const charge = deps.store.getCharge(input.chargeId);
  if (!charge || charge.card_id !== input.cardId) throw new DisputeError("charge_not_found", "no such charge on this card");
  if (charge.status !== "confirmed" || !charge.tx_hash || !charge.to_addr) {
    throw new DisputeError("charge_not_disputable", `only a confirmed on-chain payment can be disputed (charge is ${charge.status})`);
  }
  if (deps.attestcoin.openDisputeForCharge(input.chargeId)) {
    throw new DisputeError("already_disputed", "this payment already has an open dispute");
  }
  const reason = input.reason.trim();
  if (!reason) throw new DisputeError("invalid_outcome", "a reason is required");

  const row: DisputeRow = {
    id: newId("dsp"),
    charge_id: charge.id,
    card_id: charge.card_id,
    opened_by_user_id: input.openedByUserId,
    reason: reason.slice(0, 500),
    status: "open",
    resolution_note: null,
    resolved_by: null,
    opened_at: now,
    resolved_at: null,
  };
  deps.attestcoin.createDispute(row);

  // Enqueue the fact only when the ledger is configured; the local dispute still
  // exists and is resolvable either way — a deployment without the ledger simply
  // keeps disputes off-chain.
  if (deps.config) {
    const payer = payerForCard(deps.store, charge.card_id);
    if (payer) {
      deps.attestcoin.enqueueFact(
        {
          id: `fact:dispute_opened:${row.id}`,
          kind: "dispute_opened",
          refId: row.id,
          cardId: charge.card_id,
          payload: {
            kind: "dispute_opened",
            disputeId: disputeIdToBytes32(row.id),
            cardIdHash: cardIdToBytes32(charge.card_id),
            payer,
            merchant: charge.to_addr as Address,
            sourceChainId: deps.config.paymentChainId,
            sourceTxHash: charge.tx_hash as Hex,
            amountAtoms: charge.amount_atoms.toString(),
            at: now,
            reason: row.reason,
          },
        },
        now,
      );
    }
  }
  return row;
}

/** Resolves an open dispute and enqueues the outcome fact. */
export function resolveDispute(
  deps: { store: Store; attestcoin: AttestcoinStore; config: Pick<AttestcoinConfig, "paymentChainId"> | null },
  disputeId: string,
  outcome: Exclude<DisputeStatus, "open">,
  note: string | null,
  resolvedBy: string,
  now: number,
): DisputeRow {
  if (!(outcome in DISPUTE_OUTCOME_CODES)) throw new DisputeError("invalid_outcome", `unknown outcome ${outcome}`);
  const row = deps.attestcoin.getDispute(disputeId);
  if (!row) throw new DisputeError("dispute_not_found", "no such dispute");
  if (row.status !== "open") throw new DisputeError("dispute_not_open", `dispute is already ${row.status}`);

  deps.attestcoin.resolveDispute(disputeId, outcome, note ? note.slice(0, 500) : null, resolvedBy, now);

  if (deps.config) {
    const payer = payerForCard(deps.store, row.card_id);
    if (payer) {
      deps.attestcoin.enqueueFact(
        {
          id: `fact:dispute_resolved:${row.id}`,
          kind: "dispute_resolved",
          refId: row.id,
          cardId: row.card_id,
          payload: {
            kind: "dispute_resolved",
            disputeId: disputeIdToBytes32(row.id),
            cardIdHash: cardIdToBytes32(row.card_id),
            payer,
            outcome: DISPUTE_OUTCOME_CODES[outcome],
            at: now,
          },
        },
        now,
      );
    }
  }
  return deps.attestcoin.getDispute(disputeId)!;
}

/** Enqueues the proven-revocation fact for a card. Idempotent: a card dies once, and
 * the fact id is keyed on the card, so revoke + nuke + cascade all collapse to one. */
export function enqueueCardRevocation(
  deps: { store: Store; attestcoin: AttestcoinStore },
  cardId: string,
  now: number,
): string | null {
  const payer = payerForCard(deps.store, cardId);
  if (!payer) return null;
  const id = `fact:card_revoked:${cardId}`;
  deps.attestcoin.enqueueFact(
    {
      id,
      kind: "card_revoked",
      refId: cardId,
      cardId,
      payload: { kind: "card_revoked", cardIdHash: cardIdToBytes32(cardId), payer, revokedAt: now },
    },
    now,
  );
  return id;
}
