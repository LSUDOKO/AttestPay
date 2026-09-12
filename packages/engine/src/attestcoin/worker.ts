// The Attestcoin proof worker: drives persisted pipeline rows toward 'verified'.
//
// WHY A WORKER AND NOT AN INLINE STEP IN `pay`
//
// Attestation takes minutes. An agent calling `pay` must get its receipt in seconds,
// so the cross-chain leg cannot be on that path. `spend()` therefore only enqueues,
// and this worker advances each row one state at a time on a timer. Each tick does a
// bounded amount of work and persists before moving on, so a restart loses at most
// one in-flight step rather than the whole pipeline.
//
// ONE STATE PER TICK, ON PURPOSE
//
// `advance` performs exactly one transition per row per tick rather than looping a row
// through to completion. That keeps a single slow row from starving the queue, and
// makes the attestation wait a natural consequence of re-checking rather than a sleep
// held inside a process.
//
// ONE STATE MACHINE, TWO PIPELINES
//
// Payments (PaymentAnchor -> AttestPayASC) and facts (FactAnchor -> AttestPayCreditLine
// / AttestPayLedger) have identical lifecycles and differ only in how a row is
// anchored and where its proof is submitted. `Pipeline` captures that difference and
// `advance` is written once against it.

import type { Store } from "../store";
import { atomsToUsdc } from "../money";
import { AttestcoinClient, AttestcoinError } from "./client";
import type { AttestcoinStore, PipelineUpdate } from "./store";
import { cardIdToBytes32, type AttestcoinConfig } from "./config";
import { endToEndSeconds, emitAttestcoinError, verificationFailures } from "./telemetry";
import type { AnchorRequest, FactRow, ProofRow, ProofStatus } from "./types";
import type { Address, Hex } from "viem";

/** Attempts before a row is parked as 'failed'.
 *
 * Sized for the real failure mode: the prover answers "not attested yet" as a generic
 * failure, so a row legitimately burns attempts while simply waiting. At the default
 * 60s tick this allows roughly half an hour of waiting — comfortably more than the
 * ~8 minute lag observed on CC3 testnet — before giving up. */
export const MAX_ATTEMPTS = 30;

export type WorkerDeps = {
  store: Store;
  attestcoin: AttestcoinStore;
  client: AttestcoinClient;
  now?: () => number;
  /** Rows advanced per tick. Keeps one sweep's RPC usage bounded. */
  batchSize?: number;
  /** Fired once when a row reaches 'verified' or 'failed'. Webhooks hang off this.
   * Must not throw; it is shielded regardless. */
  onTerminal?: (event: PipelineEvent) => void;
};

export type PipelineEvent =
  | { pipeline: "payment"; status: "verified" | "failed"; row: ProofRow }
  | { pipeline: "fact"; status: "verified" | "failed"; row: FactRow };

export type SweepResult = {
  examined: number;
  advanced: number;
  verified: number;
  failed: number;
  waiting: number;
};

/** The lifecycle columns every pipeline row shares. */
type PipelineRow = {
  status: ProofStatus;
  anchor_tx_hash: string | null;
  anchor_height: number | null;
  attempts: number;
  created_at: number;
};

/** What differs between the payment and fact pipelines. */
type Pipeline<R extends PipelineRow> = {
  name: "payment" | "fact";
  idOf(row: R): string;
  claimable(limit: number): R[];
  update(id: string, fields: PipelineUpdate, now: number): void;
  /** Whether the row can be anchored at all. Checked BEFORE an attempt is spent, so
   * a structurally impossible row is parked on its first look, budget intact. */
  anchorable(row: R): boolean;
  /** Writes the anchor. */
  anchor(row: R): Promise<{ txHash: string; height: number }>;
  submit(row: R, proof: Awaited<ReturnType<AttestcoinClient["generateProof"]>>): Promise<{ txHash: string; recorded: number }>;
  /** Runs after a row is verified (cache refreshes, local mirrors). Best-effort. */
  afterVerified?(row: R, now: number): Promise<void>;
  terminal(row: R, status: "verified" | "failed"): PipelineEvent;
};

/** Resolves the funding account a card's USDC actually leaves from: the root
 * delegator of the card tree. Sub-cards spend from their root's account, so the
 * credit history must accrue to the root, not to the leaf that initiated it. */
export function payerForCard(store: Store, cardId: string): Address | null {
  const root = store.ancestorChain(cardId).at(-1);
  if (!root) return null;
  return store.getUser(root.user_id)?.address ?? null;
}

/** Builds the anchor request for a confirmed charge, or null when it is not
 * anchorable (no tx hash, no recipient, or no resolvable funding account). */
