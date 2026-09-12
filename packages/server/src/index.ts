// @attestpay/server: the one always-on process (Railway).
// Hostname routing on a single Hono app:
//   mcp.remit.s0nderlabs.xyz        -> MCP endpoint (/c/<secret>/mcp) + dashboard API + webhooks
//   facilitator.remit.s0nderlabs.xyz -> erc7710 x402 facilitator (verify/settle/supported) + demo seller
// Facilitator routes use fetch + WebCrypto ONLY (portability rule: 20-min Workers escape hatch).

import { trace } from "@opentelemetry/api";
import { attestcoin, reconcilePending } from "@attestpay/engine";
import { createApp } from "./app";
import { envInt, realDeps } from "./deps";
import { deliverWebhooks } from "./events/deliver";

const deps = realDeps();
const app = createApp(deps);
const port = envInt("PORT", 4070);
const otel = trace.getTracer("attestpay-server");

// Reconcile sweep: charges left "pending" (confirm timed out) hold budget until
// settled. Re-check them against chain logs periodically. 0 disables (tests).
const reconcileMs = envInt("ATTESTPAY_RECONCILE_INTERVAL_MS", 300_000);
if (reconcileMs > 0) {
  setInterval(() => {
    otel.startActiveSpan("reconcile_sweep", async (span) => {
      try {
        const r = await reconcilePending({ store: deps.store, relayer: deps.relayer });
        span.setAttribute("reconciled", r.reconciled);
        span.setAttribute("still_pending", r.stillPending);
        if (r.reconciled) console.log(`[reconcile] settled ${r.reconciled} stuck charge(s)`);
      } catch (e) {
        span.recordException(e as Error);
      } finally {
        span.end();
      }
    });
  }, reconcileMs);
} else {
  console.log("[reconcile] sweep DISABLED (ATTESTPAY_RECONCILE_INTERVAL_MS=0): stuck pending charges will hold budget");
}

// Fiat settlement sweep: approved Visa rows the inline kickoff missed (process crash,
// frozen-then-unfrozen card) get re-driven through spend(). Settlement mode only.
if (deps.fiatSettler) {
  const settler = deps.fiatSettler;
  const runSweep = () =>
    otel.startActiveSpan("fiat_settle_sweep", async (span) => {
      try {
        const r = await settler.sweep();
        span.setAttribute("settled", r.settled);
        span.setAttribute("left", r.left);
        if (r.settled) console.log(`[settle] sweep settled ${r.settled} fiat charge(s) (${r.left} left)`);
      } catch (e) {
        span.recordException(e as Error);
      } finally {
        span.end();
      }
    });
  const settleMs = envInt("ATTESTPAY_FIAT_SETTLE_INTERVAL_MS", 60_000);
  if (settleMs > 0) setInterval(runSweep, settleMs);
  setTimeout(runSweep, 5_000); // startup pass: crash recovery for rows orphaned mid-settle
}

