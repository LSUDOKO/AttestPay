// Stripe Issuing real-time authorization webhook (SIMULATED Visa leg, test-mode-only
// forever — locked). The HARD constraint: synchronous {"approved": bool} within a
// 2-SECOND window, decided ENTIRELY from the local card snapshot. NEVER an RPC call
// in this handler.
//
// Mapping: the Issuing card carries metadata.remit_card_id; an approved authorization
// records a "fiat" charge against the SAME card budget the on-chain delegation governs
// ("one delegation, crypto leg AND Visa leg"). USD cents -> USDC atoms x10^4.
// ATTESTPAY_FIAT_SETTLEMENT=1: the approved row starts "pending" and a settlement executor
// drives it through spend() (real delegated USDC transfer to the settlement address);
// off, it is booked "confirmed" immediately (fee-less, no chain leg).
//
// Signature verification: stripe-signature header (t=...,v1=HMAC-SHA256(`${t}.${body}`))
// via WebCrypto; secret in ATTESTPAY_STRIPE_WEBHOOK_SECRET.

import { trace } from "@opentelemetry/api";
import { Hono } from "hono";
import type { Address } from "viem";
import { FEE_COLLECTOR, cardState, periodWindow, usdcToAtoms, usdcSpentTotal, emitChargeLog, type Store } from "@attestpay/engine";
import type { AppDeps } from "../deps";
import { recordFiatDecision } from "./decisions";

const tracer = trace.getTracer("attestpay-server");

const STRIPE_VERSION = "2025-03-31.basil";
const TOLERANCE_S = 300;
/** USDC reserved for the settlement relayer fee in the authorization decision */
const FIAT_FEE_HEADROOM_DEFAULT = "0.02";

// ---------------------------------------------------------------------------
// signature verification (WebCrypto, no stripe SDK)
// ---------------------------------------------------------------------------

