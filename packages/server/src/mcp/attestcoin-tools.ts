// The Attestcoin MCP tools: what an AGENT can ask about its own payment history.
//
// Four tools, and the split between them is deliberate:
//   verify_payment      — where is this payment in the cross-chain pipeline?
//   payment_receipt     — the full three-chain receipt for one payment
//   credit_score        — this card's accumulated on-chain reputation
//   cross_chain_status  — is the protocol itself healthy right now?
//
// Every response is written for a model that will relay it to a human, so:
//   - timestamps are ISO 8601, never raw epochs (a bare epoch invites misconversion,
//     which is why the existing `card` tool already converts),
//   - amounts are decimal USDC strings, not atoms,
//   - explorer links are included so a claim can be checked rather than trusted,
//   - the trust model is stated in the receipt itself, because an agent telling its
//     user "this payment is cryptographically verified" should be able to say
//     precisely what was verified.
//
// Registered only when the integration is configured: an agent must not be offered a
// tool that can only answer "not configured".

import { z } from "zod";
import { attestcoin as ac, type CardRow } from "@attestpay/engine";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppDeps } from "../deps";

type Run = (toolName: string, cardId: string, fn: () => Promise<unknown>) => Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}>;

const usdc = (atoms: bigint): string => (Number(atoms) / 1e6).toFixed(6);

const iso = (sec: number | bigint | null | undefined): string | null => {
  if (sec === null || sec === undefined) return null;
  const n = Number(sec);
  return n === 0 ? null : new Date(n * 1000).toISOString();
};

/** Plain-language meaning of each pipeline state, so an agent can explain a
 * "not yet verified" honestly instead of guessing that something broke. */
const STATUS_EXPLANATIONS: Record<ac.ProofStatus, string> = {
  pending: "queued for cross-chain verification; the anchor has not been written yet",
  anchoring: "writing the payment anchor to the attested source chain",
  anchored:
    "anchor written; waiting for the Attestcoin attestor network to cover its block (typically a few minutes)",
  attested: "the anchor's block is attested; generating the inclusion proof",
  proving: "submitting the inclusion proof to AttestPayASC on Creditcoin",
  verified: "verified on Creditcoin; the payment is now part of this card's on-chain credit history",
  failed: "cross-chain verification did not complete; see `error` for why",
};

/** What the Attestcoin proof does and does not establish.
 *
 * Included verbatim in receipts on purpose. The proof is genuinely trustless about
 * the anchor's inclusion, and genuinely silent about whether the Base payment
 * happened, and an agent relaying this to a user needs both halves. */
const TRUST_MODEL = {
  proven:
    "Cryptographically proven, no oracle trusted: this anchor record, with exactly these values, was included in a block attested by the Attestcoin attestor network. AttestPayASC decodes the values from the proven transaction bytes, so no relayer can alter them in flight.",
  not_proven:
    "Not proven by Attestcoin: that the underlying Base payment occurred. The AttestPay server writes the anchor, so the Base-to-source-chain hop is the server's own attestation. The Base transaction hash is included below so it can be checked independently.",
  why_anchored:
    "AttestPay pays USDC on Base, but the Attestcoin protocol on Creditcoin CC3 testnet attests only Ethereum mainnet and Ethereum Sepolia as source chains, so a Base transaction cannot be proven into Creditcoin directly.",
} as const;

