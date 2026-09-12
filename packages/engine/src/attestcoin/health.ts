// Attestcoin protocol health: attestation lag, queue depth, deployment wiring.
//
// Answers the question an operator or an agent actually has mid-demo — "is the
// cross-chain leg moving, and if my payment isn't verified yet, is that normal?" —
// which needs the attestation lag and the local queue side by side.

import { AttestcoinClient } from "./client";
import type { AttestcoinStore } from "./store";
import { attestcoinDisabledReason } from "./config";
import { CREDITCOIN_TESTNET, type AttestcoinHealth, type ProofStatus } from "./types";

const EMPTY_QUEUE: Record<ProofStatus, number> = {
  pending: 0,
  anchoring: 0,
  anchored: 0,
  attested: 0,
  proving: 0,
  verified: 0,
  failed: 0,
};

/** Health for a configured integration. Never throws: a health check that fails when
 * the thing it checks is down reports nothing useful. RPC failures land in `error`
 * with the numeric fields left null, so a caller can tell "lag is zero" apart from
 * "we could not find out". */
export async function attestcoinHealth(
  client: AttestcoinClient,
  store: AttestcoinStore,
): Promise<AttestcoinHealth> {
  const base: AttestcoinHealth = {
    configured: true,
    chainKey: client.config.chainKey,
    latestAttestedHeight: null,
    sourceHead: null,
    attestationLagBlocks: null,
    queue: store.statusCounts(),
    creditcoinChainId: client.config.creditcoinChainId,
    ascAddress: client.config.ascAddress,
    anchorAddress: client.config.anchorAddress,
  };

  try {
    const [attested, head] = await Promise.all([client.latestAttestedHeight(), client.sourceHead()]);
    base.latestAttestedHeight = attested || null;
    base.sourceHead = head;
    // Clamped at 0: attested briefly reading ahead of a lagging source RPC is a
    // reporting artefact, and a negative "lag" would be nonsense on a dashboard.
    base.attestationLagBlocks = attested > 0 ? Math.max(0, head - attested) : null;
  } catch (e) {
    base.error = e instanceof Error ? e.message : String(e);
  }

  return base;
}

/** Health for a deployment with the integration switched off, including the reason. */
export function attestcoinDisabledHealth(store?: AttestcoinStore): AttestcoinHealth {
  return {
    configured: false,
    chainKey: null,
    latestAttestedHeight: null,
    sourceHead: null,
    attestationLagBlocks: null,
    queue: store ? store.statusCounts() : { ...EMPTY_QUEUE },
    creditcoinChainId: null,
    ascAddress: null,
    anchorAddress: null,
    error: attestcoinDisabledReason() ?? "not configured",
  };
}

/** Explorer URL for a Creditcoin transaction. */
export function creditcoinTxUrl(txHash: string): string {
  return `${CREDITCOIN_TESTNET.explorer}/tx/${txHash}`;
}

/** Explorer URL for a Creditcoin address. */
export function creditcoinAddressUrl(address: string): string {
  return `${CREDITCOIN_TESTNET.explorer}/address/${address}`;
}

/** Explorer URL for a source-chain transaction (the anchor). */
export function sourceTxUrl(client: AttestcoinClient, txHash: string): string {
  return `${client.config.sourceExplorer}/tx/${txHash}`;
}

/** Explorer URL for the original payment on Base. Base mainnet and Base Sepolia are
 * different explorers, and the payment chain is independent of the anchor chain. */
export function baseTxUrl(chainId: number, txHash: string): string {
  const base = chainId === 84532 ? "https://sepolia.basescan.org" : "https://basescan.org";
  return `${base}/tx/${txHash}`;
}

/** A letter grade over a card's verified on-chain history.
 *
 * Deliberately simple and deliberately documented, because an opaque "credit score"
 * invites more trust than the data supports. Three inputs, each capped:
 *   - payment count  (consistency: does this agent pay repeatedly?)
 *   - verified volume (scale)
 *   - history length  (age: a long record is harder to fake than a large one)
 * Terms compliance, when measurable, scales the result.
 *
 * This is a readable summary of public on-chain facts, not a risk model. Anyone
 * wanting a real one should read the underlying payments from the ASC directly. */
export function creditGrade(credit: {
  totalPayments: bigint;
  totalVolume: bigint;
  firstPaymentAt: bigint;
  lastPaymentAt: bigint;
  withinTermsPayments: bigint;
  termsCheckedPayments: bigint;
}): { grade: "A" | "B" | "C" | "D" | "F"; score: number; basis: string } {
  const payments = Number(credit.totalPayments);
  if (payments === 0) {
    return { grade: "F", score: 0, basis: "no verified payments yet" };
  }

  // Volume in whole USDC (atoms are 6dp).
  const volume = Number(credit.totalVolume) / 1e6;
  const historyDays =
    credit.firstPaymentAt > 0n
      ? (Number(credit.lastPaymentAt) - Number(credit.firstPaymentAt)) / 86_400
      : 0;

  const countScore = Math.min(40, payments * 4); // 10 payments maxes this out
  const volumeScore = Math.min(30, volume * 3); // 10 USDC maxes this out
  const ageScore = Math.min(30, historyDays * 1); // 30 days maxes this out
  let score = countScore + volumeScore + ageScore;

  // Compliance only applies where terms were registered and therefore checkable.
  const checked = Number(credit.termsCheckedPayments);
  let basis = `${payments} verified payment(s), ${volume.toFixed(2)} USDC, ${historyDays.toFixed(1)}d history`;
  if (checked > 0) {
    const rate = Number(credit.withinTermsPayments) / checked;
    score *= rate;
    basis += `, ${(rate * 100).toFixed(0)}% within registered terms`;
  } else {
    basis += ", no registered terms to check against";
  }

  score = Math.round(Math.max(0, Math.min(100, score)));
  const grade = score >= 80 ? "A" : score >= 60 ? "B" : score >= 40 ? "C" : score >= 20 ? "D" : "F";
  return { grade, score, basis };
}
