// The Attestcoin client: the three network legs of the cross-chain pipeline.
//
//   1. anchorPayment   — write the payment's facts to the source chain (Sepolia)
//   2. generateProof   — wait for attestation, then fetch an inclusion proof
//   3. submitProof     — hand the proof to AttestPayASC on Creditcoin
//
// Each leg is separately callable and separately observable, because each fails for
// different reasons on different timescales: (1) is a normal tx, (2) waits minutes on
// a third party, (3) is a normal tx again. Bundling them into one "verify" call would
// make a stalled attestation indistinguishable from a broken RPC.

import { Contract, JsonRpcProvider, Wallet, type TransactionReceipt } from "ethers";
import { proofProvider } from "@gluwa/usc-sdk";
import { ATTESTPAY_ASC_ABI, CHAIN_INFO_ABI, PAYMENT_ANCHOR_ABI } from "./abi";
import type {
  AnchorEventArgs,
  AttestPayASCContract,
  ChainInfoContract,
  ContinuityProofArg,
  MerkleProofArg,
  PaymentAnchorContract,
} from "./contracts";
import { cardIdToBytes32, type AttestcoinConfig } from "./config";
import {
  PRECOMPILES,
  type AgentCredit,
  type AnchorRequest,
  type AttestcoinProof,
  type VerifiedPayment,
} from "./types";
import {
  anchorsWritten,
  attestationLagBlocks,
  attestationWaitSeconds,
  emitAnchorLog,
  emitAttestationLog,
  emitVerificationLog,
  proofGenerationSeconds,
  proofSubmissionSeconds,
  proofsGenerated,
  proofsVerified,
  traceAttestcoin,
  verificationFailures,
} from "./telemetry";

/** Raised when a stage fails. `retryable` tells the worker whether to try again:
 * a missing attestation resolves itself with time, a malformed anchor never will. */
export class AttestcoinError extends Error {
  constructor(
    readonly stage: "anchor" | "attestation" | "proof" | "submit" | "read",
    message: string,
    readonly retryable = true,
  ) {
    super(message);
    this.name = "AttestcoinError";
  }
}

function reason(e: unknown): string {
  if (typeof e === "object" && e !== null) {
    const any = e as { shortMessage?: string; reason?: string; message?: string };
    return any.shortMessage ?? any.reason ?? any.message ?? String(e);
  }
  return String(e);
}

export class AttestcoinClient {
  private readonly sourceProvider: JsonRpcProvider;
  private readonly creditcoinProvider: JsonRpcProvider;
  private readonly sourceWallet: Wallet;
  private readonly creditcoinWallet: Wallet;
  private readonly anchor: PaymentAnchorContract;
  private readonly asc: AttestPayASCContract;
  private readonly chainInfo: ChainInfoContract;
  private readonly prover: proofProvider.service.ProofBuilder;

  constructor(readonly config: AttestcoinConfig) {
    // `staticNetwork` matters: without it ethers probes the chain on every call to
    // detect network changes, which turns each read into two round trips and was the
    // cause of spurious timeouts against the Creditcoin RPC.
    this.sourceProvider = new JsonRpcProvider(config.sourceRpcUrl, undefined, {
      staticNetwork: true,
    });
    this.creditcoinProvider = new JsonRpcProvider(config.creditcoinRpcUrl, undefined, {
      staticNetwork: true,
    });

    this.sourceWallet = new Wallet(config.privateKey, this.sourceProvider);
    this.creditcoinWallet = new Wallet(config.privateKey, this.creditcoinProvider);

    this.anchor = new Contract(
      config.anchorAddress,
      PAYMENT_ANCHOR_ABI,
      this.sourceWallet,
    ) as PaymentAnchorContract;
    this.asc = new Contract(
      config.ascAddress,
      ATTESTPAY_ASC_ABI,
      this.creditcoinWallet,
    ) as AttestPayASCContract;
    this.chainInfo = new Contract(
      PRECOMPILES.chainInfo,
      CHAIN_INFO_ABI,
      this.creditcoinProvider,
    ) as ChainInfoContract;

    this.prover = new proofProvider.service.ProofBuilder(config.chainKey, config.proverApiUrl);
  }

  /** The address that anchors and submits proofs. The ASC credits only this address,
   * so it must match the `trustedAnchorer` the ASC was deployed with. */
  get anchorerAddress(): string {
    return this.sourceWallet.address;
  }

