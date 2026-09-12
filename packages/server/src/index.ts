// @attestpay/server: the one always-on process (Railway).
// Hostname routing on a single Hono app:
//   mcp.remit.s0nderlabs.xyz        -> MCP endpoint (/c/<secret>/mcp) + dashboard API + webhooks
//   facilitator.remit.s0nderlabs.xyz -> erc7710 x402 facilitator (verify/settle/supported) + demo seller
// Facilitator routes use fetch + WebCrypto ONLY (portability rule: 20-min Workers escape hatch).

import { trace } from "@opentelemetry/api";
import { attestcoin, reconcilePending } from "@attestpay/engine";
import { createApp } from "./app";
import { envInt, realDeps } from "./deps";

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

  // Check the deployment agrees with this process BEFORE doing any work. An ASC wired
  // to a different anchor or anchorer rejects every proof, and finding that out once
  // at boot beats discovering it one stuck payment at a time.
  void client
    .checkDeployment()
    .then(({ ok, problems }) => {
      if (ok) {
        console.log(`[attestcoin] deployment check OK · anchorer=${client.anchorerAddress}`);
      } else {
        for (const p of problems) console.error(`[attestcoin] DEPLOYMENT MISMATCH: ${p}`);
        console.error(
          "[attestcoin] the worker will keep running, but proofs are likely to be rejected until this is fixed",
        );
      }
    })
    .catch((e) => {
      console.error(
        `[attestcoin] deployment check could not run: ${e instanceof Error ? e.message : String(e)}`,
      );
    });

  const sweepMs = envInt("ATTESTPAY_ATTESTCOIN_SWEEP_INTERVAL_MS", 60_000);
  const runAttestcoinSweep = () =>
    otel.startActiveSpan("attestcoin_sweep", async (span) => {
      try {
        const r = await attestcoin.sweepProofs({
          store: deps.store,
          attestcoin: acStore,
          client,
          batchSize: envInt("ATTESTPAY_ATTESTCOIN_BATCH_SIZE", 10),
        });
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

console.log(`attestpay server listening on :${port}`);

export default { port, fetch: app.fetch, idleTimeout: 120 };
