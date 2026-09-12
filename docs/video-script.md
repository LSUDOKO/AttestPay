# 🎬 AttestPay Demo Video Script (2-3 min)

---

## SCENE 1: Opening — The Problem (0:00-0:20)

**🎥 Screen:** Browser → AttestPay landing page at `glass-pay.vercel.app`

**🎙️ Narrator:**
"Every AI agent today is locked inside a chat window. They can think, they can plan — but they can't spend. They can't buy APIs, can't purchase tools, can't transact in the real world. AttestPay changes that."

**🎥 Screen:** Quick overlay text: "AI Agents can't pay. AttestPay fixes that."

---

## SCENE 2: Login + Issue a Card (0:20-0:45)

**🎥 Screen:** Click "Sign in with Google" → Dashboard loads → Click "Issue Card"

**🎙️ Narrator:**
"Sign in with Google — no crypto wallet needed. Instantly, you see your dashboard. Let's issue a spending card for our AI agent."

**🎥 Screen:** Type name "Demo Agent", set budget "$21 per week" → Click Issue → Card appears with MCP URL + Visa credentials

**🎙️ Narrator:**
"Set a budget — $21 a week. One click, and your card is live. AttestPay auto-mints a linked test Visa through Stripe, so this card works everywhere — both crypto rails and traditional payment networks."

**🎥 Screen:** Hover over the Visa credentials showing number, expiry, CVC

---

## SCENE 3: Connect Claude via MCP (0:45-1:10)

**🎥 Screen:** Copy the MCP URL → Switch to Claude desktop/web → Paste the URL

**🎙️ Narrator:**
"Copy the MCP connection URL — that's the agent's wallet. Paste it into Claude. Now Claude has a spending card with a $21 budget."

**🎥 Screen:** Claude responds: "I have access to a attestpay-agent-card connector"

**🎙️ Narrator:**
"Claude acknowledges the connection. It can check the balance, make payments, and even browse a product catalog."

---

## SCENE 4: Shop the Stripe Marketplace (1:10-1:35)

**🎥 Screen:** Type `shop_products` in Claude → Claude lists 5 products

**🎙️ Narrator:**
"We ask Claude to browse the catalog. It sees all our Stripe products — Cursor IDE, Eleven Labs Pro, DeepSeek, and more. Each with real prices pulled live from Stripe's API."

**🎥 Screen:** Show Stripe Dashboard side-by-side with the same products

**🎙️ Narrator:**
"These products are managed in Stripe Dashboard — we created them there, and AttestPay fetches them in real time."

---

## SCENE 5: Claude Buys a Product (1:35-2:00)

**🎥 Screen:** Type `shop_buy product_id: "prod_UxNGMyUf5XGCvh"` → Claude processes → Returns `approved: true`

**🎙️ Narrator:**
"Now Claude buys the Cursor IDE trial — $0.09. The purchase fires a real-time Stripe authorization. Our webhook checks the budget, approves it, and returns a confirmation. The agent just made its first purchase."

**🎥 Screen:** Type `card` → Shows budget decreased from $21.00 to $20.91 + charge history

**🎙️ Narrator:**
"Check the card again. Budget dropped from $21 to $20.91. The charge is logged with the authorization ID. Real budget enforcement, real-time."

---

## SCENE 6: SigNoz Observability (2:00-2:30)

**🎥 Screen:** Switch to SigNoz dashboard → Show traces → Filter `stripe_webhook_auth`

**🎙️ Narrator:**
"Every transaction is traced in SigNoz. Here's the webhook authorization span — approval decision in milliseconds. Every payment, every budget check, every decline is fully observable."

**🎥 Screen:** Scroll through traces, show the span details (approved=true, reason=in_budget, latency)

**🎙️ Narrator:**
"Latency, decision reason, card ID — full observability out of the box. This isn't a demo hack. This is production-grade infrastructure."

---

## SCENE 7: Try to Overspend (2:30-2:45)

**🎥 Screen:** Type `shop_buy product_id: "prod_UxNNSKIhg5d77F"` → Claude tries to buy $10 Eleven Labs → Declined

**🎙️ Narrator:**
"What happens when the agent tries to overspend? Let's try buying the $10 Eleven Labs Pro — declined. `over_period_limit`. The budget is enforced on-chain and in real time. The agent cannot exceed its limits."

---

## SCENE 8: Closing (2:45-3:00)

**🎥 Screen:** Split screen: AttestPay dashboard + Claude + SigNoz

**🎙️ Narrator:**
"AttestPay gives AI agents financial agency — with Guardrails. Budgets, expiry, real-time webhook enforcement, full observability. Agents that can spend, within limits you control. This is the future of AI × payments."

**🎥 Screen:** glasspay.xyz / GitHub link

**🎙️ Narrator:**
"AttestPay. Give your agents a wallet."

---

## 📋 Shot List Summary

| Time | Screen | Audio |
|------|--------|-------|
| 0:00-0:20 | Landing page | Problem intro |
| 0:20-0:45 | Google login + Issue card | Issuance demo |
| 0:45-1:10 | Copy MCP URL → Claude connects | MCP connection |
| 1:10-1:35 | Claude shop_products + Stripe Dashboard | Product catalog |
| 1:35-2:00 | Claude shop_buy + card check | Purchase demo |
| 2:00-2:30 | SigNoz traces & spans | Observability |
| 2:30-2:45 | Overspend attempt → declined | Budget enforcement |
| 2:45-3:00 | Closing split screen | Wrap + CTA |

---

## 🎯 Key URLs for the Demo

| Resource | URL |
|----------|-----|
| **Dashboard** | `https://glass-pay.vercel.app` |
| **Railway (API)** | `https://glasspay-production.up.railway.app` |
| **SigNoz** | SigNoz cloud dashboard |
| **Stripe Dashboard** | `https://dashboard.stripe.com` |
