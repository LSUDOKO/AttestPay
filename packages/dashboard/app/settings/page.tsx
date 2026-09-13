"use client";

// /settings: the operating surface around the cards — webhooks, teams, alert
// thresholds and the audit trail. Same shell, same session; nothing here moves money.

import { useCallback, useEffect, useState } from "react";
import { api, type AuditEntry, type CardState, type Delivery, type Team, type TeamRole, type Webhook } from "@/lib/api";
import { useRemit } from "../useRemit";
import { Cockpit } from "../components/Shell";
import { CopyButton } from "../components/Authority";
import { shortHex } from "../components/ui";

export default function SettingsPage() {
  const remit = useRemit();
  const { address, logout, authenticated, ready } = remit;
  const [cards, setCards] = useState<CardState[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setCards(await api.cards());
    } catch {
      /* the sections report their own errors */
    }
  }, []);
  useEffect(() => {
    if (authenticated) void refresh();
  }, [authenticated, refresh]);

  if (!ready) return <main className="narrow">Loading…</main>;
  if (!authenticated) {
    return (
      <main className="narrow">
        <div className="panel">
          <p className="subnote">Sign in on the dashboard first.</p>
        </div>
      </main>
    );
  }

  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 4000);
  };

  return (
    <Cockpit back={{ href: "/app", label: "Dashboard" }} remit={remit} refresh={refresh} onLogout={logout} address={address}>
      <div style={{ padding: "0 8px" }}>
        <h1 style={{ fontSize: 22, margin: "4px 0 14px" }}>Settings</h1>
        {msg && <p className="ok" style={{ margin: "0 0 10px" }}>{msg}</p>}
        <WebhooksSection flash={flash} />
        <TeamsSection cards={cards} flash={flash} refresh={refresh} />
        <AlertsSection cards={cards} flash={flash} />
        <AuditSection cards={cards} />
      </div>
    </Cockpit>
  );
}

// ---------------------------------------------------------------------------