export function registerAttestcoinTools(
  server: McpServer,
  deps: AppDeps,
  card: CardRow,
  run: Run,
): void {
  const acDeps = deps.attestcoin;
  // No client means no meaningful answer, so the tools are simply not offered.
  if (!acDeps?.client) return;
  const client = acDeps.client;
  const store = acDeps.store;
  const now = () => Math.floor(Date.now() / 1000);

  const sourceChainIdForLinks = client.config.sourceChainId === 84532 ? 84532 : 8453;

  // -----------------------------------------------------------------------
  // verify_payment
  // -----------------------------------------------------------------------

  server.registerTool(
    "verify_payment",
    {
      title: "Cross-chain verification status",
      description:
        "Check (or start) Attestcoin cross-chain verification for a payment from this card. Every confirmed payment is queued automatically, so this is normally a status read: it reports which stage the proof has reached and the Creditcoin transaction once verified. Verification takes a few minutes because it waits for the Attestcoin attestor network — a 'not yet verified' answer is usually normal, not an error.",
      inputSchema: {
        charge_id: z
          .string()
          .max(128)
          .optional()
          .describe("charge to check; omit to list every in-flight and recent verification"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args: { charge_id?: string }) =>
      run("verify_payment", card.id, async () => {
        if (args.charge_id) {
          const row = store.get(args.charge_id);
          if (!row || row.card_id !== card.id) {
            return {
              found: false,
              message:
                "No verification record for that charge on this card. Only confirmed on-chain payments are anchored; x402 purchases settle through the seller and have no AttestPay transaction to anchor.",
            };
          }
          const charge = deps.store.getCharge(row.charge_id);
          return {
            found: true,
            charge_id: row.charge_id,
            status: row.status,
            what_this_means: STATUS_EXPLANATIONS[row.status],
            amount: charge ? `${usdc(charge.amount_atoms)} USDC` : null,
            anchor_tx_hash: row.anchor_tx_hash,
            anchor_block_height: row.anchor_height,
            creditcoin_tx_hash: row.creditcoin_tx_hash,
            creditcoin_explorer: row.creditcoin_tx_hash
              ? ac.creditcoinTxUrl(row.creditcoin_tx_hash)
              : null,
            verified_at: iso(row.verified_at),
            attempts: row.attempts,
            error: row.error,
          };
        }

        const rows = store.listByCard(card.id, 25);
        const stats = store.cardStats(card.id);
        return {
          summary: {
            ...stats,
            average_verification_seconds: store.averageVerifySeconds(card.id),
          },
          payments: rows.map((r) => {
            const charge = deps.store.getCharge(r.charge_id);
            return {
              charge_id: r.charge_id,
              status: r.status,
              amount: charge ? `${usdc(charge.amount_atoms)} USDC` : null,
              memo: charge?.memo ?? null,
              creditcoin_tx_hash: r.creditcoin_tx_hash,
              verified_at: iso(r.verified_at),
              error: r.error,
            };
          }),
        };
      }),
  );

  // -----------------------------------------------------------------------
  // payment_receipt
  // -----------------------------------------------------------------------

  server.registerTool(
    "payment_receipt",
    {
      title: "Cross-chain payment receipt",
      description:
        "Get the full cross-chain receipt for one payment: the original USDC transfer on Base, the anchor on the attested source chain, and the Attestcoin verification on Creditcoin, with an explorer link for each. Includes a plain statement of what the proof does and does not establish — relay that faithfully rather than describing the payment as simply 'verified'.",
      inputSchema: {
        charge_id: z.string().max(128).describe("the charge ID returned by `pay`"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args: { charge_id: string }) =>
      run("payment_receipt", card.id, async () => {
        const charge = deps.store.getCharge(args.charge_id);
        if (!charge || charge.card_id !== card.id) {
          return { found: false, message: "No such charge on this card." };
        }

        const row = store.get(args.charge_id);
        const verified = row?.status === "verified";

        return {
          found: true,
          charge_id: charge.id,
          amount: `${usdc(charge.amount_atoms)} USDC`,
          fee: `${usdc(charge.fee_atoms)} USDC`,
          merchant: charge.to_addr,
          memo: charge.memo,
          payment_status: charge.status,

          // Leg 1: the payment itself.
          source_payment: {
            chain: sourceChainIdForLinks === 84532 ? "Base Sepolia" : "Base",
            chain_id: sourceChainIdForLinks,
            tx_hash: charge.tx_hash,
            explorer: charge.tx_hash ? ac.baseTxUrl(sourceChainIdForLinks, charge.tx_hash) : null,
            confirmed_at: iso(charge.created_at),
          },

          // Leg 2: the anchor on a chain Attestcoin watches.
          anchor: row?.anchor_tx_hash
            ? {
                chain: client.config.sourceChainId === 11155111 ? "Ethereum Sepolia" : "Ethereum",
                chain_id: client.config.sourceChainId,
                attestcoin_chain_key: client.config.chainKey,
                tx_hash: row.anchor_tx_hash,
                block_height: row.anchor_height,
                explorer: ac.sourceTxUrl(client, row.anchor_tx_hash),
                anchored_by: client.anchorerAddress,
              }
            : null,

          // Leg 3: the cross-chain verification.
          attestcoin_verification: verified
            ? {
                chain: "Creditcoin CC3 Testnet",
                chain_id: client.config.creditcoinChainId,
                tx_hash: row!.creditcoin_tx_hash,
                explorer: row!.creditcoin_tx_hash
                  ? ac.creditcoinTxUrl(row!.creditcoin_tx_hash)
                  : null,
                verified_at: iso(row!.verified_at),
                asc_address: client.config.ascAddress,
                asc_explorer: ac.creditcoinAddressUrl(client.config.ascAddress),
                proof_type: "Merkle inclusion + block continuity, checked by the Block Prover precompile (0x0FD2)",
              }
            : {
                status: row?.status ?? "not queued",
                what_this_means: row
                  ? STATUS_EXPLANATIONS[row.status]
                  : "This payment is not in the verification pipeline. Only confirmed on-chain AttestPay payments are anchored.",
              },

          trust_model: TRUST_MODEL,
        };
      }),
  );

  // -----------------------------------------------------------------------
  // credit_score
  // -----------------------------------------------------------------------

  server.registerTool(
    "credit_score",
    {
      title: "On-chain credit score",
      description:
        "Read this card's cross-chain-verified payment history and credit standing from AttestPayASC on Creditcoin. Every verified payment builds a public, checkable record against the card's funding account, which any Creditcoin dApp can read. The grade is a simple published formula over payment count, volume and history length — describe it as a summary of on-chain facts, not as a risk assessment.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      run("credit_score", card.id, async () => {
        const payer = ac.payerForCard(deps.store, card.id);
        if (!payer) {
          return { error: "This card has no resolvable funding account." };
        }

        // Live read first, cache as fallback, and always say which it was: a cached
        // number presented as live is a small lie an agent would then repeat.
        let credit: ac.AgentCredit | null = null;
        let live = true;
        let syncedAt: number | null = null;
        try {
          credit = await client.getAgentCredit(payer);
          store.cacheCredit(payer, credit, now());
          syncedAt = now();
        } catch {
          const cached = store.getCachedCredit(payer);
          if (cached) {
            credit = cached;
            live = false;
            syncedAt = cached.lastSyncedAt;
          }
        }
        if (!credit) {
          return {
            error:
              "Credit history unavailable: Creditcoin could not be reached and nothing is cached locally yet.",
          };
        }

        const grade = ac.creditGrade(credit);
        const checked = Number(credit.termsCheckedPayments);
        return {
          data_source: live ? "live read from Creditcoin" : "locally cached (Creditcoin unreachable)",
          as_of: iso(syncedAt),
          funding_account: payer,
          grade: grade.grade,
          score: `${grade.score}/100`,
          basis: grade.basis,
          total_verified_payments: Number(credit.totalPayments),
          total_verified_volume: `${usdc(credit.totalVolume)} USDC`,
          first_verified_payment: iso(credit.firstPaymentAt),
          last_verified_payment: iso(credit.lastPaymentAt),
          terms_compliance:
            checked > 0
              ? {
                  within_terms: Number(credit.withinTermsPayments),
                  checked: checked,
                  rate: `${((Number(credit.withinTermsPayments) / checked) * 100).toFixed(1)}%`,
                }
              : {
                  note: "No payments have been checked against registered card terms, so there is no compliance rate. An unregistered card is not credited with perfect compliance.",
                },
          grading_formula:
            "payment count (up to 40) + verified volume (up to 30) + history length in days (up to 30), scaled by the within-terms rate where terms were registered",
          asc_address: client.config.ascAddress,
          asc_explorer: ac.creditcoinAddressUrl(client.config.ascAddress),
        };
      }),
  );

  // -----------------------------------------------------------------------
  // cross_chain_status
  // -----------------------------------------------------------------------

  server.registerTool(
    "cross_chain_status",
    {
      title: "Attestcoin protocol health",
      description:
        "Check the health of the Attestcoin cross-chain pipeline: how far behind the attestor network is running, and how many of this server's proofs are queued, in flight, verified or failed. Use this to tell whether an unverified payment is simply waiting on attestation or whether something is actually wrong.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      run("cross_chain_status", card.id, async () => {
        const health = await ac.attestcoinHealth(client, store);
        const lag = health.attestationLagBlocks;
        return {
          protocol: "Attestcoin (Creditcoin CC3 Testnet)",
          attestcoin_chain_key: health.chainKey,
          source_chain: client.config.sourceChainId === 11155111 ? "Ethereum Sepolia" : "Ethereum",
          source_chain_head: health.sourceHead,
          latest_attested_height: health.latestAttestedHeight,
          attestation_lag_blocks: lag,
          attestation_lag_estimate:
            lag === null
              ? "unknown"
              : // Sepolia targets ~12s blocks; this is an estimate, labelled as one.
                `roughly ${Math.round((lag * 12) / 60)} minute(s) behind the source chain head`,
          healthy: health.error === undefined && lag !== null,
          probe_error: health.error ?? null,
          proof_queue: health.queue,
          contracts: {
            payment_anchor: health.anchorAddress,
            attestpay_asc: health.ascAddress,
            asc_explorer: health.ascAddress ? ac.creditcoinAddressUrl(health.ascAddress) : null,
            block_prover_precompile: ac.PRECOMPILES.blockProver,
          },
          note: "A payment normally reaches 'verified' one attestation cycle after it is anchored. If the lag above is small and your payment is still 'anchored', it is waiting, not stuck.",
        };
      }),
  );
}