export function anchorRequestFor(
  store: Store,
  chargeId: string,
  sourceChainId: number,
): AnchorRequest | null {
  const charge = store.getCharge(chargeId);
  if (!charge) return null;
  // Only a charge with a real on-chain transaction can be anchored: the whole point
  // of `sourceTxHash` is that a third party can go and check it.
  if (!charge.tx_hash || !charge.to_addr) return null;

  const payer = payerForCard(store, charge.card_id);
  if (!payer) return null;

  return {
    chargeId: charge.id,
    cardId: charge.card_id,
    payer,
    merchant: charge.to_addr,
    amountAtoms: charge.amount_atoms,
    sourceChainId,
    sourceTxHash: charge.tx_hash as Hex,
    paidAt: charge.created_at,
    memo: charge.memo ?? "",
  };
}

// ---------------------------------------------------------------------------
// The two pipelines
// ---------------------------------------------------------------------------

/** The chain AttestPay's USDC settles on. Falls back to Base for clients built from
 * older configurations (and test fakes) that predate the field. */
function paymentChainId(client: AttestcoinClient): number {
  return client.config.paymentChainId ?? 8453;
}

function paymentPipeline(deps: WorkerDeps): Pipeline<ProofRow> {
  const { attestcoin, client, store } = deps;
  return {
    name: "payment",
    idOf: (r) => r.charge_id,
    claimable: (n) => attestcoin.claimable(n),
    update: (id, f, now) => attestcoin.update(id, f, now),
    anchorable: (row) => anchorRequestFor(store, row.charge_id, paymentChainId(client)) !== null,
    async anchor(row) {
      // The anchor records the chain the USDC actually moved on (Base), which is what
      // `PaymentAnchored.sourceChainId` documents; the anchor's own chain is implicit.
      const req = anchorRequestFor(store, row.charge_id, paymentChainId(client))!;
      return client.anchorPayment(req);
    },
    submit: (row, proof) => client.submitProof(row.charge_id, row.card_id, proof),
    afterVerified: (row, now) => refreshCreditCache(deps, row.card_id, now),
    terminal: (row, status) => ({ pipeline: "payment", status, row }),
  };
}

function factPipeline(deps: WorkerDeps): Pipeline<FactRow> {
  const { attestcoin, client } = deps;
  return {
    name: "fact",
    idOf: (r) => r.id,
    claimable: (n) => attestcoin.claimableFacts(n),
    update: (id, f, now) => attestcoin.updateFact(id, f, now),
    anchorable: () => true,
    anchor: (row) => client.anchorFact(row),
    submit: (row, proof) => client.submitFacts(row.target, row.id, proof),
    async afterVerified(row, now) {
      // A verified draw/repayment means the on-chain line moved: mirror it locally.
      if (row.kind === "draw" || row.kind === "repayment") {
        await syncLineFromChain(deps, row.ref_id, now);
      }
    },
    terminal: (row, status) => ({ pipeline: "fact", status, row }),
  };
}

/** Advances every claimable payment proof row by one state. Never throws: a sweep
 * that dies on one bad row would stall every other row behind it. */
export function sweepProofs(deps: WorkerDeps): Promise<SweepResult> {
  return sweep(deps, paymentPipeline(deps));
}

/** Advances every claimable fact row by one state. */
export function sweepFacts(deps: WorkerDeps): Promise<SweepResult> {
  return sweep(deps, factPipeline(deps));
}

async function sweep<R extends PipelineRow>(deps: WorkerDeps, p: Pipeline<R>): Promise<SweepResult> {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const batch = deps.batchSize ?? 10;
  const rows = p.claimable(batch);

  const result: SweepResult = {
    examined: rows.length,
    advanced: 0,
    verified: 0,
    failed: 0,
    waiting: 0,
  };

  for (const row of rows) {
    try {
      const outcome = await advance(deps, p, row, now());
      if (outcome === "advanced") result.advanced += 1;
      else if (outcome === "verified") {
        result.advanced += 1;
        result.verified += 1;
      } else if (outcome === "waiting") result.waiting += 1;
      else if (outcome === "failed") result.failed += 1;
    } catch (e) {
      // advance() is meant to classify its own errors; anything escaping is a bug,
      // so record it against the row and keep the sweep alive.
      const message = e instanceof Error ? e.message : String(e);
      emitAttestcoinError("sweep", p.idOf(row), message);
      p.update(p.idOf(row), { error: message, bumpAttempts: true }, now());
      result.failed += 1;
    }
  }

  return result;
}

type Outcome = "advanced" | "verified" | "waiting" | "failed" | "noop";

