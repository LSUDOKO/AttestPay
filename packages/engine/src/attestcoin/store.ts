// Persistence for the Attestcoin proof pipeline.
//
// The proof lifecycle spans minutes and survives restarts, so its state lives in
// sqlite rather than in memory. It is kept in its own table instead of as columns on
// `charges` for two reasons: not every charge is anchorable (x402 settles through the
// seller, and there is no tx of ours to anchor), and the pipeline needs its own
// retry/attempt bookkeeping that has nothing to do with a charge's own status.
//
// Facts (draws, repayments, disputes, revocations) get a sibling table with the same
// lifecycle columns, plus the local mirrors of credit lines and disputes that the
// dashboard and the API read without touching Creditcoin.
//
// Attaches to the engine's existing Database handle — one file, one connection.

import type { Database } from "bun:sqlite";
import type { Address, Hex } from "viem";
import type {
  CreditLineEventRow,
  CreditLineRow,
  CreditLineStatus,
  DisputeRow,
  DisputeStatus,
  FactKind,
  FactPayload,
  FactRow,
  FactTarget,
  ProofRow,
  ProofStatus,
} from "./types";
import { FACT_TARGETS } from "./types";

/** Rows the worker should act on next, in FIFO order. */
export type ClaimableStatus = Extract<
  ProofStatus,
  "pending" | "anchoring" | "anchored" | "attested" | "proving"
>;

/** The lifecycle columns every pipeline row shares; `update` writes exactly these. */
export type PipelineUpdate = {
  status?: ProofStatus;
  anchor_tx_hash?: string | null;
  anchor_height?: number | null;
  creditcoin_tx_hash?: string | null;
  verified_at?: number | null;
  error?: string | null;
  bumpAttempts?: boolean;
};

