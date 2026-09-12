// Credit lines: the domain logic between the dashboard/API and `AttestPayCreditLine`.
//
// THE SHAPE OF A LINE
//
// A lender offers a borrower (an agent's funding account) a limit, at a simple
// interest rate, until an expiry. Both sign the terms (EIP-712), the server registers
// them on Creditcoin, and from then on:
//
//   - a DRAW is the borrower's agent asking for funds: the server pays USDC from the
//     lender's designated FUNDING CARD to the borrower's funding account, through the
//     ordinary `spend()` path. The lender's own card terms are therefore the
//     on-chain (Base) ceiling on draws; the line's limit is the Creditcoin one.
//   - a REPAYMENT is the borrower's card paying the lender's address.
//
// Each is a normal charge. When it confirms, the confirmed-charge hook finds the
// `credit_line_events` row that names it and enqueues the matching fact, which the
// worker anchors, proves, and submits to `AttestPayCreditLine`.
//
// Draws and repayments are therefore ALSO ordinary payments in each party's verified
// payment history — correct, since they are exactly that.

import {
  encodeAbiParameters,
  hashTypedData,
  isAddressEqual,
  keccak256,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from "viem";
import type { Store } from "../store";
import type { AttestcoinClient } from "./client";
import type { AttestcoinStore } from "./store";
import type { AttestcoinConfig } from "./config";
import type { CreditLineEventRow, CreditLineRow } from "./types";
import { payerForCard, syncLineFromChain } from "./worker";

/** EIP-712 types, mirroring `AttestPayCreditLine.LINE_TYPEHASH` exactly. */
export const CREDIT_LINE_TYPES = {
  CreditLine: [
    { name: "lender", type: "address" },
    { name: "borrower", type: "address" },
    { name: "limit", type: "uint256" },
    { name: "interestBps", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export const LINE_TYPEHASH = keccak256(
  new TextEncoder().encode(
    "CreditLine(address lender,address borrower,uint256 limit,uint256 interestBps,uint256 expiresAt,uint256 nonce)",
  ),
);

export type LineTerms = {
  lender: Address;
  borrower: Address;
  limit: bigint;
  interestBps: bigint;
  expiresAt: bigint;
  nonce: bigint;
};

/** The EIP-712 domain of a deployed `AttestPayCreditLine`. */
export function creditLineDomain(chainId: number, verifyingContract: Address) {
  return { name: "AttestPayCreditLine", version: "1", chainId, verifyingContract } as const;
}

/** The struct hash — and therefore the line id — exactly as the contract computes it. */
export function lineIdOf(t: LineTerms): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [LINE_TYPEHASH, t.lender, t.borrower, t.limit, t.interestBps, t.expiresAt, t.nonce],
    ),
  );
}

/** The full typed-data request a wallet signs (what the dashboard hands to Privy). */
export function creditLineTypedData(chainId: number, verifyingContract: Address, t: LineTerms) {
  return {
    domain: creditLineDomain(chainId, verifyingContract),
    types: CREDIT_LINE_TYPES,
    primaryType: "CreditLine" as const,
    message: {
      lender: t.lender,
      borrower: t.borrower,
      limit: t.limit,
      interestBps: t.interestBps,
      expiresAt: t.expiresAt,
      nonce: t.nonce,
    },
  };
}

/** The digest both parties sign, as the contract's `digestOf` computes it. */
export function lineDigest(chainId: number, verifyingContract: Address, t: LineTerms): Hex {
  return hashTypedData(creditLineTypedData(chainId, verifyingContract, t));
}

/** Recovers the signer of a line signature. */
export async function recoverLineSigner(
  chainId: number,
  verifyingContract: Address,
  t: LineTerms,
  signature: Hex,
): Promise<Address> {
  return recoverTypedDataAddress({ ...creditLineTypedData(chainId, verifyingContract, t), signature });
}

export function termsOf(row: CreditLineRow): LineTerms {
  return {
    lender: row.lender_address,
    borrower: row.borrower_address,
    limit: row.limit_atoms,
    interestBps: BigInt(row.interest_bps),
    expiresAt: BigInt(row.expires_at),
    nonce: row.nonce,
  };
}

/** Simple interest, as the contract computes it. */
export function owedAtoms(row: { drawn_atoms: bigint; interest_bps: number }): bigint {
  return (row.drawn_atoms * BigInt(10_000 + row.interest_bps)) / 10_000n;
}

export function outstandingAtoms(row: { drawn_atoms: bigint; repaid_atoms: bigint; interest_bps: number }): bigint {
  const owed = owedAtoms(row);
  return owed > row.repaid_atoms ? owed - row.repaid_atoms : 0n;
}

/** What may still be drawn right now, by the local mirror's view. */
export function availableAtoms(row: CreditLineRow, now: number): bigint {
  if (row.status !== "open" && row.status !== "active") return 0n;
  if (now > row.expires_at) return 0n;
  const left = row.limit_atoms - row.drawn_atoms;
  return left > 0n ? left : 0n;
}

export class CreditLineError extends Error {
  constructor(
    readonly code:
      | "line_not_found"
      | "invalid_terms"
      | "invalid_signature"
      | "wrong_party"
      | "line_not_open"
      | "over_limit"
      | "line_expired"
      | "nothing_outstanding"
      | "not_configured",
    message: string,
  ) {
    super(message);
    this.name = "CreditLineError";
  }
}

/** A random 256-bit nonce. Per-lender uniqueness on-chain; randomness makes two
 * otherwise identical offers distinct lines. */
export function randomNonce(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
}

export type ProposeLineInput = {
  lenderUserId: string;
  lenderAddress: Address;
  borrowerAddress: Address;
  /** The borrower's card whose agent may draw; optional at proposal time. */
  borrowerCardId: string | null;
  fundingCardId: string;
  limitAtoms: bigint;
  interestBps: number;
  expiresAt: number;
  nonce?: bigint;
};

/** Drafts a line. Validates the same way the contract will, so a line the contract
 * would refuse is never offered for signature. */
export function proposeLine(ac: AttestcoinStore, input: ProposeLineInput, now: number): CreditLineRow {
  if (input.limitAtoms <= 0n) throw new CreditLineError("invalid_terms", "limit must be positive");
  if (input.interestBps < 0 || input.interestBps > 10_000) {
    throw new CreditLineError("invalid_terms", "interest must be between 0 and 10000 basis points");
  }
  if (input.expiresAt <= now) throw new CreditLineError("invalid_terms", "expiry must be in the future");
  if (isAddressEqual(input.lenderAddress, input.borrowerAddress)) {
    throw new CreditLineError("invalid_terms", "lender and borrower must differ");
  }
  const nonce = input.nonce ?? randomNonce();
  const terms: LineTerms = {
    lender: input.lenderAddress,
    borrower: input.borrowerAddress,
    limit: input.limitAtoms,
    interestBps: BigInt(input.interestBps),
    expiresAt: BigInt(input.expiresAt),
    nonce,
  };
  const row: CreditLineRow = {
    id: lineIdOf(terms),
    lender_user_id: input.lenderUserId,
    lender_address: input.lenderAddress,
    borrower_address: input.borrowerAddress,
    borrower_card_id: input.borrowerCardId,
    funding_card_id: input.fundingCardId,
    limit_atoms: input.limitAtoms,
    interest_bps: input.interestBps,
    expires_at: input.expiresAt,
    nonce,
    lender_sig: null,
    borrower_sig: null,
    status: "proposed",
    creditcoin_tx_hash: null,
    error: null,
    drawn_atoms: 0n,
    repaid_atoms: 0n,
    created_at: now,
    updated_at: now,
  };
  ac.createLine(row);
  return row;
}

/** Attaches one party's signature after verifying it recovers to that party. Once
 * both are present the line is 'signed' and ready for on-chain registration. */
export async function attachLineSignature(
  ac: AttestcoinStore,
  config: { creditcoinChainId: number; creditLineAddress: Address },
  lineId: string,
  party: "lender" | "borrower",
  signature: Hex,
  now: number,
): Promise<CreditLineRow> {
  const row = ac.getLine(lineId);
  if (!row) throw new CreditLineError("line_not_found", "no such credit line");
  if (row.status !== "proposed") throw new CreditLineError("line_not_open", `line is ${row.status}; signatures are closed`);

  const expected = party === "lender" ? row.lender_address : row.borrower_address;
  let signer: Address;
  try {
    signer = await recoverLineSigner(config.creditcoinChainId, config.creditLineAddress, termsOf(row), signature);
  } catch {
    throw new CreditLineError("invalid_signature", "signature is malformed");
  }
  if (!isAddressEqual(signer, expected)) {
    throw new CreditLineError("invalid_signature", `${party} signature recovers to ${signer}, expected ${expected}`);
  }

  const fields = party === "lender" ? { lender_sig: signature } : { borrower_sig: signature };
  const other = party === "lender" ? row.borrower_sig : row.lender_sig;
  ac.updateLine(lineId, { ...fields, ...(other ? { status: "signed" as const } : {}) }, now);
  return ac.getLine(lineId)!;
}

/** Registers a fully signed line on Creditcoin. Records the outcome locally;
 * a permanent rejection parks the line as 'failed' with the contract's reason. */
export async function openLineOnChain(
  deps: { attestcoin: AttestcoinStore; client: AttestcoinClient },
  lineId: string,
  now: number,
): Promise<{ ok: boolean; txHash?: string; error?: string }> {
  const row = deps.attestcoin.getLine(lineId);
  if (!row) return { ok: false, error: "no such line" };
  if (row.status !== "signed") return { ok: false, error: `line is ${row.status}` };
  if (!row.lender_sig || !row.borrower_sig) return { ok: false, error: "both signatures are required" };

  deps.attestcoin.updateLine(lineId, { status: "opening" }, now);
  try {
    const t = termsOf(row);
    const { txHash } = await deps.client.openCreditLine(
      {
        lender: t.lender,
        borrower: t.borrower,
        limit: t.limit,
        interestBps: t.interestBps,
        expiresAt: t.expiresAt,
        nonce: t.nonce,
      },
      row.lender_sig,
      row.borrower_sig,
    );
    deps.attestcoin.updateLine(lineId, { status: "open", creditcoin_tx_hash: txHash, error: null }, now);
    return { ok: true, txHash };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const permanent = (e as { retryable?: boolean }).retryable === false;
    // A retryable failure (RPC down) goes back to 'signed' so the sweep tries again;
    // a permanent one (bad signature, nonce used) is parked with the reason.
    deps.attestcoin.updateLine(lineId, { status: permanent ? "failed" : "signed", error: message }, now);
    return { ok: false, error: message };
  }
}

/** Validates a requested draw against the local mirror. The chain enforces the
 * same rules again when the fact is proven; checking here keeps a refused draw from
 * ever moving USDC. */
export function assertDrawable(row: CreditLineRow, amountAtoms: bigint, now: number): void {
  if (row.status !== "open" && row.status !== "active") {
    throw new CreditLineError("line_not_open", `line is ${row.status}`);
  }
  if (now > row.expires_at) throw new CreditLineError("line_expired", "line has expired");
  if (amountAtoms <= 0n) throw new CreditLineError("invalid_terms", "amount must be positive");
  const available = availableAtoms(row, now);
  if (amountAtoms > available) {
    throw new CreditLineError("over_limit", `draw of ${amountAtoms} exceeds available ${available}`);
  }
}

export function assertRepayable(row: CreditLineRow, amountAtoms: bigint): void {
  if (row.status !== "active" && row.status !== "defaulted") {
    throw new CreditLineError("line_not_open", `line is ${row.status}; nothing to repay`);
  }
  if (amountAtoms <= 0n) throw new CreditLineError("invalid_terms", "amount must be positive");
  if (outstandingAtoms(row) === 0n) throw new CreditLineError("nothing_outstanding", "line is fully repaid");
}

/** Books a draw or repayment charge against a line. Called right after `spend()`
 * returns, whatever the receipt status: the fact is enqueued only once the charge
 * confirms, via `factsForConfirmedCharge`. */
export function recordLineEvent(
  ac: AttestcoinStore,
  line: CreditLineRow,
  kind: "draw" | "repayment",
  chargeId: string,
  amountAtoms: bigint,
  now: number,
): CreditLineEventRow {
  const ev: CreditLineEventRow = {
    id: `${kind}:${chargeId}`,
    line_id: line.id,
    kind,
    charge_id: chargeId,
    amount_atoms: amountAtoms,
    created_at: now,
  };
  ac.addLineEvent(ev);
  // Optimistic local mirror; the proven fact reconciles it from the chain later.
  if (kind === "draw") {
    ac.updateLine(line.id, { drawn_atoms: line.drawn_atoms + amountAtoms, status: "active" }, now);
  } else {
    ac.updateLine(line.id, { repaid_atoms: line.repaid_atoms + amountAtoms }, now);
  }
  return ev;
}

/** The confirmed-charge hook for credit: if this charge is a draw or repayment,
 * enqueue its fact. Returns the fact id, or null when the charge is unrelated. */
export function enqueueLineFactForCharge(
  deps: { store: Store; attestcoin: AttestcoinStore; config: Pick<AttestcoinConfig, "paymentChainId"> },
  chargeId: string,
  now: number,
): string | null {
  const ev = deps.attestcoin.getLineEventByCharge(chargeId);
  if (!ev) return null;
  const line = deps.attestcoin.getLine(ev.line_id);
  const charge = deps.store.getCharge(chargeId);
  if (!line || !charge || charge.status !== "confirmed" || !charge.tx_hash) return null;

  const id = `fact:${ev.id}`;
  deps.attestcoin.enqueueFact(
    {
      id,
      kind: ev.kind,
      refId: line.id,
      cardId: ev.kind === "draw" ? line.funding_card_id : charge.card_id,
      payload: {
        kind: ev.kind,
        lineId: line.id,
        borrower: line.borrower_address,
        lender: line.lender_address,
        amountAtoms: ev.amount_atoms.toString(),
        sourceChainId: deps.config.paymentChainId,
        sourceTxHash: charge.tx_hash as Hex,
        at: charge.created_at,
      },
    },
    now,
  );
  return id;
}

/** The borrower's funding account for a card: the card tree's root user address. */
export function borrowerAddressForCard(store: Store, cardId: string): Address | null {
  return payerForCard(store, cardId);
}

/** Lines an agent on `cardId` may draw on: those naming its funding account as
 * borrower, in a drawable state. */
export function drawableLinesForCard(store: Store, ac: AttestcoinStore, cardId: string, now: number): CreditLineRow[] {
  const borrower = borrowerAddressForCard(store, cardId);
  if (!borrower) return [];
  return ac.listLinesByBorrower(borrower).filter((l) => availableAtoms(l, now) > 0n || outstandingAtoms(l) > 0n);
}

/** The periodic credit-line sweep: registers lines whose signatures are complete and
 * advances lines past their expiry (close if never drawn, default if a balance
 * remains). Each line is handled independently so one bad line cannot stall the
 * rest; failures are recorded on the row and the next tick tries again. */
export async function sweepCreditLines(
  deps: { attestcoin: AttestcoinStore; client: AttestcoinClient },
  now: number,
): Promise<{ opened: number; defaulted: number; closed: number; errors: number }> {
  const result = { opened: 0, defaulted: 0, closed: 0, errors: 0 };

  for (const line of deps.attestcoin.linesAwaitingOpen(5)) {
    const r = await openLineOnChain(deps, line.id, now);
    if (r.ok) result.opened += 1;
    else result.errors += 1;
  }

  for (const line of deps.attestcoin.linesPastExpiry(now, 10)) {
    try {
      await syncLineFromChain(deps, line.id, now);
      const fresh = deps.attestcoin.getLine(line.id)!;
      if (fresh.status === "open") {
        await deps.client.settleExpiredLine(line.id, "close");
        result.closed += 1;
      } else if (fresh.status === "active" && outstandingAtoms(fresh) > 0n) {
        await deps.client.settleExpiredLine(line.id, "default");
        result.defaulted += 1;
      }
      await syncLineFromChain(deps, line.id, now);
    } catch (e) {
      result.errors += 1;
      deps.attestcoin.updateLine(line.id, { error: e instanceof Error ? e.message : String(e) }, now);
    }
  }
  return result;
}
