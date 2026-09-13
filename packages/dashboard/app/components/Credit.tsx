"use client";

// The credit pane: what this card can borrow, what it has lent, and the disputes
// and proven facts that shape its passport.
//
// Two roles share the pane because one wallet can be both. As BORROWER, the card's
// funding account draws on lines lenders opened to it and repays them from this
// card. As LENDER, this card can be the funding card of a line offered to someone
// else's account. Every draw and repayment is an ordinary Base payment that is then
// proven into Creditcoin — the pane shows that pipeline per line, honestly staged,
// the same way the cross-chain pane does for payments.

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import Link from "next/link";
import { api, type CardState, type CreditLine, type CreditLineDetail, type Dispute, type Fact, type Passport, type ProofStatus } from "@/lib/api";
import type { useRemit } from "../useRemit";
import { fmtUsd, shortHex } from "./ui";

type Remit = ReturnType<typeof useRemit>;

const STATUS_TONE: Record<CreditLine["status"], "ok" | "work" | "bad"> = {
  proposed: "work",
  signed: "work",
  opening: "work",
  open: "ok",
  active: "ok",
  repaid: "ok",
  defaulted: "bad",
  closed: "work",
  failed: "bad",
};

const FACT_LABEL: Record<Fact["kind"], string> = {
  draw: "Draw",
  repayment: "Repayment",
  dispute_opened: "Dispute opened",
  dispute_resolved: "Dispute resolved",
  card_revoked: "Revocation",
};

const factTone = (s: ProofStatus): "ok" | "work" | "bad" => (s === "verified" ? "ok" : s === "failed" ? "bad" : "work");