function notifyTerminal<R extends PipelineRow>(deps: WorkerDeps, p: Pipeline<R>, row: R, status: "verified" | "failed"): void {
  if (!deps.onTerminal) return;
  try {
    deps.onTerminal(p.terminal(row, status));
  } catch {
    /* a broken listener must not fail a pipeline that already persisted its result */
  }
}

/** Performs one state transition for one row. */
async function advance<R extends PipelineRow>(deps: WorkerDeps, p: Pipeline<R>, row: R, now: number): Promise<Outcome> {
  const id = p.idOf(row);

  if (row.attempts >= MAX_ATTEMPTS) {
    p.update(id, { status: "failed", error: (row as { error?: string | null }).error ?? `gave up after ${MAX_ATTEMPTS} attempts` }, now);
    verificationFailures.add(1, { stage: "exhausted", pipeline: p.name });
    emitAttestcoinError("exhausted", id, `gave up after ${MAX_ATTEMPTS} attempts`);
    notifyTerminal(deps, p, { ...row, status: "failed" }, "failed");
    return "failed";
  }

  switch (row.status) {
    // ---- write the anchor on the source chain ----
    case "pending":
    case "anchoring": {
      if (!p.anchorable(row)) {
        // Not anchorable and never will be (no tx hash / no recipient / no account):
        // park it rather than retry 30 times.
        p.update(
          id,
          { status: "failed", error: "not anchorable (missing tx hash, recipient, or funding account)" },
          now,
        );
        notifyTerminal(deps, p, { ...row, status: "failed" }, "failed");
        return "failed";
      }

      p.update(id, { status: "anchoring", bumpAttempts: true }, now);
      try {
        const landed = await p.anchor(row);
        p.update(
          id,
          { status: "anchored", anchor_tx_hash: landed.txHash, anchor_height: landed.height, error: null },
          now,
        );
        return "advanced";
      } catch (e) {
        return classify(deps, p, row, e, "anchor", now);
      }
    }

    // ---- wait for the attestors to cover the anchor's block ----
    case "anchored": {
      if (row.anchor_height === null) {
        p.update(id, { status: "failed", error: "anchored row has no anchor height" }, now);
        notifyTerminal(deps, p, { ...row, status: "failed" }, "failed");
        return "failed";
      }
      try {
        const attested = await deps.client.isAttested(row.anchor_height);
        if (!attested) {
          // Deliberately does NOT bump attempts: waiting is the expected state, and
          // counting it as a failed attempt would expire healthy rows.
          p.update(id, {}, now);
          return "waiting";
        }
        deps.client.recordAttestationWait(id, row.anchor_height, now - row.created_at);
        p.update(id, { status: "attested", error: null }, now);
        return "advanced";
      } catch (e) {
        return classify(deps, p, row, e, "attestation", now);
      }
    }

    // ---- generate the proof and submit it to Creditcoin ----
    case "attested":
    case "proving": {
      if (!row.anchor_tx_hash) {
        p.update(id, { status: "failed", error: "attested row has no anchor transaction hash" }, now);
        notifyTerminal(deps, p, { ...row, status: "failed" }, "failed");
        return "failed";
      }

      p.update(id, { status: "proving", bumpAttempts: true }, now);
      try {
        const proof = await deps.client.generateProof(id, row.anchor_tx_hash);
        const { txHash, recorded } = await p.submit(row, proof);

        p.update(
          id,
          {
            status: "verified",
            creditcoin_tx_hash: txHash,
            anchor_height: proof.headerNumber,
            verified_at: now,
            error: null,
          },
          now,
        );
        endToEndSeconds.record(now - row.created_at, { pipeline: p.name });

        // Refresh local mirrors so the dashboard reflects this without waiting for a
        // read. Done even when `recorded === 0` (the event was already verified by
        // someone else's proof submission): the local view may still be behind.
        if (recorded === 0) {
          emitAttestcoinError(
            "submit",
            id,
            "proof accepted but recorded 0 new events: this transaction was already verified on-chain",
          );
        }
        if (p.afterVerified) {
          try {
            await p.afterVerified(row, now);
          } catch {
            /* mirrors are best-effort */
          }
        }
        notifyTerminal(deps, p, { ...row, status: "verified" }, "verified");
        return "verified";
      } catch (e) {
        return classify(deps, p, row, e, "proof", now);
      }
    }

    default:
      return "noop";
  }
}

