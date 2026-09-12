"use client";

// The cross-chain pane: what Attestcoin has actually proven about this card.
//
// The design problem here is honesty. "Verified ✓" is the satisfying thing to show,
// but a proof of a payment anchor is a narrower claim than "this payment happened",
// and a panel that blurs the two teaches the user something false about their own
// money. So the pane is built around three separations:
//
//   1. Three legs, three links. The Base payment, the anchor, and the Creditcoin
//      verification each get their own explorer link, so "verified" is checkable
//      rather than decorative.
//   2. Waiting is not failing. Attestation takes minutes; an unverified recent
//      payment renders as in-flight with its stage named, never as an error.
//   3. Unknown is not zero. A lag of `null` (the probe failed) reads as "unknown",
//      never as a reassuring 0.

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import {
  api,
  type AttestcoinHealth,
  type AttestcoinProofRow,
  type AttestcoinProofs,
  type CardState,
  type CreditScore,
  type ProofStatus,
} from "@/lib/api";
import { fmtUsd, shortHex } from "./ui";

// ---------------------------------------------------------------------------
// Status vocabulary
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<ProofStatus, string> = {
  pending: "Queued",
  anchoring: "Anchoring",
  anchored: "Awaiting Attestation",
  attested: "Attested",
  proving: "Proving",
  verified: "Verified",
  failed: "Failed",
};

/** What each stage actually means, in the user's terms rather than the pipeline's. */
const STATUS_NOTE: Record<ProofStatus, string> = {
  pending: "Queued for cross-chain verification",
  anchoring: "Writing the payment anchor to Ethereum Sepolia",
  anchored: "Waiting for the Attestcoin attestor network — usually a few minutes",
  attested: "Block attested · generating the inclusion proof",
  proving: "Submitting the proof to AttestPayASC on Creditcoin",
  verified: "Proven on Creditcoin · part of this card's on-chain credit history",
  failed: "Verification did not complete",
};

/** Three visual classes, not seven: done, working, broken. A stage name is detail;
 * whether the user needs to care is the signal. */
function tone(s: ProofStatus): "ok" | "work" | "bad" {
  if (s === "verified") return "ok";
  if (s === "failed") return "bad";
  return "work";
}

// ---------------------------------------------------------------------------
// The pane
// ---------------------------------------------------------------------------