export function CreditPane({ card, remit, rowVariants }: { card: CardState; remit: Remit; rowVariants?: Record<string, unknown> }) {
  const [lines, setLines] = useState<{ configured: boolean; as_lender: CreditLine[]; as_borrower: CreditLine[] } | null>(null);
  const [passport, setPassport] = useState<Passport | null>(null);
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [charges, setCharges] = useState<Array<{ id: string; amount: string; memo: string | null; status: string; to: string | null }>>([]);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const [l, p, d, f, c] = await Promise.all([
        api.creditLines(),
        api.passport(card.card_id).catch(() => null),
        api.disputes(card.card_id).catch(() => ({ configured: false, items: [] })),
        api.attestcoinFacts(card.card_id).catch(() => ({ configured: false, items: [] })),
        api.card(card.card_id).catch(() => null),
      ]);
      if (!alive.current) return;
      setLines(l);
      setPassport(p);
      setDisputes(d.items);
      setFacts(f.items);
      setCharges(c ? c.charges.map((ch) => ({ id: ch.id, amount: ch.amount, memo: ch.memo, status: ch.status, to: ch.to })) : []);
      setErr(null);
    } catch (e) {
      if (!alive.current) return;
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [card.card_id]);

  useEffect(() => {
    alive.current = true;
    void load();
    const t = setInterval(() => void load(), 20_000);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [load]);

  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 4000);
  };

  if (err) {
    return (
      <motion.div className="dr panein" variants={rowVariants as never}>
        <div className="subnote">Credit unavailable · {err}</div>
      </motion.div>
    );
  }
  if (!lines) {
    return (
      <motion.div className="dr panein" variants={rowVariants as never}>
        <div className="subnote">Reading credit state…</div>
      </motion.div>
    );
  }

  const me = remit.address?.toLowerCase();
  const borrowing = lines.as_borrower;
  const lending = lines.as_lender.filter((l) => l.funding_card_id === card.card_id || !card.card_id);

  return (
    <motion.div className="dr panein" variants={rowVariants as never}>
      {!lines.configured && (
        <p className="panenote">
          Credit lines are not configured on this deployment (AttestPayCreditLine / FactAnchor). Disputes and the
          payments-only passport still work below.
        </p>
      )}
      {msg && <p className="ok" style={{ margin: "0 0 8px" }}>{msg}</p>}

      <div className="acgrid">
        <PassportCard passport={passport} />
        <div className="accard">
          <h3>Borrowing power</h3>
          <div className="acrows">
            <Row label="Open lines" value={String(borrowing.filter((l) => l.status === "open" || l.status === "active").length)} />
            <Row label="Available" value={fmtUsd(sum(borrowing.map((l) => l.available)))} />
            <Row label="Outstanding" value={fmtUsd(sum(borrowing.map((l) => l.outstanding)))} />
            <Row label="Open disputes" value={String(disputes.filter((d) => d.status === "open").length)} />
          </div>
          <p className="acbasis">Draws land in this card&apos;s funding account; repayments leave from this card within its own terms.</p>
        </div>
      </div>

      {/* ---- as borrower ---- */}
      <h3 className="acproof-head" style={{ marginTop: 14 }}>Lines to this account</h3>
      {borrowing.length === 0 && <div className="subnote">No lender has opened a line to this account yet.</div>}
      {borrowing.map((l) => (
        <LineCard key={l.line_id} line={l} role="borrower" card={card} remit={remit} me={me} onChange={load} flash={flash} />
      ))}

      {/* ---- as lender ---- */}
      {lines.configured && (
        <>
          <h3 className="acproof-head" style={{ marginTop: 18 }}>Lines funded by this card</h3>
          {lending.map((l) => (
            <LineCard key={l.line_id} line={l} role="lender" card={card} remit={remit} me={me} onChange={load} flash={flash} />
          ))}
          <ProposeForm card={card} onDone={load} flash={flash} />
        </>
      )}

      {/* ---- disputes ---- */}
      <h3 className="acproof-head" style={{ marginTop: 18 }}>Disputes</h3>
      <DisputeForm card={card} charges={charges} onDone={load} flash={flash} />
      {disputes.length === 0 && <div className="subnote">No disputes on this card.</div>}
      {disputes.map((d) => (
        <div key={d.dispute_id} className="acproof">
          <div className="acproof-state">
            <span className={`acpill p-${d.status === "open" ? "work" : d.status === "upheld" ? "ok" : "bad"}`}>{d.status}</span>
            <span className="num">{shortHex(d.charge_id, 8, 4)}</span>
            <span className="w">{d.reason}</span>
          </div>
          <div className="acproof-state" style={{ marginTop: 6 }}>
            {d.facts.map((f) => (
              <span key={f.fact_id} className={`acpill p-${factTone(f.status)}`} title={f.error ?? undefined}>
                {FACT_LABEL[f.kind]} · {f.status}
              </span>
            ))}
            {d.status === "open" && (
              <button
                className="acretry"
                onClick={async () => {
                  try {
                    await api.resolveDispute(d.dispute_id, "withdrawn");
                    flash("Dispute withdrawn");
                    await load();
                  } catch (e) {
                    setErr(e instanceof Error ? e.message : String(e));
                  }
                }}
              >
                withdraw
              </button>
            )}
          </div>
        </div>
      ))}

      {/* ---- facts pipeline ---- */}
      {facts.length > 0 && (
        <>
          <h3 className="acproof-head" style={{ marginTop: 18 }}>Proven facts</h3>
          <div className="acproofs">
            {facts.map((f) => (
              <div key={f.fact_id} className="acproof">
                <div className="acproof-state">
                  <span className={`acpill p-${factTone(f.status)}`}>{f.status}</span>
                  <span className="num">{FACT_LABEL[f.kind]}</span>
                  <span className="w">{f.created_at ? new Date(f.created_at).toLocaleString() : ""}</span>
                  {f.creditcoin_explorer && (
                    <a className="aclink" href={f.creditcoin_explorer} target="_blank" rel="noreferrer" style={{ marginTop: 0 }}>
                      Creditcoin ↗
                    </a>
                  )}
                  {f.status === "failed" && (
                    <button
                      className="acretry"
                      onClick={async () => {
                        await api.retryFact(f.fact_id).catch(() => null);
                        await load();
                      }}
                    >
                      retry
                    </button>
                  )}
                </div>
                {f.error && <div className="acerr">{f.error}</div>}
              </div>
            ))}
          </div>
        </>
      )}
    </motion.div>
  );
}