/** Records a stage failure and decides whether the row may be retried. */
function classify<R extends PipelineRow>(
  deps: WorkerDeps,
  p: Pipeline<R>,
  row: R,
  e: unknown,
  stage: string,
  now: number,
): Outcome {
  const id = p.idOf(row);
  const message = e instanceof Error ? e.message : String(e);
  emitAttestcoinError(stage, id, message);

  const permanent = e instanceof AttestcoinError && !e.retryable;
  if (permanent) {
    p.update(id, { status: "failed", error: message }, now);
    verificationFailures.add(1, { stage, pipeline: p.name });
    notifyTerminal(deps, p, { ...row, status: "failed" }, "failed");
    return "failed";
  }

  // Retryable: keep the row where it is and let the next tick try again. The attempt
  // counter was already bumped on entry to the stage, so this cannot loop forever.
  p.update(id, { error: message }, now);
  return "waiting";
}

/** Re-reads a card's payer credit from the ASC into the local cache.
 * Failures are swallowed: a stale cache must never fail a verification that
 * already succeeded on-chain. */
export async function refreshCreditCache(
  deps: WorkerDeps,
  cardId: string,
  now: number,
): Promise<void> {
  const payer = payerForCard(deps.store, cardId);
  if (!payer) return;
  try {
    const credit = await deps.client.getAgentCredit(payer);
    deps.attestcoin.cacheCredit(payer, credit, now);
  } catch {
    /* cache refresh is best-effort */
  }
}

/** Mirrors a line's on-chain state (status, drawn, repaid) into the local row. */
export async function syncLineFromChain(
  deps: { attestcoin: AttestcoinStore; client: AttestcoinClient },
  lineId: string,
  now: number,
): Promise<void> {
  const local = deps.attestcoin.getLine(lineId);
  if (!local) return;
  const onChain = await deps.client.getLine(lineId);
  if (!onChain) return;
  const status = (["proposed", "open", "active", "repaid", "defaulted", "closed"] as const)[onChain.status];
  deps.attestcoin.updateLine(
    lineId,
    {
      status: status && status !== "proposed" ? status : undefined,
      drawn_atoms: onChain.drawn,
      repaid_atoms: onChain.repaid,
    },
    now,
  );
}

/** Registers a card's terms on Creditcoin, recording the outcome locally.
 *
 * Called at issuance. Failures are recorded and swallowed: a card must still be
 * issuable when Creditcoin is unreachable — the registry makes verified payments
 * judgeable, it is not a precondition for spending. */
export async function registerCardTermsOnChain(
  deps: { store: Store; attestcoin: AttestcoinStore; client: AttestcoinClient },
  cardId: string,
  now: number,
): Promise<{ ok: boolean; txHash?: string; error?: string }> {
  const card = deps.store.getCard(cardId);
  if (!card) return { ok: false, error: "no such card" };

  const termsHash = termsHashOf(cardId, card.terms);
  deps.attestcoin.recordTermsRegistration(cardId, termsHash, "pending", now);

  try {
    const period = card.terms.pay?.period;
    const txHash = await deps.client.registerCardTerms({
      cardId,
      termsHash,
      periodBudgetAtoms: period ? usdcStringToAtoms(period.amount) : 0n,
      periodSeconds: period?.seconds ?? 0,
      perTxMaxAtoms: card.terms.perTxMax ? usdcStringToAtoms(card.terms.perTxMax) : 0n,
      expiresAt: card.terms.expiry ?? 0,
    });
    deps.attestcoin.recordTermsRegistration(cardId, termsHash, "confirmed", now, txHash);
    return { ok: true, txHash };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    deps.attestcoin.recordTermsRegistration(cardId, termsHash, "failed", now, null, message);
    emitAttestcoinError("register_terms", cardId, message);
    return { ok: false, error: message };
  }
}

/** The on-chain terms commitment: a hash over the card's id and its full terms.
 *
 * Includes the card id so two cards with identical terms get distinct hashes — a
 * bare terms hash would collide across cards and make the commitment useless for
 * identifying which card's terms were registered. */
export function termsHashOf(cardId: string, terms: unknown): string {
  return cardIdToBytes32(`${cardId}|${stableStringify(terms)}`);
}

/** Key-sorted JSON, so logically identical terms hash identically regardless of the
 * key order `JSON.stringify` happens to emit. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** USDC decimal string -> atoms. Local to avoid importing the spend path's parser
 * (which throws engine refusals) into a background worker. */
function usdcStringToAtoms(s: string): bigint {
  const [whole, frac = ""] = s.split(".");
  const padded = (frac + "000000").slice(0, 6);
  return BigInt(whole || "0") * 1_000_000n + BigInt(padded || "0");
}

/** Re-exported for receipts/tools that render atoms for agents. */
export { atomsToUsdc };
export type { AttestcoinConfig };
