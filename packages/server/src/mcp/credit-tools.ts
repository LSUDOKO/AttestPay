// The credit MCP tools: what an AGENT can do with the credit it has earned.
//
//   credit_lines     — the lines open to this card's funding account, with room left
//   draw_credit      — pull funds from a line into the funding account
//   repay_credit     — pay a line down from this card
//   dispute_payment  — contest a payment this card made
//   credit_passport  — the account's composed on-chain standing, signed and portable
//
// Registered only when the relevant contracts are configured, like the other
// Attestcoin tools: a tool that can only answer "not configured" is not offered.
//
// Same writing rules as attestcoin-tools.ts: ISO timestamps, decimal USDC, explorer
// links, and the trust model stated where an agent might otherwise overstate it.

import { z } from "zod";
import { RefusalError, attestcoin as ac, usdcToAtoms, type CardRow } from "@attestpay/engine";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppDeps } from "../deps";
import { executeDraw, executeRepayment, lineView } from "../attestcoin/credit-exec";
import { disputeView, passportFor } from "../attestcoin/credit-routes";

type Run = (toolName: string, cardId: string, fn: () => Promise<unknown>) => Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}>;

const CREDIT_TRUST_NOTE =
  "Draws and repayments are ordinary USDC transfers on Base. Each is anchored on the attested source chain and proven into AttestPayCreditLine on Creditcoin, which advances the line's state from the proven bytes. The proof establishes the anchor; the AttestPay anchorer asserts the Base transfer, and the Base transaction hash is included so anyone can check it.";