function WebhooksSection({ flash }: { flash: (m: string) => void }) {
  const [hooks, setHooks] = useState<Webhook[]>([]);
  const [types, setTypes] = useState<string[]>([]);
  const [url, setUrl] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [secret, setSecret] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<Record<string, Delivery[]>>({});
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.webhooks();
      setHooks(r.items);
      setTypes(r.event_types);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="setsec">
      <h2>Webhooks</h2>
      <p className="lede">
        Signed POSTs for payments, card changes, proofs, credit and disputes. Header <code>X-AttestPay-Signature: t=…,v1=…</code>{" "}
        is an HMAC-SHA256 over <code>t.body</code> with the secret shown once at creation. Retries: 30s, 2m, 10m, 1h, 6h.
      </p>
      {err && <p className="err">{err}</p>}
      {secret && (
        <div className="secretbox">
          Secret (shown once): <b>{secret}</b> <CopyButton text={secret} label="copy" />
        </div>
      )}
      <div className="crform">
        <label className="span2">
          Endpoint URL
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/attestpay" />
        </label>
        <label className="span2">
          Events (none = all)
          <select multiple value={picked} onChange={(e) => setPicked(Array.from(e.target.selectedOptions, (o) => o.value))} style={{ minHeight: 88 }}>
            {types.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <button
          className="primary"
          disabled={!url}
          onClick={async () => {
            try {
              const r = await api.createWebhook({ url, events: picked });
              setSecret(r.secret);
              setUrl("");
              setPicked([]);
              flash("Webhook created");
              await load();
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          Add webhook
        </button>
      </div>
      {hooks.map((h) => (
        <div key={h.webhook_id}>
          <div className="setrow">
            <div className="main">
              {h.url}
              <div className="sub">
                {h.events.join(", ")} · {h.active ? "active" : "paused"}
              </div>
            </div>
            <div className="acts">
              <button
                className="acretry"
                onClick={async () => {
                  const r = await api.testWebhook(h.webhook_id).catch((e) => ({ delivery: null, error: String(e) }));
                  flash(r.delivery ? `Test delivery: ${r.delivery.status} (${r.delivery.last_status_code ?? "no answer"})` : "Test failed");
                }}
              >
                test
              </button>
              <button
                className="acretry"
                onClick={async () => {
                  const r = await api.deliveries(h.webhook_id).catch(() => ({ items: [] }));
                  setDeliveries((d) => ({ ...d, [h.webhook_id]: d[h.webhook_id] ? [] : r.items }));
                }}
              >
                {deliveries[h.webhook_id]?.length ? "hide" : "deliveries"}
              </button>
              <button className="acretry" onClick={async () => (await api.pauseWebhook(h.webhook_id, !h.active), load())}>
                {h.active ? "pause" : "resume"}
              </button>
              <button className="danger-ghost" onClick={async () => (await api.deleteWebhook(h.webhook_id), load())}>
                delete
              </button>
            </div>
          </div>
          {deliveries[h.webhook_id]?.map((d) => (
            <div key={d.delivery_id} className="acproof">
              <div className="acproof-state">
                <span className={`acpill p-${d.status === "delivered" ? "ok" : d.status === "dead" ? "bad" : "work"}`}>{d.status}</span>
                <span className="num">{d.event_type}</span>
                <span className="w">
                  {d.attempts} attempt{d.attempts === 1 ? "" : "s"} · {d.last_status_code ?? "—"} {d.last_error ? `· ${d.last_error}` : ""}
                </span>
              </div>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}

function TeamsSection({ cards, flash, refresh }: { cards: CardState[]; flash: (m: string) => void; refresh: () => Promise<void> }) {
  const [teams, setTeams] = useState<Team[]>([]);
  const [name, setName] = useState("");
  const [invite, setInvite] = useState<Record<string, { address: string; role: TeamRole }>>({});
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTeams((await api.teams()).items);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const own = cards.filter((c) => c.your_role === "owner" || !c.your_role);

  return (
    <section className="setsec">
      <h2>Teams</h2>
      <p className="lede">
        Share cards with roles. Viewers read; members freeze, dispute, draw and repay; admins assign cards and manage members.
        No role can issue, reveal a card URL, or revoke on-chain — those stay with the owning wallet.
      </p>
      {err && <p className="err">{err}</p>}
      <div className="crform">
        <label className="span2">
          New team
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="ops" />
        </label>
        <button
          className="primary"
          disabled={!name.trim()}
          onClick={async () => {
            await api.createTeam(name.trim()).catch((e) => setErr(String(e)));
            setName("");
            await load();
          }}
        >
          Create
        </button>
      </div>
      {teams.map((t) => (
        <div key={t.team_id} className="crline">
          <div className="crline-head">
            <b>{t.name}</b>
            <span className="who">
              you are <b>{t.your_role}</b>
            </span>
          </div>
          {t.members.map((m) => (
            <div key={m.user_id} className="setrow">
              <div className="main">
                {shortHex(m.user_id, 8, 6)} <span className="sub">· {m.role}</span>
              </div>
              {m.role !== "owner" && (t.your_role === "owner" || t.your_role === "admin") && (
                <button className="danger-ghost" onClick={async () => (await api.removeMember(t.team_id, m.user_id), load())}>
                  remove
                </button>
              )}
            </div>
          ))}
          {(t.your_role === "owner" || t.your_role === "admin") && (
            <div className="cractions">
              <input
                placeholder="0x… wallet"
                style={{ width: 220 }}
                value={invite[t.team_id]?.address ?? ""}
                onChange={(e) => setInvite((i) => ({ ...i, [t.team_id]: { address: e.target.value, role: i[t.team_id]?.role ?? "member" } }))}
              />
              <select
                value={invite[t.team_id]?.role ?? "member"}
                onChange={(e) => setInvite((i) => ({ ...i, [t.team_id]: { address: i[t.team_id]?.address ?? "", role: e.target.value as TeamRole } }))}
              >
                <option value="viewer">viewer</option>
                <option value="member">member</option>
                <option value="admin">admin</option>
              </select>
              <button
                disabled={!/^0x[0-9a-fA-F]{40}$/.test(invite[t.team_id]?.address ?? "")}
                onClick={async () => {
                  const i = invite[t.team_id]!;
                  try {
                    await api.addMember(t.team_id, i.address, i.role);
                    setInvite((x) => ({ ...x, [t.team_id]: { address: "", role: "member" } }));
                    flash("Member added");
                    await load();
                  } catch (e) {
                    setErr(e instanceof Error ? e.message : String(e));
                  }
                }}
              >
                Invite
              </button>
            </div>
          )}
          <div className="cractions">
            <span className="subnote" style={{ padding: 0 }}>
              Cards: {t.cards.length === 0 ? "none" : t.cards.map((c) => c.name ?? shortHex(c.card_id, 6, 4)).join(", ")}
            </span>
            {(t.your_role === "owner" || t.your_role === "admin") && own.length > 0 && (
              <select
                defaultValue=""
                onChange={async (e) => {
                  if (!e.target.value) return;
                  await api.assignTeam(e.target.value, t.team_id).catch((x) => setErr(String(x)));
                  e.target.value = "";
                  flash("Card assigned");
                  await Promise.all([load(), refresh()]);
                }}
              >
                <option value="">assign one of my cards…</option>
                {own.map((c) => (
                  <option key={c.card_id} value={c.card_id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
            {t.your_role === "owner" && (
              <button className="danger-ghost" onClick={async () => (await api.deleteTeam(t.team_id), load())}>
                delete team
              </button>
            )}
          </div>
        </div>
      ))}
      {cards.some((c) => c.team) && (
        <p className="subnote">
          Assigned: {cards.filter((c) => c.team).map((c) => `${c.name} → ${c.team!.name}`).join(" · ")}{" "}
          {cards
            .filter((c) => c.team && (c.your_role === "owner" || !c.your_role))
            .map((c) => (
              <button key={c.card_id} className="acretry" onClick={async () => (await api.assignTeam(c.card_id, null), refresh(), load())}>
                unassign {c.name}
              </button>
            ))}
        </p>
      )}
    </section>
  );
}

function AlertsSection({ cards, flash }: { cards: CardState[]; flash: (m: string) => void }) {
  const [th, setTh] = useState<Record<string, number>>({});
  useEffect(() => {
    void Promise.all(cards.map((c) => api.alerts(c.card_id).then((r) => [c.card_id, r.threshold_pct] as const).catch(() => null))).then((rs) =>
      setTh(Object.fromEntries(rs.filter((r): r is readonly [string, number] => r !== null))),
    );
  }, [cards]);
  return (
    <section className="setsec">
      <h2>Budget alerts</h2>
      <p className="lede">
        A <code>budget.low</code> event (and webhook) fires once per period when a card&apos;s remaining budget drops to or below its
        threshold.
      </p>
      {cards.map((c) => (
        <div key={c.card_id} className="setrow">
          <div className="main">
            {c.name}
            <div className="sub">{c.terms.pay?.period ? `${c.terms.pay.period.amount} USDC per period` : "no period budget · alerts do not apply"}</div>
          </div>
          <div className="acts">
            <input
              type="number"
              min={0}
              max={100}
              style={{ width: 70 }}
              value={th[c.card_id] ?? 20}
              onChange={(e) => setTh((t) => ({ ...t, [c.card_id]: Number(e.target.value) }))}
            />
            <span className="sub">%</span>
            <button className="acretry" onClick={async () => (await api.setAlerts(c.card_id, th[c.card_id] ?? 20), flash("Threshold saved"))}>
              save
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}

function AuditSection({ cards }: { cards: CardState[] }) {
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [cardId, setCardId] = useState("");
  const [action, setAction] = useState("");
  const load = useCallback(async () => {
    setRows((await api.audit({ card_id: cardId || undefined, action: action || undefined, limit: 200 }).catch(() => ({ items: [] }))).items);
  }, [cardId, action]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <section className="setsec">
      <h2>Audit log</h2>
      <p className="lede">Who did what to which card, from which lane. Export the filtered view as CSV.</p>
      <div className="crform">
        <label>
          Card
          <select value={cardId} onChange={(e) => setCardId(e.target.value)}>
            <option value="">all</option>
            {cards.map((c) => (
              <option key={c.card_id} value={c.card_id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Action
          <input value={action} onChange={(e) => setAction(e.target.value)} placeholder="card.frozen" />
        </label>
        <button
          onClick={async () => {
            const csv = await api.auditCsv({ card_id: cardId || undefined, action: action || undefined });
            const blob = new Blob([csv], { type: "text/csv" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = `attestpay-audit-${Date.now()}.csv`;
            a.click();
            URL.revokeObjectURL(a.href);
          }}
        >
          Download CSV
        </button>
      </div>
      {rows.length === 0 && <p className="subnote">Nothing recorded yet.</p>}
      {rows.map((r) => (
        <div key={r.id} className="setrow">
          <div className="main">
            <b>{r.action}</b> <span className="sub">· {r.target}</span>
            <div className="sub">
              {new Date(r.at).toLocaleString()} · {r.actor}
              {r.detail ? ` · ${JSON.stringify(r.detail)}` : ""}
            </div>
          </div>
        </div>
      ))}
    </section>
  );
}
