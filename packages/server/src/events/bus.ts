// The event bus: one call site turns "this happened" into an outbox row, webhook
// deliveries and an audit entry.
//
// Emitting is synchronous and cheap (sqlite inserts), so it is safe on the payment
// path: `spend()`'s confirmed hook emits `charge.confirmed` and the HTTP delivery
// happens later, in the delivery sweep. A webhook endpoint that is down can never
// slow a payment down.

import { cardState, type Store } from "@attestpay/engine";
import { EventStore, type EventRow, type EventType } from "./store";

export type Actor = { kind: "admin" | "user" | "card" | "system"; id: string };

export class EventBus {
  constructor(
    readonly events: EventStore,
    private readonly store: Store,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  /** Records an event and fans it out to the owning user's subscribed webhooks.
   * `userId` is resolved from the card when not given. */
  emit(type: EventType, scope: { userId?: string | null; cardId?: string | null }, data: Record<string, unknown>): EventRow {
    const cardId = scope.cardId ?? null;
    let userId = scope.userId ?? null;
    if (!userId && cardId) userId = this.store.getCard(cardId)?.user_id ?? null;

    const now = this.now();
    const ev = this.events.insertEvent({ type, user_id: userId, card_id: cardId, data, created_at: now });
    if (userId) {
      const payload = JSON.stringify(deliveryPayload(ev));
      for (const w of this.events.subscribers(userId, type)) {
        this.events.enqueueDelivery({ webhook_id: w.id, event_id: ev.id, event_type: type, payload_json: payload }, now);
      }
    }
    return ev;
  }

  /** Writes an audit entry. Never throws: an audit failure must not fail the action. */
  audit(actor: Actor, action: string, target: { type: string; id: string }, detail?: Record<string, unknown>, ip?: string | null): void {
    try {
      this.events.audit({
        at: this.now(),
        actor_kind: actor.kind,
        actor_id: actor.id,
        action,
        target_type: target.type,
        target_id: target.id,
        detail: detail ?? null,
        ip: ip ?? null,
      });
    } catch {
      /* see above */
    }
  }

  /** After a charge confirms: emits `budget.low` once per period window when the
   * card's remaining period budget has dropped to or below its threshold. */
  checkBudget(cardId: string): EventRow | null {
    const now = this.now();
    const state = cardState(this.store, cardId, now);
    const period = state?.terms.pay?.period;
    if (!state || !period || state.remaining_this_period === null || state.period_resets_at === null) return null;

    const remaining = Number(state.remaining_this_period);
    const budget = Number(period.amount);
    if (!(budget > 0)) return null;
    const pct = (remaining / budget) * 100;
    const threshold = this.events.getAlertThreshold(cardId);
    if (pct > threshold) return null;

    const windowStart = state.period_resets_at - period.seconds;
    if (this.events.budgetAlertSent(cardId, windowStart)) return null;
    this.events.markBudgetAlert(cardId, windowStart, now);

    return this.emit("budget.low", { cardId }, {
      card_id: cardId,
      card_name: state.name,
      remaining_this_period: state.remaining_this_period,
      period_budget: period.amount,
      remaining_pct: Math.round(pct * 10) / 10,
      threshold_pct: threshold,
      period_resets_at: new Date(state.period_resets_at * 1000).toISOString(),
    });
  }
}

/** The body a webhook receives. Stable shape: consumers switch on `type`. */
export function deliveryPayload(ev: EventRow): { id: string; type: EventType; created_at: string; card_id: string | null; data: Record<string, unknown> } {
  return {
    id: ev.id,
    type: ev.type,
    created_at: new Date(ev.created_at * 1000).toISOString(),
    card_id: ev.card_id,
    data: ev.data,
  };
}