export function registerCreditTools(server: McpServer, deps: AppDeps, card: CardRow, run: Run): void {
  const a = deps.attestcoin;
  if (!a?.client) return;
  const client = a.client;
  const store = a.store;
  const features = ac.attestcoinFeatures(client.config);
  const now = () => Math.floor(Date.now() / 1000);

  /** The account whose credit this card spends and builds. */
  const account = () => {
    const addr = ac.borrowerAddressForCard(deps.store, card.id);
    if (!addr) throw new RefusalError("card_not_found", "this card has no resolvable funding account");
    return addr;
  };

  /** A line this card's account borrows on, or a typed refusal. */
  const myLine = (lineId: string): ac.CreditLineRow => {
    const line = store.getLine(lineId);
    if (!line || line.borrower_address.toLowerCase() !== account().toLowerCase()) {
      throw new RefusalError("card_not_found", "no such credit line for this card's funding account");
    }
    return line;
  };

  if (features.credit) {
    server.registerTool(
      "credit_lines",
      {
        title: "Credit lines available to this card",
        description:
          "List the credit lines opened to this card's funding account: limit, what has been drawn and repaid, what is still available and what is owed. A line is funded by a lender's own AttestPay card, so a draw is subject to that card's terms as well as the line's limit. Use the line_id with draw_credit and repay_credit.",
        inputSchema: {},
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async () =>
        run("credit_lines", card.id, async () => {
          const t = now();
          const lines = store.listLinesByBorrower(account());
          return {
            funding_account: account(),
            lines: lines.map((l) => lineView(l, t)),
            drawable: lines.filter((l) => ac.availableAtoms(l, t) > 0n).map((l) => l.id),
            note:
              lines.length === 0
                ? "No credit lines are open to this account yet. A lender opens one from the dashboard; both parties sign the terms."
                : CREDIT_TRUST_NOTE,
          };
        }),
    );

    server.registerTool(
      "draw_credit",
      {
        title: "Draw on a credit line",
        description:
          "Draw USDC from a credit line into this card's funding account. The lender's funding card pays; the transfer confirms on Base in seconds and is then proven into Creditcoin. Refused (typed) when the amount exceeds what is available, the line has expired, or the lender's card declines. Use idempotency_key to make retries safe.",
        inputSchema: {
          line_id: z.string().regex(/^0x[0-9a-fA-F]{64}$/).describe("the line id from credit_lines"),
          amount: z.string().regex(/^\d+(\.\d{1,6})?$/).describe("USDC amount, decimal string"),
          memo: z.string().max(280).optional(),
          idempotency_key: z.string().max(128).optional().describe("same key -> same draw (safe retries)"),
        },
        annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      async (args: { line_id: string; amount: string; memo?: string; idempotency_key?: string }) =>
        run("draw_credit", card.id, async () => {
          const line = myLine(args.line_id);
          const r = await executeDraw(deps, line.id, {
            amountAtoms: usdcToAtoms(args.amount),
            memo: args.memo,
            idempotencyKey: args.idempotency_key,
            actorCardId: card.id,
          });
          return {
            status: r.receipt.status,
            tx: r.receipt.tx,
            explorer: r.receipt.tx ? ac.baseTxUrl(client.config.paymentChainId, r.receipt.tx) : null,
            charge_id: r.charge_id,
            drawn: r.receipt.amount,
            received_by: r.receipt.to,
            line: lineView(r.line, now()),
            cross_chain:
              r.fact_id
                ? { fact_id: r.fact_id, status: store.getFact(r.fact_id)?.status ?? "pending", note: "queued for proof into AttestPayCreditLine; takes a few minutes" }
                : { status: "awaiting confirmation", note: "the fact is queued once the Base transfer confirms" },
            trust_model: CREDIT_TRUST_NOTE,
          };
        }),
    );

    server.registerTool(
      "repay_credit",
      {
        title: "Repay a credit line",
        description:
          "Pay a credit line down from this card: USDC goes to the lender's address within this card's own terms, and the repayment is proven into Creditcoin. Repaying in full (drawn plus interest) marks the line repaid on-chain, which lifts this account's credit passport. Use idempotency_key to make retries safe.",
        inputSchema: {
          line_id: z.string().regex(/^0x[0-9a-fA-F]{64}$/).describe("the line id from credit_lines"),
          amount: z.string().regex(/^\d+(\.\d{1,6})?$/).describe("USDC amount, decimal string"),
          idempotency_key: z.string().max(128).optional(),
        },
        annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      async (args: { line_id: string; amount: string; idempotency_key?: string }) =>
        run("repay_credit", card.id, async () => {
          const line = myLine(args.line_id);
          const r = await executeRepayment(deps, line.id, {
            cardId: card.id,
            amountAtoms: usdcToAtoms(args.amount),
            idempotencyKey: args.idempotency_key,
          });
          return {
            status: r.receipt.status,
            tx: r.receipt.tx,
            explorer: r.receipt.tx ? ac.baseTxUrl(client.config.paymentChainId, r.receipt.tx) : null,
            charge_id: r.charge_id,
            repaid: r.receipt.amount,
            paid_to: r.receipt.to,
            remaining_this_period: r.receipt.remaining_this_period,
            line: lineView(r.line, now()),
            cross_chain: r.fact_id
              ? { fact_id: r.fact_id, status: store.getFact(r.fact_id)?.status ?? "pending" }
              : { status: "awaiting confirmation" },
          };
        }),
    );
  }

  server.registerTool(
    "dispute_payment",
    {
      title: "Dispute a payment",
      description:
        "Open a dispute against a confirmed payment this card made (wrong amount, goods not delivered, ...). The dispute is recorded, and where the ledger contract is configured it is proven into AttestPayLedger on Creditcoin so the outcome becomes part of the public record. One open dispute per payment; the operator adjudicates (upheld / rejected) and you may withdraw.",
      inputSchema: {
        charge_id: z.string().max(128).describe("the charge ID returned by `pay`"),
        reason: z.string().min(3).max(500).describe("what went wrong"),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async (args: { charge_id: string; reason: string }) =>
      run("dispute_payment", card.id, async () => {
        try {
          const d = ac.openDispute(
            { store: deps.store, attestcoin: store, config: features.disputes ? client.config : null },
            { chargeId: args.charge_id, cardId: card.id, openedByUserId: `card:${card.id}`, reason: args.reason },
            now(),
          );
          deps.events?.emit("dispute.opened", { cardId: card.id }, { dispute_id: d.id, charge_id: d.charge_id, reason: d.reason, opened_by: "agent" });
          deps.events?.audit({ kind: "card", id: `card:${card.id}` }, "dispute.opened", { type: "dispute", id: d.id }, { charge_id: d.charge_id });
          return {
            ...disputeView(d, store),
            on_chain: features.disputes
              ? "queued for proof into AttestPayLedger (a few minutes)"
              : "recorded locally; the ledger contract is not configured on this deployment",
          };
        } catch (e) {
          if (e instanceof ac.DisputeError) throw new RefusalError("invalid_terms", e.message, { dispute_error: e.code });
          throw e;
        }
      }),
  );

  server.registerTool(
    "credit_passport",
    {
      title: "Credit passport",
      description:
        "The composed on-chain standing of this card's funding account: verified payments, credit lines drawn / repaid / defaulted, disputes, and CTC bonded behind it, with the score computed on-chain by CreditPassport. Comes with a signed credential any third party can verify offline (POST /passport/verify) or check live against the contract. Describe the score as a published formula over public facts, not a risk assessment.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => run("credit_passport", card.id, () => passportFor(deps, account())),
  );
}
