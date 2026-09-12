// OpenTelemetry instrumentation for the Attestcoin proof lifecycle (SigNoz).
//
// The pipeline is slow (minutes) and multi-hop, so "it didn't verify" is useless on
// its own — the question is always WHICH hop stalled. Every stage therefore gets its
// own span and its own histogram, so attestation wait is separable from proof
// generation, which is separable from Creditcoin submission.

import { logs } from "@opentelemetry/api-logs";
import { metrics, trace, SpanStatusCode, type Span } from "@opentelemetry/api";

const logger = logs.getLogger("attestpay-attestcoin");
const meter = metrics.getMeter("attestpay-attestcoin");
const tracer = trace.getTracer("attestpay-attestcoin");

// --- Counters ---

export const anchorsWritten = meter.createCounter("attestpay.attestcoin.anchors_written_total", {
  description: "Payment anchors written to the source chain",
});

export const proofsGenerated = meter.createCounter("attestpay.attestcoin.proofs_generated_total", {
  description: "Attestcoin inclusion proofs successfully generated",
});

export const proofsVerified = meter.createCounter("attestpay.attestcoin.proofs_verified_total", {
  description: "Proofs accepted by AttestPayASC on Creditcoin",
});

export const verificationFailures = meter.createCounter(
  "attestpay.attestcoin.verification_failures_total",
  { description: "Failed proof generations or on-chain verifications" },
);

// --- Histograms ---

export const attestationWaitSeconds = meter.createHistogram(
  "attestpay.attestcoin.attestation_wait_seconds",
  { description: "Time waiting for the anchor's block to be attested", unit: "s" },
);

export const proofGenerationSeconds = meter.createHistogram(
  "attestpay.attestcoin.proof_generation_seconds",
  { description: "Time to generate an inclusion proof via the prover API", unit: "s" },
);

export const proofSubmissionSeconds = meter.createHistogram(
  "attestpay.attestcoin.proof_submission_seconds",
  { description: "Time to submit and confirm the verification tx on Creditcoin", unit: "s" },
);

/** End-to-end latency from source payment to Creditcoin verification. The number that
 * actually answers "how long until an agent's payment is provable?" */
export const endToEndSeconds = meter.createHistogram("attestpay.attestcoin.end_to_end_seconds", {
  description: "Payment confirmation to cross-chain verification",
  unit: "s",
});

/** How far behind the attestors are running, sampled each time the worker checks. */
export const attestationLagBlocks = meter.createHistogram(
  "attestpay.attestcoin.attestation_lag_blocks",
  { description: "Source-chain head minus latest attested height", unit: "1" },
);

// --- Spans ---

/** Runs `fn` inside a named Attestcoin span with standard attributes.
 * Errors are recorded on the span and re-thrown — the worker, not the tracer,
 * decides retry policy. */
export async function traceAttestcoin<T>(
  name: string,
  attrs: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(`attestcoin.${name}`, async (span) => {
    for (const [k, v] of Object.entries(attrs)) span.setAttribute(k, v);
    span.setAttribute("attestpay.attestcoin.stage", name);
    try {
      return await fn(span);
    } catch (e) {
      span.recordException(e as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: e instanceof Error ? e.message : String(e) });
      throw e;
    } finally {
      span.end();
    }
  });
}

// --- Structured logs ---

export function emitAnchorLog(chargeId: string, cardId: string, anchorTxHash: string): void {
  logger.emit({
    severityNumber: 9,
    severityText: "INFO",
    body: `Attestcoin anchor written for charge ${chargeId}`,
    attributes: {
      attestcoin_event: "anchor_written",
      charge_id: chargeId,
      card_id: cardId,
      anchor_tx_hash: anchorTxHash,
    },
  });
}

export function emitAttestationLog(
  chargeId: string,
  chainKey: number,
  height: number,
  waitSeconds: number,
): void {
  logger.emit({
    severityNumber: 9,
    severityText: "INFO",
    body: `Attestcoin attestation confirmed for block ${height}`,
    attributes: {
      attestcoin_event: "attestation_confirmed",
      charge_id: chargeId,
      chain_key: chainKey,
      block_number: height,
      wait_seconds: waitSeconds,
    },
  });
}

export function emitVerificationLog(
  chargeId: string,
  cardId: string,
  creditcoinTxHash: string,
  recorded: number,
): void {
  logger.emit({
    severityNumber: 9,
    severityText: "INFO",
    body: `Attestcoin proof verified on Creditcoin for charge ${chargeId}`,
    attributes: {
      attestcoin_event: "verification_result",
      charge_id: chargeId,
      card_id: cardId,
      creditcoin_tx_hash: creditcoinTxHash,
      payments_recorded: recorded,
      verified: true,
    },
  });
}

export function emitAttestcoinError(stage: string, chargeId: string, message: string): void {
  logger.emit({
    severityNumber: 17,
    severityText: "ERROR",
    body: `Attestcoin ${stage} failed for charge ${chargeId}: ${message}`,
    attributes: {
      attestcoin_event: "stage_failed",
      stage,
      charge_id: chargeId,
      error_message: message,
    },
  });
}