const EMPTY_COUNTS = (): Record<ProofStatus, number> => ({
  pending: 0,
  anchoring: 0,
  anchored: 0,
  attested: 0,
  proving: 0,
  verified: 0,
  failed: 0,
});

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

      -- Facts proven through FactAnchor: same lifecycle as payments, different anchor
      -- and consumer. payload_json holds the exact anchor arguments so the worker
      -- never has to re-derive them from mutable rows.
      CREATE TABLE IF NOT EXISTS attestcoin_facts (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        card_id TEXT,
        payload_json TEXT NOT NULL,
        target TEXT NOT NULL,
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
      CREATE INDEX IF NOT EXISTS idx_attestcoin_facts_status ON attestcoin_facts(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_attestcoin_facts_ref ON attestcoin_facts(ref_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_attestcoin_facts_card ON attestcoin_facts(card_id, created_at);

      -- Local mirror of credit lines. The id is the EIP-712 struct hash, so it is the
      -- same id on Creditcoin from the moment the terms are drafted.
      CREATE TABLE IF NOT EXISTS credit_lines (
        id TEXT PRIMARY KEY,
        lender_user_id TEXT NOT NULL,
        lender_address TEXT NOT NULL,
        borrower_address TEXT NOT NULL,
        borrower_card_id TEXT,
        funding_card_id TEXT NOT NULL,
        limit_atoms TEXT NOT NULL,
        interest_bps INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        nonce TEXT NOT NULL,
        lender_sig TEXT,
        borrower_sig TEXT,
        status TEXT NOT NULL DEFAULT 'proposed',
        creditcoin_tx_hash TEXT,
        error TEXT,
        drawn_atoms TEXT NOT NULL DEFAULT '0',
        repaid_atoms TEXT NOT NULL DEFAULT '0',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_credit_lines_lender ON credit_lines(lender_user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_credit_lines_borrower ON credit_lines(borrower_address, created_at);
      CREATE INDEX IF NOT EXISTS idx_credit_lines_card ON credit_lines(borrower_card_id, created_at);

      -- Every draw/repayment is a charge; this joins them to their line so the
      -- confirmed-charge hook knows which facts to enqueue.
      CREATE TABLE IF NOT EXISTS credit_line_events (
        id TEXT PRIMARY KEY,
        line_id TEXT NOT NULL REFERENCES credit_lines(id),
        kind TEXT NOT NULL,
        charge_id TEXT NOT NULL UNIQUE,
        amount_atoms TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_credit_line_events_line ON credit_line_events(line_id, created_at);

      CREATE TABLE IF NOT EXISTS disputes (
        id TEXT PRIMARY KEY,
        charge_id TEXT NOT NULL REFERENCES charges(id),
        card_id TEXT NOT NULL REFERENCES cards(id),
        opened_by_user_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        resolution_note TEXT,
        resolved_by TEXT,
        opened_at INTEGER NOT NULL,
        resolved_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_disputes_card ON disputes(card_id, opened_at);
      CREATE INDEX IF NOT EXISTS idx_disputes_charge ON disputes(charge_id);
      CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status, opened_at);
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

  update(chargeId: string, fields: PipelineUpdate, now: number): void {
    this.applyUpdate("attestcoin_proofs", "charge_id", chargeId, fields, now);
  }

  /** The one UPDATE builder both pipeline tables share. */
  private applyUpdate(table: string, key: string, id: string, fields: PipelineUpdate, now: number): void {
    const sets: string[] = ["updated_at = $now"];
    const params: Record<string, unknown> = { $c: id, $now: now };
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

    this.db.query(`UPDATE ${table} SET ${sets.join(", ")} WHERE ${key} = $c`).run(params as never);
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
    const out = EMPTY_COUNTS();
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

  // =========================================================================
  // Facts
  // =========================================================================

  private static factRow(r: Record<string, unknown> | null): FactRow | null {
    if (!r) return null;
    return {
      id: r.id as string,
      kind: r.kind as FactKind,
      ref_id: r.ref_id as string,
      card_id: (r.card_id as string) ?? null,
      payload: JSON.parse(r.payload_json as string) as FactPayload,
      target: r.target as FactTarget,
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

  /** Enqueues a fact. Idempotent on `id`, like payments: the same fact proposed twice
   * (a reconcile sweep re-confirming a draw's charge) is left where it is. */
  enqueueFact(
    fact: { id: string; kind: FactKind; refId: string; cardId: string | null; payload: FactPayload },
    now: number,
  ): void {
    this.db
      .query(
        `INSERT INTO attestcoin_facts (id, kind, ref_id, card_id, payload_json, target, status, created_at, updated_at)
         VALUES ($id, $kind, $ref, $card, $payload, $target, 'pending', $now, $now)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run({
        $id: fact.id,
        $kind: fact.kind,
        $ref: fact.refId,
        $card: fact.cardId,
        $payload: JSON.stringify(fact.payload),
        $target: FACT_TARGETS[fact.kind],
        $now: now,
      });
  }

  getFact(id: string): FactRow | null {
    return AttestcoinStore.factRow(this.db.query(`SELECT * FROM attestcoin_facts WHERE id = $id`).get({ $id: id }) as never);
  }

  claimableFacts(limit: number): FactRow[] {
    const rows = this.db
      .query(
        `SELECT * FROM attestcoin_facts
         WHERE status IN ('pending','anchoring','anchored','attested','proving')
         ORDER BY updated_at ASC LIMIT $l`,
      )
      .all({ $l: limit }) as never[];
    return rows.map((r) => AttestcoinStore.factRow(r)!);
  }

  listFactsByRef(refId: string): FactRow[] {
    const rows = this.db
      .query(`SELECT * FROM attestcoin_facts WHERE ref_id = $r ORDER BY created_at ASC`)
      .all({ $r: refId }) as never[];
    return rows.map((r) => AttestcoinStore.factRow(r)!);
  }

  listFactsByCard(cardId: string, limit = 100): FactRow[] {
    const rows = this.db
      .query(`SELECT * FROM attestcoin_facts WHERE card_id = $c ORDER BY created_at DESC LIMIT $l`)
      .all({ $c: cardId, $l: limit }) as never[];
    return rows.map((r) => AttestcoinStore.factRow(r)!);
  }

  updateFact(id: string, fields: PipelineUpdate, now: number): void {
    this.applyUpdate("attestcoin_facts", "id", id, fields, now);
  }

  retryFailedFact(id: string, now: number): boolean {
    const row = this.getFact(id);
    if (!row || row.status !== "failed") return false;
    this.db
      .query(`UPDATE attestcoin_facts SET status = 'pending', attempts = 0, error = NULL, updated_at = $now WHERE id = $c`)
      .run({ $c: id, $now: now });
    return true;
  }

  factStatusCounts(): Record<ProofStatus, number> {
    const rows = this.db
      .query(`SELECT status, COUNT(*) AS n FROM attestcoin_facts GROUP BY status`)
      .all() as Array<{ status: ProofStatus; n: number }>;
    const out = EMPTY_COUNTS();
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  // =========================================================================
  // Credit lines
  // =========================================================================

  private static lineRow(r: Record<string, unknown> | null): CreditLineRow | null {
    if (!r) return null;
    return {
      id: r.id as Hex,
      lender_user_id: r.lender_user_id as string,
      lender_address: r.lender_address as Address,
      borrower_address: r.borrower_address as Address,
      borrower_card_id: (r.borrower_card_id as string) ?? null,
      funding_card_id: r.funding_card_id as string,
      limit_atoms: BigInt(r.limit_atoms as string),
      interest_bps: r.interest_bps as number,
      expires_at: r.expires_at as number,
      nonce: BigInt(r.nonce as string),
      lender_sig: (r.lender_sig as Hex) ?? null,
      borrower_sig: (r.borrower_sig as Hex) ?? null,
      status: r.status as CreditLineStatus,
      creditcoin_tx_hash: (r.creditcoin_tx_hash as string) ?? null,
      error: (r.error as string) ?? null,
      drawn_atoms: BigInt(r.drawn_atoms as string),
      repaid_atoms: BigInt(r.repaid_atoms as string),
      created_at: r.created_at as number,
      updated_at: r.updated_at as number,
    };
  }

  createLine(line: CreditLineRow): void {
    this.db
      .query(
        `INSERT INTO credit_lines
           (id, lender_user_id, lender_address, borrower_address, borrower_card_id, funding_card_id,
            limit_atoms, interest_bps, expires_at, nonce, lender_sig, borrower_sig, status,
            creditcoin_tx_hash, error, drawn_atoms, repaid_atoms, created_at, updated_at)
         VALUES ($id, $lu, $la, $ba, $bc, $fc, $limit, $bps, $exp, $nonce, $ls, $bs, $status,
                 $tx, $err, $drawn, $repaid, $created, $updated)`,
      )
      .run({
        $id: line.id,
        $lu: line.lender_user_id,
        $la: line.lender_address,
        $ba: line.borrower_address,
        $bc: line.borrower_card_id,
        $fc: line.funding_card_id,
        $limit: line.limit_atoms.toString(),
        $bps: line.interest_bps,
        $exp: line.expires_at,
        $nonce: line.nonce.toString(),
        $ls: line.lender_sig,
        $bs: line.borrower_sig,
        $status: line.status,
        $tx: line.creditcoin_tx_hash,
        $err: line.error,
        $drawn: line.drawn_atoms.toString(),
        $repaid: line.repaid_atoms.toString(),
        $created: line.created_at,
        $updated: line.updated_at,
      });
  }

  getLine(id: string): CreditLineRow | null {
    return AttestcoinStore.lineRow(this.db.query(`SELECT * FROM credit_lines WHERE id = $id`).get({ $id: id }) as never);
  }

  /** Lines a user lends on. */
  listLinesByLender(userId: string): CreditLineRow[] {
    const rows = this.db
      .query(`SELECT * FROM credit_lines WHERE lender_user_id = $u ORDER BY created_at DESC`)
      .all({ $u: userId }) as never[];
    return rows.map((r) => AttestcoinStore.lineRow(r)!);
  }

  /** Lines a funding account borrows on. */
  listLinesByBorrower(address: string): CreditLineRow[] {
    const rows = this.db
      .query(`SELECT * FROM credit_lines WHERE borrower_address = $a COLLATE NOCASE ORDER BY created_at DESC`)
      .all({ $a: address }) as never[];
    return rows.map((r) => AttestcoinStore.lineRow(r)!);
  }

  /** Lines whose registration is queued (both signatures present). */
  linesAwaitingOpen(limit = 10): CreditLineRow[] {
    const rows = this.db
      .query(`SELECT * FROM credit_lines WHERE status = 'signed' ORDER BY updated_at ASC LIMIT $l`)
      .all({ $l: limit }) as never[];
    return rows.map((r) => AttestcoinStore.lineRow(r)!);
  }

  /** Lines that may need a time-based transition on-chain. */
  linesPastExpiry(now: number, limit = 20): CreditLineRow[] {
    const rows = this.db
      .query(
        `SELECT * FROM credit_lines WHERE status IN ('open','active') AND expires_at < $now ORDER BY expires_at ASC LIMIT $l`,
      )
      .all({ $now: now, $l: limit }) as never[];
    return rows.map((r) => AttestcoinStore.lineRow(r)!);
  }

  updateLine(
    id: string,
    fields: {
      status?: CreditLineStatus;
      lender_sig?: Hex | null;
      borrower_sig?: Hex | null;
      creditcoin_tx_hash?: string | null;
      error?: string | null;
      drawn_atoms?: bigint;
      repaid_atoms?: bigint;
      borrower_card_id?: string | null;
    },
    now: number,
  ): void {
    const sets: string[] = ["updated_at = $now"];
    const params: Record<string, unknown> = { $id: id, $now: now };
    if (fields.status !== undefined) {
      sets.push("status = $status");
      params.$status = fields.status;
    }
    if (fields.lender_sig !== undefined) {
      sets.push("lender_sig = $ls");
      params.$ls = fields.lender_sig;
    }
    if (fields.borrower_sig !== undefined) {
      sets.push("borrower_sig = $bs");
      params.$bs = fields.borrower_sig;
    }
    if (fields.creditcoin_tx_hash !== undefined) {
      sets.push("creditcoin_tx_hash = $tx");
      params.$tx = fields.creditcoin_tx_hash;
    }
    if (fields.error !== undefined) {
      sets.push("error = $err");
      params.$err = fields.error;
    }
    if (fields.drawn_atoms !== undefined) {
      sets.push("drawn_atoms = $drawn");
      params.$drawn = fields.drawn_atoms.toString();
    }
    if (fields.repaid_atoms !== undefined) {
      sets.push("repaid_atoms = $repaid");
      params.$repaid = fields.repaid_atoms.toString();
    }
    if (fields.borrower_card_id !== undefined) {
      sets.push("borrower_card_id = $bc");
      params.$bc = fields.borrower_card_id;
    }
    this.db.query(`UPDATE credit_lines SET ${sets.join(", ")} WHERE id = $id`).run(params as never);
  }

  addLineEvent(ev: CreditLineEventRow): void {
    this.db
      .query(
        `INSERT INTO credit_line_events (id, line_id, kind, charge_id, amount_atoms, created_at)
         VALUES ($id, $line, $kind, $charge, $amount, $now)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run({
        $id: ev.id,
        $line: ev.line_id,
        $kind: ev.kind,
        $charge: ev.charge_id,
        $amount: ev.amount_atoms.toString(),
        $now: ev.created_at,
      });
  }

  private static eventRow(r: Record<string, unknown> | null): CreditLineEventRow | null {
    if (!r) return null;
    return {
      id: r.id as string,
      line_id: r.line_id as Hex,
      kind: r.kind as "draw" | "repayment",
      charge_id: r.charge_id as string,
      amount_atoms: BigInt(r.amount_atoms as string),
      created_at: r.created_at as number,
    };
  }

  getLineEventByCharge(chargeId: string): CreditLineEventRow | null {
    return AttestcoinStore.eventRow(
      this.db.query(`SELECT * FROM credit_line_events WHERE charge_id = $c`).get({ $c: chargeId }) as never,
    );
  }

  listLineEvents(lineId: string): CreditLineEventRow[] {
    const rows = this.db
      .query(`SELECT * FROM credit_line_events WHERE line_id = $l ORDER BY created_at ASC`)
      .all({ $l: lineId }) as never[];
    return rows.map((r) => AttestcoinStore.eventRow(r)!);
  }

  // =========================================================================
  // Disputes
  // =========================================================================

  private static disputeRow(r: Record<string, unknown> | null): DisputeRow | null {
    if (!r) return null;
    return {
      id: r.id as string,
      charge_id: r.charge_id as string,
      card_id: r.card_id as string,
      opened_by_user_id: r.opened_by_user_id as string,
      reason: r.reason as string,
      status: r.status as DisputeStatus,
      resolution_note: (r.resolution_note as string) ?? null,
      resolved_by: (r.resolved_by as string) ?? null,
      opened_at: r.opened_at as number,
      resolved_at: (r.resolved_at as number) ?? null,
    };
  }

  createDispute(d: DisputeRow): void {
    this.db
      .query(
        `INSERT INTO disputes (id, charge_id, card_id, opened_by_user_id, reason, status, resolution_note, resolved_by, opened_at, resolved_at)
         VALUES ($id, $charge, $card, $by, $reason, $status, $note, $rby, $opened, $resolved)`,
      )
      .run({
        $id: d.id,
        $charge: d.charge_id,
        $card: d.card_id,
        $by: d.opened_by_user_id,
        $reason: d.reason,
        $status: d.status,
        $note: d.resolution_note,
        $rby: d.resolved_by,
        $opened: d.opened_at,
        $resolved: d.resolved_at,
      });
  }

  getDispute(id: string): DisputeRow | null {
    return AttestcoinStore.disputeRow(this.db.query(`SELECT * FROM disputes WHERE id = $id`).get({ $id: id }) as never);
  }

  /** The live dispute on a charge, if any: one open dispute per payment. */
  openDisputeForCharge(chargeId: string): DisputeRow | null {
    return AttestcoinStore.disputeRow(
      this.db.query(`SELECT * FROM disputes WHERE charge_id = $c AND status = 'open'`).get({ $c: chargeId }) as never,
    );
  }

  listDisputesByCard(cardId: string, limit = 100): DisputeRow[] {
    const rows = this.db
      .query(`SELECT * FROM disputes WHERE card_id = $c ORDER BY opened_at DESC LIMIT $l`)
      .all({ $c: cardId, $l: limit }) as never[];
    return rows.map((r) => AttestcoinStore.disputeRow(r)!);
  }

  listDisputes(status: DisputeStatus | null, limit = 200): DisputeRow[] {
    const rows = status
      ? (this.db
          .query(`SELECT * FROM disputes WHERE status = $s ORDER BY opened_at DESC LIMIT $l`)
          .all({ $s: status, $l: limit }) as never[])
      : (this.db.query(`SELECT * FROM disputes ORDER BY opened_at DESC LIMIT $l`).all({ $l: limit }) as never[]);
    return rows.map((r) => AttestcoinStore.disputeRow(r)!);
  }

  resolveDispute(id: string, status: Exclude<DisputeStatus, "open">, note: string | null, by: string, now: number): void {
    this.db
      .query(
        `UPDATE disputes SET status = $s, resolution_note = $note, resolved_by = $by, resolved_at = $now
         WHERE id = $id AND status = 'open'`,
      )
      .run({ $s: status, $note: note, $by: by, $now: now, $id: id });
  }
}
