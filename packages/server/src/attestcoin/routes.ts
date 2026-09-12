// Dashboard REST surface for the Attestcoin integration.
//
// Mounted under /api, so it inherits that router's auth (admin token OR verified
// Privy session) and its per-user card scoping. Card-scoped routes take an
// `ownedCard` resolver from the parent rather than reaching into the store directly:
// re-implementing ownership here is how one user ends up able to read another's
// payment history.

import { Hono } from "hono";
import type { Context } from "hono";
import { attestcoin as ac, type CardRow } from "@attestpay/engine";
import type { ApiEnv } from "../api/routes";
import type { AppDeps } from "../deps";

/** Resolves a card the caller is allowed to see, or throws the parent router's
 * not-found refusal. Supplied by api/routes.ts — ownership is defined once, there. */
export type OwnedCardResolver = (c: Context<ApiEnv>, id: string, level?: "read" | "control" | "manage") => CardRow;

/** Wraps a handler in the parent router's error mapping. Supplied by api/routes.ts. */
export type Handle = (c: Context<ApiEnv>, fn: () => Promise<unknown>) => Promise<Response>;

/** USDC atoms -> decimal string, for display. */
const usdc = (atoms: bigint): string => (Number(atoms) / 1e6).toFixed(6);

const iso = (sec: number | bigint | null | undefined): string | null => {
  if (sec === null || sec === undefined) return null;
  const n = Number(sec);
  return n === 0 ? null : new Date(n * 1000).toISOString();
};

