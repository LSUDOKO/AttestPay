// Persistence for the Attestcoin proof pipeline.
//
// The proof lifecycle spans minutes and survives restarts, so its state lives in
// sqlite rather than in memory. It is kept in its own table instead of as columns on
// `charges` for two reasons: not every charge is anchorable (x402 settles through the
// seller, and there is no tx of ours to anchor), and the pipeline needs its own
// retry/attempt bookkeeping that has nothing to do with a charge's own status.
//
// Attaches to the engine's existing Database handle — one file, one connection.

import type { Database } from "bun:sqlite";
import type { ProofRow, ProofStatus } from "./types";

/** Rows the worker should act on next, in FIFO order. */
export type ClaimableStatus = Extract<
  ProofStatus,
  "pending" | "anchoring" | "anchored" | "attested" | "proving"
>;

export class AttestcoinStore {
  constructor(readonly db: Database) {
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS attestcoin_proofs (
        charge_id TEXT PRIMARY KEY REFERENCES charges(id),
        card_id TEXT NOT NULL REFERENCES cards(id),
        status TEXT NOT NULL DEFAULT 'pending',
        anchor_tx_hash TEXT,
        anchor_height INTEGER,
        creditcoin_tx_hash TEXT,
        verified_at INTEGER,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_attestcoin_status
        ON attestcoin_proofs(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_attestcoin_card
        ON attestcoin_proofs(card_id, created_at);

      CREATE TABLE IF NOT EXISTS attestcoin_card_terms (
        card_id TEXT PRIMARY KEY REFERENCES cards(id),
        terms_hash TEXT NOT NULL,
        creditcoin_tx_hash TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        registered_at INTEGER,
        created_at INTEGER NOT NULL
      );

      -- Cache of ASC credit reads, so the dashboard and the credit_score tool can
      -- answer instantly and still work when the Creditcoin RPC is briefly down.
      -- last_synced_at lets a reader say how stale the number is instead of
      -- presenting a cached value as live.
      CREATE TABLE IF NOT EXISTS attestcoin_credit_cache (
        payer_address TEXT PRIMARY KEY,
        total_payments INTEGER NOT NULL DEFAULT 0,
        total_volume TEXT NOT NULL DEFAULT '0',
        first_payment_at INTEGER,
        last_payment_at INTEGER,
        within_terms_payments INTEGER NOT NULL DEFAULT 0,
        terms_checked_payments INTEGER NOT NULL DEFAULT 0,
        last_synced_at INTEGER NOT NULL
      );
    `);
  }

  private static row(r: Record<string, unknown> | null): ProofRow | null {
    if (!r) return null;
    return {
      charge_id: r.charge_id as string,
      card_id: r.card_id as string,
      status: r.status as ProofStatus,
      anchor_tx_hash: (r.anchor_tx_hash as string) ?? null,
      anchor_height: (r.anchor_height as number) ?? null,
      creditcoin_tx_hash: (r.creditcoin_tx_hash as string) ?? null,
      verified_at: (r.verified_at as number) ?? null,
      error: (r.error as string) ?? null,
      attempts: r.attempts as number,
      created_at: r.created_at as number,
      updated_at: r.updated_at as number,
    };
  }

  /** Enqueues a confirmed payment for cross-chain verification.
   *
   * Idempotent: a charge already in the pipeline is left exactly as it is. Without
   * `DO NOTHING` a re-enqueue (reconcile sweep re-confirming a charge, say) would
   * reset an in-flight row to 'pending' and re-anchor an already-anchored payment. */
  enqueue(chargeId: string, cardId: string, now: number): void {
    this.db
      .query(
        `INSERT INTO attestcoin_proofs (charge_id, card_id, status, created_at, updated_at)
         VALUES ($charge, $card, 'pending', $now, $now)
         ON CONFLICT(charge_id) DO NOTHING`,
      )
      .run({ $charge: chargeId, $card: cardId, $now: now });
  }

  get(chargeId: string): ProofRow | null {
    return AttestcoinStore.row(
      this.db
        .query(`SELECT * FROM attestcoin_proofs WHERE charge_id = $c`)
        .get({ $c: chargeId }) as never,
    );
  }

  /** Oldest-first rows in a working state, for the worker to drive forward. */
  claimable(limit: number): ProofRow[] {
    const rows = this.db
      .query(
        `SELECT * FROM attestcoin_proofs
         WHERE status IN ('pending','anchoring','anchored','attested','proving')
         ORDER BY updated_at ASC
         LIMIT $l`,
      )
      .all({ $l: limit }) as never[];
    return rows.map((r) => AttestcoinStore.row(r)!);
  }

  listByCard(cardId: string, limit = 100): ProofRow[] {
    const rows = this.db
      .query(
        `SELECT * FROM attestcoin_proofs WHERE card_id = $c ORDER BY created_at DESC LIMIT $l`,
      )
      .all({ $c: cardId, $l: limit }) as never[];
    return rows.map((r) => AttestcoinStore.row(r)!);
  }

  update(
    chargeId: string,
    fields: {
      status?: ProofStatus;
      anchor_tx_hash?: string | null;
      anchor_height?: number | null;
      creditcoin_tx_hash?: string | null;
      verified_at?: number | null;
      error?: string | null;
      bumpAttempts?: boolean;
    },
    now: number,
  ): void {
    const sets: string[] = ["updated_at = $now"];
    const params: Record<string, unknown> = { $c: chargeId, $now: now };
    if (fields.status !== undefined) {
      sets.push("status = $status");
      params.$status = fields.status;
    }
    if (fields.anchor_tx_hash !== undefined) {
      sets.push("anchor_tx_hash = $atx");
      params.$atx = fields.anchor_tx_hash;
    }
    if (fields.anchor_height !== undefined) {
      sets.push("anchor_height = $ah");
      params.$ah = fields.anchor_height;
    }
    if (fields.creditcoin_tx_hash !== undefined) {
      sets.push("creditcoin_tx_hash = $ctx");
      params.$ctx = fields.creditcoin_tx_hash;
    }
    if (fields.verified_at !== undefined) {
      sets.push("verified_at = $vat");
      params.$vat = fields.verified_at;
    }
    if (fields.error !== undefined) {
      sets.push("error = $err");
      params.$err = fields.error;
    }
    if (fields.bumpAttempts) sets.push("attempts = attempts + 1");

    this.db
      .query(`UPDATE attestcoin_proofs SET ${sets.join(", ")} WHERE charge_id = $c`)
      .run(params as never);
  }

  /** Re-arms a terminally-failed row for another run.
   *
   * Resets the attempt budget as well as the status, because a row parked at
   * MAX_ATTEMPTS would otherwise fail again on the worker's very first look. `error`
   * is cleared only on the row itself; the operator-visible reason lives in the log
   * trail, so nothing is lost. Returns false when the row is absent or not failed —
   * re-arming a healthy in-flight row would restart its anchoring. */
  retryFailed(chargeId: string, now: number): boolean {
    const row = this.get(chargeId);
    if (!row || row.status !== "failed") return false;
    this.db
      .query(
        `UPDATE attestcoin_proofs
            SET status = 'pending', attempts = 0, error = NULL, updated_at = $now
          WHERE charge_id = $c`,
      )
      .run({ $c: chargeId, $now: now });
    return true;
  }

  /** Counts per status — the pipeline's queue depth, for health and dashboards. */
  statusCounts(): Record<ProofStatus, number> {
    const rows = this.db
      .query(`SELECT status, COUNT(*) AS n FROM attestcoin_proofs GROUP BY status`)
      .all() as Array<{ status: ProofStatus; n: number }>;
    const out: Record<ProofStatus, number> = {
      pending: 0,
      anchoring: 0,
      anchored: 0,
      attested: 0,
      proving: 0,
      verified: 0,
      failed: 0,
    };
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  /** Aggregate verification stats for a card, from the local pipeline's view. */
  cardStats(cardId: string): { total: number; verified: number; failed: number; inFlight: number } {
    const rows = this.db
      .query(`SELECT status, COUNT(*) AS n FROM attestcoin_proofs WHERE card_id = $c GROUP BY status`)
      .all({ $c: cardId }) as Array<{ status: ProofStatus; n: number }>;
    let total = 0;
    let verified = 0;
    let failed = 0;
    for (const r of rows) {
      total += r.n;
      if (r.status === "verified") verified += r.n;
      else if (r.status === "failed") failed += r.n;
    }
    return { total, verified, failed, inFlight: total - verified - failed };
  }

  /** Mean seconds from enqueue to verification, over verified rows for a card.
   * Returns null with no verified rows rather than 0 — "no data" and "instant" are
   * different answers and a dashboard must not show the latter for the former. */
  averageVerifySeconds(cardId: string): number | null {
    const r = this.db
      .query(
        `SELECT AVG(verified_at - created_at) AS avg_s
         FROM attestcoin_proofs
         WHERE card_id = $c AND status = 'verified' AND verified_at IS NOT NULL`,
      )
      .get({ $c: cardId }) as { avg_s: number | null };
    return r.avg_s === null ? null : Math.round(r.avg_s);
  }

  // ---- card terms registrations ----

  recordTermsRegistration(
    cardId: string,
    termsHash: string,
    status: "pending" | "confirmed" | "failed",
    now: number,
    creditcoinTxHash?: string | null,
    error?: string | null,
  ): void {
    this.db
      .query(
        `INSERT INTO attestcoin_card_terms
           (card_id, terms_hash, creditcoin_tx_hash, status, error, registered_at, created_at)
         VALUES ($card, $hash, $tx, $status, $err, $reg, $now)
         ON CONFLICT(card_id) DO UPDATE SET
           terms_hash = $hash,
           creditcoin_tx_hash = COALESCE($tx, creditcoin_tx_hash),
           status = $status,
           error = $err,
           registered_at = COALESCE($reg, registered_at)`,
      )
      .run({
        $card: cardId,
        $hash: termsHash,
        $tx: creditcoinTxHash ?? null,
        $status: status,
        $err: error ?? null,
        $reg: status === "confirmed" ? now : null,
        $now: now,
      });
  }

  getTermsRegistration(cardId: string): {
    card_id: string;
    terms_hash: string;
    creditcoin_tx_hash: string | null;
    status: string;
    error: string | null;
    registered_at: number | null;
  } | null {
    return (
      (this.db
        .query(`SELECT * FROM attestcoin_card_terms WHERE card_id = $c`)
        .get({ $c: cardId }) as never) ?? null
    );
  }

  // ---- credit cache ----

  cacheCredit(
    payer: string,
    credit: {
      totalPayments: bigint;
      totalVolume: bigint;
      firstPaymentAt: bigint;
      lastPaymentAt: bigint;
      withinTermsPayments: bigint;
      termsCheckedPayments: bigint;
    },
    now: number,
  ): void {
    this.db
      .query(
        `INSERT INTO attestcoin_credit_cache
           (payer_address, total_payments, total_volume, first_payment_at, last_payment_at,
            within_terms_payments, terms_checked_payments, last_synced_at)
         VALUES ($p, $tp, $tv, $fp, $lp, $wt, $tc, $now)
         ON CONFLICT(payer_address) DO UPDATE SET
           total_payments = $tp, total_volume = $tv, first_payment_at = $fp,
           last_payment_at = $lp, within_terms_payments = $wt,
           terms_checked_payments = $tc, last_synced_at = $now`,
      )
      .run({
        $p: payer.toLowerCase(),
        $tp: Number(credit.totalPayments),
        $tv: credit.totalVolume.toString(),
        $fp: Number(credit.firstPaymentAt),
        $lp: Number(credit.lastPaymentAt),
        $wt: Number(credit.withinTermsPayments),
        $tc: Number(credit.termsCheckedPayments),
        $now: now,
      });
  }

  getCachedCredit(payer: string): {
    totalPayments: bigint;
    totalVolume: bigint;
    firstPaymentAt: bigint;
    lastPaymentAt: bigint;
    withinTermsPayments: bigint;
    termsCheckedPayments: bigint;
    lastSyncedAt: number;
  } | null {
    const r = this.db
      .query(`SELECT * FROM attestcoin_credit_cache WHERE payer_address = $p`)
      .get({ $p: payer.toLowerCase() }) as Record<string, unknown> | null;
    if (!r) return null;
    return {
      totalPayments: BigInt(r.total_payments as number),
      totalVolume: BigInt(r.total_volume as string),
      firstPaymentAt: BigInt((r.first_payment_at as number) ?? 0),
      lastPaymentAt: BigInt((r.last_payment_at as number) ?? 0),
      withinTermsPayments: BigInt(r.within_terms_payments as number),
      termsCheckedPayments: BigInt(r.terms_checked_payments as number),
      lastSyncedAt: r.last_synced_at as number,
    };
  }
}