// Attestcoin proof worker: drives anchored payments through attestation, proof
// generation and on-chain verification on Creditcoin. Off entirely when the
// integration is not configured.
const acDeps = deps.attestcoin;
if (acDeps?.client) {
  const client = acDeps.client;
  const acStore = acDeps.store;

  // Resolve the chain key against the live registry, THEN check the deployment
  // agrees with this process, all before doing any work. In `auto` mode the registry
  // decides which source chain is anchored; in `env` mode disagreements are reported.
  // An ASC wired to a different anchor or anchorer rejects every proof, and finding
  // that out once at boot beats discovering it one stuck payment at a time.
  let ready = false;
  const boot = (async () => {
    try {
      const r = await client.resolveChainKey();
      console.log(
        `[attestcoin] chain key ${r.chainKey} (${r.source}) · source chain ${r.sourceChainId} · attested chains: ${r.chains
          .map((c) => `${c.chainKey}=${c.chainId}(${c.name})`)
          .join(", ") || "unknown"} · payment chain ${client.config.paymentChainId} attested: ${r.paymentChainAttested}`,
      );
      for (const p of r.problems) console.error(`[attestcoin] CHAIN KEY WARNING: ${p}`);
    } catch (e) {
      console.error(`[attestcoin] chain key resolution failed: ${e instanceof Error ? e.message : String(e)}`);
      if (client.config.chainKeyMode === "auto") {
        console.error("[attestcoin] chain key is 'auto' and could not be resolved: the worker will NOT run");
        return;
      }
    }
    try {
      const { ok, problems } = await client.checkDeployment();
      if (ok) {
        console.log(`[attestcoin] deployment check OK · anchorer=${client.anchorerAddress}`);
      } else {
        for (const p of problems) console.error(`[attestcoin] DEPLOYMENT MISMATCH: ${p}`);
        console.error(
          "[attestcoin] the worker will keep running, but proofs are likely to be rejected until this is fixed",
        );
      }
    } catch (e) {
      console.error(`[attestcoin] deployment check could not run: ${e instanceof Error ? e.message : String(e)}`);
    }
    const f = attestcoin.attestcoinFeatures(client.config);
    console.log(
      `[attestcoin] features · credit=${f.credit} disputes=${f.disputes} guarantee=${f.guarantee} passport=${f.passport}`,
    );
    ready = true;
  })();

  const sweepMs = envInt("ATTESTPAY_ATTESTCOIN_SWEEP_INTERVAL_MS", 60_000);
  const workerDeps = () => ({
    store: deps.store,
    attestcoin: acStore,
    client,
    batchSize: envInt("ATTESTPAY_ATTESTCOIN_BATCH_SIZE", 10),
    // Verified / failed proofs and facts become events (and webhooks).
    onTerminal: (e: attestcoin.PipelineEvent) => {
      if (!deps.events) return;
      if (e.pipeline === "payment") {
        deps.events.emit(e.status === "verified" ? "proof.verified" : "proof.failed", { cardId: e.row.card_id }, {
          charge_id: e.row.charge_id,
          anchor_tx_hash: e.row.anchor_tx_hash,
          creditcoin_tx_hash: e.row.creditcoin_tx_hash,
          error: e.row.error,
        });
      } else {
        deps.events.emit(e.status === "verified" ? "fact.verified" : "fact.failed", { cardId: e.row.card_id }, {
          fact_id: e.row.id,
          kind: e.row.kind,
          ref_id: e.row.ref_id,
          anchor_tx_hash: e.row.anchor_tx_hash,
          creditcoin_tx_hash: e.row.creditcoin_tx_hash,
          error: e.row.error,
        });
      }
    },
  });
  const runAttestcoinSweep = () =>
    otel.startActiveSpan("attestcoin_sweep", async (span) => {
      try {
        await boot;
        if (!ready) {
          span.setAttribute("skipped", true);
          return;
        }
        const r = await attestcoin.sweepProofs(workerDeps());
        span.setAttribute("examined", r.examined);
        span.setAttribute("advanced", r.advanced);
        span.setAttribute("verified", r.verified);
        span.setAttribute("failed", r.failed);
        span.setAttribute("waiting", r.waiting);
        if (r.verified || r.failed) {
          console.log(
            `[attestcoin] sweep: ${r.verified} verified, ${r.failed} failed, ${r.waiting} waiting (${r.examined} examined)`,
          );
        }
        // Facts (draws, repayments, disputes, revocations) share the state machine
        // but have their own queue, so a stuck payment never blocks a dispute.
        if (attestcoin.attestcoinFeatures(client.config).credit || attestcoin.attestcoinFeatures(client.config).disputes) {
          const f = await attestcoin.sweepFacts(workerDeps());
          span.setAttribute("facts_examined", f.examined);
          span.setAttribute("facts_verified", f.verified);
          span.setAttribute("facts_failed", f.failed);
          if (f.verified || f.failed) {
            console.log(`[attestcoin] facts: ${f.verified} verified, ${f.failed} failed, ${f.waiting} waiting`);
          }
        }
        // Credit lines: register signed lines, settle expired ones.
        if (attestcoin.attestcoinFeatures(client.config).credit) {
          const l = await attestcoin.sweepCreditLines({ attestcoin: acStore, client }, Math.floor(Date.now() / 1000));
          span.setAttribute("lines_opened", l.opened);
          span.setAttribute("lines_defaulted", l.defaulted);
          if (l.opened || l.defaulted || l.closed) {
            console.log(`[attestcoin] lines: ${l.opened} opened, ${l.defaulted} defaulted, ${l.closed} closed`);
          }
        }
      } catch (e) {
        // sweepProofs is already internally defensive; this is the last resort so a
        // throw can never kill the interval and silently stop all verification.
        span.recordException(e as Error);
        console.error(
          `[attestcoin] sweep threw: ${e instanceof Error ? e.message : String(e)}`,
        );
      } finally {
        span.end();
      }
    });

  if (sweepMs > 0) {
    setInterval(runAttestcoinSweep, sweepMs);
    // Startup pass, delayed so the deployment check and the HTTP listener go first.
    setTimeout(runAttestcoinSweep, 10_000);
    console.log(`[attestcoin] proof worker every ${sweepMs}ms`);
  } else {
    console.log(
      "[attestcoin] proof worker DISABLED (ATTESTPAY_ATTESTCOIN_SWEEP_INTERVAL_MS=0): payments will queue but never verify",
    );
  }
}

// Webhook delivery sweep: signed POSTs for every queued event, with backoff. Off when
// the bus is absent (tests) or the interval is 0.
if (deps.events) {
  const bus = deps.events;
  const whMs = envInt("ATTESTPAY_WEBHOOK_INTERVAL_MS", 15_000);
  if (whMs > 0) {
    setInterval(() => {
      otel.startActiveSpan("webhook_deliver_sweep", async (span) => {
        try {
          const r = await deliverWebhooks(bus.events);
          span.setAttribute("attempted", r.attempted);
          span.setAttribute("delivered", r.delivered);
          span.setAttribute("dead", r.dead);
          if (r.attempted) console.log(`[webhooks] ${r.delivered} delivered, ${r.failed} retrying, ${r.dead} dead`);
        } catch (e) {
          span.recordException(e as Error);
        } finally {
          span.end();
        }
      });
    }, whMs);
  }
}

console.log(`attestpay server listening on :${port}`);

export default { port, fetch: app.fetch, idleTimeout: 120 };