// ---------------------------------------------------------------------------

function PassportCard({ passport }: { passport: Passport | null }) {
  if (!passport || !passport.configured || !passport.passport) {
    return (
      <div className="accard">
        <h3>Credit Passport</h3>
        <div className="subnote">{passport?.reason ?? "Not configured"}</div>
      </div>
    );
  }
  const p = passport.passport;
  return (
    <div className="accard note-yellow">
      <h3>Credit Passport</h3>
      <div className="acgrade-row">
        <span className={`acgrade g${p.grade}`}>{p.grade}</span>
        <div className="acgrade-side">
          <span className="num acscore">{p.score}/100</span>
          {passport.credential ? <span className="acstale" style={{ color: "var(--accent-deep)" }}>signed</span> : <span className="acstale">payments only</span>}
        </div>
      </div>
      <div className="acrows">
        <Row label="Verified payments" value={String(p.verified_payments)} />
        <Row label="Lines repaid / defaulted" value={`${p.lines_repaid ?? 0} / ${p.lines_defaulted ?? 0}`} />
        <Row label="Disputes upheld" value={String(p.disputes_upheld ?? 0)} />
        <Row label="CTC bonded behind" value={p.guarantee_bonded_ctc ? `${Number(p.guarantee_bonded_ctc).toFixed(2)} CTC` : "·"} />
      </div>
      <Link className="aclink" href={`/passport/${passport.account}`}>
        Public passport ↗
      </Link>
    </div>
  );
}

