// The Attestcoin client: the network legs of the cross-chain pipeline.
//
//   1. anchorPayment / anchorFact — write the facts to the source chain (Sepolia)
//   2. generateProof               — wait for attestation, then fetch an inclusion proof
//   3. submitProof / submitFacts   — hand the proof to the consumer on Creditcoin
//
// Each leg is separately callable and separately observable, because each fails for
// different reasons on different timescales: (1) is a normal tx, (2) waits minutes on
// a third party, (3) is a normal tx again. Bundling them into one "verify" call would
// make a stalled attestation indistinguishable from a broken RPC.
//
// Beyond the pipeline, the client is the one place that talks to the optional
// Creditcoin contracts — credit lines, the ledger, guarantees, the passport — and to
// the ChainInfo registry that says which source chains are attested at all.

import { Contract, JsonRpcProvider, Wallet, type TransactionReceipt } from "ethers";
import { proofProvider } from "@gluwa/usc-sdk";
import {
  ATTESTPAY_ASC_ABI,
  CHAIN_INFO_ABI,
  CREDIT_LINE_ABI,
  FACT_ANCHOR_ABI,
  GUARANTEE_ABI,
  LEDGER_ABI,
  PASSPORT_ABI,
  PAYMENT_ANCHOR_ABI,
} from "./abi";
import type {
  AnchorEventArgs,
  AttestPayASCContract,
  ChainInfoContract,
  ContinuityProofArg,
  CreditLineContract,
  FactAnchorContract,
  GuaranteeContract,
  LedgerContract,
  LineTermsArg,
  MerkleProofArg,
  PassportContract,
  PaymentAnchorContract,
  ProvenFactsContract,
} from "./contracts";
import { attestcoinFeatures, cardIdToBytes32, sourceExplorerFor, type AttestcoinConfig } from "./config";
import {
  LINE_STATUS_NAMES,
  PRECOMPILES,
  type AgentCredit,
  type AnchorRequest,
  type AttestcoinProof,
  type BorrowerRecord,
  type CreditLineOnChain,
  type DisputeRecord,
  type FactPayload,
  type FactRow,
  type FactTarget,
  type Passport,
  type SupportedChain,
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
    readonly stage: "anchor" | "attestation" | "proof" | "submit" | "read" | "config",
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

/** What `resolveChainKey` learned from the live registry. */
export type ChainResolution = {
  chainKey: number;
  sourceChainId: number;
  source: "env" | "registry";
  chains: SupportedChain[];
  paymentChainAttested: boolean;
  /** Mismatches between configuration and registry. Empty when everything agrees. */
  problems: string[];
  resolvedAt: number;
};

export class AttestcoinClient {
  private readonly sourceProvider: JsonRpcProvider;
  private readonly creditcoinProvider: JsonRpcProvider;
  private readonly sourceWallet: Wallet;
  private readonly creditcoinWallet: Wallet;
  private readonly anchor: PaymentAnchorContract;
  private readonly asc: AttestPayASCContract;
  private readonly chainInfo: ChainInfoContract;
  private prover: proofProvider.service.ProofBuilder;

  private readonly factAnchor: FactAnchorContract | null;
  private readonly creditLine: CreditLineContract | null;
  private readonly ledger: LedgerContract | null;
  private readonly guarantee: GuaranteeContract | null;
  private readonly passport: PassportContract | null;

  /** Last registry resolution; null until `resolveChainKey` has run. */
  discovery: ChainResolution | null = null;

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

    this.factAnchor = config.factAnchorAddress
      ? (new Contract(config.factAnchorAddress, FACT_ANCHOR_ABI, this.sourceWallet) as FactAnchorContract)
      : null;
    this.creditLine = config.creditLineAddress
      ? (new Contract(config.creditLineAddress, CREDIT_LINE_ABI, this.creditcoinWallet) as CreditLineContract)
      : null;
    this.ledger = config.ledgerAddress
      ? (new Contract(config.ledgerAddress, LEDGER_ABI, this.creditcoinWallet) as LedgerContract)
      : null;
    this.guarantee = config.guaranteeAddress
      ? (new Contract(config.guaranteeAddress, GUARANTEE_ABI, this.creditcoinWallet) as GuaranteeContract)
      : null;
    this.passport = config.passportAddress
      ? (new Contract(config.passportAddress, PASSPORT_ABI, this.creditcoinProvider) as PassportContract)
      : null;

    this.prover = new proofProvider.service.ProofBuilder(config.chainKey, config.proverApiUrl);
  }

  /** The address that anchors and submits proofs. The ASC credits only this address,
   * so it must match the `trustedAnchorer` the ASC was deployed with. */
  get anchorerAddress(): string {
    return this.sourceWallet.address;
  }

  /** Which optional features this client can serve. */
  get features() {
    return attestcoinFeatures(this.config);
  }

  // -------------------------------------------------------------------------
  // Chain registry: which source chains does Attestcoin attest right now?
  // -------------------------------------------------------------------------

  /** Reads `get_supported_chains()` from the ChainInfo precompile. */
  async discoverChains(): Promise<SupportedChain[]> {
    try {
      const rows = await this.chainInfo.get_supported_chains();
      return rows.map((r) => ({
        chainKey: Number(r.chainKey),
        chainId: Number(r.chainId),
        // `chainName` is `bytes` on the precompile; it decodes as a 0x hex string.
        name: hexToUtf8(String(r.chainName)),
        encoding: Number(r.chainEncoding),
      }));
    } catch (e) {
      throw new AttestcoinError("read", `supported chains read failed: ${reason(e)}`);
    }
  }

  /** Reconciles the configured chain key with the live registry.
   *
   * In `auto` mode the registry decides: the key whose chain id matches the source
   * RPC is adopted, and an unattested source chain is a hard configuration error —
   * anchoring to a chain nobody attests would queue proofs that can never be
   * generated. In `env` mode the configured key is kept and disagreements are
   * reported as problems, so an operator sees "your key says Sepolia but your RPC is
   * mainnet" once at boot rather than as a stream of rejected proofs. */
  async resolveChainKey(now: number = Math.floor(Date.now() / 1000)): Promise<ChainResolution> {
    const problems: string[] = [];
    let chains: SupportedChain[] = [];
    try {
      chains = await this.discoverChains();
    } catch (e) {
      problems.push(reason(e));
    }

    let rpcChainId: number | null = null;
    try {
      const hex = (await this.sourceProvider.send("eth_chainId", [])) as string;
      rpcChainId = Number(BigInt(hex));
    } catch (e) {
      problems.push(`source RPC chain id read failed: ${reason(e)}`);
    }

    let source: "env" | "registry" = "env";
    if (this.config.chainKeyMode === "auto") {
      if (chains.length === 0 || rpcChainId === null) {
        throw new AttestcoinError(
          "config",
          `chain key is 'auto' but the registry or the source RPC could not be read: ${problems.join("; ")}`,
          false,
        );
      }
      const match = chains.find((c) => c.chainId === rpcChainId);
      if (!match) {
        throw new AttestcoinError(
          "config",
          `source RPC serves chain ${rpcChainId}, which Attestcoin does not attest (registry: ${chains
            .map((c) => `${c.chainKey}=${c.chainId}`)
            .join(", ")})`,
          false,
        );
      }
      this.applyChainKey(match.chainKey, match.chainId);
      source = "registry";
    } else {
      const entry = chains.find((c) => c.chainKey === this.config.chainKey);
      if (chains.length > 0 && !entry) {
        problems.push(`chain key ${this.config.chainKey} is not in the live registry`);
      }
      if (entry && rpcChainId !== null && entry.chainId !== rpcChainId) {
        problems.push(
          `chain key ${this.config.chainKey} is chain ${entry.chainId} but the source RPC serves chain ${rpcChainId}`,
        );
      }
      // The registry is authoritative over the static fallback table.
      if (entry && entry.chainId !== this.config.sourceChainId) {
        this.config.sourceChainId = entry.chainId;
        this.config.sourceExplorer = sourceExplorerFor(entry.chainId);
      }
    }

    this.discovery = {
      chainKey: this.config.chainKey,
      sourceChainId: this.config.sourceChainId,
      source,
      chains,
      paymentChainAttested: chains.some((c) => c.chainId === this.config.paymentChainId),
      problems,
      resolvedAt: now,
    };
    return this.discovery;
  }

  private applyChainKey(chainKey: number, chainId: number): void {
    this.config.chainKey = chainKey;
    this.config.sourceChainId = chainId;
    this.config.sourceExplorer = sourceExplorerFor(chainId);
    this.prover = new proofProvider.service.ProofBuilder(chainKey, this.config.proverApiUrl);
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

  /** Writes one fact to `FactAnchor`. Same convergence rule as payments: an anchor
   * that already exists is located rather than re-sent. */
  async anchorFact(fact: FactRow): Promise<{ txHash: string; height: number }> {
    const fa = this.requireFactAnchor();
    return traceAttestcoin(
      "anchor_fact",
      { "attestpay.fact_id": fact.id, "attestpay.fact_kind": fact.kind, "attestpay.ref_id": fact.ref_id },
      async (span) => {
        if (await this.factAlreadyAnchored(fa, fact.payload)) {
          span.setAttribute("attestpay.attestcoin.anchor_preexisting", true);
          const found = await this.findExistingFact(fa, fact.payload);
          if (found) return found;
          throw new AttestcoinError(
            "anchor",
            `fact ${fact.id} is already anchored but its transaction could not be located; re-anchoring would revert`,
            false,
          );
        }

        let receipt: TransactionReceipt | null;
        try {
          const tx = await this.sendFactAnchor(fa, fact.payload);
          receipt = await tx.wait();
        } catch (e) {
          verificationFailures.add(1, { stage: "anchor" });
          throw new AttestcoinError("anchor", `fact anchor transaction failed: ${reason(e)}`);
        }
        if (!receipt) throw new AttestcoinError("anchor", "fact anchor produced no receipt");

        anchorsWritten.add(1, { kind: fact.kind });
        span.setAttribute("attestpay.attestcoin.anchor_tx_hash", receipt.hash);
        span.setAttribute("attestpay.attestcoin.anchor_height", receipt.blockNumber);
        emitAnchorLog(fact.id, fact.card_id ?? fact.ref_id, receipt.hash);
        return { txHash: receipt.hash, height: receipt.blockNumber };
      },
    );
  }

  private sendFactAnchor(fa: FactAnchorContract, p: FactPayload) {
    switch (p.kind) {
      case "draw":
        return fa.anchorDraw(
          p.lineId,
          p.borrower,
          p.lender,
          BigInt(p.amountAtoms),
          BigInt(p.sourceChainId),
          p.sourceTxHash,
          BigInt(p.at),
        );
      case "repayment":
        return fa.anchorRepayment(
          p.lineId,
          p.borrower,
          p.lender,
          BigInt(p.amountAtoms),
          BigInt(p.sourceChainId),
          p.sourceTxHash,
          BigInt(p.at),
        );
      case "dispute_opened":
        return fa.anchorDisputeOpened(
          p.disputeId,
          p.cardIdHash,
          p.payer,
          p.merchant,
          BigInt(p.sourceChainId),
          p.sourceTxHash,
          BigInt(p.amountAtoms),
          BigInt(p.at),
          p.reason,
        );
      case "dispute_resolved":
        return fa.anchorDisputeResolved(p.disputeId, p.cardIdHash, p.payer, p.outcome, BigInt(p.at));
      case "card_revoked":
        return fa.anchorCardRevoked(p.cardIdHash, p.payer, BigInt(p.revokedAt));
    }
  }

  private async factAlreadyAnchored(fa: FactAnchorContract, p: FactPayload): Promise<boolean> {
    switch (p.kind) {
      case "draw":
        return fa.isTransferAnchored(1, BigInt(p.sourceChainId), p.sourceTxHash);
      case "repayment":
        return fa.isTransferAnchored(2, BigInt(p.sourceChainId), p.sourceTxHash);
      case "dispute_opened":
        return fa.disputeOpened(p.disputeId);
      case "dispute_resolved":
        return fa.disputeResolved(p.disputeId);
      case "card_revoked":
        return fa.cardRevoked(p.cardIdHash);
    }
  }

  private async findExistingFact(
    fa: FactAnchorContract,
    p: FactPayload,
  ): Promise<{ txHash: string; height: number } | null> {
    try {
      const head = await this.sourceProvider.getBlockNumber();
      const from = Math.max(0, head - 50_000);
      let filter;
      switch (p.kind) {
        case "draw":
          filter = fa.filters.CreditDrawn(p.lineId, p.borrower, p.lender);
          break;
        case "repayment":
          filter = fa.filters.CreditRepaid(p.lineId, p.borrower, p.lender);
          break;
        case "dispute_opened":
          filter = fa.filters.DisputeOpened(p.disputeId);
          break;
        case "dispute_resolved":
          filter = fa.filters.DisputeResolved(p.disputeId);
          break;
        case "card_revoked":
          filter = fa.filters.CardRevoked(p.cardIdHash);
          break;
      }
      const events = await fa.queryFilter(filter, from, head);
      for (const ev of events) {
        if (p.kind === "draw" || p.kind === "repayment") {
          const args = (ev as unknown as { args?: { sourceTxHash?: string } }).args;
          if (String(args?.sourceTxHash).toLowerCase() !== p.sourceTxHash.toLowerCase()) continue;
        }
        return { txHash: ev.transactionHash, height: ev.blockNumber };
      }
      return null;
    } catch {
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

  private static proofArgs(proof: AttestcoinProof): [MerkleProofArg, ContinuityProofArg] {
    return [
      {
        root: proof.merkleProof.root,
        siblings: proof.merkleProof.siblings.map((s) => [s.hash, s.isLeft] as [string, boolean]),
      },
      {
        lowerEndpointDigest: proof.continuityProof.lowerEndpointDigest,
        roots: proof.continuityProof.roots,
      },
    ];
  }

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
        const [merkleArg, continuityArg] = AttestcoinClient.proofArgs(proof);

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

  /** Submits a fact proof to its consumer (`AttestPayCreditLine` or `AttestPayLedger`). */
  async submitFacts(
    target: FactTarget,
    factId: string,
    proof: AttestcoinProof,
  ): Promise<{ txHash: string; recorded: number }> {
    const consumer = this.consumerFor(target);
    return traceAttestcoin(
      "fact_submission",
      {
        "attestpay.fact_id": factId,
        "attestpay.fact_target": target,
        "attestpay.attestcoin.header_number": proof.headerNumber,
      },
      async (span) => {
        const started = Date.now();
        const [merkleArg, continuityArg] = AttestcoinClient.proofArgs(proof);

        try {
          await consumer.verifyFacts.staticCall(BigInt(proof.headerNumber), proof.txBytes, merkleArg, continuityArg);
        } catch (e) {
          verificationFailures.add(1, { stage: "submit", target });
          const msg = reason(e);
          // Configuration and data errors do not heal with time; a line in the wrong
          // status might (the opening transaction may still be landing).
          const permanent =
            /UntrustedAnchorer|NoRelevantFact|ZeroAddress|PartyMismatch|DrawExceedsLimit|LineExpired|UnknownOutcome|MalformedLog/.test(
              msg,
            );
          throw new AttestcoinError("submit", `fact proof rejected on simulation: ${msg}`, !permanent);
        }

        let receipt: TransactionReceipt | null;
        try {
          const tx = await consumer.verifyFacts(BigInt(proof.headerNumber), proof.txBytes, merkleArg, continuityArg);
          receipt = await tx.wait();
        } catch (e) {
          verificationFailures.add(1, { stage: "submit", target });
          throw new AttestcoinError("submit", `fact verification transaction failed: ${reason(e)}`);
        }
        if (!receipt) throw new AttestcoinError("submit", "fact verification produced no receipt");

        // Every log the consumer emitted is one consumed fact (LineDrawn,
        // DisputeRecorded, RevocationRecorded, ...); count those.
        const me = consumer.target.toString().toLowerCase();
        const recorded = receipt.logs.filter((l) => l.address.toLowerCase() === me).length;

        proofSubmissionSeconds.record((Date.now() - started) / 1000);
        proofsVerified.add(1, { target });
        span.setAttribute("attestpay.attestcoin.creditcoin_tx_hash", receipt.hash);
        span.setAttribute("attestpay.attestcoin.facts_recorded", recorded);
        emitVerificationLog(factId, target, receipt.hash, recorded);
        return { txHash: receipt.hash, recorded };
      },
    );
  }

  private consumerFor(target: FactTarget): ProvenFactsContract {
    const c = target === "credit_line" ? this.creditLine : this.ledger;
    if (!c) {
      throw new AttestcoinError("config", `${target} contract is not configured`, false);
    }
    return c;
  }

  private requireFactAnchor(): FactAnchorContract {
    if (!this.factAnchor) throw new AttestcoinError("config", "FactAnchor is not configured", false);
    return this.factAnchor;
  }

  private requireCreditLine(): CreditLineContract {
    if (!this.creditLine) throw new AttestcoinError("config", "AttestPayCreditLine is not configured", false);
    return this.creditLine;
  }

  private requireLedger(): LedgerContract {
    if (!this.ledger) throw new AttestcoinError("config", "AttestPayLedger is not configured", false);
    return this.ledger;
  }

  private requireGuarantee(): GuaranteeContract {
    if (!this.guarantee) throw new AttestcoinError("config", "AttestPayGuarantee is not configured", false);
    return this.guarantee;
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
  // Credit lines
  // -------------------------------------------------------------------------

  /** Registers a dual-signed line on `AttestPayCreditLine`. */
  async openCreditLine(
    terms: LineTermsArg,
    lenderSig: string,
    borrowerSig: string,
  ): Promise<{ txHash: string; lineId: string }> {
    const cl = this.requireCreditLine();
    return traceAttestcoin("open_line", { "attestpay.lender": terms.lender, "attestpay.borrower": terms.borrower }, async (span) => {
      let lineId: string;
      try {
        lineId = await cl.lineIdOf(terms);
        // Simulate for the named error (InvalidSignature / NonceUsed / ...).
        await cl.openLine.staticCall(terms, lenderSig, borrowerSig);
      } catch (e) {
        const msg = reason(e);
        const permanent = /InvalidSignature|InvalidTerms|NonceUsed|LineExists/.test(msg);
        throw new AttestcoinError("submit", `openLine rejected on simulation: ${msg}`, !permanent);
      }
      try {
        const tx = await cl.openLine(terms, lenderSig, borrowerSig);
        const receipt = await tx.wait();
        if (!receipt) throw new Error("no receipt");
        span.setAttribute("attestpay.attestcoin.creditcoin_tx_hash", receipt.hash);
        span.setAttribute("attestpay.line_id", lineId);
        return { txHash: receipt.hash, lineId };
      } catch (e) {
        throw new AttestcoinError("submit", `openLine transaction failed: ${reason(e)}`);
      }
    });
  }

  /** A line as the chain sees it, or null when the id is unknown there. */
  async getLine(lineId: string): Promise<CreditLineOnChain | null> {
    const cl = this.requireCreditLine();
    try {
      const l = await cl.getLine(lineId);
      if (Number(l.status) === 0) return null;
      const [owed, outstanding, available] = await Promise.all([
        cl.owed(lineId),
        cl.outstanding(lineId),
        cl.available(lineId),
      ]);
      return {
        lender: l.terms.lender as `0x${string}`,
        borrower: l.terms.borrower as `0x${string}`,
        limit: l.terms.limit,
        interestBps: l.terms.interestBps,
        expiresAt: l.terms.expiresAt,
        nonce: l.terms.nonce,
        status: Number(l.status),
        drawn: l.drawn,
        repaid: l.repaid,
        openedAt: l.openedAt,
        lastEventAt: l.lastEventAt,
        defaultedAt: l.defaultedAt,
        repaidAt: l.repaidAt,
        owed,
        outstanding,
        available,
      };
    } catch (e) {
      throw new AttestcoinError("read", `line read failed: ${reason(e)}`);
    }
  }

  async getBorrowerRecord(borrower: string): Promise<BorrowerRecord> {
    const cl = this.requireCreditLine();
    try {
      const r = await cl.getBorrowerRecord(borrower);
      return {
        linesOpened: r.linesOpened,
        linesRepaid: r.linesRepaid,
        linesDefaulted: r.linesDefaulted,
        totalDrawn: r.totalDrawn,
        totalRepaid: r.totalRepaid,
      };
    } catch (e) {
      throw new AttestcoinError("read", `borrower record read failed: ${reason(e)}`);
    }
  }

  /** Advances a stale line: `markDefaulted` for an active line with a balance past
   * expiry, `closeUnused` for an open line that was never drawn. Permissionless on
   * the contract, so the anchorer key may do it for anyone. */
  async settleExpiredLine(lineId: string, action: "default" | "close"): Promise<string> {
    const cl = this.requireCreditLine();
    try {
      const tx = action === "default" ? await cl.markDefaulted(lineId) : await cl.closeUnused(lineId);
      const receipt = await tx.wait();
      if (!receipt) throw new Error("no receipt");
      return receipt.hash;
    } catch (e) {
      const msg = reason(e);
      throw new AttestcoinError("submit", `${action} failed: ${msg}`, !/WrongStatus|NotExpired|NothingOutstanding/.test(msg));
    }
  }

  // -------------------------------------------------------------------------
  // Ledger: disputes and revocations
  // -------------------------------------------------------------------------

  async getDisputeRecord(payer: string): Promise<DisputeRecord> {
    const ledger = this.requireLedger();
    try {
      const r = await ledger.getDisputeRecord(payer);
      return {
        opened: r.opened,
        upheld: r.upheld,
        rejected: r.rejected,
        withdrawn: r.withdrawn,
        disputedVolume: r.disputedVolume,
      };
    } catch (e) {
      throw new AttestcoinError("read", `dispute record read failed: ${reason(e)}`);
    }
  }

  async getDisputeOnChain(disputeIdHash: string): Promise<{ status: number; openedAt: bigint; resolvedAt: bigint } | null> {
    const ledger = this.requireLedger();
    try {
      const d = await ledger.getDispute(disputeIdHash);
      if (Number(d.status) === 0) return null;
      return { status: Number(d.status), openedAt: d.openedAt, resolvedAt: d.resolvedAt };
    } catch (e) {
      throw new AttestcoinError("read", `dispute read failed: ${reason(e)}`);
    }
  }

  /** The proven revocation time of a card, or null when none is proven. */
  async cardRevokedAt(cardId: string): Promise<number | null> {
    const ledger = this.requireLedger();
    try {
      const at = await ledger.cardRevokedAt(cardIdToBytes32(cardId));
      return at === 0n ? null : Number(at);
    } catch (e) {
      throw new AttestcoinError("read", `revocation read failed: ${reason(e)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Guarantees
  // -------------------------------------------------------------------------

  async guaranteeOf(borrower: string): Promise<bigint> {
    const g = this.requireGuarantee();
    try {
      return await g.guaranteeOf(borrower);
    } catch (e) {
      throw new AttestcoinError("read", `guarantee read failed: ${reason(e)}`);
    }
  }

  async guarantorsOf(borrower: string): Promise<Array<{ guarantor: string; amount: bigint; unbondRequestedAt: bigint }>> {
    const g = this.requireGuarantee();
    try {
      const gs = await g.guarantorsOf(borrower);
      const bonds = await Promise.all(gs.map((x) => g.bondOf(borrower, x)));
      return gs.map((guarantor, i) => ({
        guarantor,
        amount: bonds[i]!.amount,
        unbondRequestedAt: bonds[i]!.unbondRequestedAt,
      }));
    } catch (e) {
      throw new AttestcoinError("read", `guarantors read failed: ${reason(e)}`);
    }
  }

  /** Bonds CTC from the anchorer key behind a borrower: the operator standing behind
   * an agent it runs. */
  async bondGuarantee(borrower: string, wei: bigint): Promise<string> {
    const g = this.requireGuarantee();
    try {
      const tx = await g.bond(borrower, { value: wei });
      const receipt = await tx.wait();
      if (!receipt) throw new Error("no receipt");
      return receipt.hash;
    } catch (e) {
      throw new AttestcoinError("submit", `bond failed: ${reason(e)}`);
    }
  }

  /** Slashes bonds behind a defaulted line in the lender's favour. Permissionless. */
  async slashGuarantee(lineId: string): Promise<string> {
    const g = this.requireGuarantee();
    try {
      await g.slash.staticCall(lineId);
      const tx = await g.slash(lineId);
      const receipt = await tx.wait();
      if (!receipt) throw new Error("no receipt");
      return receipt.hash;
    } catch (e) {
      const msg = reason(e);
      throw new AttestcoinError("submit", `slash failed: ${msg}`, !/LineNotDefaulted|NothingToSlash/.test(msg));
    }
  }

  // -------------------------------------------------------------------------
  // Passport
  // -------------------------------------------------------------------------

  async getPassport(account: string): Promise<Passport> {
    if (!this.passport) throw new AttestcoinError("config", "CreditPassport is not configured", false);
    try {
      const p = await this.passport.passportOf(account);
      return {
        account: p.account as `0x${string}`,
        verifiedPayments: p.verifiedPayments,
        verifiedVolume: p.verifiedVolume,
        firstPaymentAt: p.firstPaymentAt,
        lastPaymentAt: p.lastPaymentAt,
        withinTermsPayments: p.withinTermsPayments,
        termsCheckedPayments: p.termsCheckedPayments,
        linesOpened: p.linesOpened,
        linesRepaid: p.linesRepaid,
        linesDefaulted: p.linesDefaulted,
        totalDrawn: p.totalDrawn,
        totalRepaid: p.totalRepaid,
        disputesOpened: p.disputesOpened,
        disputesUpheld: p.disputesUpheld,
        disputesRejected: p.disputesRejected,
        disputedVolume: p.disputedVolume,
        guaranteeBonded: p.guaranteeBonded,
        score: p.score,
        grade: p.grade,
        asOf: p.asOf,
      };
    } catch (e) {
      throw new AttestcoinError("read", `passport read failed: ${reason(e)}`);
    }
  }

  async passportFormula(): Promise<string> {
    if (!this.passport) throw new AttestcoinError("config", "CreditPassport is not configured", false);
    try {
      return await this.passport.formula();
    } catch (e) {
      throw new AttestcoinError("read", `formula read failed: ${reason(e)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Deployment sanity check
  // -------------------------------------------------------------------------

  /** Confirms the deployed contracts agree with this process's configuration.
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

    // The fact consumers must agree with the same anchorer and with the FactAnchor.
    for (const [name, c] of [
      ["AttestPayCreditLine", this.creditLine],
      ["AttestPayLedger", this.ledger],
    ] as const) {
      if (!c) continue;
      try {
        const [chainKey, fa, anchorer] = await Promise.all([c.sourceChainKey(), c.factAnchor(), c.trustedAnchorer()]);
        if (Number(chainKey) !== this.config.chainKey) {
          problems.push(`${name} sourceChainKey is ${chainKey} but this process is configured for ${this.config.chainKey}`);
        }
        if (this.config.factAnchorAddress && fa.toLowerCase() !== this.config.factAnchorAddress.toLowerCase()) {
          problems.push(`${name} factAnchor is ${fa} but this process anchors facts to ${this.config.factAnchorAddress}`);
        }
        if (anchorer.toLowerCase() !== this.sourceWallet.address.toLowerCase()) {
          problems.push(`${name} trustedAnchorer is ${anchorer} but this process anchors from ${this.sourceWallet.address}`);
        }
      } catch (e) {
        problems.push(`could not read ${name} configuration: ${reason(e)}`);
      }
    }
    if (this.factAnchorAddressMissingFor()) {
      problems.push(this.factAnchorAddressMissingFor()!);
    }
    return { ok: problems.length === 0, problems };
  }

  private factAnchorAddressMissingFor(): string | null {
    if (this.config.factAnchorAddress) return null;
    const wanting = [this.config.creditLineAddress && "credit lines", this.config.ledgerAddress && "disputes"].filter(
      Boolean,
    );
    if (wanting.length === 0) return null;
    return `${wanting.join(" and ")} configured but ATTESTPAY_FACT_ANCHOR_ADDRESS is not set; those features stay off`;
  }
}

/** Human-readable on-chain line status. */
export function lineStatusName(status: number): string {
  return LINE_STATUS_NAMES[status] ?? `unknown(${status})`;
}

/** Decodes a `bytes` value the precompile returns (0x-hex of UTF-8) into text. */
function hexToUtf8(hex: string): string {
  if (!hex.startsWith("0x")) return hex;
  try {
    return Buffer.from(hex.slice(2), "hex").toString("utf8").replace(/\0+$/, "");
  } catch {
    return hex;
  }
}