  // -------------------------------------------------------------------------
  // Leg 1: anchor on the source chain
  // -------------------------------------------------------------------------

  /** Writes a payment anchor to the source chain and returns its tx hash + height.
   *
   * An already-anchored payment is NOT an error: the anchor's own replay guard makes
   * re-anchoring revert, and a worker retrying after a crash that happened between
   * "tx landed" and "row updated" must converge rather than get stuck. In that case
   * the existing anchor is located by log search so the pipeline can carry on. */
  async anchorPayment(req: AnchorRequest): Promise<{ txHash: string; height: number }> {
    return traceAttestcoin(
      "anchor",
      {
        "attestpay.charge_id": req.chargeId,
        "attestpay.card_id": req.cardId,
        "attestpay.source_tx_hash": req.sourceTxHash,
        "attestpay.amount_atoms": req.amountAtoms.toString(),
      },
      async (span) => {
        const cardIdHash = cardIdToBytes32(req.cardId);

        // Converge on a pre-existing anchor instead of failing: see above.
        const already = await this.anchor.isAnchored(BigInt(req.sourceChainId), req.sourceTxHash);
        if (already) {
          span.setAttribute("attestpay.attestcoin.anchor_preexisting", true);
          const found = await this.findExistingAnchor(req);
          if (found) return found;
          throw new AttestcoinError(
            "anchor",
            `payment ${req.sourceTxHash} is already anchored but its anchoring transaction could not be located in the log history; re-anchoring would revert`,
            false,
          );
        }

        let receipt: TransactionReceipt | null;
        try {
          const tx = await this.anchor.anchorPayment(
            cardIdHash,
            req.payer,
            req.merchant,
            req.amountAtoms,
            BigInt(req.sourceChainId),
            req.sourceTxHash,
            BigInt(req.paidAt),
            req.memo ?? "",
          );
          receipt = await tx.wait();
        } catch (e) {
          verificationFailures.add(1, { stage: "anchor" });
          throw new AttestcoinError("anchor", `anchor transaction failed: ${reason(e)}`);
        }
        if (!receipt) {
          throw new AttestcoinError("anchor", "anchor transaction produced no receipt");
        }

        anchorsWritten.add(1);
        span.setAttribute("attestpay.attestcoin.anchor_tx_hash", receipt.hash);
        span.setAttribute("attestpay.attestcoin.anchor_height", receipt.blockNumber);
        emitAnchorLog(req.chargeId, req.cardId, receipt.hash);
        return { txHash: receipt.hash, height: receipt.blockNumber };
      },
    );
  }