function LineCard({
  line,
  role,
  card,
  remit,
  me,
  onChange,
  flash,
}: {
  line: CreditLine;
  role: "borrower" | "lender";
  card: CardState;
  remit: Remit;
  me: string | undefined;
  onChange: () => Promise<void>;
  flash: (m: string) => void;
}) {
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [detail, setDetail] = useState<CreditLineDetail | null>(null);

  const isLender = me !== undefined && line.lender.toLowerCase() === me;
  const isBorrower = me !== undefined && line.borrower.toLowerCase() === me;
  const needsMySignature = line.status === "proposed" && ((isLender && !line.signatures.lender) || (isBorrower && !line.signatures.borrower));
  const drawnPct = Number(line.limit) > 0 ? Math.min(100, (Number(line.drawn) / Number(line.limit)) * 100) : 0;

  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    setErr(null);
    try {
      await fn();
      await onChange();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const sign = () =>
    run("sign", async () => {
      const d = await api.creditLine(line.line_id);
      if (!d.typed_data) throw new Error("nothing to sign");
      const sig = await remit.signTypedData(d.typed_data);
      await api.signCreditLine(line.line_id, isLender ? "lender" : "borrower", sig);
      flash(isLender ? "Signed as lender" : "Signed as borrower");
    });

  return (
    <div className="crline">
      <div className="crline-head">
        <div className="acproof-state">
          <span className={`acpill p-${STATUS_TONE[line.status]}`}>{line.status}</span>
          <span className="num">{fmtUsd(line.limit)} limit</span>
          <span className="w">· {(line.interest_bps / 100).toFixed(2)}% interest</span>
          {line.expires_at && <span className="w">· until {new Date(line.expires_at).toLocaleDateString()}</span>}
        </div>
        <span className="who">
          {role === "borrower" ? `from ${shortHex(line.lender, 6, 4)}` : `to ${shortHex(line.borrower, 6, 4)}`}
        </span>
      </div>

      <div className="crbar" title={`${drawnPct.toFixed(0)}% drawn`}>
        <span className={line.status === "defaulted" ? "bad" : ""} style={{ width: `${drawnPct}%` }} />
      </div>
      <div className="crfigs num">
        <Fig l="Drawn" v={fmtUsd(line.drawn)} />
        <Fig l="Repaid" v={fmtUsd(line.repaid)} />
        <Fig l="Outstanding" v={fmtUsd(line.outstanding)} />
        <Fig l="Available" v={fmtUsd(line.available)} />
      </div>

      <div className="cractions">
        {needsMySignature && (
          <button className="primary" disabled={busy !== null} onClick={sign}>
            {busy === "sign" ? "Signing…" : isLender ? "Sign as lender" : "Sign as borrower"}
          </button>
        )}
        {line.status === "proposed" && !needsMySignature && (
          <span className="subnote" style={{ padding: 0 }}>
            Waiting for {!line.signatures.lender ? "the lender" : "the borrower"} to sign.
          </span>
        )}
        {role === "borrower" && isBorrower && (line.status === "open" || line.status === "active" || line.status === "defaulted") && (
          <>
            <input placeholder="USDC" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
            {Number(line.available) > 0 && (
              <button
                disabled={busy !== null || !/^\d+(\.\d{1,6})?$/.test(amount)}
                onClick={() =>
                  run("draw", async () => {
                    const r = await api.drawCredit(line.line_id, { card_id: card.card_id, amount });
                    flash(`Drew ${fmtUsd(amount)} · ${r.receipt.status}`);
                    setAmount("");
                  })
                }
              >
                {busy === "draw" ? "Drawing…" : "Draw"}
              </button>
            )}
            {Number(line.outstanding) > 0 && (
              <button
                disabled={busy !== null || !/^\d+(\.\d{1,6})?$/.test(amount)}
                onClick={() =>
                  run("repay", async () => {
                    const r = await api.repayCredit(line.line_id, { card_id: card.card_id, amount });
                    flash(`Repaid ${fmtUsd(amount)} · ${r.receipt.status}`);
                    setAmount("");
                  })
                }
              >
                {busy === "repay" ? "Repaying…" : "Repay"}
              </button>
            )}
          </>
        )}
        {role === "lender" && isLender && line.expires_at && new Date(line.expires_at).getTime() < Date.now() && (line.status === "open" || line.status === "active") && (
          <button
            className="danger-ghost"
            disabled={busy !== null}
            onClick={() => run("settle", async () => api.settleCreditLine(line.line_id, line.status === "open" ? "close" : "default"))}
          >
            {line.status === "open" ? "Close (never drawn)" : "Mark defaulted"}
          </button>
        )}
        <button
          className="acretry"
          onClick={async () => {
            if (detail) return setDetail(null);
            setDetail(await api.creditLine(line.line_id).catch(() => null));
          }}
        >
          {detail ? "hide" : "history"}
        </button>
        {line.creditcoin_explorer && (
          <a className="aclink" href={line.creditcoin_explorer} target="_blank" rel="noreferrer" style={{ marginTop: 0 }}>
            Creditcoin ↗
          </a>
        )}
      </div>
      {err && <div className="acerr">{err}</div>}
      {line.error && <div className="acerr">{line.error}</div>}

      {detail && (
        <div className="acproofs" style={{ marginTop: 8 }}>
          {detail.events.length === 0 && <div className="subnote">No draws or repayments yet.</div>}
          {detail.events.map((e) => {
            const fact = detail.facts.find((f) => f.fact_id === `fact:${e.kind}:${e.charge_id}`);
            return (
              <div key={e.charge_id} className="acproof">
                <div className="acproof-state">
                  <span className="num">{e.kind === "draw" ? "Draw" : "Repayment"} {fmtUsd(e.amount)}</span>
                  <span className="w">{e.at ? new Date(e.at).toLocaleString() : ""}</span>
                  <span className={`acpill p-${e.charge_status === "confirmed" ? "ok" : "work"}`}>Base · {e.charge_status ?? "?"}</span>
                  {fact && <span className={`acpill p-${factTone(fact.status)}`}>Creditcoin · {fact.status}</span>}
                  {e.explorer && (
                    <a className="aclink" href={e.explorer} target="_blank" rel="noreferrer" style={{ marginTop: 0 }}>
                      tx ↗
                    </a>
                  )}
                </div>
              </div>
            );
          })}
          {detail.on_chain && (
            <p className="acbasis">
              On Creditcoin: {detail.on_chain.status} · drawn {fmtUsd(detail.on_chain.drawn ?? "0")} · repaid {fmtUsd(detail.on_chain.repaid ?? "0")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function ProposeForm({ card, onDone, flash }: { card: CardState; onDone: () => Promise<void>; flash: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [borrower, setBorrower] = useState("");
  const [limit, setLimit] = useState("");
  const [bps, setBps] = useState("500");
  const [days, setDays] = useState("30");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!open) {
    return (
      <div className="cractions">
        <button onClick={() => setOpen(true)}>Offer a credit line from this card</button>
      </div>
    );
  }
  const isAddr = /^0x[0-9a-fA-F]{40}$/.test(borrower.trim());
  return (
    <div className="crline">
      <p className="panenote">
        This card pays the draws, within its own terms. The borrower is a funding account (a wallet address) or one of its
        cards; both of you sign the terms, then the line is registered on Creditcoin.
      </p>
      <div className="crform">
        <label className="span2">
          Borrower (address or card id)
          <input value={borrower} onChange={(e) => setBorrower(e.target.value)} placeholder="0x… or card id" />
        </label>
        <label>
          Limit (USDC)
          <input value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="25.00" inputMode="decimal" />
        </label>
        <label>
          Interest (bps)
          <input value={bps} onChange={(e) => setBps(e.target.value)} inputMode="numeric" />
        </label>
        <label>
          Expires in (days)
          <input value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" />
        </label>
      </div>
      <div className="cractions">
        <button
          className="primary"
          disabled={busy || !borrower.trim() || !/^\d+(\.\d{1,6})?$/.test(limit)}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              await api.proposeCreditLine({
                funding_card_id: card.card_id,
                ...(isAddr ? { borrower_address: borrower.trim() } : { borrower_card_id: borrower.trim() }),
                limit,
                interest_bps: Number(bps) || 0,
                expires_at: Math.floor(Date.now() / 1000) + (Number(days) || 30) * 86_400,
              });
              flash("Line proposed · sign it as lender below");
              setOpen(false);
              setBorrower("");
              setLimit("");
              await onDone();
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Proposing…" : "Propose"}
        </button>
        <button onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {err && <div className="acerr">{err}</div>}
    </div>
  );
}

function DisputeForm({
  card,
  charges,
  onDone,
  flash,
}: {
  card: CardState;
  charges: Array<{ id: string; amount: string; memo: string | null; status: string; to: string | null }>;
  onDone: () => Promise<void>;
  flash: (m: string) => void;
}) {
  const [chargeId, setChargeId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const eligible = charges.filter((c) => c.status === "confirmed");
  if (eligible.length === 0) return null;
  return (
    <div className="crform" style={{ marginBottom: 10 }}>
      <label className="span2">
        Payment
        <select value={chargeId} onChange={(e) => setChargeId(e.target.value)}>
          <option value="">choose a confirmed payment…</option>
          {eligible.map((c) => (
            <option key={c.id} value={c.id}>
              {fmtUsd(c.amount)} · {c.memo ?? shortHex(c.to, 6, 4)}
            </option>
          ))}
        </select>
      </label>
      <label className="span2">
        Reason
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="what went wrong" />
      </label>
      <button
        disabled={busy || !chargeId || reason.trim().length < 3}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            await api.openDispute(card.card_id, chargeId, reason.trim());
            flash("Dispute opened");
            setChargeId("");
            setReason("");
            await onDone();
          } catch (e) {
            setErr(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Opening…" : "Dispute"}
      </button>
      {err && <div className="acerr span2">{err}</div>}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="trow">
      <span className="tl">{label}</span>
      <span className="tv num">{value}</span>
    </div>
  );
}

function Fig({ l, v }: { l: string; v: string }) {
  return (
    <div className="crfig">
      <span className="l">{l}</span>
      <span className="v">{v}</span>
    </div>
  );
}

function sum(xs: string[]): string {
  return xs.reduce((a, x) => a + Number(x || 0), 0).toFixed(6);
}
