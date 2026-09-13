"use client";

// /passport/<address>: the public credit passport. No login: a passport only its
// owner can read is not a passport. Everything on this page is either read live from
// CreditPassport on Creditcoin or carried in a signed credential a third party can
// verify without trusting this page — the verify button does exactly that against
// the server, and the credential is shown so it can be copied out and checked
// elsewhere.

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, type Passport } from "@/lib/api";
import { CopyButton } from "../../components/Authority";
import { PublicNav } from "../../components/Landing";
import { shortHex } from "../../components/ui";

export default function PassportPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = use(params);
  const [p, setP] = useState<Passport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [check, setCheck] = useState<{ valid: boolean; signer: string | null; reason?: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setP(await api.publicPassport(address));
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [address]);

  useEffect(() => {
    void load();
  }, [load]);

  const pp = p?.passport;
  const cred = p?.credential ?? null;

  return (
    <>
    <PublicNav links={false} />
    <main className="narrow">
      <div className="panel">
        <p className="microlbl" style={{ margin: "0 0 6px" }}>
          AttestPay credit passport
        </p>
        <h1 style={{ margin: "0 0 12px", fontSize: 20, overflowWrap: "anywhere" }}>{address}</h1>

        {err && <p className="err">{err}</p>}
        {!p && !err && <p className="subnote">Reading Creditcoin…</p>}

        {p && !p.configured && <p className="subnote">{p.reason ?? "Cross-chain verification is not configured on this deployment."}</p>}

        {pp && (
          <>
            <div className="pphead">
              <span className={`ppgrade g${pp.grade}`}>{pp.grade}</span>
              <div>
                <div className="num">{pp.score}/100</div>
                <div className="subnote" style={{ padding: 0 }}>
                  {p.source} {pp.as_of ? `· as of ${new Date(pp.as_of).toLocaleString()}` : ""}
                </div>
              </div>
            </div>

            <div className="acrows">
              <Row l="Verified payments" v={String(pp.verified_payments)} />
              <Row l="Verified volume" v={`${Number(pp.verified_volume_usdc).toFixed(2)} USDC`} />
              <Row l="History" v={pp.first_payment_at ? `${new Date(pp.first_payment_at).toLocaleDateString()} → ${pp.last_payment_at ? new Date(pp.last_payment_at).toLocaleDateString() : "·"}` : "·"} />
              <Row l="Within registered terms" v={pp.terms_checked_payments > 0 ? `${pp.within_terms_payments}/${pp.terms_checked_payments}` : "no registered terms"} />
              {pp.lines_opened !== undefined && (
                <>
                  <Row l="Credit lines opened / repaid / defaulted" v={`${pp.lines_opened} / ${pp.lines_repaid} / ${pp.lines_defaulted}`} />
                  <Row l="Drawn / repaid" v={`${Number(pp.total_drawn_usdc).toFixed(2)} / ${Number(pp.total_repaid_usdc).toFixed(2)} USDC`} />
                  <Row l="Disputes opened / upheld / rejected" v={`${pp.disputes_opened} / ${pp.disputes_upheld} / ${pp.disputes_rejected}`} />
                  <Row l="CTC bonded behind this account" v={`${Number(pp.guarantee_bonded_ctc).toFixed(4)} CTC`} />
                </>
              )}
            </div>
            {p.note && <p className="acbasis">{p.note}</p>}
            {p.contracts?.explorer && (
              <a className="aclink" href={p.contracts.explorer} target="_blank" rel="noreferrer">
                CreditPassport on Creditcoin ↗
              </a>
            )}
          </>
        )}
      </div>

      {cred && (
        <div className="panel" style={{ marginTop: 14 }}>
          <h2 style={{ margin: "0 0 6px", fontSize: 15 }}>Signed credential</h2>
          <p className="subnote" style={{ padding: 0 }}>
            EIP-191 signature over the key-sorted JSON payload by the AttestPay anchorer {shortHex(cred.signer, 6, 4)}. Verify
            it here, with the SDK, or by recovering the signer yourself.
          </p>
          <div className="cractions">
            <button
              className="primary"
              onClick={async () => {
                try {
                  setCheck(await api.verifyPassport({ payload: cred.payload, signature: cred.signature }));
                } catch (e) {
                  setCheck({ valid: false, signer: null, reason: e instanceof Error ? e.message : String(e) });
                }
              }}
            >
              Verify signature
            </button>
            <CopyButton text={JSON.stringify({ payload: cred.payload, signature: cred.signature }, null, 2)} label="Copy credential" />
            {check && (
              <span className={check.valid ? "ok" : "err"}>
                {check.valid ? `valid · signed by ${shortHex(check.signer, 6, 4)}` : `invalid · ${check.reason ?? ""}`}
              </span>
            )}
          </div>
          <pre className="ppjson">{JSON.stringify(cred.payload, null, 2)}</pre>
        </div>
      )}

      {p?.local && (p.local.credit_lines.length > 0 || p.local.disputes.length > 0) && (
        <div className="panel" style={{ marginTop: 14 }}>
          <h2 style={{ margin: "0 0 6px", fontSize: 15 }}>This server&apos;s records</h2>
          <p className="subnote" style={{ padding: 0 }}>
            Local mirrors of the same facts, before and while they are proven. The chain is authoritative.
          </p>
          {p.local.credit_lines.map((l) => (
            <div key={l.line_id} className="trow">
              <span className="tl">line {shortHex(l.line_id, 6, 4)}</span>
              <span className="tv">
                {l.status} · limit {Number(l.limit).toFixed(2)} · outstanding {Number(l.outstanding).toFixed(2)}
              </span>
            </div>
          ))}
          {p.local.disputes.map((d) => (
            <div key={d.dispute_id} className="trow">
              <span className="tl">dispute</span>
              <span className="tv">
                {d.status} · {d.reason}
              </span>
            </div>
          ))}
        </div>
      )}

      <p className="subnote" style={{ textAlign: "center" }}>
        <Link href="/" style={{ color: "var(--accent-deep)" }}>
          AttestPay
        </Link>{" "}
        · agentic spending cards with cross-chain credit history on Creditcoin
      </p>
    </main>
    </>
  );
}

function Row({ l, v }: { l: string; v: string }) {
  return (
    <div className="trow">
      <span className="tl">{l}</span>
      <span className="tv num" style={{ textAlign: "right" }}>
        {v}
      </span>
    </div>
  );
}
