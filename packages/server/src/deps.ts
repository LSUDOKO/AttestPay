// Server dependency wiring. ONE process serves MCP + dashboard API + (P3) facilitator
// + seller + webhooks, routed by hostname. Engine objects are singletons here;
// tests build their own AppDeps with fakes.

import { privateKeyToAccount } from "viem/accounts";
import { isAddress } from "viem";
import type { Hex } from "viem";
import {
  KeyedMutex,
  Relayer,
  Store,
  attestcoin,
  type DelegationSigner,
  type FinalizeOpsDeps,
  type SpendDeps,
} from "@attestpay/engine";
import { makePrivyVerifier, type PrivyVerifier } from "./api/privy";
import { makeStripeClient, type StripeClient } from "./stripe/client";
import { makeFiatSettler, type FiatSettler } from "./stripe/settlement";
import { veniceChat, type ChatFn } from "./venice/client";

export type AppDeps = {
  store: Store;
  relayer: Relayer;
  /** dev-mode server-side signer for A_user (local key); P4 adds the pre-signed Privy path */
  userSigner: DelegationSigner | null;
  /** ops bearer token (server-side curl/scripts lane; full access) */
  adminToken: string | null;
  /** Privy session verifier (per-user dashboard lane); null = lane disabled */
  verifyPrivyToken: PrivyVerifier | null;
  /** serializes spends per card tree (root id) so concurrent spends can't double-approve a budget */
  spendMutex: KeyedMutex;
  spendOverrides?: Partial<SpendDeps>;
  /** test seams for the client-signed admin ops (codeCheck/confirmViaChain/nonce) */
  opsOverrides?: Partial<FinalizeOpsDeps>;
  /** Venice NL->CardTerms compiler brain; null/absent = /cards/compile disabled (no VENICE_API_KEY) */
  veniceChat?: ChatFn | null;
  /** Basescan API key for verified-contract labels in compiled drafts (optional) */
  basescanKey?: string | null;
  /** Stripe Issuing REST client (test-mode-only); null = fiat trigger/credential tools disabled */
  stripe?: StripeClient | null;
  /** drives approved fiat charge rows through spend(); null = settlement mode off */
  fiatSettler?: FiatSettler | null;
  /** Attestcoin cross-chain verification. `client` is null when the integration is
   * configured-off; the whole field is absent in tests that don't exercise it.
   * Optional like the other integrations above, so a fake AppDeps stays small —
   * every consumer must therefore handle it being missing. */
  attestcoin?: {
    store: attestcoin.AttestcoinStore;
    client: attestcoin.AttestcoinClient | null;
  };
};

/** Numeric env with a default that survives the empty string. `Number(x ?? d)` is a trap:
 * `.env.example` ships optional vars as `KEY=` and Bun loads them as "", which `??`
 * passes through and Number("") coerces to 0 — silently zeroing rate limits and
 * intervals. Empty/missing/non-numeric all fall back to the default. */