export function attestcoinRoutes(
  deps: AppDeps,
  ownedCard: OwnedCardResolver,
  handle: Handle,
): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  const now = () => Math.floor(Date.now() / 1000);

  /** The proof store always exists in production wiring; a fake AppDeps may omit it. */
  const store = () => deps.attestcoin?.store ?? null;
  const client = () => deps.attestcoin?.client ?? null;

  // -----------------------------------------------------------------------
  // Per-card proof list
  // -----------------------------------------------------------------------

  // Local pipeline state joined onto the charges it refers to. Served from sqlite,
  // not from Creditcoin: this is the view that must render instantly and must still
  // work when the Creditcoin RPC is down.
  app.get("/cards/:id/attestcoin-proofs", (c) =>
    handle(c, async () => {
      const card = ownedCard(c, c.req.param("id"), "read");
      const s = store();
      if (!s) return { configured: false, items: [], stats: null };

      const cl = client();
      const rows = s.listByCard(card.id, 200);
      const items = rows.map((r) => {
        const charge = deps.store.getCharge(r.charge_id);
        return {
          charge_id: r.charge_id,
          status: r.status,
          amount: charge ? usdc(charge.amount_atoms) : null,
          merchant: charge?.to_addr ?? null,
          memo: charge?.memo ?? null,
          // The original payment on Base.
          source: charge?.tx_hash
            ? {
                tx_hash: charge.tx_hash,
                explorer: ac.baseTxUrl(
                  cl?.config.sourceChainId === 84532 ? 84532 : 8453,
                  charge.tx_hash,
                ),
              }
            : null,
          // The anchor on the attested source chain.
          anchor: r.anchor_tx_hash
            ? {
                tx_hash: r.anchor_tx_hash,
                height: r.anchor_height,
                explorer: cl ? ac.sourceTxUrl(cl, r.anchor_tx_hash) : null,
              }
            : null,
          // The verification on Creditcoin.
          creditcoin: r.creditcoin_tx_hash
            ? {
                tx_hash: r.creditcoin_tx_hash,
                explorer: ac.creditcoinTxUrl(r.creditcoin_tx_hash),
              }
            : null,
          verified_at: iso(r.verified_at),
          error: r.error,
          attempts: r.attempts,
          created_at: iso(r.created_at),
        };
      });

      const stats = s.cardStats(card.id);
      return {
        configured: cl !== null,
        items,
        stats: {
          ...stats,
          avg_verify_seconds: s.averageVerifySeconds(card.id),
        },
      };
    }),
  );

  // A single proof's detail, including what the ASC itself holds. Falls back to the
  // local row when Creditcoin is unreachable rather than failing the request.
  app.get("/cards/:id/attestcoin-proofs/:chargeId", (c) =>
    handle(c, async () => {
      const card = ownedCard(c, c.req.param("id"), "read");
      const s = store();
      const row = s?.get(c.req.param("chargeId"));
      if (!row || row.card_id !== card.id) {
        return { found: false };
      }
      const charge = deps.store.getCharge(row.charge_id);
      const cl = client();

      let onChain: unknown = null;
      let onChainError: string | null = null;
      if (cl && row.status === "verified") {
        try {
          const payments = await cl.getCardPayments(card.id, 0, 100);
          const match = payments.find(
            (p) => charge?.tx_hash && p.sourceTxHash.toLowerCase() === charge.tx_hash.toLowerCase(),
          );
          onChain = match
            ? {
                amount: usdc(match.amount),
                payer: match.payer,
                merchant: match.merchant,
                source_chain_id: Number(match.sourceChainId),
                source_tx_hash: match.sourceTxHash,
                paid_at: iso(match.paidAt),
                anchor_height: Number(match.anchorHeight),
                verified_at: iso(match.verifiedAt),
                memo: match.memo,
              }
            : null;
        } catch (e) {
          onChainError = e instanceof Error ? e.message : String(e);
        }
      }

      return {
        found: true,
        charge_id: row.charge_id,
        status: row.status,
        anchor_tx_hash: row.anchor_tx_hash,
        anchor_height: row.anchor_height,
        creditcoin_tx_hash: row.creditcoin_tx_hash,
        verified_at: iso(row.verified_at),
        attempts: row.attempts,
        error: row.error,
        proof_type: "Merkle inclusion + block continuity (Attestcoin Protocol)",
        on_chain: onChain,
        on_chain_error: onChainError,
      };
    }),
  );

  // -----------------------------------------------------------------------
  // Manual verification kick
  // -----------------------------------------------------------------------

  // Re-enqueues a charge, and resets a 'failed' row so an operator can retry after
  // fixing whatever broke. Does NOT run the pipeline inline — the worker picks it up
  // on its next tick, keeping one code path for all verification.
  app.post("/cards/:id/attestcoin-verify", (c) =>
    handle(c, async () => {
      const card = ownedCard(c, c.req.param("id"), "control");
      const s = store();
      const cl = client();
      if (!s || !cl) {
        return { queued: false, reason: ac.attestcoinDisabledReason() ?? "not configured" };
      }

      const body = (await c.req.json().catch(() => ({}))) as { charge_id?: string };
      if (!body.charge_id) return { queued: false, reason: "charge_id required" };

      const charge = deps.store.getCharge(body.charge_id);
      if (!charge || charge.card_id !== card.id) {
        return { queued: false, reason: "no such charge on this card" };
      }
      if (charge.status !== "confirmed") {
        return {
          queued: false,
          reason: `charge is '${charge.status}'; only a confirmed payment can be anchored`,
        };
      }

      const existing = s.get(body.charge_id);
      if (existing?.status === "verified") {
        return { queued: false, reason: "already verified", creditcoin_tx_hash: existing.creditcoin_tx_hash };
      }

      s.enqueue(body.charge_id, card.id, now());
      // A previously failed row needs its attempt budget reset, not just its status,
      // or the worker gives up again on its first look.
      const rearmed = existing?.status === "failed" ? s.retryFailed(body.charge_id, now()) : false;
      return { queued: true, charge_id: body.charge_id, retried_after_failure: rearmed };
    }),
  );

  // -----------------------------------------------------------------------
  // Credit score
  // -----------------------------------------------------------------------

  app.get("/cards/:id/credit-score", (c) =>
    handle(c, async () => {
      const card = ownedCard(c, c.req.param("id"), "read");
      const s = store();
      const cl = client();
      if (!s || !cl) {
        return { configured: false, reason: ac.attestcoinDisabledReason() ?? "not configured" };
      }

      const payer = ac.payerForCard(deps.store, card.id);
      if (!payer) return { configured: true, error: "card has no resolvable funding account" };

      // Live read preferred; cache is the fallback, and the response always says
      // which one it is so a stale number is never shown as live.
      let credit: Awaited<ReturnType<typeof cl.getAgentCredit>> | null = null;
      let live = true;
      let syncedAt: number | null = null;
      try {
        credit = await cl.getAgentCredit(payer);
        s.cacheCredit(payer, credit, now());
        syncedAt = now();
      } catch {
        const cached = s.getCachedCredit(payer);
        if (cached) {
          credit = cached;
          live = false;
          syncedAt = cached.lastSyncedAt;
        }
      }
      if (!credit) {
        return { configured: true, error: "credit unavailable (Creditcoin unreachable and no cached value)" };
      }

      const grade = ac.creditGrade(credit);
      return {
        configured: true,
        live,
        synced_at: iso(syncedAt),
        payer,
        grade: grade.grade,
        score: grade.score,
        basis: grade.basis,
        total_verified_payments: Number(credit.totalPayments),
        total_verified_volume: usdc(credit.totalVolume),
        first_payment_at: iso(credit.firstPaymentAt),
        last_payment_at: iso(credit.lastPaymentAt),
        within_terms_payments: Number(credit.withinTermsPayments),
        terms_checked_payments: Number(credit.termsCheckedPayments),
        asc_explorer: ac.creditcoinAddressUrl(cl.config.ascAddress),
      };
    }),
  );

  // -----------------------------------------------------------------------
  // Protocol health + aggregate stats
  // -----------------------------------------------------------------------

  app.get("/attestcoin/health", (c) =>
    handle(c, async () => {
      const s = store();
      const cl = client();
      if (!cl) return ac.attestcoinDisabledHealth(s ?? undefined);
      return ac.attestcoinHealth(cl, s!);
    }),
  );

  app.get("/attestcoin/stats", (c) =>
    handle(c, async () => {
      const s = store();
      const cl = client();
      if (!s) return { configured: false, queue: null };

      const queue = s.statusCounts();
      const total = Object.values(queue).reduce((a, b) => a + b, 0);
      return {
        configured: cl !== null,
        chain_key: cl?.config.chainKey ?? null,
        source_chain_id: cl?.config.sourceChainId ?? null,
        creditcoin_chain_id: cl?.config.creditcoinChainId ?? null,
        asc_address: cl?.config.ascAddress ?? null,
        anchor_address: cl?.config.anchorAddress ?? null,
        anchorer_address: cl?.anchorerAddress ?? null,
        asc_explorer: cl ? ac.creditcoinAddressUrl(cl.config.ascAddress) : null,
        queue,
        total_enqueued: total,
        // A verification rate over an empty set is meaningless, so it is null rather
        // than a misleading 0% or 100%.
        verification_rate:
          total > 0 ? `${((queue.verified / total) * 100).toFixed(1)}%` : null,
      };
    }),
  );

  return app;
}