export function AttestcoinPane({
  card,
  rowVariants,
}: {
  card: CardState;
  rowVariants?: Record<string, unknown>;
}) {
  const [proofs, setProofs] = useState<AttestcoinProofs | null>(null);
  const [credit, setCredit] = useState<CreditScore | null>(null);
  const [health, setHealth] = useState<AttestcoinHealth | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Survives unmount mid-fetch: a pane switch must not setState on a dead component.
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const [p, c, h] = await Promise.all([
        api.attestcoinProofs(card.card_id),
        api.creditScore(card.card_id),
        api.attestcoinHealth(),
      ]);
      if (!alive.current) return;
      setProofs(p);
      setCredit(c);
      setHealth(h);
      setErr(null);
    } catch (e) {
      if (!alive.current) return;
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [card.card_id]);

  useEffect(() => {
    alive.current = true;
    void load();
    // Verification lands minutes after a payment, so the pane refreshes itself —
    // otherwise the user stares at "Awaiting Attestation" long after it cleared.
    const t = setInterval(() => void load(), 20_000);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [load]);

  const reverify = async (chargeId: string) => {
    setBusy(chargeId);
    try {
      await api.verifyPayment(card.card_id, chargeId);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  if (err) {
    return (
      <motion.div className="dr panein" variants={rowVariants as never}>
        <div className="subnote">Cross-chain status unavailable · {err}</div>
      </motion.div>
    );
  }

  if (!proofs) {
    return (
      <motion.div className="dr panein" variants={rowVariants as never}>
        <div className="subnote">Reading cross-chain state…</div>
      </motion.div>
    );
  }

  if (!proofs.configured) {
    return (
      <motion.div className="dr panein" variants={rowVariants as never}>
        <p className="panenote">
          Attestcoin cross-chain verification is not configured on this deployment.
          Payments still work exactly as before; they are simply not being proven onto
          Creditcoin.
        </p>
      </motion.div>
    );
  }

  const stats = proofs.stats;

  return (
    <motion.div className="dr panein" variants={rowVariants as never}>
      <p className="panenote">
        Every confirmed payment is anchored on Ethereum Sepolia and proven into
        Creditcoin by the Attestcoin Block Prover precompile — no oracle, no bridge.
      </p>

      <div className="acgrid">
        <CreditCard credit={credit} />
        <HealthCard health={health} />
      </div>

      {stats && (
        <div className="acstats num">
          <Stat label="Verified" value={String(stats.verified)} />
          <Stat label="In Flight" value={String(stats.inFlight)} />
          <Stat label="Failed" value={String(stats.failed)} tone={stats.failed > 0 ? "bad" : undefined} />
          <Stat
            label="Avg Proof Time"
            value={stats.avg_verify_seconds === null ? "·" : `${stats.avg_verify_seconds}s`}
          />
        </div>
      )}

      <ProofList rows={proofs.items} onReverify={reverify} busy={busy} />
    </motion.div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "bad" }) {
  return (
    <div className="acstat">
      <span className="acstat-l">{label}</span>
      <span className={`acstat-v${tone === "bad" ? " bad" : ""}`}>{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Credit score
// ---------------------------------------------------------------------------

export function CreditCard({ credit }: { credit: CreditScore | null }) {
  if (!credit || !credit.configured) {
    return (
      <div className="accard">
        <h3>Credit Standing</h3>
        <div className="subnote">Not configured</div>
      </div>
    );
  }
  if (credit.error) {
    return (
      <div className="accard">
        <h3>Credit Standing</h3>
        <div className="subnote">{credit.error}</div>
      </div>
    );
  }

  const checked = credit.terms_checked_payments ?? 0;
  const grade = credit.grade ?? "F";

  return (
    <div className="accard">
      <h3>Credit Standing</h3>
      <div className="acgrade-row">
        <span className={`acgrade g${grade}`}>{grade}</span>
        <div className="acgrade-side">
          <span className="num acscore">{credit.score ?? 0}/100</span>
          {/* A cached figure must never be presented as live. */}
          {credit.live === false && <span className="acstale">cached</span>}
        </div>
      </div>

      <div className="acrows">
        <Row label="Verified Payments" value={String(credit.total_verified_payments ?? 0)} />
        <Row label="Verified Volume" value={fmtUsd(credit.total_verified_volume ?? "0")} />
        <Row
          label="History Since"
          value={
            credit.first_payment_at
              ? new Date(credit.first_payment_at).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })
              : "·"
          }
        />
        <Row
          label="Within Terms"
          value={
            checked > 0
              ? `${credit.within_terms_payments}/${checked}`
              : "no registered terms"
          }
          // An unregistered card gets no free 100%, and the UI says why rather than
          // leaving a bare dash the user has to interpret.
          hint={
            checked === 0
              ? "No payments have been checked against registered card terms, so there is no compliance rate."
              : undefined
          }
        />
      </div>

      {credit.basis && <p className="acbasis">{credit.basis}</p>}
      {credit.asc_explorer && (
        <a className="aclink" href={credit.asc_explorer} target="_blank" rel="noreferrer">
          AttestPayASC on Creditcoin ↗
        </a>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Protocol health
// ---------------------------------------------------------------------------

export function HealthCard({ health }: { health: AttestcoinHealth | null }) {
  if (!health || !health.configured) {
    return (
      <div className="accard">
        <h3>Protocol Health</h3>
        <div className="subnote">{health?.error ?? "Not configured"}</div>
      </div>
    );
  }

  const lag = health.attestationLagBlocks;
  // Sepolia targets ~12s blocks. Labelled as an estimate, because it is one.
  const lagMins = lag === null ? null : Math.round((lag * 12) / 60);
  const lagTone = lag === null ? "work" : lag > 300 ? "bad" : "ok";

  return (
    <div className="accard">
      <h3>Protocol Health</h3>
      <div className="acrows">
        <Row
          label="Attestation Lag"
          value={lag === null ? "unknown" : `${lag} blocks`}
          tone={lagTone}
        />
        <Row
          label="Estimated Delay"
          value={lagMins === null ? "unknown" : `~${lagMins} min`}
        />
        <Row
          label="Attested Height"
          value={health.latestAttestedHeight ? health.latestAttestedHeight.toLocaleString() : "·"}
        />
        <Row label="Source Head" value={health.sourceHead ? health.sourceHead.toLocaleString() : "·"} />
        <Row label="Chain Key" value={health.chainKey === null ? "·" : String(health.chainKey)} />
      </div>
      {health.error && <p className="acbasis">Probe error · {health.error}</p>}
      {health.ascAddress && (
        <div className="accontracts">
          <span className="code">{shortHex(health.anchorAddress, 8, 6)}</span>
          <span className="w"> anchor</span>
          <br />
          <span className="code">{shortHex(health.ascAddress, 8, 6)}</span>
          <span className="w"> ASC</span>
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: "ok" | "work" | "bad";
  hint?: string;
}) {
  return (
    <div className="trow" title={hint}>
      <span className="tl">{label}</span>
      <span className={`tv${tone ? ` t-${tone}` : ""}`}>{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The proof list: one row per payment, three links per row
// ---------------------------------------------------------------------------

function ProofList({
  rows,
  onReverify,
  busy,
}: {
  rows: AttestcoinProofRow[];
  onReverify: (chargeId: string) => void;
  busy: string | null;
}) {
  if (rows.length === 0) {
    return (
      <div className="subnote">
        No cross-chain proofs yet · the next confirmed payment from this card is
        anchored and proven automatically
      </div>
    );
  }

  return (
    <div className="acproofs">
      <div className="acproof-head">
        <span>Amount</span>
        <span>Base</span>
        <span>Anchor</span>
        <span>Creditcoin</span>
        <span>State</span>
      </div>
      {rows.map((r) => {
        const t = tone(r.status);
        return (
          <div key={r.charge_id} className="acproof" title={STATUS_NOTE[r.status]}>
            <span className="num">{r.amount ? fmtUsd(r.amount) : "·"}</span>
            <Leg leg={r.source} label="tx" />
            <Leg leg={r.anchor} label="tx" />
            <Leg leg={r.creditcoin} label="proof" />
            <span className="acproof-state">
              <span className={`acpill p-${t}`}>{STATUS_LABEL[r.status]}</span>
              {r.status === "failed" && (
                <button
                  type="button"
                  className="acretry"
                  onClick={() => onReverify(r.charge_id)}
                  disabled={busy === r.charge_id}
                >
                  {busy === r.charge_id ? "…" : "Retry"}
                </button>
              )}
            </span>
            {r.error && r.status === "failed" && <span className="acerr">{r.error}</span>}
          </div>
        );
      })}
    </div>
  );
}

/** A leg renders as a link only when it exists; a missing leg is a dot, not an
 * empty link the user can click into nothing. */
function Leg({ leg, label }: { leg: { tx_hash: string; explorer: string | null } | null; label: string }) {
  if (!leg) return <span className="w">·</span>;
  if (!leg.explorer) return <span className="code">{shortHex(leg.tx_hash, 6, 4)}</span>;
  return (
    <a className="aclink" href={leg.explorer} target="_blank" rel="noreferrer" title={leg.tx_hash}>
      {label} ↗
    </a>
  );
}