export function envInt(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

export function realDeps(): AppDeps {
  const store = new Store(); // ATTESTPAY_DB_PATH or :memory:
  const relayer = new Relayer();
  const pk = process.env.ATTESTPAY_DEV_USER_PK as Hex | undefined;
  const privyAppId = process.env.ATTESTPAY_PRIVY_APP_ID;
  // Created unconditionally so the proof tables always exist: the dashboard renders
  // an empty, labelled panel when the integration is off rather than 500-ing.
  const acStore = new attestcoin.AttestcoinStore(store.db);
  const deps: AppDeps = {
    store,
    relayer,
    userSigner: pk ? privateKeyToAccount(pk) : null,
    adminToken: process.env.ATTESTPAY_ADMIN_TOKEN ?? null,
    verifyPrivyToken: privyAppId ? makePrivyVerifier(privyAppId) : null,
    spendMutex: new KeyedMutex(),
    veniceChat: process.env.VENICE_API_KEY ? veniceChat() : null,
    basescanKey: process.env.BASESCAN_API_KEY ?? null,
    stripe: makeStripeClient(),
    attestcoin: { store: acStore, client: null },
  };

  // Attestcoin is optional. A misconfiguration must disable the cross-chain leg
  // LOUDLY and leave everything else working — payments are the product, provable
  // payment history is the addition.
  const acConfig = attestcoin.attestcoinConfig();
  if (acConfig) {
    try {
      deps.attestcoin = { store: acStore, client: new attestcoin.AttestcoinClient(acConfig) };
      console.log(
        `[attestcoin] enabled · chainKey=${acConfig.chainKey} anchor=${acConfig.anchorAddress} asc=${acConfig.ascAddress}`,
      );
    } catch (e) {
      console.error(
        `[attestcoin] DISABLED: client construction failed (${e instanceof Error ? e.message : String(e)})`,
      );
    }
  } else {
    console.log(`[attestcoin] disabled · ${attestcoin.attestcoinDisabledReason() ?? "not configured"}`);
  }
  // the settler closes over the full deps object (store + mutex + spend seams).
  // A malformed settlement address would book every approved charge against a
  // recipient the relayer can never pay (parking rows + freezing cards), so a bad
  // value disables on-chain settlement LOUDLY and the lane falls back to ledger-only.
  const settleAddr = process.env.ATTESTPAY_SETTLEMENT_ADDRESS;
  let settlementOk = process.env.ATTESTPAY_FIAT_SETTLEMENT === "1";
  if (settlementOk && settleAddr && !isAddress(settleAddr)) {
    console.error("[deps] ATTESTPAY_SETTLEMENT_ADDRESS is not a valid address; on-chain settlement DISABLED (fiat lane falls back to ledger-only)");
    settlementOk = false;
  }
  deps.fiatSettler = settlementOk ? makeFiatSettler(deps) : null;
  return deps;
}

/** The card-tree key a spend serializes on: the root ancestor (whole subtree shares budget). */
export function spendKey(store: Store, cardId: string): string {
  const chain = store.ancestorChain(cardId);
  return chain.length ? chain[chain.length - 1]!.id : cardId;
}

export function spendDeps(deps: AppDeps): SpendDeps {
  return {
    store: deps.store,
    relayer: deps.relayer,
    // Every confirmed charge is offered to the Attestcoin pipeline. Enqueue is
    // cheap (one idempotent INSERT) and the background worker does the slow
    // cross-chain work, so `pay` still returns as soon as Base confirms.
    onChargeConfirmed: enqueueForVerification(deps),
    ...deps.spendOverrides,
  };
}

/** Registers a newly issued card's terms on Creditcoin, fire-and-forget.
 *
 * Deliberately not awaited by the issuance handlers. Registering terms makes verified
 * payments judgeable against them; it is NOT a precondition for issuing or spending,
 * so an unreachable Creditcoin must not make cards un-issuable. Failures are recorded
 * in the local registration table and logged, and the card works regardless. */
export function registerTermsInBackground(deps: AppDeps, cardId: string): void {
  const ac = deps.attestcoin;
  if (!ac?.client) return;
  const client = ac.client;
  void attestcoin
    .registerCardTermsOnChain(
      { store: deps.store, attestcoin: ac.store, client },
      cardId,
      Math.floor(Date.now() / 1000),
    )
    .then((r) => {
      if (!r.ok) console.error(`[attestcoin] terms registration failed for ${cardId}: ${r.error}`);
    })
    .catch(() => {
      /* recorded in attestcoin_card_terms; never surfaces to the issuing caller */
    });
}

/** Marks a card's registered terms revoked on Creditcoin, fire-and-forget, and
 * queues the PROVEN revocation fact when the ledger is configured.
 *
 * The ASC keeps the terms record (history must not vanish) and flips `active` to
 * false. Best-effort for the same reason as registration: a card's revocation on Base
 * is what actually stops it spending, and that must never be blocked on Creditcoin.
 *
 * The proven fact is what gives counterparties a checkable `revokedAt`: the ASC flag
 * says a card was revoked, `AttestPayLedger.cardRevokedAt` says WHEN, from attested
 * bytes, so "was this card live when it paid me?" has an answer nobody has to take
 * AttestPay's word for. */
export function revokeTermsInBackground(deps: AppDeps, cardId: string): void {
  const ac = deps.attestcoin;
  if (!ac?.client) return;
  void ac.client.revokeCardTerms(cardId).catch(() => {
    /* best-effort: the on-Base revocation is the one that stops spending */
  });
  if (attestcoin.attestcoinFeatures(ac.client.config).disputes) {
    try {
      attestcoin.enqueueCardRevocation({ store: deps.store, attestcoin: ac.store }, cardId, Math.floor(Date.now() / 1000));
    } catch {
      /* the local revocation already happened; the fact is a record of it */
    }
  }
}

/** Registers a fully signed credit line on Creditcoin, fire-and-forget. The sweep
 * retries anything this misses (process restart, transient RPC failure). */
export function openLineInBackground(deps: AppDeps, lineId: string): void {
  const ac = deps.attestcoin;
  if (!ac?.client || !attestcoin.attestcoinFeatures(ac.client.config).credit) return;
  const client = ac.client;
  void attestcoin
    .openLineOnChain({ attestcoin: ac.store, client }, lineId, Math.floor(Date.now() / 1000))
    .then((r) => {
      if (!r.ok) console.error(`[attestcoin] credit line ${lineId} registration failed: ${r.error}`);
    })
    .catch(() => {
      /* recorded on the line row; the sweep retries */
    });
}

/** The confirmed-charge hook: enqueues a charge for cross-chain verification, and
 * — when the charge is a credit-line draw or repayment — the fact that proves it.
 * Does nothing when Attestcoin is not configured. */
export function enqueueForVerification(deps: AppDeps): (chargeId: string, cardId: string) => void {
  return (chargeId, cardId) => {
    const ac = deps.attestcoin;
    if (!ac?.client) return;
    const now = Math.floor(Date.now() / 1000);
    ac.store.enqueue(chargeId, cardId, now);
    if (attestcoin.attestcoinFeatures(ac.client.config).credit) {
      attestcoin.enqueueLineFactForCharge({ store: deps.store, attestcoin: ac.store, config: ac.client.config }, chargeId, now);
    }
  };
}