export async function verifyStripeSignature(
  body: string,
  header: string | undefined,
  secret: string,
  nowS = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(",").map((kv) => kv.split("=", 2) as [string, string]),
  ) as Record<string, string>;
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(nowS - t) > TOLERANCE_S) return false;
  const v1 = parts.v1;
  if (!v1) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${parts.t}.${body}`)));
  const expected = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  // constant-time-ish compare
  if (expected.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// the 2s decision (cache-only)
// ---------------------------------------------------------------------------

export function decideAuthorization(
  store: Store,
  remitCardId: string,
  amountCents: number,
  nowS: number,
  opts: { feeHeadroomAtoms?: bigint } = {},
): { approved: boolean; reason: string } {
  // Walk the WHOLE ancestor chain (leaf first, root last) exactly like spend.ts: a
  // sub-card's Visa charge must respect every ancestor's freeze, expiry, and budget,
  // not just the mapped card's. ancestorChain reads only local rows, so this stays
  // inside Stripe's 2s window (no RPC).
  const chain = store.ancestorChain(remitCardId);
  if (chain.length === 0) return { approved: false, reason: "unknown_card" };

  const amountAtoms = BigInt(amountCents) * 10_000n; // cents -> 6-dec atoms
  // settlement mode reserves headroom for the on-chain settlement fee: the budget must
  // fit amount + fee or the settlement leg would overdraw what the decision approved
  const headroomAtoms = opts.feeHeadroomAtoms ?? 0n;
  for (const card of chain) {
    const isLeaf = card.id === remitCardId;
    if (card.status !== "active") {
      return { approved: false, reason: isLeaf ? `card_${card.status}` : `ancestor_${card.status}` };
    }
    if (card.terms.expiry !== undefined && nowS >= card.terms.expiry) {
      return { approved: false, reason: isLeaf ? "card_expired" : "ancestor_expired" };
    }
    // a merchant whitelist is an on-chain RECIPIENT pin; a card-network merchant name
    // can never satisfy it, so a merchant-scoped card (or ancestor) declines all Visa
    if (card.compiled.carvePolicy.merchants !== null) {
      return { approved: false, reason: "merchant_scoped_card" };
    }
    if (card.compiled.carvePolicy.perTxMaxAtoms !== null && amountAtoms > card.compiled.carvePolicy.perTxMaxAtoms) {
      return { approved: false, reason: "per_tx_exceeded" };
    }
    // uses (limitedCalls mirror, same walk as spend.ts): a maxUses card must not keep
    // approving Visa charges after the redemption cap the rest of the system enforces
    if (card.terms.maxUses !== undefined && store.subtreeUsesCount(card.id) >= card.terms.maxUses) {
      return { approved: false, reason: "uses_exhausted" };
    }
    const pay = card.terms.pay;
    if (!pay) {
      // the mapped card itself must be spendable; a pay-less ANCESTOR (contract-only)
      // imposes no budget and is skipped (status/expiry above still bind it).
      if (isLeaf) return { approved: false, reason: "no_pay_capability" };
      continue;
    }
    if (pay.period && card.compiled.periodStartDate !== null) {
      const w = periodWindow(card.compiled.periodStartDate, pay.period.seconds, nowS);
      const spent = store.subtreeSpentSince(card.id, w.start);
      if (spent + amountAtoms + headroomAtoms > usdcToAtoms(pay.period.amount)) {
        return { approved: false, reason: "over_period_limit" };
      }
    }
    if (pay.lifetime) {
      const spent = store.subtreeSpentLifetime(card.id);
      if (spent + amountAtoms + headroomAtoms > usdcToAtoms(pay.lifetime.amount)) {
        return { approved: false, reason: "over_lifetime_limit" };
      }
    }
  }
  return { approved: true, reason: "in_budget" };
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

export function stripeRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.post("/stripe/webhook", async (c) => {
    const secret = process.env.ATTESTPAY_STRIPE_WEBHOOK_SECRET;
    if (!secret) return c.json({ error: "webhook not configured" }, 503);
    const body = await c.req.text();
    if (!(await verifyStripeSignature(body, c.req.header("stripe-signature"), secret))) {
      return c.json({ error: "bad signature" }, 400);
    }

    const event = JSON.parse(body) as {
      type: string;
      data: {
        object: {
          id: string;
          amount?: number;
          currency?: string;
          pending_request?: { amount?: number; currency?: string } | null;
          card?: { id?: string; metadata?: Record<string, string> } | null;
          merchant_data?: { name?: string | null } | null;
        };
      };
    };

    if (event.type !== "issuing_authorization.request") {
      return c.json({ received: true }); // other events: ack only
    }

    return tracer.startActiveSpan("stripe_webhook_auth", async (span) => {
      const auth = event.data.object;
      const nowS = Math.floor(Date.now() / 1000);
      const remitCardId = auth.card?.metadata?.remit_card_id;
      const currency = auth.pending_request?.currency ?? auth.currency ?? "usd";
      const amountCentsRaw = auth.pending_request?.amount ?? auth.amount;
      const amountCents = amountCentsRaw ?? 0;

      span.setAttribute("stripe.charge_id", auth.id);
      span.setAttribute("card_id", remitCardId ?? "unknown");
      span.setAttribute("latency_critical", true);

      // settlement mode: approved charges become pending "fiat" rows a settlement
      // executor drives through the spend pipeline (real delegated transfer). Off:
      // approved charges are booked confirmed immediately (simulated leg, no chain).
      // The EXECUTOR'S EXISTENCE is the single source of truth: deriving this from the
      // env per-request could book pending rows that nothing ever drives.
      const settlementOn = !!deps.fiatSettler;
      let headroomAtoms = 0n;
      if (settlementOn) {
        try {
          headroomAtoms = usdcToAtoms(process.env.ATTESTPAY_FIAT_FEE_HEADROOM || FIAT_FEE_HEADROOM_DEFAULT);
        } catch {
          headroomAtoms = usdcToAtoms(FIAT_FEE_HEADROOM_DEFAULT);
        }
      }

      let approved = false;
      let reason = "no_remit_card_mapping";
      if (currency !== "usd") {
        reason = "unsupported_currency";
      } else if (amountCentsRaw === undefined || !Number.isInteger(amountCentsRaw) || amountCentsRaw < 0) {
        reason = "invalid_amount";
      } else if (remitCardId && deps.store.chargeByIdempotency(remitCardId, `stripe-${auth.id}`)) {
        approved = true;
        reason = "duplicate_delivery";
      } else if (remitCardId) {
        const decision = decideAuthorization(deps.store, remitCardId, amountCents, nowS, {
          feeHeadroomAtoms: headroomAtoms,
        });
        approved = decision.approved;
        reason = decision.reason;

        if (approved) {
          const merchant = auth.merchant_data?.name;
          const chargeId = crypto.randomUUID();
          try {
            deps.store.insertCharge({
              id: chargeId,
              card_id: remitCardId,
              idempotency_key: `stripe-${auth.id}`,
              kind: "fiat",
              to_addr: settlementOn
                ? ((process.env.ATTESTPAY_SETTLEMENT_ADDRESS as Address | undefined) || FEE_COLLECTOR)
                : null,
              amount_atoms: BigInt(amountCents) * 10_000n,
              fee_atoms: settlementOn ? headroomAtoms : 0n,
              request_id: settlementOn ? null : auth.id,
              tx_hash: null,
              status: settlementOn ? "pending" : "confirmed",
              memo: `visa · ${merchant ? `${merchant} · ` : ""}${auth.id} (${reason})`,
              created_at: nowS,
            });
            if (settlementOn) {
              setTimeout(() => {
                deps.fiatSettler?.settle(chargeId).catch((e) => {
                  console.error(`[stripe] settlement kickoff failed for ${chargeId}: ${e instanceof Error ? e.message : String(e)}`);
                });
              }, 0);
            } else {
              usdcSpentTotal.add(amountCents / 100);
              emitChargeLog("confirmed", remitCardId, (amountCents / 100).toFixed(2), "fiat");
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (/UNIQUE constraint failed/i.test(msg)) {
            } else {
              approved = false;
              reason = "persist_failed";
              console.error(`[stripe] charge persist failed for ${auth.id}: ${msg}`);
            }
          }
        }
      }

      recordFiatDecision(auth.id, { approved, reason, cardId: remitCardId ?? null });
      console.log(`[stripe] issuing_authorization.request ${auth.id}: ${approved ? "APPROVE" : "DECLINE"} (${reason})`);
      c.header("Stripe-Version", STRIPE_VERSION);

      span.setAttribute("app.response.approved", approved);
      span.setAttribute("app.response.reason", reason);
      span.end();

      return c.json({ approved });
    });
  });

  return app;
}