  /** Locates an existing anchor for a payment by scanning `PaymentAnchored` logs.
   *
   * Filtered on the indexed cardId/payer/merchant triple, then matched on the
   * non-indexed `sourceTxHash` — `sourceTxHash` is not indexed (the event already
   * spends all three topic slots), so the final match has to happen in the decoded
   * data rather than in the filter. */
  private async findExistingAnchor(
    req: AnchorRequest,
  ): Promise<{ txHash: string; height: number } | null> {
    try {
      const filter = this.anchor.filters.PaymentAnchored(
        cardIdToBytes32(req.cardId),
        req.payer,
        req.merchant,
      );
      const head = await this.sourceProvider.getBlockNumber();
      // Anchors are written within minutes of a payment, so a recent window suffices
      // and keeps the query inside public-RPC log-range limits.
      const from = Math.max(0, head - 50_000);
      const events = await this.anchor.queryFilter(filter, from, head);
      for (const ev of events) {
        const args = (ev as unknown as { args?: AnchorEventArgs }).args;
        if (!args) continue;
        if (String(args.sourceTxHash).toLowerCase() === req.sourceTxHash.toLowerCase()) {
          return { txHash: ev.transactionHash, height: ev.blockNumber };
        }
      }
      return null;
    } catch {
      // A log-scan failure is not itself fatal; the caller turns a null into a
      // clear, non-retryable error.
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Leg 2: attestation wait + proof generation
  // -------------------------------------------------------------------------

  /** Latest source-chain height the Attestcoin attestors have covered. */
  async latestAttestedHeight(): Promise<number> {
    try {
      const r = await this.chainInfo.get_latest_attestation_height_and_hash(
        BigInt(this.config.chainKey),
      );
      if (!r.exists) return 0;
      return Number(r.height);
    } catch (e) {
      throw new AttestcoinError("attestation", `attestation height read failed: ${reason(e)}`);
    }
  }

  /** Current head of the source chain. */
  async sourceHead(): Promise<number> {
    return this.sourceProvider.getBlockNumber();
  }

  /** Whether `height` is covered by attestation yet. */
  async isAttested(height: number): Promise<boolean> {
    const latest = await this.latestAttestedHeight();
    if (latest > 0) {
      try {
        const head = await this.sourceHead();
        attestationLagBlocks.record(Math.max(0, head - latest));
      } catch {
        // lag is a metric, not a gate — a failed head read must not block progress
      }
    }
    return latest >= height;
  }

  /** Generates an inclusion proof for an anchor transaction.
   *
   * Does NOT block waiting for attestation: the caller (a background worker driving a
   * persisted state machine) decides when to re-check. A long in-process sleep would
   * lose all progress on restart and hold a worker slot for minutes. */
  async generateProof(chargeId: string, anchorTxHash: string): Promise<AttestcoinProof> {
    return traceAttestcoin(
      "proof_generation",
      { "attestpay.charge_id": chargeId, "attestpay.attestcoin.anchor_tx_hash": anchorTxHash },
      async (span) => {
        const started = Date.now();
        let result: proofProvider.ProofResult;
        try {
          result = await this.prover.getProof(anchorTxHash);
        } catch (e) {
          verificationFailures.add(1, { stage: "proof" });
          throw new AttestcoinError("proof", `prover API request failed: ${reason(e)}`);
        }

        if (!result.success || !result.data) {
          verificationFailures.add(1, { stage: "proof" });
          // The prover answers "not yet attested / not in cache" the same way it
          // answers a real failure, so this stays retryable.
          throw new AttestcoinError(
            "proof",
            `proof not available yet: ${result.error ?? "prover returned no data"}`,
          );
        }

        const elapsed = (Date.now() - started) / 1000;
        proofGenerationSeconds.record(elapsed);
        proofsGenerated.add(1);

        const d = result.data;
        span.setAttribute("attestpay.attestcoin.header_number", d.headerNumber);
        span.setAttribute("attestpay.attestcoin.tx_index", d.txIndex);
        span.setAttribute("attestpay.attestcoin.continuity_roots", d.continuityProof.roots.length);
        span.setAttribute("attestpay.attestcoin.merkle_siblings", d.merkleProof.siblings.length);

        return {
          chainKey: d.chainKey,
          headerNumber: d.headerNumber,
          txIndex: d.txIndex,
          txHash: d.txHash,
          txBytes: d.txBytes,
          merkleProof: {
            root: d.merkleProof.root,
            siblings: d.merkleProof.siblings.map((s) => ({ hash: s.hash, isLeft: s.isLeft })),
          },
          continuityProof: {
            lowerEndpointDigest: d.continuityProof.lowerEndpointDigest,
            roots: [...d.continuityProof.roots],
          },
        };
      },
    );
  }

  /** Records an observed attestation wait, for the SigNoz histogram. */
  recordAttestationWait(chargeId: string, height: number, waitSeconds: number): void {
    attestationWaitSeconds.record(waitSeconds);
    emitAttestationLog(chargeId, this.config.chainKey, height, waitSeconds);
  }

  // -------------------------------------------------------------------------
  // Leg 3: submit the proof to Creditcoin
  // -------------------------------------------------------------------------

  /** Submits a proof to `AttestPayASC.verifyPayment` and returns the Creditcoin tx.
   *
   * `recorded === 0` means every anchored event in that transaction was already
   * verified — a successful no-op, not a failure. The caller treats it as verified,
   * which is what makes the whole pipeline safely retryable. */
  async submitProof(
    chargeId: string,
    cardId: string,
    proof: AttestcoinProof,
  ): Promise<{ txHash: string; recorded: number }> {
    return traceAttestcoin(
      "proof_submission",
      {
        "attestpay.charge_id": chargeId,
        "attestpay.card_id": cardId,
        "attestpay.attestcoin.header_number": proof.headerNumber,
      },
      async (span) => {
        const started = Date.now();

        const merkleArg: MerkleProofArg = {
          root: proof.merkleProof.root,
          siblings: proof.merkleProof.siblings.map((s) => [s.hash, s.isLeft] as [string, boolean]),
        };
        const continuityArg: ContinuityProofArg = {
          lowerEndpointDigest: proof.continuityProof.lowerEndpointDigest,
          roots: proof.continuityProof.roots,
        };

        // Simulate first. A revert here is the precompile or the ASC rejecting the
        // proof, and learning that from a static call costs no gas and surfaces the
        // named custom error instead of a bare "transaction reverted".
        try {
          await this.asc.verifyPayment.staticCall(
            BigInt(proof.headerNumber),
            proof.txBytes,
            merkleArg,
            continuityArg,
          );
        } catch (e) {
          verificationFailures.add(1, { stage: "submit" });
          const msg = reason(e);
          // An untrusted anchorer or a missing anchor log is a configuration or data
          // problem: retrying forever would just burn the queue.
          const permanent = /UntrustedAnchorer|AnchorLogNotFound|ZeroAddress/.test(msg);
          throw new AttestcoinError("submit", `proof rejected on simulation: ${msg}`, !permanent);
        }

        let receipt: TransactionReceipt | null;
        try {
          const tx = await this.asc.verifyPayment(
            BigInt(proof.headerNumber),
            proof.txBytes,
            merkleArg,
            continuityArg,
          );
          receipt = await tx.wait();
        } catch (e) {
          verificationFailures.add(1, { stage: "submit" });
          throw new AttestcoinError("submit", `verification transaction failed: ${reason(e)}`);
        }
        if (!receipt) {
          throw new AttestcoinError("submit", "verification transaction produced no receipt");
        }

        // Count PaymentVerified events rather than reading the return value: a
        // mined transaction's return data is not available from a receipt.
        const recorded = receipt.logs.filter((l) => {
          try {
            return this.asc.interface.parseLog({ topics: [...l.topics], data: l.data })?.name === "PaymentVerified";
          } catch {
            return false;
          }
        }).length;

        const elapsed = (Date.now() - started) / 1000;
        proofSubmissionSeconds.record(elapsed);
        proofsVerified.add(1);
        span.setAttribute("attestpay.attestcoin.creditcoin_tx_hash", receipt.hash);
        span.setAttribute("attestpay.attestcoin.payments_recorded", recorded);
        emitVerificationLog(chargeId, cardId, receipt.hash, recorded);

        return { txHash: receipt.hash, recorded };
      },
    );
  }

  // -------------------------------------------------------------------------
  // Reads from the ASC
  // -------------------------------------------------------------------------

  /** On-chain credit record for a payer address. */
  async getAgentCredit(payer: string): Promise<AgentCredit> {
    try {
      const c = await this.asc.getAgentCredit(payer);
      return {
        totalPayments: c.totalPayments,
        totalVolume: c.totalVolume,
        firstPaymentAt: c.firstPaymentAt,
        lastPaymentAt: c.lastPaymentAt,
        withinTermsPayments: c.withinTermsPayments,
        termsCheckedPayments: c.termsCheckedPayments,
      };
    } catch (e) {
      throw new AttestcoinError("read", `agent credit read failed: ${reason(e)}`);
    }
  }

  /** Verified payments for a card, newest last. */
  async getCardPayments(cardId: string, offset = 0, limit = 50): Promise<VerifiedPayment[]> {
    try {
      const rows = await this.asc.getCardPayments(
        cardIdToBytes32(cardId),
        BigInt(offset),
        BigInt(limit),
      );
      return rows.map((r) => ({
        cardId: r.cardId as `0x${string}`,
        payer: r.payer as `0x${string}`,
        merchant: r.merchant as `0x${string}`,
        amount: r.amount,
        sourceChainId: r.sourceChainId,
        sourceTxHash: r.sourceTxHash as `0x${string}`,
        paidAt: r.paidAt,
        anchorHeight: r.anchorHeight,
        verifiedAt: r.verifiedAt,
        memo: r.memo,
      }));
    } catch (e) {
      throw new AttestcoinError("read", `verified payments read failed: ${reason(e)}`);
    }
  }

  async getCardPaymentCount(cardId: string): Promise<bigint> {
    try {
      return await this.asc.getCardPaymentCount(cardIdToBytes32(cardId));
    } catch (e) {
      throw new AttestcoinError("read", `payment count read failed: ${reason(e)}`);
    }
  }

  async getTotalVerifiedSpend(cardId: string): Promise<bigint> {
    try {
      return await this.asc.totalVerifiedSpend(cardIdToBytes32(cardId));
    } catch (e) {
      throw new AttestcoinError("read", `verified spend read failed: ${reason(e)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Card terms registry
  // -------------------------------------------------------------------------

  /** Registers a card's terms on Creditcoin so verified payments can be judged
   * against them. Idempotent from the caller's side: re-registering the same card
   * overwrites its record (the ASC enforces that only the claiming owner may). */
  async registerCardTerms(args: {
    cardId: string;
    termsHash: string;
    periodBudgetAtoms: bigint;
    periodSeconds: number;
    perTxMaxAtoms: bigint;
    expiresAt: number;
  }): Promise<string> {
    return traceAttestcoin(
      "register_terms",
      { "attestpay.card_id": args.cardId },
      async (span) => {
        try {
          const tx = await this.asc.registerCardTerms(
            cardIdToBytes32(args.cardId),
            args.termsHash,
            args.periodBudgetAtoms,
            BigInt(args.periodSeconds),
            args.perTxMaxAtoms,
            BigInt(args.expiresAt),
          );
          const receipt = await tx.wait();
          if (!receipt) throw new Error("no receipt");
          span.setAttribute("attestpay.attestcoin.creditcoin_tx_hash", receipt.hash);
          return receipt.hash;
        } catch (e) {
          throw new AttestcoinError("submit", `card terms registration failed: ${reason(e)}`);
        }
      },
    );
  }

  async getCardTerms(cardId: string): Promise<{
    termsHash: string;
    periodBudget: bigint;
    periodSeconds: bigint;
    perTxMax: bigint;
    expiresAt: bigint;
    registeredAt: bigint;
    active: boolean;
    exists: boolean;
  }> {
    try {
      const t = await this.asc.getCardTerms(cardIdToBytes32(cardId));
      return {
        termsHash: t.termsHash,
        periodBudget: t.periodBudget,
        periodSeconds: t.periodSeconds,
        perTxMax: t.perTxMax,
        expiresAt: t.expiresAt,
        registeredAt: t.registeredAt,
        active: t.active,
        exists: t.exists,
      };
    } catch (e) {
      throw new AttestcoinError("read", `card terms read failed: ${reason(e)}`);
    }
  }

  async revokeCardTerms(cardId: string): Promise<string> {
    try {
      const tx = await this.asc.revokeCardTerms(cardIdToBytes32(cardId));
      const receipt = await tx.wait();
      if (!receipt) throw new Error("no receipt");
      return receipt.hash;
    } catch (e) {
      throw new AttestcoinError("submit", `card terms revocation failed: ${reason(e)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Deployment sanity check
  // -------------------------------------------------------------------------

  /** Confirms the deployed ASC agrees with this process's configuration.
   *
   * Worth doing at startup: an ASC deployed against a different anchor or a different
   * anchorer key produces proofs that always revert, and the failure surfaces one
   * payment at a time deep in a worker rather than once, loudly, at boot. */
  async checkDeployment(): Promise<{ ok: boolean; problems: string[] }> {
    const problems: string[] = [];
    try {
      const [chainKey, anchorAddr, anchorer] = await Promise.all([
        this.asc.sourceChainKey(),
        this.asc.paymentAnchor(),
        this.asc.trustedAnchorer(),
      ]);

      if (Number(chainKey) !== this.config.chainKey) {
        problems.push(
          `ASC sourceChainKey is ${chainKey} but this process is configured for ${this.config.chainKey}`,
        );
      }
      if (anchorAddr.toLowerCase() !== this.config.anchorAddress.toLowerCase()) {
        problems.push(
          `ASC paymentAnchor is ${anchorAddr} but this process anchors to ${this.config.anchorAddress}`,
        );
      }
      if (anchorer.toLowerCase() !== this.sourceWallet.address.toLowerCase()) {
        problems.push(
          `ASC trustedAnchorer is ${anchorer} but this process anchors from ${this.sourceWallet.address}; proofs will be rejected with UntrustedAnchorer`,
        );
      }
    } catch (e) {
      problems.push(`could not read ASC configuration: ${reason(e)}`);
    }
    return { ok: problems.length === 0, problems };
  }
}
