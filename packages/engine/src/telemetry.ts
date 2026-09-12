import { logs } from "@opentelemetry/api-logs";
import { metrics } from "@opentelemetry/api";

const logger = logs.getLogger("attestpay-engine");
const meter = metrics.getMeter("attestpay-engine");

// --- Metrics (visible in SigNoz dashboards) ---

/** Total USDC spent across all confirmed redemptions and fiat settlements */
export const usdcSpentTotal = meter.createCounter("attestpay.usdc_spent_total", {
  description: "Total USDC spent across all confirmed redemptions and fiat settlements",
});

/** Number of currently active (issued minus revoked) cards */
export const activeCards = meter.createUpDownCounter("attestpay.active_cards", {
  description: "Number of currently active (issued minus revoked) cards",
});

/** Total cards issued (root + sub-cards) */
export const cardsIssuedTotal = meter.createCounter("attestpay.cards_issued_total", {
  description: "Total cards issued across all users (root + sub-cards)",
});

/** Total charges processed (confirmed + pending + failed) */
export const chargesTotal = meter.createCounter("attestpay.charges_total", {
  description: "Total charges processed across all cards",
});

/** Total API errors (refusals + exceptions) */
export const errorsTotal = meter.createCounter("attestpay.errors_total", {
  description: "Total API-level errors and refusals",
});

// --- Structured Logs (visible in SigNoz Logs explorer) ---

/** Log a structured payment refusal with typed reason and card context */
export function emitRefusalLog(cardId: string, refusalReason: string, attemptedAmount: string): void {
  logger.emit({
    severityNumber: 13,
    severityText: "WARN",
    body: `Refusal: ${refusalReason} for card ${cardId}`,
    attributes: { card_id: cardId, refusal_reason: refusalReason, attempted_amount: attemptedAmount },
  });
}

/** Log a card lifecycle event (issued, frozen, revoked, nuked) */
export function emitCardLog(event: string, cardId: string, extra?: Record<string, string | number>): void {
  logger.emit({
    severityNumber: 9,
    severityText: "INFO",
    body: `Card ${event}: ${cardId}`,
    attributes: { card_event: event, card_id: cardId, ...extra },
  });
}

/** Log a charge lifecycle event */
export function emitChargeLog(event: string, cardId: string, amount: string, kind: string): void {
  logger.emit({
    severityNumber: 9,
    severityText: "INFO",
    body: `Charge ${event}: ${amount} USDC on card ${cardId}`,
    attributes: { charge_event: event, card_id: cardId, amount, kind },
  });
}

/** Log an API-level error */
export function emitErrorLog(operation: string, message: string, extra?: Record<string, string | number>): void {
  logger.emit({
    severityNumber: 17,
    severityText: "ERROR",
    body: `Error in ${operation}: ${message}`,
    attributes: { operation, error_message: message, ...extra },
  });
}
